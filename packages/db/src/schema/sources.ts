import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
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
  connectionStatusEnum,
  providerInvoiceStatusEnum,
  providerPaymentStatusEnum,
  providerRefundStatusEnum,
  providerSubscriptionStatusEnum,
  syncResourceEnum,
  syncStatusEnum,
} from "./enums";

/** Raw binary column for ciphertext, nonce and auth tag. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * A customer's READ-ONLY Stripe connection.
 *
 * This is the "customer data integration" Stripe context. It is completely
 * separate from PayRecon's own billing (see schema/billing.ts): different
 * tables, different services, different environment variables. No code path
 * reachable from here performs a Stripe write.
 */
export const stripeConnections = pgTable(
  "stripe_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** `acct_...` from the validated key. Non-secret. */
    stripeAccountId: text("stripe_account_id"),
    /** Business name reported by Stripe, for operator recognition only. */
    accountDisplayName: text("account_display_name"),
    /** True when the restricted key targets live mode. */
    livemode: boolean("livemode").notNull().default(false),
    status: connectionStatusEnum("status").notNull().default("pending_validation"),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true, mode: "date" }),
    /** Sanitised reason a validation failed. Never contains key material. */
    lastValidationError: text("last_validation_error"),
    /** Resources the restricted key was observed to be able to read. */
    readableResources: jsonb("readable_resources")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("stripe_connections_org_idx").on(table.organizationId),
    // One connection per Stripe account per organization, ignoring deleted rows.
    uniqueIndex("stripe_connections_org_account_uidx")
      .on(table.organizationId, table.stripeAccountId)
      .where(sql`${table.deletedAt} is null and ${table.stripeAccountId} is not null`),
  ],
);

/**
 * Encrypted restricted keys, versioned to support rotation and re-encryption.
 *
 * AES-256-GCM. The nonce is unique per encryption. `aad` records the additional
 * authenticated data binding the ciphertext to its organization and connection,
 * so a ciphertext moved to another tenant's row fails to decrypt.
 *
 * Only ONE active version exists per connection at a time; `revokedAt` makes a
 * credential immediately unusable without deleting the audit trail.
 */
export const stripeCredentials = pgTable(
  "stripe_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    ciphertext: bytea("ciphertext").notNull(),
    nonce: bytea("nonce").notNull(),
    authTag: bytea("auth_tag").notNull(),
    /** Identifies WHICH master key encrypted this row, for rotation. */
    keyId: text("key_id").notNull(),
    /** Envelope format version, so the scheme can evolve safely. */
    encryptionVersion: integer("encryption_version").notNull().default(1),
    /** Non-secret prefix such as `rk_live` for display and audit. */
    keyKind: text("key_kind").notNull(),
    /** Last four characters, for operator recognition. Never more. */
    keyLastFour: text("key_last_four").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("stripe_credentials_connection_idx").on(table.connectionId),
    uniqueIndex("stripe_credentials_active_uidx")
      .on(table.connectionId)
      .where(sql`${table.revokedAt} is null`),
    check("stripe_credentials_last_four_len", sql`length(${table.keyLastFour}) <= 4`),
  ],
);

// ---------------------------------------------------------------------------
// Synchronisation bookkeeping
// ---------------------------------------------------------------------------

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    status: syncStatusEnum("status").notNull().default("queued"),
    /** True for the first full backfill of a connection. */
    isInitial: boolean("is_initial").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
    /** Per-resource counts: { charges: { fetched, upserted } , ... }. */
    stats: jsonb("stats")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Coarse failure class for metrics, e.g. "rate_limited", "auth". */
    errorCategory: text("error_category"),
    /** Sanitised message. Never contains key material or raw payloads. */
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("sync_runs_org_connection_idx").on(table.organizationId, table.connectionId),
    index("sync_runs_created_idx").on(table.createdAt),
  ],
);

/**
 * Per-resource cursors.
 *
 * `lastSuccessfulAt` only advances when a resource completes cleanly, so a
 * failure on page 7 can never discard the checkpoint earned by pages 1-6 of a
 * previous successful run.
 */
