/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * Tests for webhook verification and processing. The signature verifier is
 * injected and every event comes from `fixtures.ts`, so no live Stripe
 * account, no webhook secret and no network are involved.
 * See docs/adr/0007-stripe-context-separation.md.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  WebhookPayloadError,
  WebhookSignatureError,
  processEvent,
  verifyAndParse,
  type BillingEvent,
  type SignatureVerifier,
} from "./webhooks";
import { getEntitlements } from "./entitlements";
import { createMemoryBillingStore, type MemoryBillingStore } from "./memory-store";
import {
  FIXTURE_ENV,
  FIXTURE_EPOCH_SECONDS,
  FIXTURE_ORGANIZATION_ID,
  FIXTURE_PRICE_GROWTH,
  FIXTURE_PRICE_STARTER,
  FIXTURE_PRICE_UNMAPPED,
  FIXTURE_STRIPE_CUSTOMER_ID,
  FIXTURE_SUBSCRIPTION_ID,
  checkoutSessionCompleted,
  invoicePaid,
  invoicePaymentFailed,
  legacySubscriptionObject,
  outOfOrderSubscriptionPair,
  subscriptionCreated,
  subscriptionDeleted,
  subscriptionUpdated,
} from "./fixtures";

const ORG = FIXTURE_ORGANIZATION_ID;
const DEPS = { env: FIXTURE_ENV } as const;

let store: MemoryBillingStore;

