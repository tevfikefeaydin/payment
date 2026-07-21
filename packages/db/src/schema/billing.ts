import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { billingSubscriptionStatusEnum, planKeyEnum, webhookProcessingStatusEnum } from "./enums";

/**
 * PayRecon's OWN subscription billing.
 *
 * This is the "platform billing" Stripe context and is deliberately isolated
 * from the customer data integration in schema/sources.ts:
 *   - different tables (nothing here references stripe_connections),
 *   - different credentials (PLATFORM_STRIPE_* environment variables),
 *   - different clients, services, routes and webhook handlers.
 *
 * ESLint additionally forbids the two packages from importing each other.
 * Revenue recorded here is PayRecon's revenue and is never mixed with a
 * customer's reconciled operational revenue.
 */

export const billingCustomers = pgTable(
  "billing_customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Customer id in PayRecon's own Stripe account. */
    stripeCustomerId: text("stripe_customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_customers_org_uidx").on(table.organizationId),
    uniqueIndex("billing_customers_stripe_uidx").on(table.stripeCustomerId),
  ],
);

export const billingSubscriptions = pgTable(
  "billing_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text("stripe_subscription_id").notNull(),
    status: billingSubscriptionStatusEnum("status").notNull(),
    /** Resolved SERVER-SIDE from the price id. Never supplied by the browser. */
    planKey: planKeyEnum("plan_key").notNull(),
    stripePriceId: text("stripe_price_id"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: "date" }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true, mode: "date" }),
    canceledAt: timestamp("canceled_at", { withTimezone: true, mode: "date" }),
    /**
     * Stripe's monotonically increasing indicator for this object. Used to
     * ignore events that arrive out of order without losing newer state.
     */
    lastEventAt: timestamp("last_event_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_subscriptions_stripe_uidx").on(table.stripeSubscriptionId),
    index("billing_subscriptions_org_idx").on(table.organizationId),
  ],
);

/**
 * Durable webhook receipts.
 *
 * `stripe_event_id` is unique, which makes processing idempotent: a redelivered
 * event conflicts on insert and is recognised as already handled rather than
 * applied twice.
 */
export const billingWebhookEvents = pgTable(
  "billing_webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeEventId: text("stripe_event_id").notNull(),
    type: text("type").notNull(),
    /** Organization resolved from the event, when it maps to one. */
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    status: webhookProcessingStatusEnum("status").notNull().default("received"),
    /** Stripe's event creation time, used for ordering. */
    eventCreatedAt: timestamp("event_created_at", { withTimezone: true, mode: "date" }),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true, mode: "date" }),
    attempts: jsonb("attempts")
      .notNull()
      .default(sql`'[]'::jsonb`),
    errorMessage: text("error_message"),
  },
  (table) => [
    uniqueIndex("billing_webhook_events_stripe_uidx").on(table.stripeEventId),
    index("billing_webhook_events_status_idx").on(table.status),
  ],
);
