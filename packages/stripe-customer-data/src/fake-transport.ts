/**
 * Deterministic in-memory `StripeReadTransport`.
 *
 * READ-ONLY CONTEXT: like every transport in this package it exposes reads only.
 *
 * Used by the default test suite, by the demo, and whenever
 * `STRIPE_CUSTOMER_TRANSPORT=fake`. The specification requires the default test
 * suite to be reproducible without production secrets, so the properties that
 * matter — pagination, checkpoint safety, retry, idempotency — must be provable
 * against a controlled adapter rather than a live Stripe account.
 *
 * There is no randomness anywhere in this file. The same seed always yields the
 * same ids, amounts and timestamps, so a failing test is reproducible from its
 * inputs alone.
 */
import { StripeSyncError, type StripeErrorCategory } from "./errors";
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
  type SyncResource,
} from "./transport";

export interface FakeStripeData {
  customers: StripeCustomerDto[];
  paymentIntents: StripePaymentIntentDto[];
  charges: StripeChargeDto[];
  invoices: StripeInvoiceDto[];
  subscriptions: StripeSubscriptionDto[];
  refunds: StripeRefundDto[];
  disputes: StripeDisputeDto[];
  balanceTransactions: StripeBalanceTransactionDto[];
  payouts: StripePayoutDto[];
}

/** Failures are targeted at a resource, or at account retrieval. */
export type FakeFailureTarget = SyncResource | "account";

export interface FakeFailure {
  target: FakeFailureTarget;
  /** 1-based page number to fail on. Ignored for "account". */
  page?: number;
  /** Category the thrown `StripeSyncError` reports. */
  category?: StripeErrorCategory;
  /** Throw this instead, to exercise `classifyStripeError` on a raw shape. */
  throws?: () => unknown;
  /**
   * How many times the failure fires before the page starts succeeding.
   * Defaults to always, which models a resource that stays broken.
   */
  times?: number;
}

export interface FakeTransportOptions {
  account?: Partial<StripeAccountDto>;
  data?: Partial<FakeStripeData>;
  /** Items returned per page. Small values make paging easy to exercise. */
  pageSize?: number;
  failures?: readonly FakeFailure[];
}

/** One observed request. Lets a test assert what was actually asked for. */
export interface FakeRequest {
  target: FakeFailureTarget;
  startingAfter: string | null;
  createdGte: Date | null;
  limit: number;
  /** 1-based page number within the current sweep. */
  page: number;
}

const EMPTY_DATA: FakeStripeData = {
  customers: [],
  paymentIntents: [],
  charges: [],
  invoices: [],
  subscriptions: [],
  refunds: [],
  disputes: [],
  balanceTransactions: [],
  payouts: [],
};

interface Identified {
  id: string;
  created: Date;
}

export class FakeStripeTransport implements StripeReadTransport {
  private readonly data: FakeStripeData;
  private readonly account: StripeAccountDto;
  private readonly pageSize: number;
  private failures: FakeFailure[];
  private readonly firedFailures = new Map<FakeFailure, number>();
  private readonly requests: FakeRequest[] = [];

  constructor(options: FakeTransportOptions = {}) {
    this.data = { ...EMPTY_DATA, ...options.data };
    this.account = {
      id: options.account?.id ?? "acct_fake000000000001",
      displayName: options.account?.displayName ?? "Fake Test Account",
      livemode: options.account?.livemode ?? false,
    };
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.failures = [...(options.failures ?? [])];
  }

  /** Replace the fixture data. Returns `this` so seeding can be chained. */
  seed(data: Partial<FakeStripeData>): this {
    Object.assign(this.data, data);
    return this;
  }

  /** Arrange a failure. Later calls add to, rather than replace, existing ones. */
  failAt(failure: FakeFailure): this {
    this.failures.push(failure);
    return this;
  }

  /** Heal every arranged failure, so the next sweep can complete. */
  clearFailures(): this {
    this.failures = [];
    this.firedFailures.clear();
    return this;
  }

