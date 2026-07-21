/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * Every statement in this file targets a platform-billing table or a
 * tenant-owned table needed for limit enforcement. Nothing here reads or writes
 * the customer-data integration's tables or any provider_* table.
 * See docs/adr/0007-stripe-context-separation.md.
 *
 * ---
 *
 * PostgreSQL implementation of the billing store.
 *
 * Every tenant-owned statement carries an `organization_id` predicate. That is
 * deliberate duplication — most of these ids are already unique UUIDs — because
 * it makes an unscoped query visibly wrong in review and lets each index start
 * with the tenant key.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@payrecon/db";
import {
  billingCustomers,
  billingSubscriptions,
  billingWebhookEvents,
  notificationDestinations,
  organizationMembers,
  organizations,
  usageCounters,
} from "@payrecon/db/schema";
import { recordAudit } from "@payrecon/db/repositories/audit";
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

type BillingCustomerSelection = typeof billingCustomers.$inferSelect;
type BillingSubscriptionSelection = typeof billingSubscriptions.$inferSelect;
type WebhookEventSelection = typeof billingWebhookEvents.$inferSelect;

function toCustomerRecord(row: BillingCustomerSelection): BillingCustomerRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    stripeCustomerId: row.stripeCustomerId,
    createdAt: row.createdAt,
  };
}

function toSubscriptionRecord(row: BillingSubscriptionSelection): BillingSubscriptionRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    status: row.status,
    planKey: row.planKey,
    stripePriceId: row.stripePriceId,
    currentPeriodEnd: row.currentPeriodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    trialEndsAt: row.trialEndsAt,
    canceledAt: row.canceledAt,
    lastEventAt: row.lastEventAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toWebhookRecord(row: WebhookEventSelection): WebhookEventRecord {
  return {
    stripeEventId: row.stripeEventId,
    type: row.type,
    organizationId: row.organizationId,
    status: row.status,
    eventCreatedAt: row.eventCreatedAt,
    processedAt: row.processedAt,
    errorMessage: row.errorMessage,
  };
}

