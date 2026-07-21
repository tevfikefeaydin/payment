/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * Tests for checkout and portal sessions. The Stripe client is a hand-written
 * fake, so no live account, no API key and no network are involved.
 * See docs/adr/0007-stripe-context-separation.md.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { createCheckoutSession, createPortalSession } from "./checkout";
import type { PlatformStripeClient } from "./client";
import { BillingConfigurationError, BillingRequestError } from "./errors";
import { createMemoryBillingStore, type MemoryBillingStore } from "./memory-store";
import {
  FIXTURE_ENV,
  FIXTURE_ORGANIZATION_ID,
  FIXTURE_PRICE_GROWTH,
  FIXTURE_PRICE_STARTER,
  FIXTURE_STRIPE_CUSTOMER_ID,
} from "./fixtures";

const ORG = FIXTURE_ORGANIZATION_ID;
const ACTOR = "99999999-9999-4999-8999-999999999999";

interface FakeStripe extends PlatformStripeClient {
  customerCreates: Stripe.CustomerCreateParams[];
  checkoutCreates: Stripe.Checkout.SessionCreateParams[];
  portalCreates: Stripe.BillingPortal.SessionCreateParams[];
}

function createFakeStripe(): FakeStripe {
  const customerCreates: Stripe.CustomerCreateParams[] = [];
  const checkoutCreates: Stripe.Checkout.SessionCreateParams[] = [];
  const portalCreates: Stripe.BillingPortal.SessionCreateParams[] = [];

  return {
    customerCreates,
    checkoutCreates,
    portalCreates,
    customers: {
      async create(params) {
        customerCreates.push(params);
        return { id: `cus_created_${customerCreates.length}` };
      },
    },
    checkout: {
      sessions: {
        async create(params) {
          checkoutCreates.push(params);
          return { id: "cs_test_0001", url: "https://checkout.stripe.test/session" };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          portalCreates.push(params);
          return { url: "https://portal.stripe.test/session" };
        },
      },
    },
  };
}

/** First line item's price, whatever shape the caller used. */
function priceOf(params: Stripe.Checkout.SessionCreateParams): string | undefined {
  return params.line_items?.[0]?.price;
}

let store: MemoryBillingStore;
let stripe: FakeStripe;

beforeEach(() => {
  store = createMemoryBillingStore();
  store.seedOrganization({ id: ORG, name: "Acme" });
  stripe = createFakeStripe();
});

describe("createCheckoutSession", () => {
  it("resolves the price server-side from the plan key", async () => {
    const result = await createCheckoutSession(
      store,
      {
        organizationId: ORG,
        planKey: "growth",
        successUrl: "https://app.test/ok",
        cancelUrl: "https://app.test/no",
        actorUserId: ACTOR,
      },
      { stripe, env: FIXTURE_ENV },
    );

    expect(result.url).toBe("https://checkout.stripe.test/session");
    expect(result.planKey).toBe("growth");
    expect(priceOf(stripe.checkoutCreates[0]!)).toBe(FIXTURE_PRICE_GROWTH);
    expect(stripe.checkoutCreates[0]?.mode).toBe("subscription");
  });

  it("IGNORES a price id supplied by the caller", async () => {
    // The input type has no `priceId` field, so a browser cannot express one.
    // This simulates a hostile request body carrying an extra property anyway
    // — e.g. a $0 test price — and proves it is never read.
    const hostileInput = {
      organizationId: ORG,
      planKey: "growth",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
      actorUserId: ACTOR,
      priceId: "price_attacker_controlled",
      price: "price_attacker_controlled",
      amount: 1,
      currency: "usd",
    } as unknown as Parameters<typeof createCheckoutSession>[1];

    await createCheckoutSession(store, hostileInput, { stripe, env: FIXTURE_ENV });

    const params = stripe.checkoutCreates[0]!;
    expect(priceOf(params)).toBe(FIXTURE_PRICE_GROWTH);
    expect(JSON.stringify(params)).not.toContain("attacker_controlled");
  });

  it("IGNORES a Stripe customer id supplied by the caller", async () => {
    // Accepting one would let anyone who learned another tenant's customer id
    // start a session against their billing account.
    store.seedBillingCustomer({
      organizationId: ORG,
      stripeCustomerId: FIXTURE_STRIPE_CUSTOMER_ID,
    });

    const hostileInput = {
      organizationId: ORG,
      planKey: "starter",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
      actorUserId: ACTOR,
      customer: "cus_someone_else",
      customerId: "cus_someone_else",
    } as unknown as Parameters<typeof createCheckoutSession>[1];

    await createCheckoutSession(store, hostileInput, { stripe, env: FIXTURE_ENV });

    expect(stripe.checkoutCreates[0]?.customer).toBe(FIXTURE_STRIPE_CUSTOMER_ID);
    expect(priceOf(stripe.checkoutCreates[0]!)).toBe(FIXTURE_PRICE_STARTER);
  });

  it("creates the Stripe customer once and reuses it", async () => {
    const input = {
      organizationId: ORG,
      planKey: "starter",
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
      actorUserId: ACTOR,
    } as const;

    await createCheckoutSession(store, input, { stripe, env: FIXTURE_ENV });
    await createCheckoutSession(store, input, { stripe, env: FIXTURE_ENV });

    expect(stripe.customerCreates).toHaveLength(1);
    expect(stripe.checkoutCreates[0]?.customer).toBe(stripe.checkoutCreates[1]?.customer);
  });

  it("tags the session with the organization, server-side", async () => {
    await createCheckoutSession(
      store,
      {
        organizationId: ORG,
        planKey: "starter",
        successUrl: "https://app.test/ok",
        cancelUrl: "https://app.test/no",
        actorUserId: ACTOR,
      },
      { stripe, env: FIXTURE_ENV },
    );

    const params = stripe.checkoutCreates[0]!;
    expect(params.client_reference_id).toBe(ORG);
    expect(params.metadata?.organizationId).toBe(ORG);
    expect(params.subscription_data?.metadata?.organizationId).toBe(ORG);
  });

  it("audits the checkout without recording a price or a key", async () => {
    await createCheckoutSession(
      store,
      {
        organizationId: ORG,
        planKey: "growth",
        successUrl: "https://app.test/ok",
        cancelUrl: "https://app.test/no",
        actorUserId: ACTOR,
      },
      { stripe, env: FIXTURE_ENV },
    );

    const audit = store.listAudits().find((row) => row.action === "billing.checkout_started");
    expect(audit).toBeDefined();
    expect(audit?.organizationId).toBe(ORG);
    expect(audit?.actorUserId).toBe(ACTOR);
    expect(audit?.metadata).toEqual({ planKey: "growth" });
  });

  it("rejects a plan key that is not a real plan", async () => {
    await expect(
      createCheckoutSession(
        store,
        {
          organizationId: ORG,
          planKey: "enterprise" as never,
          successUrl: "https://app.test/ok",
          cancelUrl: "https://app.test/no",
          actorUserId: ACTOR,
        },
        { stripe, env: FIXTURE_ENV },
      ),
    ).rejects.toBeInstanceOf(BillingRequestError);

    expect(stripe.checkoutCreates).toHaveLength(0);
  });

  it("rejects the free plan, which is not purchasable", async () => {
    await expect(
      createCheckoutSession(
        store,
        {
          organizationId: ORG,
          planKey: "free",
          successUrl: "https://app.test/ok",
          cancelUrl: "https://app.test/no",
          actorUserId: ACTOR,
        },
        { stripe, env: FIXTURE_ENV },
      ),
    ).rejects.toBeInstanceOf(BillingRequestError);
  });

  it("rejects an unknown organization before touching Stripe", async () => {
    await expect(
      createCheckoutSession(
        store,
        {
          organizationId: "00000000-0000-4000-8000-00000000dead",
          planKey: "starter",
          successUrl: "https://app.test/ok",
          cancelUrl: "https://app.test/no",
          actorUserId: ACTOR,
        },
        { stripe, env: FIXTURE_ENV },
      ),
    ).rejects.toBeInstanceOf(BillingRequestError);

    expect(stripe.customerCreates).toHaveLength(0);
  });

  it("reports a configuration gap when the plan has no configured price", async () => {
    await expect(
      createCheckoutSession(
        store,
        {
          organizationId: ORG,
          planKey: "starter",
          successUrl: "https://app.test/ok",
          cancelUrl: "https://app.test/no",
          actorUserId: ACTOR,
        },
        { stripe, env: {} },
      ),
    ).rejects.toBeInstanceOf(BillingConfigurationError);
  });
});

