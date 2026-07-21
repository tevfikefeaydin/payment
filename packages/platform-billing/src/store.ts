/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * This port exposes ONLY the platform-billing tables (billing_customers,
 * billing_subscriptions, billing_webhook_events) plus the tenant-owned tables
 * needed to enforce plan limits. It deliberately offers NO operation that can
 * read or write the customer-data integration's tables or any provider_*
 * table, so the isolation is a property of the type, not of reviewer memory.
 * See docs/adr/0007-stripe-context-separation.md.
 *
 * ---
 *
 * The persistence port for platform billing.
 *
 * Why a port rather than passing Drizzle around: the guarantees that matter in
 * this package — webhook idempotency, out-of-order tolerance, non-destructive
 * limit enforcement — must be provable by the DEFAULT test suite, which is
 * required to run with no external services and no production secrets. A narrow
 * interface lets those properties be exercised against an in-memory
 * implementation that enforces the same constraints the database does, while
 * production runs the real statements in store-drizzle.ts.
 *
 * TENANT SCOPING: every tenant-owned operation takes `organizationId` as a
 * required argument rather than an optional filter, so an unscoped read or
 * write is not expressible through this API. The two exceptions are lookups
 * BY a Stripe identifier (customer id, event id), which are how the
 * organization is discovered in the first place; both are unique columns.
 */
import type { AuditAction, AuditActor, Database } from "@payrecon/db";
import type {
  billingSubscriptionStatusEnum,
  webhookProcessingStatusEnum,
} from "@payrecon/db/schema";
import type { PlanKey } from "@payrecon/config";
import { createDrizzleBillingStore } from "./store-drizzle";

export type BillingSubscriptionStatus = (typeof billingSubscriptionStatusEnum.enumValues)[number];
export type WebhookProcessingStatus = (typeof webhookProcessingStatusEnum.enumValues)[number];

/**
 * The `usage_counters.metric` row key for ingestion volume.
 *
 * MUST stay identical to `USAGE_METRIC_INGESTED_RECORDS` in @payrecon/ingestion,
 * which is what writes the counter. It is duplicated rather than imported
 * because platform billing does not depend on the ingestion package — a
 * dependency purely to share one string would couple the billing context to the
 * data-ingestion context for no benefit. If the two ever diverge, limit checks
 * silently read a counter nobody increments, so the value is asserted in a test.
 */
export const USAGE_METRIC_INGESTED_RECORDS = "ingested_records";

/** UTC `YYYY-MM` key, matching the format `usage_counters` stores and checks. */
export function usagePeriodKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface OrganizationRecord {
  id: string;
  name: string;
  planKey: PlanKey;
}

export interface BillingCustomerRecord {
  id: string;
  organizationId: string;
  /** Customer id in PAYRECON's Stripe account. Never a customer's own id. */
  stripeCustomerId: string;
  createdAt: Date;
}

export interface BillingSubscriptionRecord {
  id: string;
  organizationId: string;
  stripeSubscriptionId: string;
  status: BillingSubscriptionStatus;
  /** Always resolved server-side from the price id. */
  planKey: PlanKey;
  stripePriceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  canceledAt: Date | null;
  /** Stripe `created` of the newest event applied to this row. */
  lastEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A subscription write.
 *
 * `organizationId` and `stripeSubscriptionId` identify the row; everything
 * else is the state the event carried. Optional fields are omitted rather than
 * nulled when an event does not mention them, so a partial event cannot erase
 * state a fuller one established.
 */
export interface UpsertSubscriptionInput {
  organizationId: string;
  stripeSubscriptionId: string;
  status: BillingSubscriptionStatus;
  planKey: PlanKey;
  stripePriceId?: string | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  trialEndsAt?: Date | null;
  canceledAt?: Date | null;
  lastEventAt: Date;
  now: Date;
}

export interface WebhookEventRecord {
  stripeEventId: string;
  type: string;
  organizationId: string | null;
  status: WebhookProcessingStatus;
  eventCreatedAt: Date | null;
  processedAt: Date | null;
  errorMessage: string | null;
}

export interface InsertWebhookEventInput {
  stripeEventId: string;
  type: string;
  organizationId: string | null;
  eventCreatedAt: Date;
}

/**
 * Result of claiming a webhook event.
 *
 * `created: false` with an `existing` row is the idempotency signal: Stripe
 * redelivers, and the unique index on `stripe_event_id` is what makes the
 * second delivery observable rather than silently reapplied.
 */
export interface ClaimWebhookEventResult {
  created: boolean;
  existing: WebhookEventRecord | null;
}

export interface WebhookEventPatch {
  status: WebhookProcessingStatus;
  organizationId?: string | null;
  processedAt?: Date | null;
  /** Already sanitised by the caller. Never raw Stripe text. */
  errorMessage?: string | null;
}

export interface BillingAuditInput {
  organizationId: string;
  actor: AuditActor;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/**
 * Persistence operations required by platform billing, and no others.
 *
 * `storeKind` is a discriminator: it lets `resolveBillingStore` accept either a
 * Drizzle `Database` or an already-built store without ambiguity, so the public
 * service functions keep their `(db, input)` shape.
 */
export interface BillingStore {
  readonly storeKind: "platform-billing-store";

  // --- organization ---
  findOrganization(organizationId: string): Promise<OrganizationRecord | null>;
  /** Returns false when the organization does not exist. */
  updateOrganizationPlan(organizationId: string, planKey: PlanKey): Promise<boolean>;

  // --- billing customer (PayRecon's Stripe account) ---
  findBillingCustomerByOrganization(organizationId: string): Promise<BillingCustomerRecord | null>;
  findBillingCustomerByStripeId(stripeCustomerId: string): Promise<BillingCustomerRecord | null>;
  /**
   * Insert only if the organization has no billing customer yet, and return the
   * surviving row either way. Two concurrent checkout clicks must not create
   * two Stripe customers for one organization.
   */
  insertBillingCustomerIfAbsent(input: {
    organizationId: string;
    stripeCustomerId: string;
    now: Date;
  }): Promise<BillingCustomerRecord>;

  // --- subscription ---
  findSubscriptionByOrganization(organizationId: string): Promise<BillingSubscriptionRecord | null>;
  upsertSubscription(input: UpsertSubscriptionInput): Promise<BillingSubscriptionRecord>;

  // --- webhook receipts ---
  claimWebhookEvent(input: InsertWebhookEventInput): Promise<ClaimWebhookEventResult>;
  markWebhookEvent(stripeEventId: string, patch: WebhookEventPatch): Promise<void>;
  findWebhookEvent(stripeEventId: string): Promise<WebhookEventRecord | null>;

  // --- limit counters ---
  /**
   * Records ingested in the calendar month containing `now`, read from
   * `usage_counters`. Bigint because the counter column is bigint; callers
   * narrow at the boundary.
   */
  countIngestedRecordsThisMonth(organizationId: string, now: Date): Promise<bigint>;
  countMembers(organizationId: string): Promise<number>;
  countNotificationDestinations(organizationId: string): Promise<number>;

  recordAudit(input: BillingAuditInput): Promise<void>;
}

/**
 * What the public service functions accept as their first argument: either a
 * Drizzle database (production) or an already-built store (tests, demo).
 */
export type BillingStoreLike = Database | BillingStore;

export function isBillingStore(value: BillingStoreLike): value is BillingStore {
  return "storeKind" in value && value.storeKind === "platform-billing-store";
}

/** Normalise the first argument of every service function into a store. */
export function resolveBillingStore(db: BillingStoreLike): BillingStore {
  return isBillingStore(db) ? db : createDrizzleBillingStore(db);
}