  /** Every request the transport received, in order. */
  requestLog(): FakeRequest[] {
    return this.requests.map((request) => ({ ...request }));
  }

  /** Requests observed for one target. Used to assert real retry attempts. */
  requestsFor(target: FakeFailureTarget): FakeRequest[] {
    return this.requestLog().filter((request) => request.target === target);
  }

  resetRequestLog(): this {
    this.requests.length = 0;
    return this;
  }

  async retrieveAccount(): Promise<StripeAccountDto> {
    this.record("account", { limit: 1 }, 1);
    this.maybeFail("account", 1);
    return { ...this.account };
  }

  listCustomers(params: StripeListParams): Promise<StripePage<StripeCustomerDto>> {
    return this.page("customers", this.data.customers, params);
  }

  listPaymentIntents(params: StripeListParams): Promise<StripePage<StripePaymentIntentDto>> {
    return this.page("payment_intents", this.data.paymentIntents, params);
  }

  listCharges(params: StripeListParams): Promise<StripePage<StripeChargeDto>> {
    return this.page("charges", this.data.charges, params);
  }

  listInvoices(params: StripeListParams): Promise<StripePage<StripeInvoiceDto>> {
    return this.page("invoices", this.data.invoices, params);
  }

  listSubscriptions(params: StripeListParams): Promise<StripePage<StripeSubscriptionDto>> {
    return this.page("subscriptions", this.data.subscriptions, params);
  }

  listRefunds(params: StripeListParams): Promise<StripePage<StripeRefundDto>> {
    return this.page("refunds", this.data.refunds, params);
  }

  listDisputes(params: StripeListParams): Promise<StripePage<StripeDisputeDto>> {
    return this.page("disputes", this.data.disputes, params);
  }

  listBalanceTransactions(
    params: StripeListParams,
  ): Promise<StripePage<StripeBalanceTransactionDto>> {
    return this.page("balance_transactions", this.data.balanceTransactions, params);
  }

  listPayouts(params: StripeListParams): Promise<StripePage<StripePayoutDto>> {
    return this.page("payouts", this.data.payouts, params);
  }

  /**
   * Page a fixture list the way Stripe pages a real one: newest first, with
   * `starting_after` naming the last id of the previous page. Ordering is fully
   * determined by (created desc, id desc) so it never depends on insertion order.
   */
  private async page<T extends Identified>(
    resource: SyncResource,
    source: readonly T[],
    params: StripeListParams,
  ): Promise<StripePage<T>> {
    const limit = Math.max(1, params.limit || this.pageSize);

    const ordered = [...source]
      .filter((item) => !params.createdGte || item.created.getTime() >= params.createdGte.getTime())
      .sort((a, b) => {
        const byCreated = b.created.getTime() - a.created.getTime();
        return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
      });

    let offset = 0;
    if (params.startingAfter) {
      const index = ordered.findIndex((item) => item.id === params.startingAfter);
      // An unknown cursor is treated as "start over": the referenced object may
      // legitimately have fallen outside the window since the last sweep.
      offset = index >= 0 ? index + 1 : 0;
    }

    const pageNumber = Math.floor(offset / limit) + 1;
    this.record(resource, params, pageNumber);
    this.maybeFail(resource, pageNumber);

    const slice = ordered.slice(offset, offset + limit);
    const last = slice.at(-1);
    return {
      data: slice.map((item) => ({ ...item })),
      hasMore: offset + slice.length < ordered.length,
      lastId: last ? last.id : null,
    };
  }

  private record(target: FakeFailureTarget, params: Partial<StripeListParams>, page: number): void {
    this.requests.push({
      target,
      startingAfter: params.startingAfter ?? null,
      createdGte: params.createdGte ?? null,
      limit: params.limit ?? this.pageSize,
      page,
    });
  }

