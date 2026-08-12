import { describe, expect, it } from "vitest";
import { createOrganization } from "@payrecon/db";
import type { Keyring } from "@payrecon/auth";
import {
  createDrizzleNotificationStore,
  createEmailDestination,
  createPolicy,
  createSlackDestination,
  deletePolicy,
  listPolicies,
  loadSlackWebhook,
  setPolicyEnabled,
} from "@payrecon/notifications";
import { createTestUser, testDb } from "./helpers";

/**
 * The Drizzle notification store against a real PostgreSQL.
 *
 * The unit suite proves the behaviour over the memory store; this file proves
 * the SQL. That distinction has caught real bugs before (an `inArray` subquery
 * that only failed on live PostgreSQL), so every new store method runs here at
 * least once end-to-end.
 */

const WEBHOOK = "https://hooks.slack.com/services/T0A1B2C3D/B9Z8Y7X6W/AbCdEfGhIjKlMnOpQrStUvWx";

const keyring: Keyring = { active: { id: "itest-key-1", key: Buffer.alloc(32, 0x42) } };

async function createOrg(): Promise<string> {
  const user = await createTestUser();
  const org = await createOrganization(testDb(), {
    name: `Notify ${Date.now()}`,
    ownerUserId: user.id,
  });
  return org.id;
}

describe("drizzle notification store", () => {
  it("stores a Slack destination whose webhook decrypts back", async () => {
    const store = createDrizzleNotificationStore(testDb());
    const orgId = await createOrg();

    const destination = await createSlackDestination(store, {
      organizationId: orgId,
      name: "On-call",
      webhookUrl: WEBHOOK,
      keyring,
    });

    expect(destination.status).toBe("pending_verification");
    expect(destination.secretHint).not.toContain("AbCdEfGh");

    const roundTripped = await loadSlackWebhook(store, {
      organizationId: orgId,
      destinationId: destination.id,
      keyring,
    });
    expect(roundTripped).toBe(WEBHOOK);
  });

  it("runs the full policy lifecycle in SQL: create, list, disable, delete", async () => {
    const store = createDrizzleNotificationStore(testDb());
    const orgId = await createOrg();

    const destination = await createEmailDestination(store, {
      organizationId: orgId,
      name: "Finance alerts",
      email: "alerts@example.com",
    });

    const policy = await createPolicy(store, {
      organizationId: orgId,
      destinationId: destination.id,
      minSeverity: "medium",
      digest: "daily",
      currency: "eur",
      minRevenueAtRiskMinor: 50_00n,
      criticalBypassesDigest: false,
    });
    expect(policy.currency).toBe("EUR");
    expect(policy.minRevenueAtRiskMinor).toBe(5_000n);
    expect(policy.criticalBypassesDigest).toBe(false);

    expect(await store.listEnabledPolicies(orgId)).toHaveLength(1);

    const disabled = await setPolicyEnabled(store, {
      organizationId: orgId,
      policyId: policy.id,
      enabled: false,
    });
    expect(disabled?.enabled).toBe(false);
    expect(await store.listEnabledPolicies(orgId)).toHaveLength(0);
    expect(await listPolicies(store, orgId)).toHaveLength(1);

    expect(await deletePolicy(store, { organizationId: orgId, policyId: policy.id })).toBe(true);
    expect(await listPolicies(store, orgId)).toHaveLength(0);
  });

  it("keeps policy reads and writes tenant-scoped in SQL", async () => {
    const store = createDrizzleNotificationStore(testDb());
    const orgId = await createOrg();
    const otherOrgId = await createOrg();

    const destination = await createEmailDestination(store, {
      organizationId: orgId,
      name: "Finance alerts",
      email: "alerts@example.com",
    });
    const policy = await createPolicy(store, {
      organizationId: orgId,
      destinationId: destination.id,
      minSeverity: "high",
      digest: "hourly",
    });

    // The other tenant cannot see, attach to, toggle or delete it.
    expect(await listPolicies(store, otherOrgId)).toHaveLength(0);
    await expect(
      createPolicy(store, {
        organizationId: otherOrgId,
        destinationId: destination.id,
        minSeverity: "high",
        digest: "hourly",
      }),
    ).rejects.toThrow(/not found/i);
    expect(
      await setPolicyEnabled(store, {
        organizationId: otherOrgId,
        policyId: policy.id,
        enabled: false,
      }),
    ).toBeNull();
    expect(await deletePolicy(store, { organizationId: otherOrgId, policyId: policy.id })).toBe(
      false,
    );
    expect(await listPolicies(store, orgId)).toHaveLength(1);
  });
});
