/**
 * `StripeReadTransport` backed by the real Stripe API.
 *
 * HARD CONSTRAINT — READ-ONLY: every Stripe call below is `.list()` or
 * `.retrieve()`. There is no create, update, delete, capture, refund or replay
 * anywhere in this file, and the restricted-key admission control in
 * key-validation.ts means the credential could not perform one even if a future
 * edit tried.
 *
 * The client is constructed with `maxNetworkRetries: 0` on purpose. Retrying is
 * the sync loop's job (see retry.ts), which owns the backoff schedule, the
 * jitter, the attempt accounting and the per-resource checkpoint semantics.
 * Letting the SDK retry underneath would make attempt counts meaningless and
 * double the effective backoff.
 */
import Stripe from "stripe";
import { classifyStripeError } from "./errors";
import { defaultSleep, type SleepFn } from "./retry";
import {
  DEFAULT_PAGE_SIZE,
  type StripeAccountDto,
  type StripeBalanceTransactionDto,
  type StripeChargeDto,
  type StripeCustomerDto,
  type StripeDisputeDto,
  type StripeInvoiceDto,
  type StripeListParams,
  type StripePage,
  type StripePaymentIntentDto,
  type StripePayoutDto,
  type StripeReadTransport,
  type StripeRefundDto,
  type StripeSubscriptionDto,
} from "./transport";

export interface LiveTransportOptions {
  /** The customer's restricted key. Held only by the Stripe client. */
  restrictedKey: string;
  /** Derived from the key prefix: Stripe accounts are not themselves live/test. */
  livemode: boolean;
  /** Ceiling on outbound requests per second. See STRIPE_CUSTOMER_RATE_LIMIT_RPS. */
  rateLimitRps?: number;
  /** Injected so tests can drive the limiter without real time passing. */
  sleep?: SleepFn;
  now?: () => number;
  /** Pre-built client, for advanced wiring. Must be read-only in practice. */
  client?: Stripe;
}

/**
 * Minimum-interval rate limiter.
 *
 * A token bucket would allow a burst that immediately trips Stripe's own limit
 * and costs a full backoff cycle to recover from. Spacing requests evenly keeps
 * a long backfill inside the budget with no bursts at all, which is the right
 * trade for a background worker where latency does not matter.
 */
export class RequestRateLimiter {
  private readonly minIntervalMs: number;
  private nextAvailableAt = 0;

  constructor(
    requestsPerSecond: number,
    private readonly sleep: SleepFn = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {
    const rps = Number.isFinite(requestsPerSecond) && requestsPerSecond > 0 ? requestsPerSecond : 1;
    this.minIntervalMs = 1_000 / rps;
  }

  async acquire(): Promise<void> {
    const current = this.now();
    const scheduledAt = Math.max(current, this.nextAvailableAt);
    // Reserved before awaiting, so concurrent callers queue rather than collide.
    this.nextAvailableAt = scheduledAt + this.minIntervalMs;
    const waitMs = scheduledAt - current;
    if (waitMs > 0) await this.sleep(waitMs);
  }
}

/** Stripe sends seconds; the domain works in `Date`. */
function toDate(seconds: number): Date {
  return new Date(seconds * 1_000);
}

function toOptionalDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" ? toDate(seconds) : null;
}

/** Stripe amounts are already integer minor units; widen without going via float. */
function toMinor(amount: number): bigint {
  return BigInt(Math.trunc(amount));
}

/** Unwrap `string | { id } | null` — Stripe returns either, depending on expansion. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

function toMetadata(metadata: Stripe.Metadata | null | undefined): Record<string, string> {
  if (!metadata) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Translate our pagination shape into Stripe's list parameters. */
function toListParams(params: StripeListParams): {
  limit: number;
  starting_after?: string;
  created?: { gte: number };
} {
  const query: { limit: number; starting_after?: string; created?: { gte: number } } = {
    limit: Math.min(Math.max(params.limit || DEFAULT_PAGE_SIZE, 1), 100),
  };
  if (params.startingAfter) query.starting_after = params.startingAfter;
  if (params.createdGte) {
    query.created = { gte: Math.floor(params.createdGte.getTime() / 1_000) };
  }
  return query;
}

function toPage<S extends { id: string }, T>(
  list: Stripe.ApiList<S>,
  map: (item: S) => T,
): StripePage<T> {
  const last = list.data.at(-1);
  return {
    data: list.data.map(map),
    hasMore: list.has_more,
    lastId: last ? last.id : null,
  };
}

class LiveStripeTransport implements StripeReadTransport {
  private readonly stripe: Stripe;
  private readonly limiter: RequestRateLimiter;
  private readonly livemode: boolean;

  constructor(options: LiveTransportOptions) {
    this.livemode = options.livemode;
    this.stripe =
      options.client ??
      new Stripe(options.restrictedKey, {
        // The sync loop owns retries; see the file header.
        maxNetworkRetries: 0,
        timeout: 30_000,
        telemetry: false,
      });
    this.limiter = new RequestRateLimiter(
      options.rateLimitRps ?? 8,
      options.sleep ?? defaultSleep,
      options.now ?? Date.now,
    );
  }

