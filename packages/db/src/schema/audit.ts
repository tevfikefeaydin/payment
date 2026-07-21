import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./auth";
import { actorTypeEnum } from "./enums";

/**
 * Immutable audit log.
 *
 * Append-only is enforced in the DATABASE, not merely by convention: migration
 * 0001 installs a trigger that raises an exception on UPDATE or DELETE. An
 * ordinary application path therefore cannot rewrite history even if a bug or a
 * compromised code path tries to.
 *
 * Metadata passes through `redactObject` before it is written, so credentials,
 * tokens, raw Stripe payloads and imported row content never land here.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** NULL only for events that genuinely precede organization context. */
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** API key id when the actor was a machine. Not a foreign key: keys are deletable. */
    actorApiKeyId: uuid("actor_api_key_id"),
    /** Dotted action name, e.g. `connection.validated`, `exception.resolved`. */
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** Ties the event to the HTTP request or background job that caused it. */
    correlationId: text("correlation_id"),
    /** Redacted, bounded metadata. Never credentials or raw payloads. */
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Hashed client IP. The raw address is never stored. */
    ipHash: text("ip_hash"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_org_created_idx").on(table.organizationId, table.createdAt),
    index("audit_events_org_action_idx").on(table.organizationId, table.action),
    index("audit_events_actor_idx").on(table.actorUserId),
    index("audit_events_correlation_idx").on(table.correlationId),
  ],
);
