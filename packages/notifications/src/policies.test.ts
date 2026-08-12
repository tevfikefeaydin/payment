import { describe, expect, it } from "vitest";
import { PublicError } from "@payrecon/domain";
import { createMemoryNotificationStore, type MemoryNotificationStore } from "./memory-store";
import { createEmailDestination } from "./destinations";
import { createPolicy, deletePolicy, listPolicies, setPolicyEnabled } from "./policies";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

async function storeWithDestination(): Promise<{
  db: MemoryNotificationStore;
  destinationId: string;
}> {
  const db = createMemoryNotificationStore();
  const destination = await createEmailDestination(db, {
    organizationId: ORG,
    name: "Finance alerts",
    email: "alerts@example.com",
    createdByUserId: USER,
  });
  return { db, destinationId: destination.id };
}

describe("createPolicy", () => {
  it("creates an enabled policy and audits it without secrets", async () => {
    const { db, destinationId } = await storeWithDestination();

    const policy = await createPolicy(db, {
      organizationId: ORG,
      destinationId,
      minSeverity: "high",
      digest: "hourly",
      actorUserId: USER,
    });

    expect(policy.enabled).toBe(true);
    expect(policy.minSeverity).toBe("high");
    expect(policy.digest).toBe("hourly");
    expect(policy.criticalBypassesDigest).toBe(true);
    expect(policy.minRevenueAtRiskMinor).toBeNull();

    const audit = db.listAuditEvents().filter((e) => e.action === "notification.policy_changed");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toMatchObject({ op: "created", minSeverity: "high" });
  });

  it("normalises the currency and parses the threshold", async () => {
    const { db, destinationId } = await storeWithDestination();

    const policy = await createPolicy(db, {
      organizationId: ORG,
      destinationId,
      minSeverity: "medium",
      digest: "immediate",
      currency: "usd",
      minRevenueAtRiskMinor: 25_000n,
    });

    expect(policy.currency).toBe("USD");
    expect(policy.minRevenueAtRiskMinor).toBe(25_000n);
  });

  it("rejects a threshold without a currency — unlike currencies are never compared", async () => {
    const { db, destinationId } = await storeWithDestination();

    await expect(
      createPolicy(db, {
        organizationId: ORG,
        destinationId,
        minSeverity: "high",
        digest: "hourly",
        minRevenueAtRiskMinor: 100n,
      }),
    ).rejects.toThrow(PublicError);
  });

  it("rejects an unknown severity, digest, currency and non-positive threshold", async () => {
    const { db, destinationId } = await storeWithDestination();
    const base = { organizationId: ORG, destinationId, minSeverity: "high", digest: "hourly" };

    await expect(createPolicy(db, { ...base, minSeverity: "urgent" })).rejects.toThrow(/severity/i);
    await expect(createPolicy(db, { ...base, digest: "weekly" })).rejects.toThrow(/cadence/i);
    await expect(createPolicy(db, { ...base, currency: "DOLLARS" })).rejects.toThrow(/currency/i);
    await expect(
      createPolicy(db, { ...base, currency: "USD", minRevenueAtRiskMinor: 0n }),
    ).rejects.toThrow(/positive/i);
  });

  it("refuses to attach a policy to another tenant's destination", async () => {
    const { db, destinationId } = await storeWithDestination();

    await expect(
      createPolicy(db, {
        organizationId: OTHER_ORG,
        destinationId,
        minSeverity: "high",
        digest: "hourly",
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("setPolicyEnabled / deletePolicy", () => {
  it("disables a policy so delivery no longer sees it, and re-enables it", async () => {
    const { db, destinationId } = await storeWithDestination();
    const policy = await createPolicy(db, {
      organizationId: ORG,
      destinationId,
      minSeverity: "low",
      digest: "immediate",
    });

    const disabled = await setPolicyEnabled(db, {
      organizationId: ORG,
      policyId: policy.id,
      enabled: false,
      actorUserId: USER,
    });
    expect(disabled?.enabled).toBe(false);
    expect(await db.listEnabledPolicies(ORG)).toHaveLength(0);
    expect(await listPolicies(db, ORG)).toHaveLength(1);

    const enabled = await setPolicyEnabled(db, {
      organizationId: ORG,
      policyId: policy.id,
      enabled: true,
    });
    expect(enabled?.enabled).toBe(true);
    expect(await db.listEnabledPolicies(ORG)).toHaveLength(1);
  });

  it("scopes toggle and delete by organization", async () => {
    const { db, destinationId } = await storeWithDestination();
    const policy = await createPolicy(db, {
      organizationId: ORG,
      destinationId,
      minSeverity: "high",
      digest: "hourly",
    });

    expect(
      await setPolicyEnabled(db, {
        organizationId: OTHER_ORG,
        policyId: policy.id,
        enabled: false,
      }),
    ).toBeNull();
    expect(await deletePolicy(db, { organizationId: OTHER_ORG, policyId: policy.id })).toBe(false);
    expect(await listPolicies(db, ORG)).toHaveLength(1);

    expect(await deletePolicy(db, { organizationId: ORG, policyId: policy.id })).toBe(true);
    expect(await listPolicies(db, ORG)).toHaveLength(0);
  });
});
