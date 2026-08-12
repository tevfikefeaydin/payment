import { randomUUID } from "node:crypto";
import { PublicError, redactObject } from "@payrecon/domain";
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
 * In-memory `NotificationStore`.
 *
 * Exists so the dedupe, threshold and retry logic can be tested for real —
 * asserting on rows and rendered messages — without a database, SMTP server or
 * network. It reproduces the constraints the schema actually enforces:
 *
 *  - unique `(organization_id, dedupe_key)` on deliveries
 *  - unique `(delivery_id, exception_id)` on delivery items
 *  - unique `(organization_id, name)` on destinations
 *  - every read filtered by `organization_id`
 *
 * and it redacts audit metadata exactly as the real writer does, so a test can
 * meaningfully assert that no secret reaches the audit trail.
 */

export interface RecordedAuditEvent {
  organizationId: string;
  action: NotificationAuditInput["action"];
  actorType: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
}

export interface SeedPolicyInput extends Omit<PolicyRow, "id"> {
  id?: string;
}

export interface SeedExceptionInput extends Omit<ExceptionRow, "id"> {
  id?: string;
}

export interface MemoryNotificationStore extends NotificationStore {
  seedOrganization(organizationId: string, name: string): void;
  seedPolicy(policy: SeedPolicyInput): PolicyRow;
  seedException(exception: SeedExceptionInput): ExceptionRow;
  /** Every delivery row, for assertions. Copies, not live references. */
  listDeliveries(organizationId?: string): DeliveryRow[];
  listDestinations(organizationId?: string): DestinationRow[];
  listAuditEvents(): RecordedAuditEvent[];
  countDeliveryItems(deliveryId: string): number;
}

interface DeliveryItem {
  organizationId: string;
  deliveryId: string;
  exceptionId: string;
}

