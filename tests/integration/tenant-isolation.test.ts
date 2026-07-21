import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  assignException,
  getException,
  getExceptionTimeline,
  listAuditEvents,
  listExceptions,
  listInternalRecords,
  recordAudit,
  revenueAtRiskByCurrency,
  runReconciliationForOrganization,
  seedDemoData,
  transitionException,
  upsertInternalRecords,
} from "@payrecon/db";
import { exceptions, internalPaymentRecords } from "@payrecon/db/schema";
import { resolveOrgContext, listUserOrganizations } from "@payrecon/auth";
import { createTestUser, createTwoTenants, testDb } from "./helpers";

/**
 * Cross-tenant isolation.
 *
 * These are the tests that must fail loudly if tenancy ever regresses. Each one
 * establishes two real organizations with real data and then attempts to reach
 * one tenant's rows using the OTHER tenant's context — through repositories,
 * object ids, aggregates, audit reads and state transitions.
 */

describe("cross-tenant isolation", () => {
  it("scopes internal payment records to their own organization", async () => {
    const db = testDb();
    const { alpha, beta } = await createTwoTenants();

    await upsertInternalRecords(db, {
      organizationId: alpha.orgId,
      source: "api",
      records: [record("alpha-only")],
    });
    await upsertInternalRecords(db, {
      organizationId: beta.orgId,
      source: "api",
      records: [record("beta-only")],
    });

    const alphaRecords = await listInternalRecords(db, { organizationId: alpha.orgId });
    const betaRecords = await listInternalRecords(db, { organizationId: beta.orgId });

    expect(alphaRecords.items.map((r) => r.externalId)).toEqual(["alpha-only"]);
    expect(betaRecords.items.map((r) => r.externalId)).toEqual(["beta-only"]);
  });

  it("allows the SAME externalId in two organizations without collision", async () => {
    const db = testDb();
    const { alpha, beta } = await createTwoTenants();

    // The natural key is (organization_id, external_id): identical ids in
    // different tenants must coexist, and must not overwrite one another.
    await upsertInternalRecords(db, {
      organizationId: alpha.orgId,
      source: "api",
      records: [record("shared-id", { amountMinor: 1000n })],
    });
    await upsertInternalRecords(db, {
      organizationId: beta.orgId,
      source: "api",
      records: [record("shared-id", { amountMinor: 2000n })],
    });

    const [alphaRow] = await db
      .select()
      .from(internalPaymentRecords)
      .where(
        and(
          eq(internalPaymentRecords.organizationId, alpha.orgId),
          eq(internalPaymentRecords.externalId, "shared-id"),
        ),
      );
    const [betaRow] = await db
      .select()
      .from(internalPaymentRecords)
      .where(
        and(
          eq(internalPaymentRecords.organizationId, beta.orgId),
          eq(internalPaymentRecords.externalId, "shared-id"),
        ),
      );

    expect(alphaRow?.amountMinor).toBe(1000n);
    expect(betaRow?.amountMinor).toBe(2000n);
  });

  it("refuses to read another tenant's exception by its id (IDOR)", async () => {
    const db = testDb();
    const { alpha, beta } = await createTwoTenants();

    await seedDemoData(db, { organizationId: alpha.orgId });
    await runReconciliationForOrganization(db, {
      organizationId: alpha.orgId,
      trigger: "manual",
    });

    const alphaExceptions = await listExceptions(db, { organizationId: alpha.orgId });
    expect(alphaExceptions.total).toBeGreaterThan(0);
    const target = alphaExceptions.items[0];
    if (!target) throw new Error("expected at least one exception");

    // Beta knows alpha's exception id but must not be able to read it.
    const leaked = await getException(db, beta.orgId, target.id);
    expect(leaked).toBeNull();

    // Nor its timeline.
    const timeline = await getExceptionTimeline(db, beta.orgId, target.id);
    expect(timeline).toHaveLength(0);
  });

  it("refuses to transition another tenant's exception", async () => {
    const db = testDb();
    const { alpha, beta } = await createTwoTenants();

    await seedDemoData(db, { organizationId: alpha.orgId });
    await runReconciliationForOrganization(db, { organizationId: alpha.orgId, trigger: "manual" });

    const { items } = await listExceptions(db, { organizationId: alpha.orgId });
    const target = items[0];
    if (!target) throw new Error("expected at least one exception");

    await expect(
      transitionException(db, {
        organizationId: beta.orgId, // wrong tenant
        exceptionId: target.id,
        toState: "resolved",
        expectedVersion: target.version,
        actorUserId: beta.userId,
      }),
    ).rejects.toMatchObject({ status: 404 });

    // The exception is untouched.
    const after = await getException(db, alpha.orgId, target.id);
    expect(after?.state).toBe(target.state);
  });

  it("refuses to assign another tenant's exception", async () => {
    const db = testDb();
    const { alpha, beta } = await createTwoTenants();

    await seedDemoData(db, { organizationId: alpha.orgId });
    await runReconciliationForOrganization(db, { organizationId: alpha.orgId, trigger: "manual" });

    const { items } = await listExceptions(db, { organizationId: alpha.orgId });
    const target = items[0];
    if (!target) throw new Error("expected at least one exception");

    await expect(
      assignException(db, {
        organizationId: beta.orgId,
        exceptionId: target.id,
        assigneeUserId: beta.userId,
        actorUserId: beta.userId,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("keeps dashboard aggregates separate", async () => {
    const db = testDb();
    const { alpha, beta } = await createTwoTenants();

    await seedDemoData(db, { organizationId: alpha.orgId });
    await runReconciliationForOrganization(db, { organizationId: alpha.orgId, trigger: "manual" });

    const alphaRisk = await revenueAtRiskByCurrency(db, alpha.orgId);
    const betaRisk = await revenueAtRiskByCurrency(db, beta.orgId);

    expect(alphaRisk.length).toBeGreaterThan(0);
    // Beta has no data at all; its aggregate must be empty, not alpha's.
    expect(betaRisk).toEqual([]);
  });

  it("produces DIFFERENT fingerprints for identical data in different tenants", async () => {
    const db = testDb();
    const { alpha, beta } = await createTwoTenants();

    // Identical demo data seeded into both tenants.
    const now = new Date("2026-05-01T12:00:00Z");
    await seedDemoData(db, { organizationId: alpha.orgId, now });
    await seedDemoData(db, { organizationId: beta.orgId, now });

    await runReconciliationForOrganization(db, {
      organizationId: alpha.orgId,
      trigger: "manual",
      now,
    });
    await runReconciliationForOrganization(db, {
      organizationId: beta.orgId,
      trigger: "manual",
      now,
    });

    const alphaPrints = (
      await db
        .select({ fingerprint: exceptions.fingerprint })
        .from(exceptions)
        .where(eq(exceptions.organizationId, alpha.orgId))
    ).map((r) => r.fingerprint);

    const betaPrints = (
      await db
        .select({ fingerprint: exceptions.fingerprint })
        .from(exceptions)
        .where(eq(exceptions.organizationId, beta.orgId))
    ).map((r) => r.fingerprint);

    expect(alphaPrints.length).toBeGreaterThan(0);
    expect(alphaPrints.length).toBe(betaPrints.length);

    // No fingerprint may be shared: the organization id is part of the hash, so
    // one tenant's exception can never collide with another's.
    const overlap = alphaPrints.filter((print) => betaPrints.includes(print));
    expect(overlap).toEqual([]);
  });

  it("scopes the audit log to its own organization", async () => {
    const db = testDb();
    const { alpha, beta } = await createTwoTenants();

    await recordAudit(db, {
      organizationId: alpha.orgId,
      actor: { type: "user", userId: alpha.userId },
      action: "organization.updated",
      metadata: { note: "alpha-only-event" },
    });

    const alphaAudit = await listAuditEvents(db, { organizationId: alpha.orgId });
    const betaAudit = await listAuditEvents(db, { organizationId: beta.orgId });

    expect(alphaAudit.rows.some((r) => r.action === "organization.updated")).toBe(true);
    expect(betaAudit.rows.some((r) => r.action === "organization.updated")).toBe(false);
  });

  it("does not resolve an organization context for a non-member", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();
    const outsider = await createTestUser();

    const context = await resolveOrgContext(
      db,
      { id: outsider.id, email: outsider.email, name: "Outsider", emailVerifiedAt: null },
      alpha.orgId,
    );

    // Null, not a context with a downgraded role: non-membership is total.
    expect(context).toBeNull();

    const orgs = await listUserOrganizations(db, outsider.id);
    expect(orgs).toEqual([]);
  });
});

function record(
  externalId: string,
  overrides: Partial<{ amountMinor: bigint }> = {},
): {
  externalId: string;
  customerId: string | null;
  orderId: string | null;
  subscriptionId: string | null;
  providerTransactionId: string | null;
  amountMinor: bigint;
  currency: string;
  status: "paid";
  occurredAt: Date;
  recordUpdatedAt: Date | null;
  metadata: Record<string, string>;
} {
  return {
    externalId,
    customerId: "cus_test",
    orderId: null,
    subscriptionId: null,
    providerTransactionId: null,
    amountMinor: overrides.amountMinor ?? 1500n,
    currency: "USD",
    status: "paid",
    occurredAt: new Date("2026-04-01T10:00:00Z"),
    recordUpdatedAt: null,
    metadata: {},
  };
}