beforeEach(() => {
  store = createMemoryBillingStore();
  store.seedOrganization({ id: ORG, name: "Acme" });
  // The billing customer is what ties a Stripe event back to a tenant.
  store.seedBillingCustomer({ organizationId: ORG, stripeCustomerId: FIXTURE_STRIPE_CUSTOMER_ID });
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

describe("verifyAndParse", () => {
  const event = subscriptionCreated();
  const rawBody = JSON.stringify(event);

  it("returns the event when the signature verifies", () => {
    const verifier: SignatureVerifier = () => event;

    const parsed = verifyAndParse(rawBody, "t=1,v1=deadbeef", {
      verifier,
      webhookSecret: "whsec_fixture",
    });

    expect(parsed.id).toBe(event.id);
    expect(parsed.type).toBe("customer.subscription.created");
  });

  it("rejects an invalid signature with a DISTINCT error type", () => {
    // Distinct because the HTTP answer differs: a bad signature is a permanent
    // 400, while a database failure is a 500 that Stripe should retry.
    const verifier: SignatureVerifier = () => {
      throw new Error("No signatures found matching the expected signature for payload");
    };

    expect(() =>
      verifyAndParse(rawBody, "t=1,v1=bogus", { verifier, webhookSecret: "whsec_fixture" }),
    ).toThrow(WebhookSignatureError);
  });

  it("rejects a missing signature header without calling the verifier", () => {
    let called = false;
    const verifier: SignatureVerifier = () => {
      called = true;
      return event;
    };

    expect(() => verifyAndParse(rawBody, "", { verifier, webhookSecret: "whsec_fixture" })).toThrow(
      WebhookSignatureError,
    );
    expect(called).toBe(false);
  });

  it("hands the verifier the RAW body, byte for byte", () => {
    // The signature is an HMAC over the literal bytes. Re-serialising the body
    // — a JSON body-parser round trip, a reformat, a re-encode — silently
    // invalidates it, so this asserts nothing rewrites it on the way through.
    const rawWithOddFormatting = '{\n  "id":"evt_x",  "type":"invoice.paid",\n"created": 1 }';
    let seen: string | Buffer | null = null;

    const verifier: SignatureVerifier = (body) => {
      seen = body;
      return event;
    };

    verifyAndParse(rawWithOddFormatting, "t=1,v1=ok", {
      verifier,
      webhookSecret: "whsec_fixture",
    });

    expect(seen).toBe(rawWithOddFormatting);
  });

  it("accepts a Buffer body unchanged", () => {
    const buffer = Buffer.from(rawBody, "utf8");
    let seen: string | Buffer | null = null;
    const verifier: SignatureVerifier = (body) => {
      seen = body;
      return event;
    };

    verifyAndParse(buffer, "t=1,v1=ok", { verifier, webhookSecret: "whsec_fixture" });

    expect(seen).toBe(buffer);
  });

  it("rejects a verified payload that is not a Stripe event", () => {
    const verifier: SignatureVerifier = () => ({ id: "evt_1" });

    expect(() =>
      verifyAndParse(rawBody, "t=1,v1=ok", { verifier, webhookSecret: "whsec_fixture" }),
    ).toThrow(WebhookPayloadError);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("processEvent idempotency", () => {
  it("applies the SAME event id exactly once", async () => {
    const event = subscriptionCreated({ priceId: FIXTURE_PRICE_GROWTH });

    const first = await processEvent(store, event, DEPS);
    const second = await processEvent(store, event, DEPS);

    expect(first.status).toBe("processed");
    expect(second).toEqual({ status: "duplicate", stripeEventId: event.id });

    // The row was written once, not twice.
    expect(store.subscriptionWriteCount()).toBe(1);
    expect(store.listSubscriptions(ORG)).toHaveLength(1);
    expect(store.listWebhookEvents()).toHaveLength(1);
  });

  it("does not re-audit a duplicate delivery", async () => {
    const event = subscriptionCreated();

    await processEvent(store, event, DEPS);
    const auditsAfterFirst = store.listAudits().length;
    await processEvent(store, event, DEPS);

    expect(store.listAudits()).toHaveLength(auditsAfterFirst);
  });

  it("stores a durable receipt for every event", async () => {
    await processEvent(store, subscriptionCreated(), DEPS);

    const [receipt] = store.listWebhookEvents();
    expect(receipt?.status).toBe("processed");
    expect(receipt?.organizationId).toBe(ORG);
    expect(receipt?.eventCreatedAt).toEqual(new Date((FIXTURE_EPOCH_SECONDS + 60) * 1000));
  });

  it("reprocesses a redelivery of an event whose first attempt failed", async () => {
    // A `failed` receipt means the work did NOT land. Treating that as a
    // duplicate would drop the change permanently.
    const event = subscriptionCreated();
    await store.claimWebhookEvent({
      stripeEventId: event.id,
      type: event.type,
      organizationId: null,
      eventCreatedAt: new Date(event.created * 1000),
    });
    await store.markWebhookEvent(event.id, { status: "failed", errorMessage: "database down" });

    const result = await processEvent(store, event, DEPS);

    expect(result.status).toBe("processed");
    expect(store.listSubscriptions(ORG)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Order tolerance
// ---------------------------------------------------------------------------

describe("processEvent order tolerance", () => {
  it("does NOT let an older event overwrite newer subscription state", async () => {
    const { older, newer } = outOfOrderSubscriptionPair();

    const applied = await processEvent(store, newer, DEPS);
    const stale = await processEvent(store, older, DEPS);

    expect(applied.status).toBe("processed");
    expect(stale).toEqual({ status: "ignored_stale", stripeEventId: older.id });

    const [subscription] = store.listSubscriptions(ORG);
    expect(subscription?.planKey).toBe("growth");
    expect(subscription?.stripePriceId).toBe(FIXTURE_PRICE_GROWTH);
    expect(subscription?.lastEventAt).toEqual(new Date(newer.created * 1000));

    // And the entitlement the customer actually sees did not regress.
    expect((await getEntitlements(store, ORG)).planKey).toBe("growth");
  });

  it("applies the same pair correctly when they arrive in order", async () => {
    const { older, newer } = outOfOrderSubscriptionPair();

    await processEvent(store, older, DEPS);
    await processEvent(store, newer, DEPS);

    const [subscription] = store.listSubscriptions(ORG);
    expect(subscription?.planKey).toBe("growth");
    expect(store.subscriptionWriteCount()).toBe(2);
  });

  it("records the stale event as ignored rather than dropping it silently", async () => {
    const { older, newer } = outOfOrderSubscriptionPair();

    await processEvent(store, newer, DEPS);
    await processEvent(store, older, DEPS);

    const receipt = store.listWebhookEvents().find((row) => row.stripeEventId === older.id);
    expect(receipt?.status).toBe("ignored");
    expect(receipt?.errorMessage).toContain("older");
  });
});

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

describe("customer.subscription.*", () => {
  it("derives the plan from the PRICE, not from event metadata", async () => {
    // The metadata claims `scale`; the price says `starter`. The price wins.
    const event = subscriptionCreated({ priceId: FIXTURE_PRICE_STARTER });
    const object = event.data.object as Record<string, unknown>;
    object.metadata = { organizationId: ORG, planKey: "scale", plan: "scale" };

    await processEvent(store, event, DEPS);

    expect(store.listSubscriptions(ORG)[0]?.planKey).toBe("starter");
    expect((await getEntitlements(store, ORG)).planKey).toBe("starter");
  });

  it("stores the full subscription state and syncs the organization's plan", async () => {
    const trialEnd = FIXTURE_EPOCH_SECONDS + 14 * 24 * 3_600;
    await processEvent(
      store,
      subscriptionCreated({
        priceId: FIXTURE_PRICE_GROWTH,
        status: "trialing",
        trialEnd,
        cancelAtPeriodEnd: true,
      }),
      DEPS,
    );

    const [subscription] = store.listSubscriptions(ORG);
    expect(subscription?.status).toBe("trialing");
    expect(subscription?.planKey).toBe("growth");
    expect(subscription?.cancelAtPeriodEnd).toBe(true);
    expect(subscription?.trialEndsAt).toEqual(new Date(trialEnd * 1000));
    expect(subscription?.currentPeriodEnd).not.toBeNull();

    expect((await store.findOrganization(ORG))?.planKey).toBe("growth");
    const entitlementsAudit = store
      .listAudits()
      .find((row) => row.action === "billing.entitlements_changed");
    expect(entitlementsAudit?.metadata.planKey).toBe("growth");
  });

  it("reads current_period_end from the subscription ITEM", async () => {
    const periodEnd = FIXTURE_EPOCH_SECONDS + 45 * 24 * 3_600;
    await processEvent(store, subscriptionCreated({ currentPeriodEnd: periodEnd }), DEPS);

    expect(store.listSubscriptions(ORG)[0]?.currentPeriodEnd).toEqual(new Date(periodEnd * 1000));
  });

  it("still reads current_period_end from a replayed pre-2025 payload", async () => {
    // Stripe renders a replayed event against the API version current when it
    // was created, so the old top-level field can still turn up.
    const periodEnd = FIXTURE_EPOCH_SECONDS + 60 * 24 * 3_600;
    const event: BillingEvent = {
      id: "evt_legacy_shape",
      type: "customer.subscription.updated",
      created: FIXTURE_EPOCH_SECONDS + 500,
      data: { object: legacySubscriptionObject({ currentPeriodEnd: periodEnd }) },
    };

    const result = await processEvent(store, event, DEPS);

    expect(result.status).toBe("processed");
    expect(store.listSubscriptions(ORG)[0]?.currentPeriodEnd).toEqual(new Date(periodEnd * 1000));
  });

  it("cancels on deletion and drops the organization back to free", async () => {
    await processEvent(store, subscriptionCreated({ priceId: FIXTURE_PRICE_GROWTH }), DEPS);
    await processEvent(store, subscriptionDeleted({ priceId: FIXTURE_PRICE_GROWTH }), DEPS);

    const [subscription] = store.listSubscriptions(ORG);
    expect(subscription?.status).toBe("canceled");
    expect(subscription?.canceledAt).not.toBeNull();

    const entitlements = await getEntitlements(store, ORG);
    expect(entitlements.planKey).toBe("free");
    expect(entitlements.isActive).toBe(false);
    // What was bought is still on the record.
    expect(entitlements.subscribedPlanKey).toBe("growth");
    expect((await store.findOrganization(ORG))?.planKey).toBe("free");
  });

  it("keeps the customer's existing plan when the price maps to nothing", async () => {
    // A price added in Stripe but never wired up here is OUR misconfiguration.
    // Dropping a paying customer to free over it would be exactly the
    // destructive downgrade this package is supposed to avoid.
    await processEvent(store, subscriptionCreated({ priceId: FIXTURE_PRICE_GROWTH }), DEPS);
    await processEvent(
      store,
      subscriptionUpdated({ priceId: FIXTURE_PRICE_UNMAPPED, eventId: "evt_unmapped" }),
      DEPS,
    );

    expect(store.listSubscriptions(ORG)[0]?.planKey).toBe("growth");

    // …but it is recorded so an operator can see it.
    const receipt = store.listWebhookEvents().find((row) => row.stripeEventId === "evt_unmapped");
    expect(receipt?.status).toBe("processed");
    expect(receipt?.errorMessage).toContain("not mapped");
  });

  it("ignores an event that cannot be tied to a tenant", async () => {
    const event = subscriptionCreated({
      eventId: "evt_unknown_tenant",
      stripeCustomerId: "cus_never_seen",
      organizationId: null,
    });

    const result = await processEvent(store, event, DEPS);

    expect(result.status).toBe("ignored_unmapped");
    expect(store.listSubscriptions()).toHaveLength(0);
  });

  it("reports a failure instead of throwing when the payload is unusable", async () => {
    const broken: BillingEvent = {
      id: "evt_broken",
      type: "customer.subscription.updated",
      created: FIXTURE_EPOCH_SECONDS,
      data: { object: { id: FIXTURE_SUBSCRIPTION_ID, customer: FIXTURE_STRIPE_CUSTOMER_ID } },
    };

    const result = await processEvent(store, broken, DEPS);

    expect(result.status).toBe("failed");
    // Left `failed`, not `processed`, so Stripe's redelivery is reprocessed.
    expect(store.listWebhookEvents()[0]?.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

describe("invoice events", () => {
  beforeEach(async () => {
    await processEvent(store, subscriptionCreated({ priceId: FIXTURE_PRICE_GROWTH }), DEPS);
  });

  it("moves an active subscription to past_due when payment fails", async () => {
    const result = await processEvent(store, invoicePaymentFailed(), DEPS);

    expect(result.status).toBe("processed");
    expect(store.listSubscriptions(ORG)[0]?.status).toBe("past_due");

    // And the customer is STILL entitled — dunning must not break the product.
    const entitlements = await getEntitlements(store, ORG);
    expect(entitlements.isActive).toBe(true);
    expect(entitlements.planKey).toBe("growth");
    expect((await store.findOrganization(ORG))?.planKey).toBe("growth");
  });

  it("restores an active subscription when payment recovers", async () => {
    await processEvent(store, invoicePaymentFailed(), DEPS);
    await processEvent(store, invoicePaid({ created: FIXTURE_EPOCH_SECONDS + 400 }), DEPS);

    expect(store.listSubscriptions(ORG)[0]?.status).toBe("active");
  });

  it("reads the subscription from the legacy flat field too", async () => {
    const result = await processEvent(store, invoicePaymentFailed({ legacyShape: true }), DEPS);

    expect(result.status).toBe("processed");
    expect(store.listSubscriptions(ORG)[0]?.status).toBe("past_due");
  });

  it("leaves a canceled subscription alone", async () => {
    // An invoice event must never resurrect a cancellation.
    await processEvent(store, subscriptionDeleted({ priceId: FIXTURE_PRICE_GROWTH }), DEPS);

    const result = await processEvent(
      store,
      invoicePaid({ created: FIXTURE_EPOCH_SECONDS + 600 }),
      DEPS,
    );

    expect(result.status).toBe("ignored_unmapped");
    expect(store.listSubscriptions(ORG)[0]?.status).toBe("canceled");
  });

  it("ignores a one-off invoice with no subscription", async () => {
    const result = await processEvent(store, invoicePaid({ subscriptionId: null }), DEPS);
    expect(result.status).toBe("ignored_unmapped");
  });
});

// ---------------------------------------------------------------------------
// Checkout completion and unhandled types
// ---------------------------------------------------------------------------

describe("checkout.session.completed", () => {
  it("binds a Stripe customer created out of band to the organization", async () => {
    const fresh = createMemoryBillingStore();
    fresh.seedOrganization({ id: ORG, name: "Acme" });

    const result = await processEvent(
      fresh,
      checkoutSessionCompleted({ stripeCustomerId: "cus_out_of_band" }),
      DEPS,
    );

    expect(result.status).toBe("processed");
    expect((await fresh.findBillingCustomerByStripeId("cus_out_of_band"))?.organizationId).toBe(
      ORG,
    );
  });

  it("does not invent subscription state", async () => {
    // The authoritative subscription arrives moments later as
    // `customer.subscription.created`; reading it out of the session too would
    // be a second, racier source of truth for the same fact.
    await processEvent(store, checkoutSessionCompleted(), DEPS);

    expect(store.listSubscriptions()).toHaveLength(0);
    expect((await getEntitlements(store, ORG)).planKey).toBe("free");
  });

  it("ignores a session that names no organization", async () => {
    const fresh = createMemoryBillingStore();
    fresh.seedOrganization({ id: ORG, name: "Acme" });

    const result = await processEvent(
      fresh,
      checkoutSessionCompleted({ organizationId: null, stripeCustomerId: "cus_orphan" }),
      DEPS,
    );

    expect(result.status).toBe("ignored_unmapped");
  });
});

describe("unhandled event types", () => {
  it("records and ignores an event this package does not act on", async () => {
    const event: BillingEvent = {
      id: "evt_unhandled",
      type: "payment_intent.succeeded",
      created: FIXTURE_EPOCH_SECONDS,
      data: { object: { id: "pi_1" } },
    };

    const result = await processEvent(store, event, DEPS);

    expect(result).toEqual({
      status: "ignored_unhandled",
      stripeEventId: "evt_unhandled",
      type: "payment_intent.succeeded",
    });
    expect(store.listWebhookEvents()[0]?.status).toBe("ignored");
  });

  it("treats a redelivery of an ignored event as a duplicate", async () => {
    const event: BillingEvent = {
      id: "evt_unhandled",
      type: "payment_intent.succeeded",
      created: FIXTURE_EPOCH_SECONDS,
      data: { object: { id: "pi_1" } },
    };

    await processEvent(store, event, DEPS);
    const second = await processEvent(store, event, DEPS);

    expect(second.status).toBe("duplicate");
  });
});
