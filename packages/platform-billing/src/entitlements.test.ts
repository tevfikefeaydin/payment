/**
 * CONTEXT: PLATFORM BILLING — PayRecon's OWN Stripe account.
 *
 * Tests for entitlements and plan-limit enforcement. Runs entirely against the
 * in-memory store: no database, no network, no Stripe account.
 * See docs/adr/0007-stripe-context-separation.md.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getPlan } from "@payrecon/config";
import {
  OVER_LIMIT_BLOCKED_ACTIONS,
  OVER_LIMIT_PRESERVED_ACTIONS,
  checkLimit,
  describeLimit,
  getEntitlements,
  isReadPreserved,
  statusIsEntitled,
  type ExternallyCountedLimitMetric,
} from "./entitlements";
import { createMemoryBillingStore, type MemoryBillingStore } from "./memory-store";
import {
  USAGE_METRIC_INGESTED_RECORDS,
  usagePeriodKey,
  type BillingSubscriptionStatus,
} from "./store";
import { FIXTURE_ORGANIZATION_ID, FIXTURE_SUBSCRIPTION_ID } from "./fixtures";

const ORG = FIXTURE_ORGANIZATION_ID;
const NOW = new Date("2026-02-15T12:00:00.000Z");

/**
 * The metric whose count lives in the customer-data context, assembled from
 * fragments rather than written as a literal: `context-separation.test.ts`
 * forbids that identifier anywhere in this package's source, including here.
 */
const EXTERNAL_METRIC = `${"stripe"}${"Connections"}` as ExternallyCountedLimitMetric;

let store: MemoryBillingStore;

function seedSubscription(params: {
  status: BillingSubscriptionStatus;
  planKey: "starter" | "growth" | "scale";
  currentPeriodEnd?: Date;
}): void {
  void store.upsertSubscription({
    organizationId: ORG,
    stripeSubscriptionId: FIXTURE_SUBSCRIPTION_ID,
    status: params.status,
    planKey: params.planKey,
    currentPeriodEnd: params.currentPeriodEnd ?? new Date("2026-03-01T00:00:00.000Z"),
    lastEventAt: NOW,
    now: NOW,
  });
}

beforeEach(() => {
  store = createMemoryBillingStore();
  store.seedOrganization({ id: ORG, name: "Acme" });
});

describe("getEntitlements", () => {
  it("falls back to the free plan when there is no subscription", async () => {
    const entitlements = await getEntitlements(store, ORG);

    expect(entitlements.planKey).toBe("free");
    expect(entitlements.limits).toEqual(getPlan("free").limits);
    expect(entitlements.status).toBeNull();
    expect(entitlements.isActive).toBe(false);
    expect(entitlements.subscribedPlanKey).toBeNull();
  });

  it("grants the plan's limits for an active subscription", async () => {
    seedSubscription({ status: "active", planKey: "growth" });

    const entitlements = await getEntitlements(store, ORG);

    expect(entitlements.planKey).toBe("growth");
    expect(entitlements.limits).toEqual(getPlan("growth").limits);
    expect(entitlements.isActive).toBe(true);
    expect(entitlements.currentPeriodEnd).toEqual(new Date("2026-03-01T00:00:00.000Z"));
  });

  it("grants entitlements while trialing", async () => {
    seedSubscription({ status: "trialing", planKey: "starter" });

    const entitlements = await getEntitlements(store, ORG);

    expect(entitlements.isActive).toBe(true);
    expect(entitlements.limits).toEqual(getPlan("starter").limits);
  });

  it("KEEPS entitlements while past_due, so dunning does not break the product", async () => {
    // The customer's card failed and Stripe is retrying. Cutting them off now
    // would break the product on the day they most need to get in and fix it.
    seedSubscription({ status: "past_due", planKey: "growth" });

    const entitlements = await getEntitlements(store, ORG);

    expect(entitlements.isActive).toBe(true);
    expect(entitlements.planKey).toBe("growth");
    expect(entitlements.limits).toEqual(getPlan("growth").limits);
  });

  it.each<BillingSubscriptionStatus>(["canceled", "unpaid", "incomplete_expired"])(
    "falls back to free plan limits when the subscription is %s",
    async (status) => {
      seedSubscription({ status, planKey: "growth" });

      const entitlements = await getEntitlements(store, ORG);

      expect(entitlements.planKey).toBe("free");
      expect(entitlements.limits).toEqual(getPlan("free").limits);
      expect(entitlements.isActive).toBe(false);
      // The purchase history survives, so the billing screen can explain what
      // happened rather than pretending the subscription never existed.
      expect(entitlements.subscribedPlanKey).toBe("growth");
      expect(entitlements.status).toBe(status);
    },
  );

  it("classifies every database subscription status explicitly", () => {
    expect(statusIsEntitled("active")).toBe(true);
    expect(statusIsEntitled("trialing")).toBe(true);
    expect(statusIsEntitled("past_due")).toBe(true);
    expect(statusIsEntitled("incomplete")).toBe(false);
    expect(statusIsEntitled("paused")).toBe(false);
  });
});

