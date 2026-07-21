/**
 * Canonical domain types shared by the reconciliation engine, ingestion paths
 * and the exception inbox.
 *
 * These types are deliberately provider-neutral: the Stripe sync normalises
 * into them, and CSV/API ingestion normalises into them, so the engine has one
 * shape to reason about and one set of fixtures to test against.
 */

// ---------------------------------------------------------------------------
// Internal (customer application) records
// ---------------------------------------------------------------------------

export const INTERNAL_PAYMENT_STATUSES = [
  "pending",
  "paid",
  "failed",
  "refunded",
  "partially_refunded",
] as const;

export type InternalPaymentStatus = (typeof INTERNAL_PAYMENT_STATUSES)[number];

export function isInternalPaymentStatus(value: string): value is InternalPaymentStatus {
  return (INTERNAL_PAYMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * The canonical internal payment record as accepted at the ingestion boundary.
 * Amounts arrive as strings and are converted to bigint minor units before use.
 */
export interface InternalPaymentRecordInput {
  externalId: string;
  customerId?: string;
  orderId?: string;
  subscriptionId?: string;
  providerTransactionId?: string;
  amountMinor: string;
  currency: string;
  status: InternalPaymentStatus;
  occurredAt: string;
  updatedAt?: string;
  metadata?: Record<string, string>;
}

/** The normalised, in-engine representation of an internal payment record. */
export interface InternalPaymentRecord {
  id: string;
  organizationId: string;
  externalId: string;
  customerId: string | null;
  orderId: string | null;
  subscriptionId: string | null;
  providerTransactionId: string | null;
  amountMinor: bigint;
  currency: string;
  status: InternalPaymentStatus;
  occurredAt: Date;
  recordUpdatedAt: Date | null;
  metadata: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Provider (Stripe) records, minimised to what matching and evidence require
// ---------------------------------------------------------------------------

export const PROVIDER_PAYMENT_STATUSES = [
  "succeeded",
  "processing",
  "requires_action",
  "requires_payment_method",
  "canceled",
  "failed",
] as const;

export type ProviderPaymentStatus = (typeof PROVIDER_PAYMENT_STATUSES)[number];

export interface ProviderPayment {
  /** Stripe object id, e.g. `pi_...` or `ch_...`. */
  id: string;
  organizationId: string;
  connectionId: string;
  /** Which Stripe resource this was normalised from. */
  kind: "payment_intent" | "charge";
  status: ProviderPaymentStatus;
  amountMinor: bigint;
  currency: string;
  /** Total amount refunded against this payment, in the same currency. */
  amountRefundedMinor: bigint;
  createdAt: Date;
  customerId: string | null;
  invoiceId: string | null;
  /** Present when a charge was created by a payment intent. */
  paymentIntentId: string | null;
  /** True when a dispute exists against this payment. */
  disputed: boolean;
  /**
   * Bounded, non-sensitive subset of Stripe metadata. Used to find an
   * application-supplied correlation id when one exists.
   */
  metadata: Record<string, string>;
}

export const PROVIDER_REFUND_STATUSES = ["succeeded", "pending", "failed", "canceled"] as const;
export type ProviderRefundStatus = (typeof PROVIDER_REFUND_STATUSES)[number];

export interface ProviderRefund {
  id: string;
  organizationId: string;
  connectionId: string;
  paymentId: string | null;
  amountMinor: bigint;
  currency: string;
  status: ProviderRefundStatus;
  createdAt: Date;
}

export const PROVIDER_INVOICE_STATUSES = [
  "draft",
  "open",
  "paid",
  "uncollectible",
  "void",
] as const;
export type ProviderInvoiceStatus = (typeof PROVIDER_INVOICE_STATUSES)[number];

export interface ProviderInvoice {
  id: string;
  organizationId: string;
  connectionId: string;
  status: ProviderInvoiceStatus;
  amountDueMinor: bigint;
  amountPaidMinor: bigint;
  currency: string;
  customerId: string | null;
  subscriptionId: string | null;
  createdAt: Date;
  /** Set when Stripe reports the invoice as fully paid. */
  paidAt: Date | null;
  /** Number of failed payment attempts reported by Stripe. */
  attemptCount: number;
}

export const PROVIDER_SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "paused",
] as const;
export type ProviderSubscriptionStatus = (typeof PROVIDER_SUBSCRIPTION_STATUSES)[number];

/** Subscription states that should be able to bill successfully. */
export const ACTIVE_SUBSCRIPTION_STATUSES: ReadonlySet<ProviderSubscriptionStatus> = new Set([
  "trialing",
  "active",
]);

export interface ProviderSubscription {
  id: string;
  organizationId: string;
  connectionId: string;
  status: ProviderSubscriptionStatus;
  customerId: string | null;
  currency: string;
  createdAt: Date;
  canceledAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export const EXCEPTION_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITIES)[number];

/** Ordering used for "most severe first" sorting. */
export const SEVERITY_RANK: Record<ExceptionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export const EXCEPTION_STATES = ["open", "acknowledged", "resolved", "reopened"] as const;
export type ExceptionState = (typeof EXCEPTION_STATES)[number];

/** States in which an exception still demands operator attention. */
export const ACTIVE_EXCEPTION_STATES: ReadonlySet<ExceptionState> = new Set([
  "open",
  "acknowledged",
  "reopened",
]);

export function isActiveExceptionState(state: ExceptionState): boolean {
  return ACTIVE_EXCEPTION_STATES.has(state);
}

/** A single piece of evidence rendered on the exception detail page. */
export interface EvidenceField {
  label: string;
  /** Value from the payment provider, already redacted/safe for display. */
  providerValue: string | null;
  /** Value from the customer's internal system. */
  internalValue: string | null;
  /** True when the two sides disagree and should be visually highlighted. */
  differs: boolean;
}

/** A candidate exception produced by a rule, before persistence. */
export interface ExceptionCandidate {
  ruleId: ReconciliationRuleId;
  ruleVersion: number;
  /** Stable across runs for the same underlying problem. */
  fingerprint: string;
  severity: ExceptionSeverity;
  /** Plain-language description of the problem, safe to render. */
  summary: string;
  /** Exact revenue at risk. `null` when the rule implies no direct exposure. */
  revenueAtRiskMinor: bigint | null;
  currency: string | null;
  providerObjectId: string | null;
  internalRecordId: string | null;
  internalExternalId: string | null;
  evidence: EvidenceField[];
  probableCauses: string[];
  recommendedActions: string[];
  /** When the underlying event occurred, used for freshness display. */
  occurredAt: Date | null;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const RECONCILIATION_RULE_IDS = [
  "PAYMENT_SUCCEEDED_INTERNAL_MISSING",
  "PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID",
  "INTERNAL_PAID_PROVIDER_MISSING",
  "PAYMENT_AMOUNT_MISMATCH",
  "PAYMENT_CURRENCY_MISMATCH",
  "DUPLICATE_SUCCEEDED_PAYMENT",
  "REFUND_STATUS_MISMATCH",
  "PAID_INVOICE_INACTIVE_SUBSCRIPTION",
  "FAILED_INVOICE_ACTIVE_SUBSCRIPTION",
  "STALE_INTERNAL_PENDING_PAYMENT",
] as const;

export type ReconciliationRuleId = (typeof RECONCILIATION_RULE_IDS)[number];

export function isReconciliationRuleId(value: string): value is ReconciliationRuleId {
  return (RECONCILIATION_RULE_IDS as readonly string[]).includes(value);
}

/** Tunable thresholds. Defaults are conservative to avoid false positives. */
export interface ReconciliationConfig {
  /**
   * A provider payment younger than this is not reported as "internal missing",
   * because the customer's system may legitimately not have processed the
   * webhook yet. Prevents a burst of false positives during normal operation.
   */
  internalPropagationGraceMinutes: number;
  /** Internal `pending` older than this is considered stale. */
  stalePendingHours: number;
  /**
   * Window used when falling back to heuristic matching. Only applied when the
   * match is otherwise unambiguous on both sides.
   */
  heuristicMatchWindowHours: number;
  /**
   * Two successful provider payments for the same customer, amount and currency
   * within this window are treated as a potential duplicate charge.
   */
  duplicateWindowMinutes: number;
  /**
   * Grace period before a provider refund that is not reflected internally is
   * reported.
   */
  refundPropagationGraceMinutes: number;
}

export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  internalPropagationGraceMinutes: 30,
  stalePendingHours: 48,
  heuristicMatchWindowHours: 72,
  duplicateWindowMinutes: 60,
  refundPropagationGraceMinutes: 60,
};

/** Everything a reconciliation run needs, already scoped to one organization. */
export interface ReconciliationInput {
  organizationId: string;
  /** Evaluation time. Injected so runs are deterministic and testable. */
  now: Date;
  providerPayments: ProviderPayment[];
  providerRefunds: ProviderRefund[];
  providerInvoices: ProviderInvoice[];
  providerSubscriptions: ProviderSubscription[];
  internalRecords: InternalPaymentRecord[];
  config: ReconciliationConfig;
}

/**
 * Counters describing data-quality problems that deliberately did NOT become
 * exceptions. Surfacing these separately satisfies the requirement to report
 * ambiguous data rather than emit confident false positives.
 */
export interface ReconciliationDiagnostics {
  /** Provider payments that matched more than one internal record. */
  ambiguousProviderMatches: number;
  /** Internal records that matched more than one provider payment. */
  ambiguousInternalMatches: number;
  /** Provider payments skipped because they fall inside the grace window. */
  withinPropagationGrace: number;
  /** Records whose currency could not be validated. */
  invalidCurrencyRecords: number;
}

export interface ReconciliationResult {
  ruleVersion: number;
  candidates: ExceptionCandidate[];
  diagnostics: ReconciliationDiagnostics;
  /** Per-rule counts, used for the run summary. */
  countsByRule: Record<string, number>;
}
