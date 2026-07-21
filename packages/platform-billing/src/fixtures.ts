/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * Every fixture here imitates an event from PAYRECON's Stripe account about a
 * PayRecon subscription. None of it represents a customer's operational
 * payments, and none of the amounts here are reconcilable revenue.
 * See docs/adr/0007-stripe-context-separation.md.
 *
 * ---
 *
 * Deterministic, hand-written Stripe event fixtures.
 *
 * Hand-written rather than captured from a live account, so the default test
 * suite needs NO Stripe account, no API key, and no network — a requirement of
 * the build, not a convenience. Everything is fixed: ids, timestamps, prices.
 * A test that fails does so because behaviour changed, never because a clock
 * moved or an account was reconfigured.
 *
 * These are plain objects shaped like the fields `webhooks.ts` actually reads.
 * They are NOT complete Stripe resources, and they are not meant to be: a
 * fixture that reproduced every field of a real subscription would be mostly
 * noise, and the reader ignores all of it anyway.
 */
import type { BillingEnvSource } from "./client";
import type { BillingEvent } from "./webhooks";

// ---------------------------------------------------------------------------
// Fixed identifiers
// ---------------------------------------------------------------------------

export const FIXTURE_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_OTHER_ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";

/** Customer and subscription ids in PAYRECON's Stripe account. */
export const FIXTURE_STRIPE_CUSTOMER_ID = "cus_PayReconFixture01";
export const FIXTURE_SUBSCRIPTION_ID = "sub_PayReconFixture01";

export const FIXTURE_PRICE_STARTER = "price_fixture_starter";
export const FIXTURE_PRICE_GROWTH = "price_fixture_growth";
export const FIXTURE_PRICE_SCALE = "price_fixture_scale";
/** A price that exists in the account but maps to no PayRecon plan. */
export const FIXTURE_PRICE_UNMAPPED = "price_fixture_not_a_plan";

/**
 * Environment for tests: ONLY the plan price variables.
 *
 * No secret key and no webhook secret, deliberately. Tests inject a fake
 * verifier and a fake client instead, which keeps this file free of anything
 * shaped like a credential.
 */
export const FIXTURE_ENV: BillingEnvSource = Object.freeze({
  PLATFORM_STRIPE_PRICE_STARTER: FIXTURE_PRICE_STARTER,
  PLATFORM_STRIPE_PRICE_GROWTH: FIXTURE_PRICE_GROWTH,
  PLATFORM_STRIPE_PRICE_SCALE: FIXTURE_PRICE_SCALE,
});

/** 2026-02-01T00:00:00Z, in Stripe's unit (seconds). */
export const FIXTURE_EPOCH_SECONDS = 1_769_904_000;
export const ONE_HOUR_SECONDS = 3_600;
export const THIRTY_DAYS_SECONDS = 30 * 24 * ONE_HOUR_SECONDS;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface SubscriptionFixtureOptions {
  subscriptionId?: string;
  stripeCustomerId?: string;
  organizationId?: string | null;
  status?: string;
  priceId?: string;
  /** Seconds since epoch. */
  currentPeriodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  trialEnd?: number | null;
  canceledAt?: number | null;
}

/**
 * A subscription object in the CURRENT shape, where `current_period_end` lives
 * on the item rather than on the subscription. `legacySubscriptionObject` below
 * covers the older shape that replayed events still arrive in.
 */
export function subscriptionObject(options: SubscriptionFixtureOptions = {}): unknown {
  const {
    subscriptionId = FIXTURE_SUBSCRIPTION_ID,
    stripeCustomerId = FIXTURE_STRIPE_CUSTOMER_ID,
    organizationId = FIXTURE_ORGANIZATION_ID,
    status = "active",
    priceId = FIXTURE_PRICE_STARTER,
    currentPeriodEnd = FIXTURE_EPOCH_SECONDS + THIRTY_DAYS_SECONDS,
    cancelAtPeriodEnd = false,
    trialEnd = null,
    canceledAt = null,
  } = options;

  return {
    id: subscriptionId,
    object: "subscription",
    customer: stripeCustomerId,
    status,
    cancel_at_period_end: cancelAtPeriodEnd,
    trial_end: trialEnd,
    canceled_at: canceledAt,
    metadata: organizationId === null ? {} : { organizationId },
    items: {
      object: "list",
      data: [
        {
          id: `si_${subscriptionId}`,
          object: "subscription_item",
          current_period_start: currentPeriodEnd - THIRTY_DAYS_SECONDS,
          current_period_end: currentPeriodEnd,
          price: { id: priceId, object: "price" },
        },
      ],
    },
  };
}

/** Pre-2025 shape: `current_period_end` on the subscription, no item periods. */
export function legacySubscriptionObject(options: SubscriptionFixtureOptions = {}): unknown {
  const {
    subscriptionId = FIXTURE_SUBSCRIPTION_ID,
    stripeCustomerId = FIXTURE_STRIPE_CUSTOMER_ID,
    organizationId = FIXTURE_ORGANIZATION_ID,
    status = "active",
    priceId = FIXTURE_PRICE_STARTER,
    currentPeriodEnd = FIXTURE_EPOCH_SECONDS + THIRTY_DAYS_SECONDS,
  } = options;

  return {
    id: subscriptionId,
    object: "subscription",
    customer: stripeCustomerId,
    status,
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: false,
    trial_end: null,
    canceled_at: null,
    metadata: organizationId === null ? {} : { organizationId },
    items: {
      object: "list",
      data: [{ id: `si_${subscriptionId}`, object: "subscription_item", price: { id: priceId } }],
    },
  };
}

