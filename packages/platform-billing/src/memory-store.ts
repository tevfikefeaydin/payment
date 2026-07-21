/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * Holds only platform-billing rows. There is no table here for customer Stripe
 * connections or provider data, because this package must never touch them.
 * See docs/adr/0007-stripe-context-separation.md.
 *
 * ---
 *
 * In-memory `BillingStore`.
 *
 * Exists so webhook idempotency, out-of-order tolerance and limit enforcement
 * can be tested for real — asserting on rows — with no database, no network and
 * no Stripe account. It reproduces the constraints the schema actually
 * enforces, because a fake that is more permissive than the database proves
 * nothing:
 *
 *   - unique `organization_id` on billing_customers
 *   - unique `stripe_customer_id` on billing_customers
 *   - unique `stripe_subscription_id` on billing_subscriptions
 *   - unique `stripe_event_id` on billing_webhook_events
 *   - every tenant-owned read filtered by `organization_id`
 *
 * and it redacts audit metadata exactly as the real writer does, so a test can
 * meaningfully assert that no secret reaches the audit trail.
 */
import { randomUUID } from "node:crypto";
import { redactObject } from "@payrecon/domain";
import type { PlanKey } from "@payrecon/config";
import { BillingConfigurationError } from "./errors";
import {
  USAGE_METRIC_INGESTED_RECORDS,
  usagePeriodKey,
  type BillingAuditInput,
  type BillingCustomerRecord,
  type BillingStore,
  type BillingSubscriptionRecord,
  type ClaimWebhookEventResult,
  type InsertWebhookEventInput,
  type OrganizationRecord,
  type UpsertSubscriptionInput,
  type WebhookEventPatch,
  type WebhookEventRecord,
} from "./store";

export interface RecordedBillingAudit {
  organizationId: string;
  action: BillingAuditInput["action"];
  actorType: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

export interface MemoryBillingStore extends BillingStore {
  seedOrganization(input: { id: string; name: string; planKey?: PlanKey }): OrganizationRecord;
  seedBillingCustomer(input: { organizationId: string; stripeCustomerId: string }): void;
  seedUsage(input: {
    organizationId: string;
    metric?: string;
    period: string;
    count: number;
  }): void;
  seedMembers(organizationId: string, count: number): void;
  seedNotificationDestinations(organizationId: string, count: number): void;