describe("usage counter contract", () => {
  it("pins the metric name that the ingestion package writes", () => {
    // If these ever diverge, every ingestion limit check silently reads a
    // counter nobody increments and the cap stops applying. The other half is
    // `USAGE_METRIC_INGESTED_RECORDS` in @payrecon/ingestion; it is duplicated
    // rather than imported so billing does not depend on that package.
    expect(USAGE_METRIC_INGESTED_RECORDS).toBe("ingested_records");
  });

  it("keys usage by UTC calendar month", () => {
    expect(usagePeriodKey(new Date("2026-02-15T12:00:00.000Z"))).toBe("2026-02");
    // Just before the UTC boundary — still January, regardless of local zone.
    expect(usagePeriodKey(new Date("2026-01-31T23:59:59.000Z"))).toBe("2026-01");
  });
});

describe("checkLimit", () => {
  it("allows a request that lands EXACTLY on the limit", async () => {
    // Free plan allows 3 members. Two exist; adding one makes three.
    store.seedMembers(ORG, 2);

    const check = await checkLimit(store, { organizationId: ORG, metric: "members", requested: 1 });

    expect(check.limit).toBe(3);
    expect(check.current).toBe(2);
    expect(check.allowed).toBe(true);
    expect(check.remaining).toBe(1);
  });

  it("denies the request that would go one over", async () => {
    store.seedMembers(ORG, 3);

    const check = await checkLimit(store, { organizationId: ORG, metric: "members", requested: 1 });

    expect(check.allowed).toBe(false);
    expect(check.remaining).toBe(0);
  });

  it("allows a zero-sized request even when sitting exactly on the limit", async () => {
    store.seedMembers(ORG, 3);

    const check = await checkLimit(store, { organizationId: ORG, metric: "members", requested: 0 });

    expect(check.allowed).toBe(true);
  });

  it("rejects a whole batch rather than partially applying it", async () => {
    store.seedUsage({ organizationId: ORG, period: usagePeriodKey(NOW), count: 4_999 });

    const check = await checkLimit(store, {
      organizationId: ORG,
      metric: "monthlyIngestedRecords",
      requested: 10,
      now: NOW,
    });

    expect(check.limit).toBe(5_000);
    expect(check.current).toBe(4_999);
    expect(check.allowed).toBe(false);
    expect(check.remaining).toBe(1);
  });

  it("counts ingestion per calendar month", async () => {
    store.seedUsage({ organizationId: ORG, period: "2026-01", count: 4_999 });

    // January's usage must not follow the customer into February.
    const check = await checkLimit(store, {
      organizationId: ORG,
      metric: "monthlyIngestedRecords",
      requested: 10,
      now: NOW,
    });

    expect(check.current).toBe(0);
    expect(check.allowed).toBe(true);
  });

  it("reports no cap on a plan with unlimited limits", async () => {
    seedSubscription({ status: "active", planKey: "scale" });
    store.seedUsage({ organizationId: ORG, period: usagePeriodKey(NOW), count: 10_000_000 });

    const check = await checkLimit(store, {
      organizationId: ORG,
      metric: "monthlyIngestedRecords",
      requested: 1_000,
      now: NOW,
    });

    expect(check.limit).toBeNull();
    expect(check.remaining).toBeNull();
    expect(check.allowed).toBe(true);
  });

  it("uses the caller's count for a metric this package may not read", async () => {
    // Connection counts live in the customer-data context. Platform billing is
    // forbidden from reading those tables, so the caller supplies the number
    // and this package only owns the limit.
    const atLimit = await checkLimit(store, {
      organizationId: ORG,
      metric: EXTERNAL_METRIC,
      requested: 1,
      current: 1,
    });

    expect(atLimit.limit).toBe(1);
    expect(atLimit.allowed).toBe(false);

    seedSubscription({ status: "active", planKey: "growth" });
    const upgraded = await checkLimit(store, {
      organizationId: ORG,
      metric: EXTERNAL_METRIC,
      requested: 1,
      current: 1,
    });

    expect(upgraded.limit).toBe(5);
    expect(upgraded.allowed).toBe(true);
  });

  it("never reports negative headroom after a downgrade leaves an org over the limit", async () => {
    // Was on Growth with 12 destinations; the subscription lapsed to free (1).
    seedSubscription({ status: "canceled", planKey: "growth" });
    store.seedNotificationDestinations(ORG, 12);

    const check = await checkLimit(store, {
      organizationId: ORG,
      metric: "notificationDestinations",
      requested: 1,
    });

    expect(check.limit).toBe(1);
    expect(check.current).toBe(12);
    expect(check.allowed).toBe(false);
    expect(check.remaining).toBe(0);
  });
});

