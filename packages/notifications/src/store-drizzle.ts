import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database } from "@payrecon/db";
import {
  exceptions,
  notificationDeliveries,
  notificationDeliveryItems,
  notificationDestinations,
  notificationPolicies,
  organizations,
} from "@payrecon/db/schema";
import { recordAudit } from "@payrecon/db/repositories/audit";
import { PublicError } from "@payrecon/domain";
import type {
  DeliveryPatch,
  DeliveryRow,
  DestinationPatch,
  DestinationRow,
  ExceptionRow,
  NewDeliveryRow,
  NewDestinationRow,
  NewPolicyRow,
  NotificationAuditInput,
  NotificationStore,
  PolicyPatch,
  PolicyRow,
} from "./store";

/**
 * PostgreSQL implementation of the notification store.
 *
 * Every statement below carries an `organization_id` predicate. That is
 * deliberate duplication — the delivery id is already a UUID — because it makes
 * an unscoped query visibly wrong in review and lets each index start with the
 * tenant key.
 */

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

type DestinationSelection = typeof notificationDestinations.$inferSelect;
type PolicySelection = typeof notificationPolicies.$inferSelect;
type DeliverySelection = typeof notificationDeliveries.$inferSelect;

function toDestinationRow(row: DestinationSelection): DestinationRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    name: row.name,
    target: row.target,
    secretCiphertext: row.secretCiphertext,
    secretNonce: row.secretNonce,
    secretAuthTag: row.secretAuthTag,
    secretKeyId: row.secretKeyId,
    secretHint: row.secretHint,
    status: row.status,
    verifiedAt: row.verifiedAt,
    lastErrorAt: row.lastErrorAt,
    lastError: row.lastError,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPolicyRow(row: PolicySelection): PolicyRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    destinationId: row.destinationId,
    minSeverity: row.minSeverity,
    minRevenueAtRiskMinor: row.minRevenueAtRiskMinor,
    currency: row.currency,
    digest: row.digest,
    criticalBypassesDigest: row.criticalBypassesDigest,
    enabled: row.enabled,
  };
}

function toDeliveryRow(row: DeliverySelection): DeliveryRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    policyId: row.policyId,
    destinationId: row.destinationId,
    dedupeKey: row.dedupeKey,
    status: row.status,
    attempts: row.attempts,
    // jsonb is typed `unknown` by drizzle; this column only ever holds the
    // non-sensitive object written by `toDeliverySummary`.
    summary: (row.summary ?? {}) as Record<string, unknown>,
    exceptionCount: row.exceptionCount,
    scheduledFor: row.scheduledFor,
    sentAt: row.sentAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
  };
}

