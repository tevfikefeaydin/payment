import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Authentication tables.
 *
 * Passwords are stored only as scrypt hashes (see @payrecon/auth/password), and
 * session tokens only as SHA-256 hashes: a database disclosure must not yield a
 * usable session. Reset and verification tokens follow the same rule.
 */

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stored lowercase; uniqueness is enforced case-insensitively below. */
    email: text("email").notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true, mode: "date" }),
    /** scrypt hash with embedded parameters and salt. Never a plaintext password. */
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /** Set when the account is deactivated; sessions are revoked at the same time. */
    disabledAt: timestamp("disabled_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [uniqueIndex("users_email_lower_uidx").on(sql`lower(${table.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the opaque session token. The token itself is never stored. */
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /** Absolute expiry. Enforced in SQL on every lookup, not only by cookie age. */
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    /** Advanced on use; drives the idle timeout. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    /** Truncated/hashed client hints for session review. Never a raw IP. */
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uidx").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expiresAt),
  ],
);

/**
 * Single-use tokens for password reset and email verification.
 * Only the hash is stored; the plaintext exists solely inside the email.
 */
export const authTokens = pgTable(
  "auth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(), // "password_reset" | "email_verification"
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("auth_tokens_hash_uidx").on(table.tokenHash),
    index("auth_tokens_user_purpose_idx").on(table.userId, table.purpose),
  ],
);