  /** Copies, not live references, so a test cannot mutate the store by accident. */
  listSubscriptions(organizationId?: string): BillingSubscriptionRecord[];
  listWebhookEvents(): WebhookEventRecord[];
  listAudits(): RecordedBillingAudit[];
  /** How many times `upsertSubscription` actually wrote. Proves "applied once". */
  subscriptionWriteCount(): number;
}

export function createMemoryBillingStore(): MemoryBillingStore {
  const organizations = new Map<string, OrganizationRecord>();
  const customers: BillingCustomerRecord[] = [];
  const subscriptions: BillingSubscriptionRecord[] = [];
  const webhookEvents: WebhookEventRecord[] = [];
  const audits: RecordedBillingAudit[] = [];
  const usage = new Map<string, number>();
  const memberCounts = new Map<string, number>();
  const destinationCounts = new Map<string, number>();
  let writes = 0;

  const usageKey = (organizationId: string, period: string, metric: string): string =>
    `${organizationId}::${period}::${metric}`;

  const clone = <T>(value: T): T => ({ ...value }) as T;

  return {
    storeKind: "platform-billing-store",

    // ----------------------------------------------------------------- seeds
    seedOrganization({ id, name, planKey = "free" }) {
      const row: OrganizationRecord = { id, name, planKey };
      organizations.set(id, row);
      return clone(row);
    },

    seedBillingCustomer({ organizationId, stripeCustomerId }) {
      customers.push({
        id: randomUUID(),
        organizationId,
        stripeCustomerId,
        createdAt: new Date(0),
      });
    },

    seedUsage({ organizationId, metric = USAGE_METRIC_INGESTED_RECORDS, period, count }) {
      usage.set(usageKey(organizationId, period, metric), count);
    },

    seedMembers(organizationId, count) {
      memberCounts.set(organizationId, count);
    },

    seedNotificationDestinations(organizationId, count) {
      destinationCounts.set(organizationId, count);
    },

    // ------------------------------------------------------------ assertions
    listSubscriptions(organizationId) {
      return subscriptions
        .filter((row) => organizationId === undefined || row.organizationId === organizationId)
        .map(clone);
    },

    listWebhookEvents() {
      return webhookEvents.map(clone);
    },

    listAudits() {
      return audits.map((row) => ({ ...row, metadata: { ...row.metadata } }));
    },

    subscriptionWriteCount() {
      return writes;
    },

    // --------------------------------------------------------- organizations
    async findOrganization(organizationId) {
      const row = organizations.get(organizationId);
      return row ? clone(row) : null;
    },

    async updateOrganizationPlan(organizationId, planKey) {
      const row = organizations.get(organizationId);
      if (!row) return false;
      organizations.set(organizationId, { ...row, planKey });
      return true;
    },

    // ------------------------------------------------------ billing customer
    async findBillingCustomerByOrganization(organizationId) {
      const row = customers.find((c) => c.organizationId === organizationId);
      return row ? clone(row) : null;
    },

    async findBillingCustomerByStripeId(stripeCustomerId) {
      const row = customers.find((c) => c.stripeCustomerId === stripeCustomerId);
      return row ? clone(row) : null;
    },

    async insertBillingCustomerIfAbsent({ organizationId, stripeCustomerId, now }) {
      const byOrg = customers.find((c) => c.organizationId === organizationId);
      if (byOrg) return clone(byOrg);

      // Mirrors the unique index on `stripe_customer_id`: the same Stripe
      // customer must never end up serving two tenants.
      const byStripeId = customers.find((c) => c.stripeCustomerId === stripeCustomerId);
      if (byStripeId) {
        throw new BillingConfigurationError(
          "Stripe customer is already associated with a different organization.",
        );
      }

      const row: BillingCustomerRecord = {
        id: randomUUID(),
        organizationId,
        stripeCustomerId,
        createdAt: now,
      };
      customers.push(row);
      return clone(row);
    },

    // ----------------------------------------------------------- subscription
    async findSubscriptionByOrganization(organizationId) {
      const matches = subscriptions
        .filter((row) => row.organizationId === organizationId)
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      const row = matches[0];
      return row ? clone(row) : null;
    },

    async upsertSubscription(input: UpsertSubscriptionInput) {
      writes += 1;

      const index = subscriptions.findIndex(
        (row) => row.stripeSubscriptionId === input.stripeSubscriptionId,
      );

      if (index === -1) {
        const row: BillingSubscriptionRecord = {
          id: randomUUID(),
          organizationId: input.organizationId,
          stripeSubscriptionId: input.stripeSubscriptionId,
          status: input.status,
          planKey: input.planKey,
          stripePriceId: input.stripePriceId ?? null,
          currentPeriodEnd: input.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
          trialEndsAt: input.trialEndsAt ?? null,
          canceledAt: input.canceledAt ?? null,
          lastEventAt: input.lastEventAt,
          createdAt: input.now,
          updatedAt: input.now,
        };
        subscriptions.push(row);
        return clone(row);
      }

      const previous = subscriptions[index];
      /* c8 ignore next */
      if (!previous) throw new BillingConfigurationError("Subscription row vanished.");

      // Undefined means "the event did not mention this", and must leave the
      // stored value alone — the same partial-update rule as the SQL store.
      const updated: BillingSubscriptionRecord = {
        ...previous,
        status: input.status,
        planKey: input.planKey,
        stripePriceId:
          input.stripePriceId !== undefined ? input.stripePriceId : previous.stripePriceId,
        currentPeriodEnd:
          input.currentPeriodEnd !== undefined ? input.currentPeriodEnd : previous.currentPeriodEnd,
        cancelAtPeriodEnd:
          input.cancelAtPeriodEnd !== undefined
            ? input.cancelAtPeriodEnd
            : previous.cancelAtPeriodEnd,
        trialEndsAt: input.trialEndsAt !== undefined ? input.trialEndsAt : previous.trialEndsAt,
        canceledAt: input.canceledAt !== undefined ? input.canceledAt : previous.canceledAt,
        lastEventAt: input.lastEventAt,
        updatedAt: input.now,
      };
      subscriptions[index] = updated;
      return clone(updated);
    },

    // ------------------------------------------------------- webhook receipts
    async claimWebhookEvent(input: InsertWebhookEventInput): Promise<ClaimWebhookEventResult> {
      const existing = webhookEvents.find((row) => row.stripeEventId === input.stripeEventId);
      if (existing) return { created: false, existing: clone(existing) };

      webhookEvents.push({
        stripeEventId: input.stripeEventId,
        type: input.type,
        organizationId: input.organizationId,
        status: "received",
        eventCreatedAt: input.eventCreatedAt,
        processedAt: null,
        errorMessage: null,
      });
      return { created: true, existing: null };
    },

    async markWebhookEvent(stripeEventId: string, patch: WebhookEventPatch) {
      const index = webhookEvents.findIndex((row) => row.stripeEventId === stripeEventId);
      if (index === -1) return;

      const previous = webhookEvents[index];
      /* c8 ignore next */
      if (!previous) return;

      webhookEvents[index] = {
        ...previous,
        status: patch.status,
        organizationId:
          patch.organizationId !== undefined ? patch.organizationId : previous.organizationId,
        processedAt: patch.processedAt !== undefined ? patch.processedAt : previous.processedAt,
        errorMessage: patch.errorMessage !== undefined ? patch.errorMessage : previous.errorMessage,
      };
    },

    async findWebhookEvent(stripeEventId: string): Promise<WebhookEventRecord | null> {
      const row = webhookEvents.find((r) => r.stripeEventId === stripeEventId);
      return row ? clone(row) : null;
    },

    // -------------------------------------------------------------- counters
    async countIngestedRecordsThisMonth(organizationId: string, now: Date): Promise<bigint> {
      const key = usageKey(organizationId, usagePeriodKey(now), USAGE_METRIC_INGESTED_RECORDS);
      return BigInt(usage.get(key) ?? 0);
    },

    async countMembers(organizationId: string): Promise<number> {
      return memberCounts.get(organizationId) ?? 0;
    },

    async countNotificationDestinations(organizationId: string): Promise<number> {
      return destinationCounts.get(organizationId) ?? 0;
    },

    // ----------------------------------------------------------------- audit
    async recordAudit(input: BillingAuditInput): Promise<void> {
      audits.push({
        organizationId: input.organizationId,
        action: input.action,
        actorType: input.actor.type,
        actorUserId: input.actor.userId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        // Same redaction the real writer applies, so a test asserting "no
        // secret in the audit trail" is testing the real behaviour.
        metadata: (redactObject(input.metadata ?? {}) ?? {}) as Record<string, unknown>,
      });
    },
  };
}