export function createDrizzleNotificationStore(db: Database): NotificationStore {
  return {
    async insertDestination(row: NewDestinationRow): Promise<DestinationRow> {
      try {
        const inserted = await db
          .insert(notificationDestinations)
          .values({
            id: row.id,
            organizationId: row.organizationId,
            kind: row.kind,
            name: row.name,
            target: row.target,
            secretCiphertext: row.secretCiphertext,
            secretNonce: row.secretNonce,
            secretAuthTag: row.secretAuthTag,
            secretKeyId: row.secretKeyId,
            secretHint: row.secretHint,
            status: row.status,
            createdByUserId: row.createdByUserId,
            createdAt: row.createdAt,
            updatedAt: row.createdAt,
          })
          .returning();

        const created = inserted[0];
        if (!created) throw new Error("Destination insert returned no row");
        return toDestinationRow(created);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new PublicError(
            "notification.duplicate_name",
            "A destination with that name already exists.",
            409,
          );
        }
        throw error;
      }
    },

    async getDestination(
      organizationId: string,
      destinationId: string,
    ): Promise<DestinationRow | null> {
      const rows = await db
        .select()
        .from(notificationDestinations)
        .where(
          and(
            eq(notificationDestinations.organizationId, organizationId),
            eq(notificationDestinations.id, destinationId),
          ),
        )
        .limit(1);

      const row = rows[0];
      return row ? toDestinationRow(row) : null;
    },

    async updateDestination(
      organizationId: string,
      destinationId: string,
      patch: DestinationPatch,
    ): Promise<DestinationRow | null> {
      const rows = await db
        .update(notificationDestinations)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.verifiedAt !== undefined ? { verifiedAt: patch.verifiedAt } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.lastErrorAt !== undefined ? { lastErrorAt: patch.lastErrorAt } : {}),
          updatedAt: patch.updatedAt,
        })
        .where(
          and(
            eq(notificationDestinations.organizationId, organizationId),
            eq(notificationDestinations.id, destinationId),
          ),
        )
        .returning();

      const row = rows[0];
      return row ? toDestinationRow(row) : null;
    },

    async deleteDestination(organizationId: string, destinationId: string): Promise<boolean> {
      const rows = await db
        .delete(notificationDestinations)
        .where(
          and(
            eq(notificationDestinations.organizationId, organizationId),
            eq(notificationDestinations.id, destinationId),
          ),
        )
        .returning({ id: notificationDestinations.id });

      return rows.length > 0;
    },

    async listEnabledPolicies(organizationId: string): Promise<PolicyRow[]> {
      const rows = await db
        .select()
        .from(notificationPolicies)
        .where(
          and(
            eq(notificationPolicies.organizationId, organizationId),
            eq(notificationPolicies.enabled, true),
          ),
        );

      return rows.map(toPolicyRow);
    },

    async insertPolicy(row: NewPolicyRow): Promise<PolicyRow> {
      const inserted = await db
        .insert(notificationPolicies)
        .values({
          organizationId: row.organizationId,
          destinationId: row.destinationId,
          minSeverity: row.minSeverity,
          minRevenueAtRiskMinor: row.minRevenueAtRiskMinor,
          currency: row.currency,
          digest: row.digest,
          criticalBypassesDigest: row.criticalBypassesDigest,
          enabled: row.enabled,
          createdAt: row.createdAt,
          updatedAt: row.createdAt,
        })
        .returning();

      const created = inserted[0];
      if (!created) {
        throw new PublicError("policy_create_failed", "Could not create the notification policy.");
      }
      return toPolicyRow(created);
    },

    async listPolicies(organizationId: string): Promise<PolicyRow[]> {
      const rows = await db
        .select()
        .from(notificationPolicies)
        .where(eq(notificationPolicies.organizationId, organizationId))
        .orderBy(notificationPolicies.createdAt);

      return rows.map(toPolicyRow);
    },

    async updatePolicy(
      organizationId: string,
      policyId: string,
      patch: PolicyPatch,
    ): Promise<PolicyRow | null> {
      const rows = await db
        .update(notificationPolicies)
        .set({ enabled: patch.enabled, updatedAt: patch.updatedAt })
        .where(
          and(
            eq(notificationPolicies.organizationId, organizationId),
            eq(notificationPolicies.id, policyId),
          ),
        )
        .returning();

      const row = rows[0];
      return row ? toPolicyRow(row) : null;
    },

    async deletePolicy(organizationId: string, policyId: string): Promise<boolean> {
      const rows = await db
        .delete(notificationPolicies)
        .where(
          and(
            eq(notificationPolicies.organizationId, organizationId),
            eq(notificationPolicies.id, policyId),
          ),
        )
        .returning({ id: notificationPolicies.id });

      return rows.length > 0;
    },

    async insertDeliveryIfAbsent(row: NewDeliveryRow): Promise<{ id: string; created: boolean }> {
      // ON CONFLICT DO NOTHING against the unique (organization_id, dedupe_key)
      // index is what makes concurrent workers safe: the loser inserts nothing
      // and then reads the winner's row.
      const inserted = await db
        .insert(notificationDeliveries)
        .values({
          id: row.id,
          organizationId: row.organizationId,
          policyId: row.policyId,
          destinationId: row.destinationId,
          dedupeKey: row.dedupeKey,
          status: "pending",
          scheduledFor: row.scheduledFor,
          createdAt: row.createdAt,
        })
        .onConflictDoNothing({
          target: [notificationDeliveries.organizationId, notificationDeliveries.dedupeKey],
        })
        .returning({ id: notificationDeliveries.id });

      const created = inserted[0];
      if (created) return { id: created.id, created: true };

      const existing = await db
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.organizationId, row.organizationId),
            eq(notificationDeliveries.dedupeKey, row.dedupeKey),
          ),
        )
        .limit(1);

      const found = existing[0];
      if (!found) {
        throw new Error("Delivery insert conflicted but the conflicting row was not found");
      }
      return { id: found.id, created: false };
    },

    async linkException(
      organizationId: string,
      deliveryId: string,
      exceptionId: string,
    ): Promise<boolean> {
      const inserted = await db
        .insert(notificationDeliveryItems)
        .values({ organizationId, deliveryId, exceptionId })
        .onConflictDoNothing({
          target: [notificationDeliveryItems.deliveryId, notificationDeliveryItems.exceptionId],
        })
        .returning({ id: notificationDeliveryItems.id });

      if (inserted.length === 0) return false;

      // Incremented in SQL rather than read-modify-write, so two workers adding
      // different exceptions to the same digest cannot lose a count.
      await db
        .update(notificationDeliveries)
        .set({ exceptionCount: sql`${notificationDeliveries.exceptionCount} + 1` })
        .where(
          and(
            eq(notificationDeliveries.organizationId, organizationId),
            eq(notificationDeliveries.id, deliveryId),
          ),
        );

      return true;
    },

    async claimDueDeliveries(now: Date, limit: number, leaseUntil: Date): Promise<DeliveryRow[]> {
      // Two steps rather than `UPDATE ... WHERE id IN (SELECT ... FROM same_table)`.
      // Passing the builder straight to `inArray` does not render valid SQL for a
      // self-referential subquery, and materialising the ids is easier to reason
      // about besides.
      const due = await db
        .select({ id: notificationDeliveries.id })
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.status, "pending"),
            lte(notificationDeliveries.scheduledFor, now),
          ),
        )
        .orderBy(notificationDeliveries.scheduledFor)
        .limit(limit);

      if (due.length === 0) return [];

      // The status/schedule predicate is re-evaluated under the row lock taken by
      // the UPDATE, so a second worker that selected the same ids in the window
      // between these two statements updates nothing and receives an empty set
      // rather than sending a duplicate.
      const claimed = await db
        .update(notificationDeliveries)
        .set({ scheduledFor: leaseUntil })
        .where(
          and(
            eq(notificationDeliveries.status, "pending"),
            lte(notificationDeliveries.scheduledFor, now),
            inArray(
              notificationDeliveries.id,
              due.map((row) => row.id),
            ),
          ),
        )
        .returning();

      return claimed.map(toDeliveryRow);
    },

    async getDelivery(organizationId: string, deliveryId: string): Promise<DeliveryRow | null> {
      const rows = await db
        .select()
        .from(notificationDeliveries)
        .where(
          and(
            eq(notificationDeliveries.organizationId, organizationId),
            eq(notificationDeliveries.id, deliveryId),
          ),
        )
        .limit(1);

      const row = rows[0];
      return row ? toDeliveryRow(row) : null;
    },

    async listDeliveryExceptions(
      organizationId: string,
      deliveryId: string,
    ): Promise<ExceptionRow[]> {
      // Only the columns a message needs. Evidence blobs, provider ids and
      // internal record ids are deliberately not read here.
      const rows = await db
        .select({
          id: exceptions.id,
          organizationId: exceptions.organizationId,
          ruleId: exceptions.ruleId,
          severity: exceptions.severity,
          summary: exceptions.summary,
          revenueAtRiskMinor: exceptions.revenueAtRiskMinor,
          currency: exceptions.currency,
        })
        .from(notificationDeliveryItems)
        .innerJoin(exceptions, eq(exceptions.id, notificationDeliveryItems.exceptionId))
        .where(
          and(
            eq(notificationDeliveryItems.organizationId, organizationId),
            eq(notificationDeliveryItems.deliveryId, deliveryId),
            eq(exceptions.organizationId, organizationId),
          ),
        );

      return rows;
    },

    async updateDelivery(
      organizationId: string,
      deliveryId: string,
      patch: DeliveryPatch,
    ): Promise<void> {
      await db
        .update(notificationDeliveries)
        .set({
          status: patch.status,
          attempts: patch.attempts,
          ...(patch.scheduledFor !== undefined ? { scheduledFor: patch.scheduledFor } : {}),
          ...(patch.sentAt !== undefined ? { sentAt: patch.sentAt } : {}),
          ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
          ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        })
        .where(
          and(
            eq(notificationDeliveries.organizationId, organizationId),
            eq(notificationDeliveries.id, deliveryId),
          ),
        );
    },

    async getOrganizationName(organizationId: string): Promise<string | null> {
      const rows = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1);

      return rows[0]?.name ?? null;
    },

    async recordAudit(input: NotificationAuditInput): Promise<void> {
      await recordAudit(db, {
        organizationId: input.organizationId,
        actor: { type: input.actor.type, userId: input.actor.userId ?? null },
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ?? {},
      });
    },
  };
}
