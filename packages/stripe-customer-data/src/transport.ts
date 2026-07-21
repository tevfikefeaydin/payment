/**
 * The READ-ONLY Stripe transport contract.
 *
 * HARD CONSTRAINT: this interface exposes list and retrieve operations only.
 * There is deliberately no create, update, delete, capture, refund or replay
 * method, so no implementation — and no caller — can perform a Stripe write.
 * Widening this interface with a mutating method would be a specification
 * violation, not a feature.
 *
 * The DTOs below are the *minimised* shape PayRecon is willing to hold. They
 * carry no card details, no payment-method fingerprints, no billing or shipping
 * addresses, no phone numbers and no raw Stripe payloads. Data that is never
 * fetched into a DTO cannot leak from a log, an export, or a database dump.
 *
 * Amounts are already `bigint` minor units and currencies are already uppercase
 * at this boundary: normalising in the transport means every downstream
 * consumer, including the fake used by tests, is exercised against the same
 * representation.
 */
import type { syncResourceEnum } from "@payrecon/db/schema";

export type SyncResource = (typeof syncResourceEnum.enumValues)[number];

/**
 * Order in which resources are swept.
 *
 * Refunds and disputes come before payments on purpose: a payment intent has no
 * refunded-amount field of its own, so `amountRefundedMinor` and `disputed` are
 * derived from the refunds and disputes observed earlier in the same run.
 * Customers lead so that evidence rendered for a payment can name its customer.
 */
export const SYNC_RESOURCE_ORDER: readonly SyncResource[] = [
  "customers",
  "refunds",
  "disputes",
  "payment_intents",
  "charges",
  "invoices",
  "subscriptions",
  "balance_transactions",
  "payouts",
] as const;

/** Stripe's own ceiling on `limit`. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 100;

export interface StripeListParams {
  /** Stripe object id to page after. Absent for the first page of a sweep. */
  startingAfter?: string;
  /** Lower bound on `created`, used by incremental syncs. */
  createdGte?: Date;
  limit: number;
}

export interface StripePage<T> {
  data: T[];
  hasMore: boolean;
  /** Cursor for the next page: the id of the last item, or null when empty. */
  lastId: string | null;
}

// ---------------------------------------------------------------------------
// Minimised DTOs
// ---------------------------------------------------------------------------

/**
 * Account identity. `livemode` is derived from the key prefix rather than the
 * account object, because Stripe accounts are not themselves live or test — the
 * credential is.
 */
export interface StripeAccountDto {
  id: string;
  /** Dashboard display name or business name. Operator recognition only. */
  displayName: string | null;
  livemode: boolean;
}

export interface StripeCustomerDto {
  id: string;
  email: string | null;
  name: string | null;
  created: Date;
}

export interface StripePaymentIntentDto {
  id: string;
  status: string;
  amountMinor: bigint;
  currency: string;
  customerId: string | null;
  invoiceId: string | null;
  created: Date;
  metadata: Record<string, string>;
}

export interface StripeChargeDto {
  id: string;
  status: string;
  amountMinor: bigint;
  amountRefundedMinor: bigint;
  currency: string;
  customerId: string | null;
  invoiceId: string | null;
  paymentIntentId: string | null;
  disputed: boolean;
  created: Date;
  metadata: Record<string, string>;
}

export interface StripeInvoiceDto {
  id: string;
  status: string | null;
  amountDueMinor: bigint;
  amountPaidMinor: bigint;
  currency: string;
  customerId: string | null;
  subscriptionId: string | null;
  attemptCount: number;
  created: Date;
  paidAt: Date | null;
}