export function createDrizzleBillingStore(db: Database): BillingStore {
  return {
    storeKind: "platform-billing-store",

    // -----------------------------------------------------------------------
    // Organization
    // -----------------------------------------------------------------------

    async findOrganization(organizationId: string): Promise<OrganizationRecord | null> {
      const [row] = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          planKey: organizations.planKey,
        })
        .from(organizations)
        // A soft-deleted organization is not billable: it must not be able to
        // start a checkout, and a late webhook must not resurrect its plan.
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
        .limit(1);

      return row ?? null;
    },

    async updateOrganizationPlan(organizationId: string, planKey: PlanKey): Promise<boolean> {
      const rows = await db
        .update(organizations)
        .set({ planKey, updatedAt: sql`now()` })
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deletedAt)))
        .returning({ id: organizations.id });

      return rows.length > 0;
    },

    // -----------------------------------------------------------------------
    // Billing customer
    // -----------------------------------------------------------------------

    async findBillingCustomerByOrganization(
      organizationId: string,
    ): Promise<BillingCustomerRecord | null> {
      const [row] = await db
        .select()
        .from(billingCustomers)
        .where(eq(billingCustomers.organizationId, organizationId))
        .limit(1);

      return row ? toCustomerRecord(row) : null;
    },

    async findBillingCustomerByStripeId(
      stripeCustomerId: string,
    ): Promise<BillingCustomerRecord | null> {
      // Not organization-scoped by necessity: this lookup is how the
      // organization is DISCOVERED when a webhook arrives. `stripe_customer_id`
      // is unique, so it resolves to at most one tenant.
      const [row] = await db
        .select()
        .from(billingCustomers)
        .where(eq(billingCustomers.stripeCustomerId, stripeCustomerId))
        .limit(1);

      return row ? toCustomerRecord(row) : null;
    },

    async insertBillingCustomerIfAbsent(input): Promise<BillingCustomerRecord> {
      // No conflict target: BOTH unique indexes (organization, stripe customer)
      // must be absorbed. Two concurrent checkout clicks would otherwise create
      // two Stripe customers for one organization and split its billing history.
      const [inserted] = await db
        .insert(billingCustomers)
        .values({
          organizationId: input.organizationId,
          stripeCustomerId: input.stripeCustomerId,
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .returning();

      if (inserted) return toCustomerRecord(inserted);

      const [existing] = await db
        .select()
        .from(billingCustomers)
        .where(eq(billingCustomers.organizationId, input.organizationId))
        .limit(1);

      if (!existing) {
        // The insert conflicted, but not on this organization — meaning the
        // Stripe customer id is already bound to a DIFFERENT tenant. Failing
        // loudly is the only safe outcome: silently reusing it would let one
        // organization's subscription drive another's entitlements.
        throw new BillingConfigurationError(
          "Stripe customer is already associated with a different organization.",
        );
      }

      return toCustomerRecord(existing);
    },

    // -----------------------------------------------------------------------
    // Subscription
    // -----------------------------------------------------------------------

    async findSubscriptionByOrganization(
      organizationId: string,
    ): Promise<BillingSubscriptionRecord | null> {
      const [row] = await db
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.organizationId, organizationId))
        // Newest first: an organization that resubscribed after cancelling has
        // more than one row, and the current one is what entitles it.
        .orderBy(sql`${billingSubscriptions.updatedAt} desc`)
        .limit(1);

      return row ? toSubscriptionRecord(row) : null;
    },

    async upsertSubscription(input: UpsertSubscriptionInput): Promise<BillingSubscriptionRecord> {
      // Only fields the event actually carried are written. Omitting a field
      // leaves the stored value untouched, so a sparse event cannot erase state
      // that a fuller earlier event established.
      const set: Record<string, unknown> = {
        status: input.status,
        planKey: input.planKey,
        lastEventAt: input.lastEventAt,
        updatedAt: input.now,
      };
      if (input.stripePriceId !== undefined) set.stripePriceId = input.stripePriceId;
      if (input.currentPeriodEnd !== undefined) set.currentPeriodEnd = input.currentPeriodEnd;
      if (input.cancelAtPeriodEnd !== undefined) set.cancelAtPeriodEnd = input.cancelAtPeriodEnd;
      if (input.trialEndsAt !== undefined) set.trialEndsAt = input.trialEndsAt;
      if (input.canceledAt !== undefined) set.canceledAt = input.canceledAt;

      const [row] = await db
        .insert(billingSubscriptions)
        .values({
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
        })
        .onConflictDoUpdate({
          target: billingSubscriptions.stripeSubscriptionId,
          set,
        })
        .returning();

      if (!row) {
        throw new BillingConfigurationError("Subscription upsert returned no row.");
      }
      return toSubscriptionRecord(row);
    },

    // -----------------------------------------------------------------------
    // Webhook receipts
    // -----------------------------------------------------------------------

    async claimWebhookEvent(input: InsertWebhookEventInput): Promise<ClaimWebhookEventResult> {
      // The unique index on `stripe_event_id` IS the idempotency mechanism.
      // Stripe redelivers on any non-2xx (and sometimes anyway); this insert is
      // what makes the redelivery observable instead of silently reapplied.
      const [inserted] = await db
        .insert(billingWebhookEvents)
        .values({
          stripeEventId: input.stripeEventId,
          type: input.type,
          organizationId: input.organizationId,
          status: "received",
          eventCreatedAt: input.eventCreatedAt,
        })
        .onConflictDoNothing({ target: billingWebhookEvents.stripeEventId })
        .returning();

      if (inserted) return { created: true, existing: null };

      const [existing] = await db
        .select()
        .from(billingWebhookEvents)
        .where(eq(billingWebhookEvents.stripeEventId, input.stripeEventId))
        .limit(1);

      return { created: false, existing: existing ? toWebhookRecord(existing) : null };
    },

    async markWebhookEvent(stripeEventId: string, patch: WebhookEventPatch): Promise<void> {
      const set: Record<string, unknown> = { status: patch.status };
      if (patch.organizationId !== undefined) set.organizationId = patch.organizationId;
      if (patch.processedAt !== undefined) set.processedAt = patch.processedAt;
      if (patch.errorMessage !== undefined) set.errorMessage = patch.errorMessage;

      await db
        .update(billingWebhookEvents)
        .set(set)
        .where(eq(billingWebhookEvents.stripeEventId, stripeEventId));
    },

    async findWebhookEvent(stripeEventId: string): Promise<WebhookEventRecord | null> {
      const [row] = await db
        .select()
        .from(billingWebhookEvents)
        .where(eq(billingWebhookEvents.stripeEventId, stripeEventId))
        .limit(1);

      return row ? toWebhookRecord(row) : null;
    },

    // -----------------------------------------------------------------------
    // Limit counters
    // -----------------------------------------------------------------------

    async countIngestedRecordsThisMonth(organizationId: string, now: Date): Promise<bigint> {
      const [row] = await db
        .select({ count: usageCounters.count })
        .from(usageCounters)
        .where(
          and(
            eq(usageCounters.organizationId, organizationId),
            eq(usageCounters.period, usagePeriodKey(now)),
            eq(usageCounters.metric, USAGE_METRIC_INGESTED_RECORDS),
          ),
        )
        .limit(1);

      return row?.count ?? 0n;
    },

    async countMembers(organizationId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(organizationMembers)
        .where(eq(organizationMembers.organizationId, organizationId));

      return row?.count ?? 0;
    },

    async countNotificationDestinations(organizationId: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(notificationDestinations)
        .where(eq(notificationDestinations.organizationId, organizationId));

      return row?.count ?? 0;
    },

    async recordAudit(input: BillingAuditInput): Promise<void> {
      // Delegated so billing writes go through the same redaction as every
      // other audit writer, rather than re-implementing it here.
      await recordAudit(db, {
        organizationId: input.organizationId,
        actor: input.actor,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata,
      });
    },
  };
}