export function createMemoryNotificationStore(): MemoryNotificationStore {
  const organizations = new Map<string, string>();
  const destinations: DestinationRow[] = [];
  const policies: PolicyRow[] = [];
  const deliveries: DeliveryRow[] = [];
  const items: DeliveryItem[] = [];
  const exceptions: ExceptionRow[] = [];
  const audits: RecordedAuditEvent[] = [];

  const findDestination = (organizationId: string, id: string): DestinationRow | undefined =>
    destinations.find((row) => row.organizationId === organizationId && row.id === id);

  const findDelivery = (organizationId: string, id: string): DeliveryRow | undefined =>
    deliveries.find((row) => row.organizationId === organizationId && row.id === id);

  return {
    // ---- destinations ---------------------------------------------------
    insertDestination(row: NewDestinationRow): Promise<DestinationRow> {
      const clash = destinations.some(
        (existing) => existing.organizationId === row.organizationId && existing.name === row.name,
      );
      if (clash) {
        throw new PublicError(
          "notification.duplicate_name",
          "A destination with that name already exists.",
          409,
        );
      }

      const created: DestinationRow = {
        ...row,
        verifiedAt: null,
        lastErrorAt: null,
        lastError: null,
        updatedAt: row.createdAt,
      };
      destinations.push(created);
      return Promise.resolve({ ...created });
    },

    getDestination(organizationId: string, destinationId: string): Promise<DestinationRow | null> {
      const row = findDestination(organizationId, destinationId);
      return Promise.resolve(row ? { ...row } : null);
    },

    updateDestination(
      organizationId: string,
      destinationId: string,
      patch: DestinationPatch,
    ): Promise<DestinationRow | null> {
      const row = findDestination(organizationId, destinationId);
      if (!row) return Promise.resolve(null);

      if (patch.status !== undefined) row.status = patch.status;
      if (patch.verifiedAt !== undefined) row.verifiedAt = patch.verifiedAt;
      if (patch.lastError !== undefined) row.lastError = patch.lastError;
      if (patch.lastErrorAt !== undefined) row.lastErrorAt = patch.lastErrorAt;
      row.updatedAt = patch.updatedAt;

      return Promise.resolve({ ...row });
    },

    deleteDestination(organizationId: string, destinationId: string): Promise<boolean> {
      const index = destinations.findIndex(
        (row) => row.organizationId === organizationId && row.id === destinationId,
      );
      if (index < 0) return Promise.resolve(false);
      destinations.splice(index, 1);
      return Promise.resolve(true);
    },

    // ---- policies -------------------------------------------------------
    listEnabledPolicies(organizationId: string): Promise<PolicyRow[]> {
      return Promise.resolve(
        policies
          .filter((policy) => policy.organizationId === organizationId && policy.enabled)
          .map((policy) => ({ ...policy })),
      );
    },

    insertPolicy(row: NewPolicyRow): Promise<PolicyRow> {
      const created: PolicyRow = {
        id: randomUUID(),
        organizationId: row.organizationId,
        destinationId: row.destinationId,
        minSeverity: row.minSeverity,
        minRevenueAtRiskMinor: row.minRevenueAtRiskMinor,
        currency: row.currency,
        digest: row.digest,
        criticalBypassesDigest: row.criticalBypassesDigest,
        enabled: row.enabled,
      };
      policies.push(created);
      return Promise.resolve({ ...created });
    },

    listPolicies(organizationId: string): Promise<PolicyRow[]> {
      return Promise.resolve(
        policies
          .filter((policy) => policy.organizationId === organizationId)
          .map((policy) => ({ ...policy })),
      );
    },

    updatePolicy(
      organizationId: string,
      policyId: string,
      patch: PolicyPatch,
    ): Promise<PolicyRow | null> {
      const row = policies.find(
        (policy) => policy.organizationId === organizationId && policy.id === policyId,
      );
      if (!row) return Promise.resolve(null);
      row.enabled = patch.enabled;
      return Promise.resolve({ ...row });
    },

    deletePolicy(organizationId: string, policyId: string): Promise<boolean> {
      const index = policies.findIndex(
        (policy) => policy.organizationId === organizationId && policy.id === policyId,
      );
      if (index < 0) return Promise.resolve(false);
      policies.splice(index, 1);
      return Promise.resolve(true);
    },

    // ---- deliveries -----------------------------------------------------
    insertDeliveryIfAbsent(row: NewDeliveryRow): Promise<{ id: string; created: boolean }> {
      // Stands in for the unique (organization_id, dedupe_key) index.
      const existing = deliveries.find(
        (delivery) =>
          delivery.organizationId === row.organizationId && delivery.dedupeKey === row.dedupeKey,
      );
      if (existing) return Promise.resolve({ id: existing.id, created: false });

      deliveries.push({
        id: row.id,
        organizationId: row.organizationId,
        policyId: row.policyId,
        destinationId: row.destinationId,
        dedupeKey: row.dedupeKey,
        status: "pending",
        attempts: 0,
        summary: {},
        exceptionCount: 0,
        scheduledFor: row.scheduledFor,
        sentAt: null,
        lastError: null,
        createdAt: row.createdAt,
      });
      return Promise.resolve({ id: row.id, created: true });
    },

    linkException(
      organizationId: string,
      deliveryId: string,
      exceptionId: string,
    ): Promise<boolean> {
      const delivery = findDelivery(organizationId, deliveryId);
      if (!delivery) return Promise.resolve(false);

      const already = items.some(
        (item) => item.deliveryId === deliveryId && item.exceptionId === exceptionId,
      );
      if (already) return Promise.resolve(false);

      items.push({ organizationId, deliveryId, exceptionId });
      delivery.exceptionCount += 1;
      return Promise.resolve(true);
    },

    claimDueDeliveries(now: Date, limit: number, leaseUntil: Date): Promise<DeliveryRow[]> {
      const due = deliveries
        .filter(
          (delivery) =>
            delivery.status === "pending" && delivery.scheduledFor.getTime() <= now.getTime(),
        )
        .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
        .slice(0, limit);

      // Lease them forward so a concurrent drain cannot claim the same rows.
      const claimed = due.map((delivery) => {
        const snapshot = { ...delivery };
        delivery.scheduledFor = leaseUntil;
        return snapshot;
      });

      return Promise.resolve(claimed);
    },

    getDelivery(organizationId: string, deliveryId: string): Promise<DeliveryRow | null> {
      const row = findDelivery(organizationId, deliveryId);
      return Promise.resolve(row ? { ...row } : null);
    },

    listDeliveryExceptions(organizationId: string, deliveryId: string): Promise<ExceptionRow[]> {
      const linkedIds = items
        .filter((item) => item.organizationId === organizationId && item.deliveryId === deliveryId)
        .map((item) => item.exceptionId);

      return Promise.resolve(
        exceptions
          .filter(
            (exception) =>
              exception.organizationId === organizationId && linkedIds.includes(exception.id),
          )
          .map((exception) => ({ ...exception })),
      );
    },

    updateDelivery(
      organizationId: string,
      deliveryId: string,
      patch: DeliveryPatch,
    ): Promise<void> {
      const delivery = findDelivery(organizationId, deliveryId);
      if (!delivery) return Promise.resolve();

      delivery.status = patch.status;
      delivery.attempts = patch.attempts;
      if (patch.scheduledFor !== undefined) delivery.scheduledFor = patch.scheduledFor;
      if (patch.sentAt !== undefined) delivery.sentAt = patch.sentAt;
      if (patch.lastError !== undefined) delivery.lastError = patch.lastError;
      if (patch.summary !== undefined) delivery.summary = patch.summary;

      return Promise.resolve();
    },

    // ---- organizations --------------------------------------------------
    getOrganizationName(organizationId: string): Promise<string | null> {
      return Promise.resolve(organizations.get(organizationId) ?? null);
    },

    // ---- audit ----------------------------------------------------------
    recordAudit(input: NotificationAuditInput): Promise<void> {
      audits.push({
        organizationId: input.organizationId,
        action: input.action,
        actorType: input.actor.type,
        actorUserId: input.actor.userId ?? null,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        // Same redaction the real writer applies, so leakage assertions are real.
        metadata: (redactObject(input.metadata ?? {}) ?? {}) as Record<string, unknown>,
      });
      return Promise.resolve();
    },

    // ---- test helpers ---------------------------------------------------
    seedOrganization(organizationId: string, name: string): void {
      organizations.set(organizationId, name);
    },

    seedPolicy(policy: SeedPolicyInput): PolicyRow {
      const row: PolicyRow = { ...policy, id: policy.id ?? randomUUID() };
      policies.push(row);
      return { ...row };
    },

    seedException(exception: SeedExceptionInput): ExceptionRow {
      const row: ExceptionRow = { ...exception, id: exception.id ?? randomUUID() };
      exceptions.push(row);
      return { ...row };
    },

    listDeliveries(organizationId?: string): DeliveryRow[] {
      return deliveries
        .filter((delivery) => !organizationId || delivery.organizationId === organizationId)
        .map((delivery) => ({ ...delivery }));
    },

    listDestinations(organizationId?: string): DestinationRow[] {
      return destinations
        .filter((row) => !organizationId || row.organizationId === organizationId)
        .map((row) => ({ ...row }));
    },

    listAuditEvents(): RecordedAuditEvent[] {
      return audits.map((event) => ({ ...event }));
    },

    countDeliveryItems(deliveryId: string): number {
      return items.filter((item) => item.deliveryId === deliveryId).length;
    },
  };
}