function event(id: string, type: string, created: number, object: unknown): BillingEvent {
  return { id, type, created, data: { object } };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface CheckoutFixtureOptions {
  eventId?: string;
  created?: number;
  stripeCustomerId?: string;
  organizationId?: string | null;
  subscriptionId?: string;
}

export function checkoutSessionCompleted(options: CheckoutFixtureOptions = {}): BillingEvent {
  const {
    eventId = "evt_fixture_checkout_completed",
    created = FIXTURE_EPOCH_SECONDS,
    stripeCustomerId = FIXTURE_STRIPE_CUSTOMER_ID,
    organizationId = FIXTURE_ORGANIZATION_ID,
    subscriptionId = FIXTURE_SUBSCRIPTION_ID,
  } = options;

  return event(eventId, "checkout.session.completed", created, {
    id: "cs_fixture_0001",
    object: "checkout.session",
    mode: "subscription",
    status: "complete",
    payment_status: "paid",
    customer: stripeCustomerId,
    subscription: subscriptionId,
    // Set server-side by createCheckoutSession.
    client_reference_id: organizationId,
    metadata: organizationId === null ? {} : { organizationId },
  });
}

export interface SubscriptionEventOptions extends SubscriptionFixtureOptions {
  eventId?: string;
  created?: number;
}

export function subscriptionCreated(options: SubscriptionEventOptions = {}): BillingEvent {
  const { eventId = "evt_fixture_sub_created", created = FIXTURE_EPOCH_SECONDS + 60 } = options;
  return event(eventId, "customer.subscription.created", created, subscriptionObject(options));
}

export function subscriptionUpdated(options: SubscriptionEventOptions = {}): BillingEvent {
  const { eventId = "evt_fixture_sub_updated", created = FIXTURE_EPOCH_SECONDS + 120 } = options;
  return event(eventId, "customer.subscription.updated", created, subscriptionObject(options));
}

export function subscriptionDeleted(options: SubscriptionEventOptions = {}): BillingEvent {
  const { eventId = "evt_fixture_sub_deleted", created = FIXTURE_EPOCH_SECONDS + 180 } = options;
  return event(
    eventId,
    "customer.subscription.deleted",
    created,
    subscriptionObject({ status: "canceled", canceledAt: created, ...options }),
  );
}

export interface InvoiceFixtureOptions {
  eventId?: string;
  created?: number;
  stripeCustomerId?: string;
  subscriptionId?: string | null;
  /** Emit the pre-2025 flat `subscription` field instead of `parent`. */
  legacyShape?: boolean;
}

function invoiceObject(options: InvoiceFixtureOptions): unknown {
  const {
    stripeCustomerId = FIXTURE_STRIPE_CUSTOMER_ID,
    subscriptionId = FIXTURE_SUBSCRIPTION_ID,
    legacyShape = false,
  } = options;

  const base = {
    id: "in_fixture_0001",
    object: "invoice",
    customer: stripeCustomerId,
    currency: "usd",
    amount_due: 4900,
    amount_paid: 4900,
  };

  if (subscriptionId === null) return { ...base, parent: null };
  if (legacyShape) return { ...base, subscription: subscriptionId };

  return {
    ...base,
    parent: {
      type: "subscription_details",
      quote_details: null,
      subscription_details: { subscription: subscriptionId, metadata: null },
    },
  };
}

export function invoicePaid(options: InvoiceFixtureOptions = {}): BillingEvent {
  const { eventId = "evt_fixture_invoice_paid", created = FIXTURE_EPOCH_SECONDS + 240 } = options;
  return event(eventId, "invoice.paid", created, invoiceObject(options));
}

export function invoicePaymentFailed(options: InvoiceFixtureOptions = {}): BillingEvent {
  const { eventId = "evt_fixture_invoice_failed", created = FIXTURE_EPOCH_SECONDS + 300 } = options;
  return event(eventId, "invoice.payment_failed", created, invoiceObject(options));
}

// ---------------------------------------------------------------------------
// Out-of-order pair
// ---------------------------------------------------------------------------

/**
 * Two `customer.subscription.updated` events for the SAME subscription, where
 * the newer one upgrades to Growth and the older one still says Starter.
 *
 * Delivering `older` after `newer` is the exact situation Stripe produces when
 * a first delivery attempt is retried behind a later event. Applying it must
 * not regress the stored plan.
 */
export function outOfOrderSubscriptionPair(): { older: BillingEvent; newer: BillingEvent } {
  const older = subscriptionUpdated({
    eventId: "evt_fixture_sub_older",
    created: FIXTURE_EPOCH_SECONDS + 1_000,
    priceId: FIXTURE_PRICE_STARTER,
    status: "active",
    currentPeriodEnd: FIXTURE_EPOCH_SECONDS + THIRTY_DAYS_SECONDS,
  });

  const newer = subscriptionUpdated({
    eventId: "evt_fixture_sub_newer",
    created: FIXTURE_EPOCH_SECONDS + 2_000,
    priceId: FIXTURE_PRICE_GROWTH,
    status: "active",
    currentPeriodEnd: FIXTURE_EPOCH_SECONDS + 2 * THIRTY_DAYS_SECONDS,
  });

  return { older, newer };
}
