import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOrganization, usageCounters } from "@payrecon/db";
import { createDrizzleBillingStore, usagePeriodKey } from "@payrecon/platform-billing";
import { createTestUser, testDb } from "./helpers";

/**
 * The Drizzle billing store against a real PostgreSQL.
 *
 * The billing behaviour (webhook idempotency, out-of-order tolerance,
 * entitlements) is proven over the in-memory store by the unit suite; until
 * now the production SQL in store-drizzle.ts was typechecked but never
 * executed. This file runs every method at least once for real.
 */

async function createOrg(): Promise<string> {
  const user = await createTestUser();
  const org = await createOrganization(testDb(), {
    name: `Billing ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    ownerUserId: user.id,
  });
  return org.id;
}

describe("drizzle billing store", () => {
  it("reads and updates the organization plan", async () => {
    const store = createDrizzleBillingStore(testDb());
    const orgId = await createOrg();

    const before = await store.findOrganization(orgId);
    expect(before?.planKey).toBe("free");

    expect(await store.updateOrganizationPlan(orgId, "growth")).toBe(true);
    expect((await store.findOrganization(orgId))?.planKey).toBe("growth");

    expect(await store.updateOrganizationPlan(randomUUID(), "growth")).toBe(false);
    expect(await store.findOrganization(randomUUID())).toBeNull();
  });

  it("creates exactly one billing customer per organization", async () => {
    const store = createDrizzleBillingStore(testDb());
    const orgId = await createOrg();
    const now = new Date();

    const first = await store.insertBillingCustomerIfAbsent({
      organizationId: orgId,
      stripeCustomerId: `cus_${orgId.slice(0, 8)}a`,
      now,
    });
    // The losing side of a concurrent checkout must get the surviving row back.
    const second = await store.insertBillingCustomerIfAbsent({
      organizationId: orgId,
      stripeCustomerId: `cus_${orgId.slice(0, 8)}b`,
      now,
    });
    expect(second.id).toBe(first.id);
    expect(second.stripeCustomerId).toBe(first.stripeCustomerId);

    expect((await store.findBillingCustomerByOrganization(orgId))?.id).toBe(first.id);
    expect(
      (await store.findBillingCustomerByStripeId(first.stripeCustomerId))?.organizationId,
    ).toBe(orgId);
    expect(await store.findBillingCustomerByStripeId("cus_missing")).toBeNull();
  });

  it("upserts a subscription without letting a partial event erase state", async () => {
    const store = createDrizzleBillingStore(testDb());
    const orgId = await createOrg();
    const subId = `sub_${orgId.slice(0, 12)}`;
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const created = await store.upsertSubscription({
      organizationId: orgId,
      stripeSubscriptionId: subId,
      status: "active",
      planKey: "starter",
      stripePriceId: "price_123",
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      lastEventAt: now,
      now,
    });
    expect(created.status).toBe("active");
    expect(created.stripePriceId).toBe("price_123");

    // A later, sparser event updates status but must not null the price or
    // period it does not mention.
    const updated = await store.upsertSubscription({
      organizationId: orgId,
      stripeSubscriptionId: subId,
      status: "past_due",
      planKey: "starter",
      lastEventAt: new Date(now.getTime() + 1000),
      now: new Date(now.getTime() + 1000),
    });
    expect(updated.status).toBe("past_due");
    expect(updated.stripePriceId).toBe("price_123");
    expect(updated.currentPeriodEnd?.getTime()).toBe(periodEnd.getTime());

    expect((await store.findSubscriptionByOrganization(orgId))?.status).toBe("past_due");
  });

  it("claims a webhook event exactly once and records its outcome", async () => {
    const store = createDrizzleBillingStore(testDb());
    const orgId = await createOrg();
    const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
    const eventCreatedAt = new Date();

    const first = await store.claimWebhookEvent({
      stripeEventId: eventId,
      type: "customer.subscription.updated",
      organizationId: orgId,
      eventCreatedAt,
    });
    expect(first.created).toBe(true);
    expect(first.existing).toBeNull();

    // Stripe redelivers; the unique index makes the duplicate observable.
    const second = await store.claimWebhookEvent({
      stripeEventId: eventId,
      type: "customer.subscription.updated",
      organizationId: orgId,
      eventCreatedAt,
    });
    expect(second.created).toBe(false);
    expect(second.existing?.stripeEventId).toBe(eventId);
    expect(second.existing?.status).toBe("received");

    await store.markWebhookEvent(eventId, { status: "processed", processedAt: new Date() });
    const marked = await store.findWebhookEvent(eventId);
    expect(marked?.status).toBe("processed");
    expect(marked?.processedAt).toBeInstanceOf(Date);
  });

  it("reads the tenant-scoped limit counters", async () => {
    const store = createDrizzleBillingStore(testDb());
    const orgId = await createOrg();
    const otherOrgId = await createOrg();
    const now = new Date();

    await testDb()
      .insert(usageCounters)
      .values([
        {
          organizationId: orgId,
          period: usagePeriodKey(now),
          metric: "ingested_records",
          count: 42n,
        },
        {
          organizationId: otherOrgId,
          period: usagePeriodKey(now),
          metric: "ingested_records",
          count: 7n,
        },
      ]);

    expect(await store.countIngestedRecordsThisMonth(orgId, now)).toBe(42n);
    expect(await store.countMembers(orgId)).toBe(1);
    expect(await store.countNotificationDestinations(orgId)).toBe(0);
  });
});