  private maybeFail(target: FakeFailureTarget, page: number): void {
    for (const failure of this.failures) {
      if (failure.target !== target) continue;
      if (target !== "account" && (failure.page ?? 1) !== page) continue;

      const alreadyFired = this.firedFailures.get(failure) ?? 0;
      if (failure.times !== undefined && alreadyFired >= failure.times) continue;
      this.firedFailures.set(failure, alreadyFired + 1);

      if (failure.throws) throw failure.throws();
      const category = failure.category ?? "transient";
      throw new StripeSyncError(
        category,
        `Simulated ${category} failure on ${target} page ${page}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Fixture generation
// ---------------------------------------------------------------------------

/** Fixed epoch so generated timestamps never depend on the wall clock. */
export const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

export interface FixtureSpec {
  customers?: number;
  paymentIntents?: number;
  charges?: number;
  invoices?: number;
  subscriptions?: number;
  refunds?: number;
  disputes?: number;
  balanceTransactions?: number;
  payouts?: number;
  /** Currencies cycled across generated objects. Lower-case, as Stripe returns. */
  currencies?: readonly string[];
  epoch?: Date;
}

const PAYMENT_INTENT_STATUSES = [
  "succeeded",
  "processing",
  "requires_payment_method",
  "canceled",
] as const;
const CHARGE_STATUSES = ["succeeded", "pending", "failed"] as const;
const INVOICE_STATUSES = ["paid", "open", "draft", "uncollectible", "void"] as const;
const SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "canceled"] as const;
const REFUND_STATUSES = ["succeeded", "pending", "failed", "canceled"] as const;

function pick<T>(values: readonly T[], index: number): T {
  // Guaranteed in range; the non-null assertion is avoided by a modulo lookup.
  const value = values[index % values.length];
  if (value === undefined) throw new Error("Fixture value list must not be empty");
  return value;
}

function id(prefix: string, index: number): string {
  return `${prefix}_fake${index.toString().padStart(8, "0")}`;
}

function createdAt(epoch: Date, index: number): Date {
  // One hour apart, ascending, so ordering is unambiguous.
  return new Date(epoch.getTime() + index * 3_600_000);
}

/**
 * Build a deterministic fixture set.
 *
 * Amounts derive from the index rather than a random source, and are chosen to
 * be distinct so an off-by-one in paging or upserting shows up as a wrong value
 * rather than a coincidentally correct one.
 */
export function buildFakeStripeData(spec: FixtureSpec = {}): FakeStripeData {
  const epoch = spec.epoch ?? FIXTURE_EPOCH;
  const currencies = spec.currencies ?? ["usd", "eur"];

  const customers: StripeCustomerDto[] = [];
  for (let i = 0; i < (spec.customers ?? 0); i += 1) {
    customers.push({
      id: id("cus", i),
      email: `customer${i}@example.test`,
      name: `Customer ${i}`,
      created: createdAt(epoch, i),
    });
  }

  const paymentIntents: StripePaymentIntentDto[] = [];
  for (let i = 0; i < (spec.paymentIntents ?? 0); i += 1) {
    paymentIntents.push({
      id: id("pi", i),
      status: pick(PAYMENT_INTENT_STATUSES, i),
      amountMinor: BigInt(1_000 + i * 137),
      currency: pick(currencies, i),
      customerId: customers.length > 0 ? pick(customers, i).id : null,
      invoiceId: null,
      created: createdAt(epoch, i),
      metadata: { order_id: `order-${i}` },
    });
  }

  const charges: StripeChargeDto[] = [];
  for (let i = 0; i < (spec.charges ?? 0); i += 1) {
    charges.push({
      id: id("ch", i),
      status: pick(CHARGE_STATUSES, i),
      amountMinor: BigInt(2_000 + i * 211),
      amountRefundedMinor: i % 5 === 0 ? BigInt(500) : 0n,
      currency: pick(currencies, i),
      customerId: customers.length > 0 ? pick(customers, i).id : null,
      invoiceId: null,
      paymentIntentId: paymentIntents.length > 0 ? pick(paymentIntents, i).id : null,
      disputed: i % 7 === 0,
      created: createdAt(epoch, i),
      metadata: { order_id: `order-${i}` },
    });
  }

  const subscriptions: StripeSubscriptionDto[] = [];
  for (let i = 0; i < (spec.subscriptions ?? 0); i += 1) {
    const created = createdAt(epoch, i);
    const status = pick(SUBSCRIPTION_STATUSES, i);
    subscriptions.push({
      id: id("sub", i),
      status,
      customerId: customers.length > 0 ? pick(customers, i).id : null,
      currency: pick(currencies, i),
      created,
      canceledAt: status === "canceled" ? new Date(created.getTime() + 86_400_000) : null,
      currentPeriodStart: created,
      currentPeriodEnd: new Date(created.getTime() + 30 * 86_400_000),
    });
  }

  const invoices: StripeInvoiceDto[] = [];
  for (let i = 0; i < (spec.invoices ?? 0); i += 1) {
    const status = pick(INVOICE_STATUSES, i);
    const created = createdAt(epoch, i);
    invoices.push({
      id: id("in", i),
      status,
      amountDueMinor: BigInt(3_000 + i * 173),
      amountPaidMinor: status === "paid" ? BigInt(3_000 + i * 173) : 0n,
      currency: pick(currencies, i),
      customerId: customers.length > 0 ? pick(customers, i).id : null,
      subscriptionId: subscriptions.length > 0 ? pick(subscriptions, i).id : null,
      attemptCount: i % 3,
      created,
      paidAt: status === "paid" ? new Date(created.getTime() + 60_000) : null,
    });
  }

  const refunds: StripeRefundDto[] = [];
  for (let i = 0; i < (spec.refunds ?? 0); i += 1) {
    const charge = charges.length > 0 ? pick(charges, i) : null;
    refunds.push({
      id: id("re", i),
      chargeId: charge?.id ?? null,
      paymentIntentId: charge?.paymentIntentId ?? null,
      amountMinor: BigInt(500 + i * 13),
      currency: charge?.currency ?? pick(currencies, i),
      status: pick(REFUND_STATUSES, i),
      created: createdAt(epoch, i),
    });
  }

  const disputes: StripeDisputeDto[] = [];
  for (let i = 0; i < (spec.disputes ?? 0); i += 1) {
    const charge = charges.length > 0 ? pick(charges, i) : null;
    disputes.push({
      id: id("dp", i),
      chargeId: charge?.id ?? null,
      paymentIntentId: charge?.paymentIntentId ?? null,
      amountMinor: BigInt(1_500 + i * 29),
      currency: charge?.currency ?? pick(currencies, i),
      status: "needs_response",
      reason: "fraudulent",
      created: createdAt(epoch, i),
    });
  }

  const balanceTransactions: StripeBalanceTransactionDto[] = [];
  for (let i = 0; i < (spec.balanceTransactions ?? 0); i += 1) {
    const amount = BigInt(2_000 + i * 211);
    const fee = BigInt(59 + i);
    balanceTransactions.push({
      id: id("txn", i),
      type: "charge",
      amountMinor: amount,
      feeMinor: fee,
      netMinor: amount - fee,
      currency: pick(currencies, i),
      sourceId: charges.length > 0 ? pick(charges, i).id : null,
      created: createdAt(epoch, i),
    });
  }

  const payouts: StripePayoutDto[] = [];
  for (let i = 0; i < (spec.payouts ?? 0); i += 1) {
    const created = createdAt(epoch, i);
    payouts.push({
      id: id("po", i),
      amountMinor: BigInt(50_000 + i * 1_009),
      currency: pick(currencies, i),
      status: "paid",
      arrivalDate: new Date(created.getTime() + 2 * 86_400_000),
      created,
    });
  }

  return {
    customers,
    paymentIntents,
    charges,
    invoices,
    subscriptions,
    refunds,
    disputes,
    balanceTransactions,
    payouts,
  };
}

/** Convenience factory used by tests, the demo, and STRIPE_CUSTOMER_TRANSPORT=fake. */
export function createFakeStripeTransport(options: FakeTransportOptions = {}): FakeStripeTransport {
  return new FakeStripeTransport(options);
}
