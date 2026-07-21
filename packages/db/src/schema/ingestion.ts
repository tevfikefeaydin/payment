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
import { importStatusEnum, internalPaymentStatusEnum, recordSourceEnum } from "./enums";

/**
 * Internal payment records: the customer's own view of a payment, ingested via
 * CSV, the versioned REST API, or the demo seeder.
 *
 * `(organization_id, external_id)` is the natural key. Upserts target it, which
 * makes both CSV re-imports and API retries idempotent.
 */
export const internalPaymentRecords = pgTable(
  "internal_payment_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The customer's own identifier for this payment. */
    externalId: text("external_id").notNull(),
    customerId: text("customer_id"),
    orderId: text("order_id"),
    subscriptionId: text("subscription_id"),
    /** The provider transaction this record claims to correspond to. */
    providerTransactionId: text("provider_transaction_id"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    status: internalPaymentStatusEnum("status").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "date" }).notNull(),
    /** `updatedAt` as reported by the source system, if supplied. */
    recordUpdatedAt: timestamp("record_updated_at", { withTimezone: true, mode: "date" }),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    source: recordSourceEnum("source").notNull(),
    /** Import batch that most recently wrote this row, when applicable. */
    importBatchId: uuid("import_batch_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("internal_records_org_external_uidx").on(table.organizationId, table.externalId),
    index("internal_records_org_status_occurred_idx").on(
      table.organizationId,
      table.status,
      table.occurredAt,
    ),
    index("internal_records_org_provider_txn_idx").on(
      table.organizationId,
      table.providerTransactionId,
    ),
    index("internal_records_org_customer_idx").on(table.organizationId, table.customerId),
    check("internal_records_currency_upper", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Sanitised original filename. Never used as a filesystem path. */
    filename: text("filename").notNull(),
    byteSize: integer("byte_size").notNull(),
    status: importStatusEnum("status").notNull().default("uploaded"),
    /** Column mapping chosen by the operator, including the amount unit. */
    mapping: jsonb("mapping"),
    /** Detected header row. */
    headers: jsonb("headers")
      .notNull()
      .default(sql`'[]'::jsonb`),
    totalRows: integer("total_rows").notNull().default(0),
    validRows: integer("valid_rows").notNull().default(0),
    errorRows: integer("error_rows").notNull().default(0),
    insertedRows: integer("inserted_rows").notNull().default(0),
    updatedRows: integer("updated_rows").notNull().default(0),
    /**
     * The uploaded file content. Retained only until the batch completes and the
     * organization's retention window elapses, whichever is sooner.
     */
    rawContent: text("raw_content"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    errorMessage: text("error_message"),
  },
  (table) => [index("import_batches_org_created_idx").on(table.organizationId, table.createdAt)],
);

export const importRowErrors = pgTable(
  "import_row_errors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    /** 1-based row number as the operator sees it in their spreadsheet. */
    rowNumber: integer("row_number").notNull(),
    column: text("column"),
    message: text("message").notNull(),
    /** Short, sanitised excerpt of the offending value for context. */
    valueExcerpt: text("value_excerpt"),
  },
  (table) => [
    index("import_row_errors_batch_idx").on(table.batchId, table.rowNumber),
    index("import_row_errors_org_idx").on(table.organizationId),
  ],
);

/** Saved column mappings so a recurring export format is mapped once. */
export const mappingTemplates = pgTable(
  "mapping_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mapping: jsonb("mapping").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("mapping_templates_org_name_uidx").on(table.organizationId, table.name)],
);

// ---------------------------------------------------------------------------
// Organization API keys
// ---------------------------------------------------------------------------

/**
 * API keys are shown in plaintext exactly once, at creation.
 * Only a SHA-256 hash and a short non-secret prefix are stored; verification is
 * a constant-time comparison against the hash.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Non-secret identifying prefix, e.g. `prk_live_a1b2c3d4`. */
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: jsonb("scopes")
      .notNull()
      .default(sql`'["records:write"]'::jsonb`),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("api_keys_hash_uidx").on(table.keyHash),
    uniqueIndex("api_keys_prefix_uidx").on(table.prefix),
    index("api_keys_org_idx").on(table.organizationId),
  ],
);

/**
 * Idempotency records for mutating API requests.
 *
 * Scoped by organization so one tenant's key can never collide with, or read,
 * another's. The request hash detects reuse of the same key with different
 * content, which must be rejected rather than silently returning a stale result.
 */
export const apiIdempotencyRecords = pgTable(
  "api_idempotency_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    /** SHA-256 over method + path + canonical body. */
    requestHash: text("request_hash").notNull(),
    /** Null while the original request is still in flight. */
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    uniqueIndex("api_idempotency_org_key_uidx").on(table.organizationId, table.idempotencyKey),
    index("api_idempotency_expires_idx").on(table.expiresAt),
  ],
);

/**
 * Fixed-window rate-limit buckets for the ingestion API.
 *
 * A dedicated table rather than `usage_counters`, because that table's `period`
 * is constrained to `YYYY-MM` for monthly billing and cannot express a
 * sub-minute window.
 *
 * The bucket is keyed by `(organization_id, bucket_key)` where `bucket_key`
 * itself embeds the organization, the API key and the window start. Carrying
 * the tenant in BOTH the key and the index column means one organization's
 * traffic can never consume another's allowance, even if a future caller
 * constructs a key by hand.
 */
export const apiRateLimitBuckets = pgTable(
  "api_rate_limit_buckets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "cascade" }),
    bucketKey: text("bucket_key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true, mode: "date" }).notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("api_rate_limit_org_bucket_uidx").on(table.organizationId, table.bucketKey),
    // Supports cheap deletion of elapsed windows by the retention job.
    index("api_rate_limit_window_idx").on(table.windowStart),
  ],
);

/**
 * Monthly usage counters backing plan-limit enforcement.
 * `period` is a UTC `YYYY-MM` string so a month boundary is unambiguous.
 */
export const usageCounters = pgTable(
  "usage_counters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    period: text("period").notNull(),
    metric: text("metric").notNull(),
    count: bigint("count", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("usage_counters_org_period_metric_uidx").on(
      table.organizationId,
      table.period,
      table.metric,
    ),
    check("usage_counters_period_format", sql`${table.period} ~ '^[0-9]{4}-[0-9]{2}$'`),
  ],
);