  /** Every outbound call goes through here: rate limit in, error mapping out. */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    await this.limiter.acquire();
    try {
      return await operation();
    } catch (caught) {
      throw classifyStripeError(caught);
    }
  }

  async retrieveAccount(): Promise<StripeAccountDto> {
    const account = await this.call(() => this.stripe.accounts.retrieve(null));
    return {
      id: account.id,
      // Dashboard name first: it is what the operator sees in Stripe itself.
      displayName:
        account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? null,
      livemode: this.livemode,
    };
  }

  async listCustomers(params: StripeListParams): Promise<StripePage<StripeCustomerDto>> {
    const list = await this.call(() => this.stripe.customers.list(toListParams(params)));
    return toPage(list, (customer) => ({
      id: customer.id,
      email: customer.email,
      name: customer.name ?? null,
      created: toDate(customer.created),
    }));
  }

  async listPaymentIntents(params: StripeListParams): Promise<StripePage<StripePaymentIntentDto>> {
    const list = await this.call(() => this.stripe.paymentIntents.list(toListParams(params)));
    return toPage(list, (intent) => ({
      id: intent.id,
      status: intent.status,
      amountMinor: toMinor(intent.amount),
      currency: intent.currency,
      customerId: idOf(intent.customer),
      invoiceId: null,
      created: toDate(intent.created),
      metadata: toMetadata(intent.metadata),
    }));
  }

  async listCharges(params: StripeListParams): Promise<StripePage<StripeChargeDto>> {
    const list = await this.call(() => this.stripe.charges.list(toListParams(params)));
    return toPage(list, (charge) => ({
      id: charge.id,
      status: charge.status,
      amountMinor: toMinor(charge.amount),
      amountRefundedMinor: toMinor(charge.amount_refunded),
      currency: charge.currency,
      customerId: idOf(charge.customer),
      invoiceId: null,
      paymentIntentId: idOf(charge.payment_intent),
      disputed: charge.disputed,
      created: toDate(charge.created),
      metadata: toMetadata(charge.metadata),
    }));
  }

  async listInvoices(params: StripeListParams): Promise<StripePage<StripeInvoiceDto>> {
    const list = await this.call(() => this.stripe.invoices.list(toListParams(params)));
    return toPage(list, (invoice) => ({
      // An invoice id is optional in the type because a preview has none; a
      // listed invoice always does.
      id: invoice.id ?? "",
      status: invoice.status,
      amountDueMinor: toMinor(invoice.amount_due),
      amountPaidMinor: toMinor(invoice.amount_paid),
      currency: invoice.currency,
      customerId: idOf(invoice.customer),
      // Current API versions carry the subscription under `parent`.
      subscriptionId: idOf(invoice.parent?.subscription_details?.subscription),
      attemptCount: invoice.attempt_count,
      created: toDate(invoice.created),
      paidAt: toOptionalDate(invoice.status_transitions.paid_at),
    }));
  }

  async listSubscriptions(params: StripeListParams): Promise<StripePage<StripeSubscriptionDto>> {
    const list = await this.call(() => this.stripe.subscriptions.list(toListParams(params)));
    return toPage(list, (subscription) => {
      // Billing periods moved onto items. A subscription can hold items with
      // different intervals, so the widest span is the honest summary.
      const periods = subscription.items.data;
      const starts = periods.map((item) => item.current_period_start);
      const ends = periods.map((item) => item.current_period_end);
      return {
        id: subscription.id,
        status: subscription.status,
        customerId: idOf(subscription.customer),
        currency: subscription.currency,
        created: toDate(subscription.created),
        canceledAt: toOptionalDate(subscription.canceled_at),
        currentPeriodStart: starts.length > 0 ? toDate(Math.min(...starts)) : null,
        currentPeriodEnd: ends.length > 0 ? toDate(Math.max(...ends)) : null,
      };
    });
  }

  async listRefunds(params: StripeListParams): Promise<StripePage<StripeRefundDto>> {
    const list = await this.call(() => this.stripe.refunds.list(toListParams(params)));
    return toPage(list, (refund) => ({
      id: refund.id,
      chargeId: idOf(refund.charge),
      paymentIntentId: idOf(refund.payment_intent),
      amountMinor: toMinor(refund.amount),
      currency: refund.currency,
      status: refund.status,
      created: toDate(refund.created),
    }));
  }

  async listDisputes(params: StripeListParams): Promise<StripePage<StripeDisputeDto>> {
    const list = await this.call(() => this.stripe.disputes.list(toListParams(params)));
    return toPage(list, (dispute) => ({
      id: dispute.id,
      chargeId: idOf(dispute.charge),
      paymentIntentId: idOf(dispute.payment_intent),
      amountMinor: toMinor(dispute.amount),
      currency: dispute.currency,
      status: dispute.status,
      reason: dispute.reason,
      created: toDate(dispute.created),
    }));
  }

  async listBalanceTransactions(
    params: StripeListParams,
  ): Promise<StripePage<StripeBalanceTransactionDto>> {
    const list = await this.call(() => this.stripe.balanceTransactions.list(toListParams(params)));
    return toPage(list, (transaction) => ({
      id: transaction.id,
      type: transaction.type,
      amountMinor: toMinor(transaction.amount),
      feeMinor: toMinor(transaction.fee),
      netMinor: toMinor(transaction.net),
      currency: transaction.currency,
      sourceId: idOf(transaction.source),
      created: toDate(transaction.created),
    }));
  }

  async listPayouts(params: StripeListParams): Promise<StripePage<StripePayoutDto>> {
    const list = await this.call(() => this.stripe.payouts.list(toListParams(params)));
    return toPage(list, (payout) => ({
      id: payout.id,
      amountMinor: toMinor(payout.amount),
      currency: payout.currency,
      status: payout.status,
      arrivalDate: toOptionalDate(payout.arrival_date),
      created: toDate(payout.created),
    }));
  }
}

export function createLiveStripeTransport(options: LiveTransportOptions): StripeReadTransport {
  return new LiveStripeTransport(options);
}
