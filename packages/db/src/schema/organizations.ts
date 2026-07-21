import { sql } from "drizzle-orm";
import {
  boolean,
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
import { organizationRoleEnum, planKeyEnum } from "./enums";
import { users } from "./auth";

/**
 * Organizations are the tenant boundary AND the billable entity.
 *
 * Every tenant-owned table in this schema carries `organization_id` directly,
 * rather than relying on a join to establish ownership. That redundancy is
 * deliberate: it makes an unscoped query obviously wrong in review, and lets
 * every index start with the tenant key.
 */

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    planKey: planKeyEnum("plan_key").notNull().default("free"),
    /**
     * Days of imported source data retained before scheduled cleanup.
     * Bounded by RETENTION_MIN_DAYS/RETENTION_MAX_DAYS in @payrecon/config.
     */
    retentionDays: integer("retention_days").notNull().default(90),
    /** Non-sensitive organization preferences. Never holds credentials. */
    settings: jsonb("settings")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** True for the seeded demo organization; drives UI affordances only. */
    isDemo: boolean("is_demo").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("organizations_slug_uidx").on(table.slug),
    check("organizations_retention_bounds", sql`${table.retentionDays} between 7 and 365`),
    check("organizations_slug_format", sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'`),
  ],
);

export const organizationMembers = pgTable(
  "organization_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: organizationRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    // A user holds exactly one role per organization.
    uniqueIndex("organization_members_org_user_uidx").on(table.organizationId, table.userId),
    index("organization_members_user_idx").on(table.userId),
    index("organization_members_org_role_idx").on(table.organizationId, table.role),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: organizationRoleEnum("role").notNull(),
    /** SHA-256 of the invitation token. The plaintext exists only in the email. */
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("invitations_token_hash_uidx").on(table.tokenHash),
    index("invitations_org_idx").on(table.organizationId),
    // At most one outstanding invitation per email per organization.
    uniqueIndex("invitations_org_email_pending_uidx")
      .on(table.organizationId, sql`lower(${table.email})`)
      .where(sql`${table.acceptedAt} is null and ${table.revokedAt} is null`),
  ],
);
