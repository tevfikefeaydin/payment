import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
import { exceptions } from "./reconciliation";
import {
  exceptionSeverityEnum,
  notificationDeliveryStatusEnum,
  notificationDestinationStatusEnum,
  notificationDigestEnum,
  notificationKindEnum,
} from "./enums";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

/**
 * Where notifications are sent.
 *
 * A Slack webhook URL is a credential and is encrypted at rest with the same
 * AES-256-GCM envelope used for Stripe restricted keys. An email address is not
 * a credential and is stored in `target` directly.
 */
export const notificationDestinations = pgTable(
  "notification_destinations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: notificationKindEnum("kind").notNull(),
    name: text("name").notNull(),
    /** Email address for `email`; NULL for `slack` (the URL is encrypted below). */
    target: text("target"),
    /** Encrypted Slack webhook URL. NULL for email destinations. */
    secretCiphertext: bytea("secret_ciphertext"),
    secretNonce: bytea("secret_nonce"),
    secretAuthTag: bytea("secret_auth_tag"),
    secretKeyId: text("secret_key_id"),
    /** Non-secret hint such as `hooks.slack.com/…/T0A1`. */
    secretHint: text("secret_hint"),
    status: notificationDestinationStatusEnum("status").notNull().default("pending_verification"),
    /** Set once a test message has been delivered successfully. */
    verifiedAt: timestamp("verified_at", { withTimezone: true, mode: "date" }),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("notification_destinations_org_idx").on(table.organizationId),
    uniqueIndex("notification_destinations_org_name_uidx").on(table.organizationId, table.name),
  ],
);

/** Which exceptions reach a destination, and how they are batched. */
export const notificationPolicies = pgTable(
  "notification_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => notificationDestinations.id, { onDelete: "cascade" }),
    minSeverity: exceptionSeverityEnum("min_severity").notNull().default("high"),
    /** Only notify when revenue at risk meets this threshold, if set. */
    minRevenueAtRiskMinor: bigint("min_revenue_at_risk_minor", { mode: "bigint" }),
    /** Restrict to one currency, or NULL for all currencies. */
    currency: text("currency"),
    digest: notificationDigestEnum("digest").notNull().default("hourly"),
    /** Critical exceptions may bypass the digest and send immediately. */
    criticalBypassesDigest: boolean("critical_bypasses_digest").notNull().default(true),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("notification_policies_org_idx").on(table.organizationId),
    index("notification_policies_destination_idx").on(table.destinationId),
  ],
);

/**
 * One delivery attempt group.
 *
 * `dedupeKey` is unique per organization and encodes policy + subject + window,
 * so the same exception cannot notify the same destination twice for the same
 * reason, even if two workers process overlapping batches.
 */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").references(() => notificationPolicies.id, {
      onDelete: "set null",
    }),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => notificationDestinations.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    status: notificationDeliveryStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    /** Non-sensitive summary of what was sent, for the delivery log UI. */
    summary: jsonb("summary")
      .notNull()
      .default(sql`'{}'::jsonb`),
    exceptionCount: integer("exception_count").notNull().default(0),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("notification_deliveries_org_dedupe_uidx").on(
      table.organizationId,
      table.dedupeKey,
    ),
    index("notification_deliveries_status_scheduled_idx").on(table.status, table.scheduledFor),
    index("notification_deliveries_org_idx").on(table.organizationId),
  ],
);

/** Join table recording exactly which exceptions each delivery covered. */
export const notificationDeliveryItems = pgTable(
  "notification_delivery_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    deliveryId: uuid("delivery_id")
      .notNull()
      .references(() => notificationDeliveries.id, { onDelete: "cascade" }),
    exceptionId: uuid("exception_id")
      .notNull()
      .references(() => exceptions.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("notification_delivery_items_uidx").on(table.deliveryId, table.exceptionId),
    index("notification_delivery_items_exception_idx").on(table.exceptionId),
  ],
);