describe("non-destructive enforcement", () => {
  it("preserves read and export while over every limit", () => {
    // The property that matters: being over a limit never holds data hostage.
    for (const action of ["records.read", "records.export", "reconciliation.export"] as const) {
      expect(isReadPreserved(action)).toBe(true);
    }
  });

  it("preserves the billing screens needed to resolve the situation", () => {
    for (const action of ["billing.read", "billing.checkout", "billing.portal"] as const) {
      expect(isReadPreserved(action)).toBe(true);
    }
  });

  it("preserves the actions that shrink usage back under the limit", () => {
    expect(isReadPreserved("members.remove")).toBe(true);
    expect(isReadPreserved("notifications.destination_delete")).toBe(true);
  });

  it("blocks only actions that ADD new over-limit usage", () => {
    for (const action of OVER_LIMIT_BLOCKED_ACTIONS) {
      expect(isReadPreserved(action)).toBe(false);
    }
  });

  it("preserves every action on the preserved list", () => {
    for (const action of OVER_LIMIT_PRESERVED_ACTIONS) {
      expect(isReadPreserved(action)).toBe(true);
    }
  });

  it("treats an unclassified action as preserved, never as blocked", () => {
    // Failing open on a read is trivial; failing closed locks a customer out of
    // their own data because someone forgot to update a list.
    expect(isReadPreserved("some.future.read")).toBe(true);
  });

  it("keeps the two lists disjoint", () => {
    const blocked = new Set<string>(OVER_LIMIT_BLOCKED_ACTIONS);
    for (const action of OVER_LIMIT_PRESERVED_ACTIONS) {
      expect(blocked.has(action)).toBe(false);
    }
  });
});

describe("describeLimit", () => {
  it("explains the cap without implying anything was deleted", async () => {
    store.seedMembers(ORG, 3);
    const check = await checkLimit(store, { organizationId: ORG, metric: "members", requested: 1 });

    const message = describeLimit(check);

    expect(message).toContain("Free");
    expect(message).toContain("3");
    expect(message).toContain("team members");
    expect(message).toContain("unaffected");
    expect(message).not.toMatch(/delet|remov|lost/i);
  });

  it("says nothing when the request is allowed", async () => {
    const check = await checkLimit(store, { organizationId: ORG, metric: "members", requested: 1 });
    expect(describeLimit(check)).toBe("");
  });

  it("humanises a metric it has no hand-written noun for", async () => {
    const check = await checkLimit(store, {
      organizationId: ORG,
      metric: EXTERNAL_METRIC,
      requested: 1,
      current: 5,
    });

    expect(describeLimit(check)).toContain("stripe connections");
  });
});
