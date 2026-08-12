import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { redactObject } from "@payrecon/domain";
import type { Database } from "../client";
import { auditEvents } from "../schema/audit";

/**
 * Audit log writer and reader.
 *
 * Every security- and finance-relevant action goes through `recordAudit`.
 * Metadata is passed through `redactObject` before it is written, so a caller
 * that carelessly includes a token, a raw Stripe payload, or an imported row
 * cannot leak it into the audit trail.
 *
 * Rows are append-only, enforced by a database trigger (see guards.ts).
 */

/** Canonical action names. Keeping them in one union prevents typo-drift. */
export const AUDIT_ACTIONS = [
  // authentication and account
  "auth.signed_up",
  "auth.signed_in",
  "auth.sign_in_failed",
  "auth.signed_out",
  "auth.password_changed",
  "auth.password_reset_requested",
  "auth.password_reset_completed",
  "auth.sessions_revoked",

  // organization and membership
  "organization.created",
  "organization.updated",
  "organization.deleted",
  "organization.ownership_transferred",
  "member.invited",
  "member.invitation_revoked",
  "member.joined",
  "member.role_changed",
  "member.removed",

  // customer Stripe connections
  "connection.created",
  "connection.validated",
  "connection.validation_failed",
  "connection.disabled",
  "connection.enabled",
  "connection.credential_rotated",
  "connection.deleted",

  // synchronisation and ingestion
  "sync.started",
  "sync.succeeded",
  "sync.failed",
  "import.created",
  "import.started",
  "import.completed",
  "import.failed",
  "records.upserted",

  // API keys
  "api_key.created",
  "api_key.revoked",

  // reconciliation and exceptions
  "reconciliation.started",
  "reconciliation.completed",
  "reconciliation.failed",
  "exception.created",
  "exception.reopened",
  "exception.assigned",
  "exception.state_changed",

  // notifications
  "notification.destination_created",
  "notification.destination_verified",
  "notification.destination_deleted",
  "notification.policy_changed",
  "notification.test_sent",
  "notification.delivery_failed",

  // billing and entitlements
  "billing.checkout_started",
  "billing.portal_opened",
  "billing.subscription_changed",
  "billing.entitlements_changed",
  "billing.limit_reached",

  // retention and data lifecycle
  "retention.settings_changed",
  "retention.cleanup_ran",
  "encryption.envelopes_rotated",
  "data.exported",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditActor {
  type: "user" | "api_key" | "system";
  userId?: string | null;
  apiKeyId?: string | null;
}

export interface RecordAuditInput {
  /** Null only for events that genuinely precede organization context. */
  organizationId: string | null;
  actor: AuditActor;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  correlationId?: string | null;
  /** Redacted before write. Keep it small and non-sensitive. */
  metadata?: Record<string, unknown>;
  /** Already-hashed client IP. Never pass a raw address. */
  ipHash?: string | null;
}

export async function recordAudit(db: Database, input: RecordAuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    organizationId: input.organizationId,
    actorType: input.actor.type,
    actorUserId: input.actor.userId ?? null,
    actorApiKeyId: input.actor.apiKeyId ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    correlationId: input.correlationId ?? null,
    // Defence in depth: even a careless caller cannot write a secret here.
    metadata: (redactObject(input.metadata ?? {}) ?? {}) as Record<string, unknown>,
    ipHash: input.ipHash ?? null,
  });
}

export interface AuditQuery {
  organizationId: string;
  action?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditRow {
  id: string;
  action: string;
  actorType: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  correlationId: string | null;
  metadata: unknown;
  createdAt: Date;
}

/**
 * Read the audit trail for ONE organization.
 *
 * `organizationId` is a required parameter rather than an optional filter, so an
 * unscoped read is not expressible through this API.
 */
export async function listAuditEvents(
  db: Database,
  query: AuditQuery,
): Promise<{ rows: AuditRow[]; total: number }> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const offset = Math.max(query.offset ?? 0, 0);

  const conditions: SQL[] = [eq(auditEvents.organizationId, query.organizationId)];
  if (query.action) conditions.push(eq(auditEvents.action, query.action));
  if (query.actorUserId) conditions.push(eq(auditEvents.actorUserId, query.actorUserId));
  if (query.from) conditions.push(gte(auditEvents.createdAt, query.from));
  if (query.to) conditions.push(lte(auditEvents.createdAt, query.to));

  const where = and(...conditions);

  const rows = await db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorType: auditEvents.actorType,
      actorUserId: auditEvents.actorUserId,
      targetType: auditEvents.targetType,
      targetId: auditEvents.targetId,
      correlationId: auditEvents.correlationId,
      metadata: auditEvents.metadata,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit)
    .offset(offset);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(where);

  return { rows, total: countRow?.count ?? 0 };
}

/** Distinct action names present for an organization, for the filter dropdown. */
export async function listAuditActions(db: Database, organizationId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ action: auditEvents.action })
    .from(auditEvents)
    .where(eq(auditEvents.organizationId, organizationId))
    .orderBy(auditEvents.action);
  return rows.map((r) => r.action);
}