describe("createPortalSession", () => {
  it("opens the portal for the organization's own customer", async () => {
    store.seedBillingCustomer({
      organizationId: ORG,
      stripeCustomerId: FIXTURE_STRIPE_CUSTOMER_ID,
    });

    const result = await createPortalSession(
      store,
      { organizationId: ORG, returnUrl: "https://app.test/billing", actorUserId: ACTOR },
      { stripe, env: FIXTURE_ENV },
    );

    expect(result.url).toBe("https://portal.stripe.test/session");
    expect(stripe.portalCreates[0]?.customer).toBe(FIXTURE_STRIPE_CUSTOMER_ID);
    expect(stripe.portalCreates[0]?.return_url).toBe("https://app.test/billing");
  });

  it("IGNORES a customer id supplied by the caller", async () => {
    store.seedBillingCustomer({
      organizationId: ORG,
      stripeCustomerId: FIXTURE_STRIPE_CUSTOMER_ID,
    });

    const hostileInput = {
      organizationId: ORG,
      returnUrl: "https://app.test/billing",
      actorUserId: ACTOR,
      customer: "cus_someone_else",
    } as unknown as Parameters<typeof createPortalSession>[1];

    await createPortalSession(store, hostileInput, { stripe, env: FIXTURE_ENV });

    expect(stripe.portalCreates[0]?.customer).toBe(FIXTURE_STRIPE_CUSTOMER_ID);
  });

  it("refuses when the organization has never checked out", async () => {
    await expect(
      createPortalSession(
        store,
        { organizationId: ORG, returnUrl: "https://app.test/billing", actorUserId: ACTOR },
        { stripe, env: FIXTURE_ENV },
      ),
    ).rejects.toBeInstanceOf(BillingRequestError);

    expect(stripe.portalCreates).toHaveLength(0);
  });

  it("audits the portal visit", async () => {
    store.seedBillingCustomer({
      organizationId: ORG,
      stripeCustomerId: FIXTURE_STRIPE_CUSTOMER_ID,
    });

    await createPortalSession(
      store,
      { organizationId: ORG, returnUrl: "https://app.test/billing", actorUserId: ACTOR },
      { stripe, env: FIXTURE_ENV },
    );

    const audit = store.listAudits().find((row) => row.action === "billing.portal_opened");
    expect(audit?.organizationId).toBe(ORG);
    expect(audit?.actorUserId).toBe(ACTOR);
  });
});