export const syncCheckpoints = pgTable(
  "sync_checkpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    resource: syncResourceEnum("resource").notNull(),
    /** Stripe object id used as the pagination cursor. */
    cursor: text("cursor"),
    /** Upper bound of the window already covered, for incremental sync. */
    syncedThrough: timestamp("synced_through", { withTimezone: true, mode: "date" }),
    lastSuccessfulAt: timestamp("last_successful_at", { withTimezone: true, mode: "date" }),
    lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sync_checkpoints_connection_resource_uidx").on(table.connectionId, table.resource),
    index("sync_checkpoints_org_idx").on(table.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// Synced provider objects (minimised)
// ---------------------------------------------------------------------------
//
// Only fields required for matching and evidence are stored. No card details,
// no billing addresses, no raw Stripe payloads.

export const providerPayments = pgTable(
  "provider_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    /** Stripe object id, e.g. `pi_...` / `ch_...`. */
    providerId: text("provider_id").notNull(),
    kind: text("kind").notNull(), // payment_intent | charge
    status: providerPaymentStatusEnum("status").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    amountRefundedMinor: bigint("amount_refunded_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    currency: text("currency").notNull(),
    providerCustomerId: text("provider_customer_id"),
    providerInvoiceId: text("provider_invoice_id"),
    paymentIntentId: text("payment_intent_id"),
    disputed: boolean("disputed").notNull().default(false),
    /** Bounded, non-sensitive metadata subset used for correlation. */
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // Tenant-scoped natural key: makes sync upserts idempotent.
    uniqueIndex("provider_payments_org_provider_uidx").on(table.organizationId, table.providerId),
    index("provider_payments_org_status_created_idx").on(
      table.organizationId,
      table.status,
      table.providerCreatedAt,
    ),
    index("provider_payments_org_customer_idx").on(table.organizationId, table.providerCustomerId),
    check("provider_payments_currency_upper", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check("provider_payments_amount_nonneg", sql`${table.amountMinor} >= 0`),
    check("provider_payments_refund_nonneg", sql`${table.amountRefundedMinor} >= 0`),
  ],
);

export const providerRefunds = pgTable(
  "provider_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    /** Stripe id of the charge/payment intent this refund applies to. */
    providerPaymentId: text("provider_payment_id"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    status: providerRefundStatusEnum("status").notNull(),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_refunds_org_provider_uidx").on(table.organizationId, table.providerId),
    index("provider_refunds_org_payment_idx").on(table.organizationId, table.providerPaymentId),
    check("provider_refunds_currency_upper", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const providerInvoices = pgTable(
  "provider_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    status: providerInvoiceStatusEnum("status").notNull(),
    amountDueMinor: bigint("amount_due_minor", { mode: "bigint" }).notNull(),
    amountPaidMinor: bigint("amount_paid_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    currency: text("currency").notNull(),
    providerCustomerId: text("provider_customer_id"),
    providerSubscriptionId: text("provider_subscription_id"),
    attemptCount: integer("attempt_count").notNull().default(0),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_invoices_org_provider_uidx").on(table.organizationId, table.providerId),
    index("provider_invoices_org_subscription_idx").on(
      table.organizationId,
      table.providerSubscriptionId,
    ),
    check("provider_invoices_currency_upper", sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const providerSubscriptions = pgTable(
  "provider_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    status: providerSubscriptionStatusEnum("status").notNull(),
    providerCustomerId: text("provider_customer_id"),
    currency: text("currency").notNull(),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    canceledAt: timestamp("canceled_at", { withTimezone: true, mode: "date" }),
    currentPeriodStart: timestamp("current_period_start", { withTimezone: true, mode: "date" }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: "date" }),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_subscriptions_org_provider_uidx").on(
      table.organizationId,
      table.providerId,
    ),
    index("provider_subscriptions_org_customer_idx").on(
      table.organizationId,
      table.providerCustomerId,
    ),
  ],
);

/**
 * Minimal customer identity, used only to label evidence.
 * Email is stored because operators need to recognise the customer; no address,
 * phone or payment-method data is retained.
 */
export const providerCustomers = pgTable(
  "provider_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    email: text("email"),
    name: text("name"),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_customers_org_provider_uidx").on(table.organizationId, table.providerId),
  ],
);

export const providerDisputes = pgTable(
  "provider_disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    providerPaymentId: text("provider_payment_id"),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    reason: text("reason"),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_disputes_org_provider_uidx").on(table.organizationId, table.providerId),
  ],
);

export const providerPayouts = pgTable(
  "provider_payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    status: text("status").notNull(),
    arrivalDate: timestamp("arrival_date", { withTimezone: true, mode: "date" }),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_payouts_org_provider_uidx").on(table.organizationId, table.providerId),
  ],
);

export const providerBalanceTransactions = pgTable(
  "provider_balance_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => stripeConnections.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    type: text("type").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    feeMinor: bigint("fee_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    netMinor: bigint("net_minor", { mode: "bigint" }).notNull(),
    currency: text("currency").notNull(),
    sourceId: text("source_id"),
    providerCreatedAt: timestamp("provider_created_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("provider_balance_txn_org_provider_uidx").on(
      table.organizationId,
      table.providerId,
    ),
  ],
);
