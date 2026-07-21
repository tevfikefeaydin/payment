/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * Tests for the plan/price mapping. No live Stripe account, no network, no
 * key: price ids are plain fixture strings in an injected environment.
 * See docs/adr/0007-stripe-context-separation.md.
 */
import { describe, expect, it } from "vitest";
import { PLANS } from "@payrecon/config";
import {
  isPurchasablePlan,
  listConfiguredPlanKeys,
  planForPriceId,
  priceIdForPlan,
  toPurchasablePlanKey,
} from "./plan-mapping";
import {
  FIXTURE_ENV,
  FIXTURE_PRICE_GROWTH,
  FIXTURE_PRICE_STARTER,
  FIXTURE_PRICE_UNMAPPED,
} from "./fixtures";

describe("priceIdForPlan", () => {
  it("resolves a purchasable plan to its configured price", () => {
    expect(priceIdForPlan("starter", FIXTURE_ENV)).toBe(FIXTURE_PRICE_STARTER);
    expect(priceIdForPlan("growth", FIXTURE_ENV)).toBe(FIXTURE_PRICE_GROWTH);
  });

  it("returns null for the free plan, which has no price to sell", () => {
    expect(PLANS.free.priceEnvVar).toBeNull();
    expect(priceIdForPlan("free", FIXTURE_ENV)).toBeNull();
    expect(isPurchasablePlan("free")).toBe(false);
  });

  it("returns null when the plan's price variable is unset", () => {
    expect(priceIdForPlan("starter", {})).toBeNull();
  });

  it("treats a blank price variable as unset rather than as a valid id", () => {
    expect(priceIdForPlan("starter", { PLATFORM_STRIPE_PRICE_STARTER: "   " })).toBeNull();
  });
});

describe("toPurchasablePlanKey", () => {
  it("accepts a real, purchasable plan key", () => {
    expect(toPurchasablePlanKey("growth")).toBe("growth");
  });

  it("rejects a key that is not a plan at all", () => {
    // The shape of a hostile request body: a plan key nobody sells.
    expect(toPurchasablePlanKey("enterprise")).toBeNull();
    expect(toPurchasablePlanKey("")).toBeNull();
    expect(toPurchasablePlanKey("FREE")).toBeNull();
  });

  it("rejects a real plan that is not purchasable", () => {
    expect(toPurchasablePlanKey("free")).toBeNull();
  });
});

describe("planForPriceId", () => {
  it("maps a configured price back to its internal plan", () => {
    expect(planForPriceId(FIXTURE_PRICE_STARTER, FIXTURE_ENV)).toBe("starter");
    expect(planForPriceId(FIXTURE_PRICE_GROWTH, FIXTURE_ENV)).toBe("growth");
  });

  it("returns null for a price that is not a PayRecon plan", () => {
    // A price that exists in the Stripe account — an internal one, a legacy
    // one, a partner one — must not entitle anybody to anything.
    expect(planForPriceId(FIXTURE_PRICE_UNMAPPED, FIXTURE_ENV)).toBeNull();
    expect(planForPriceId("", FIXTURE_ENV)).toBeNull();
  });

  it("refuses to guess when one price is configured for two plans", () => {
    // Misconfiguration. Picking one would, half the time, hand out the more
    // generous plan's limits.
    const ambiguous = {
      PLATFORM_STRIPE_PRICE_STARTER: "price_same",
      PLATFORM_STRIPE_PRICE_GROWTH: "price_same",
    };
    expect(planForPriceId("price_same", ambiguous)).toBeNull();
  });
});

describe("listConfiguredPlanKeys", () => {
  it("lists only plans that can actually be checked out", () => {
    expect(listConfiguredPlanKeys(FIXTURE_ENV)).toEqual(["starter", "growth", "scale"]);
  });

  it("is empty when no prices are configured", () => {
    expect(listConfiguredPlanKeys({})).toEqual([]);
  });
});