export interface StripeSubscriptionDto {
  id: string;
  status: string;
  customerId: string | null;
  currency: string;
  created: Date;
  canceledAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

export interface StripeRefundDto {
  id: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  amountMinor: bigint;
  currency: string;
  status: string | null;
  created: Date;
}

export interface StripeDisputeDto {
  id: string;
  chargeId: string | null;
  paymentIntentId: string | null;
  amountMinor: bigint;
  currency: string;
  status: string;
  reason: string | null;
  created: Date;
}

export interface StripeBalanceTransactionDto {
  id: string;
  type: string;
  amountMinor: bigint;
  feeMinor: bigint;
  netMinor: bigint;
  currency: string;
  /** Stripe id of the object that produced this entry, e.g. a charge. */
  sourceId: string | null;
  created: Date;
}

export interface StripePayoutDto {
  id: string;
  amountMinor: bigint;
  currency: string;
  status: string;
  arrivalDate: Date | null;
  created: Date;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/**
 * Read-only access to one customer's Stripe account.
 *
 * Implementations must throw `StripeSyncError` (see errors.ts) so the sync loop
 * can decide about retries from the category alone.
 */
export interface StripeReadTransport {
  listCustomers(params: StripeListParams): Promise<StripePage<StripeCustomerDto>>;
  listPaymentIntents(params: StripeListParams): Promise<StripePage<StripePaymentIntentDto>>;
  listCharges(params: StripeListParams): Promise<StripePage<StripeChargeDto>>;
  listInvoices(params: StripeListParams): Promise<StripePage<StripeInvoiceDto>>;
  listSubscriptions(params: StripeListParams): Promise<StripePage<StripeSubscriptionDto>>;
  listRefunds(params: StripeListParams): Promise<StripePage<StripeRefundDto>>;
  listDisputes(params: StripeListParams): Promise<StripePage<StripeDisputeDto>>;
  listBalanceTransactions(
    params: StripeListParams,
  ): Promise<StripePage<StripeBalanceTransactionDto>>;
  listPayouts(params: StripeListParams): Promise<StripePage<StripePayoutDto>>;
  retrieveAccount(): Promise<StripeAccountDto>;
}

/** DTO produced by each resource, so the sync loop can stay generic. */
export interface StripeDtoByResource {
  customers: StripeCustomerDto;
  payment_intents: StripePaymentIntentDto;
  charges: StripeChargeDto;
  invoices: StripeInvoiceDto;
  subscriptions: StripeSubscriptionDto;
  refunds: StripeRefundDto;
  disputes: StripeDisputeDto;
  balance_transactions: StripeBalanceTransactionDto;
  payouts: StripePayoutDto;
}

/**
 * Dispatch one resource to its list method.
 *
 * A single lookup keeps the sync loop from repeating a nine-arm switch for every
 * concern (paging, retry, checkpointing, probing).
 */
export function listResource<R extends SyncResource>(
  transport: StripeReadTransport,
  resource: R,
  params: StripeListParams,
): Promise<StripePage<StripeDtoByResource[R]>> {
  // Switching on the widened value lets TypeScript narrow (and keeps the
  // exhaustiveness check working); the casts then re-tie each arm to `R`, which
  // TypeScript cannot relate to the arm it selected on its own.
  const target: SyncResource = resource;
  switch (target) {
    case "customers":
      return transport.listCustomers(params) as Promise<StripePage<StripeDtoByResource[R]>>;
    case "payment_intents":
      return transport.listPaymentIntents(params) as Promise<StripePage<StripeDtoByResource[R]>>;
    case "charges":
      return transport.listCharges(params) as Promise<StripePage<StripeDtoByResource[R]>>;
    case "invoices":
      return transport.listInvoices(params) as Promise<StripePage<StripeDtoByResource[R]>>;
    case "subscriptions":
      return transport.listSubscriptions(params) as Promise<StripePage<StripeDtoByResource[R]>>;
    case "refunds":
      return transport.listRefunds(params) as Promise<StripePage<StripeDtoByResource[R]>>;
    case "disputes":
      return transport.listDisputes(params) as Promise<StripePage<StripeDtoByResource[R]>>;
    case "balance_transactions":
      return transport.listBalanceTransactions(params) as Promise<
        StripePage<StripeDtoByResource[R]>
      >;
    case "payouts":
      return transport.listPayouts(params) as Promise<StripePage<StripeDtoByResource[R]>>;
    default: {
      // Exhaustiveness: adding a resource to the enum breaks the build here.
      const unreachable: never = target;
      throw new Error(`Unsupported sync resource: ${String(unreachable)}`);
    }
  }
}
