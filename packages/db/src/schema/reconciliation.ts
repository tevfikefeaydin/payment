import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./auth";
import {
  actorTypeEnum,
  exceptionSeverityEnum,
  exceptionStateEnum,
  reconciliationRunStatusEnum,
  runTriggerEnum,
} from "./enums";

export const reconciliationRuns = pgTable(
  "reconciliation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    status: reconciliationRunStatusEnum("status").notNull().default("queued"),
    trigger: runTriggerEnum("trigger").notNull(),
    /** Rule-set version used, so historical results remain interpretable. */
    ruleVersion: integer("rule_version").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    /** Counts per rule, plus totals created/reopened/unchanged. */
    counts: jsonb("counts")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Ambiguity and grace-window counters that deliberately became no exception. */
    diagnostics: jsonb("diagnostics")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /**
     * Source freshness at the moment the run started: per-connection last
     * successful sync and last import. Lets the UI state exactly how current the
     * inputs were.
     */
    sourceSnapshot: jsonb("source_snapshot")
      .notNull()
      .default(sql`'{}'::jsonb`),
    triggeredByUserId: uuid("triggered_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    errorCategory: text("error_category"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("reconciliation_runs_org_created_idx").on(table.organizationId, table.createdAt),
    index("reconciliation_runs_org_status_idx").on(table.organizationId, table.status),
  ],
);

/**
 * The exception inbox.
 *
 * `(organization_id, fingerprint)` is unique, which is what prevents duplicate
 * open exceptions across runs while allowing a resolved exception to be reopened
 * in place, preserving its history.
 *
 * `version` provides optimistic concurrency: a state transition supplies the
 * version it read, and the UPDATE fails if another operator moved first.
 */
export const exceptions = pgTable(
  "exceptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    severity: exceptionSeverityEnum("severity").notNull(),
    state: exceptionStateEnum("state").notNull().default("open"),
    summary: text("summary").notNull(),
    /** Exact, per-currency. Never summed across currencies. */
    revenueAtRiskMinor: bigint("revenue_at_risk_minor", { mode: "bigint" }),
    currency: text("currency"),
    providerObjectId: text("provider_object_id"),
    internalRecordId: uuid("internal_record_id"),
    internalExternalId: text("internal_external_id"),
    evidence: jsonb("evidence")
      .notNull()
      .default(sql`'[]'::jsonb`),
    probableCauses: jsonb("probable_causes")
      .notNull()
      .default(sql`'[]'::jsonb`),
    recommendedActions: jsonb("recommended_actions")
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** When the underlying event happened, distinct from when it was detected. */
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }),
    assignedToUserId: uuid("assigned_to_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "date" }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Run that first created this exception, and the most recent to observe it. */
    firstRunId: uuid("first_run_id").references(() => reconciliationRuns.id, {
      onDelete: "set null",
    }),
    lastRunId: uuid("last_run_id").references(() => reconciliationRuns.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("exceptions_org_fingerprint_uidx").on(table.organizationId, table.fingerprint),
    index("exceptions_org_state_severity_idx").on(
      table.organizationId,
      table.state,
      table.severity,
    ),
    index("exceptions_org_rule_idx").on(table.organizationId, table.ruleId),
    index("exceptions_org_assignee_idx").on(table.organizationId, table.assignedToUserId),
    index("exceptions_org_created_idx").on(table.organizationId, table.createdAt),
    index("exceptions_org_currency_risk_idx").on(
      table.organizationId,
      table.currency,
      table.revenueAtRiskMinor,
    ),
    check(
      "exceptions_currency_upper",
      sql`${table.currency} is null or ${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    // Revenue at risk is meaningless without a currency.
    check(
      "exceptions_risk_requires_currency",
      sql`${table.revenueAtRiskMinor} is null or ${table.currency} is not null`,
    ),
  ],
);

/**
 * Append-only timeline for one exception: creation, re-detection, assignment
 * and every state transition, with the actor and an optional bounded note.
 */
export const exceptionEvents = pgTable(
  "exception_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    exceptionId: uuid("exception_id")
      .notNull()
      .references(() => exceptions.id, { onDelete: "cascade" }),
    /** e.g. "created", "reopened", "assigned", "state_changed", "redetected". */
    action: text("action").notNull(),
    fromState: exceptionStateEnum("from_state"),
    toState: exceptionStateEnum("to_state"),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Bounded operator note. Never contains secrets; length-checked on write. */
    note: text("note"),
    /** Correlates this event with the request or job that caused it. */
    correlationId: text("correlation_id"),
    runId: uuid("run_id").references(() => reconciliationRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("exception_events_exception_idx").on(table.exceptionId, table.createdAt),
    index("exception_events_org_idx").on(table.organizationId),
    check("exception_events_note_len", sql`${table.note} is null or length(${table.note}) <= 2000`),
  ],
);
