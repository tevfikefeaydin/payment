import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  changeMemberRole,
  getException,
  getExceptionTimeline,
  listExceptions,
  recordAudit,
  removeMember,
  runReconciliationForOrganization,
  seedDemoData,
  transferOwnership,
  transitionException,
} from "@payrecon/db";
import { auditEvents, exceptions, organizationMembers } from "@payrecon/db/schema";
import { createTestUser, createTwoTenants, expectDatabaseRejection, testDb } from "./helpers";

/**
 * Exception lifecycle and the guarantees that protect it.
 *
 * These tests exercise the behaviours an operator depends on: that a repeated
 * run does not spam the inbox, that a genuinely-returning problem reopens, that
 * triage is not silently undone, and that two people cannot overwrite each
 * other.
 */

const NOW = new Date("2026-05-01T12:00:00Z");

async function seedAndRun(orgId: string): Promise<void> {
  await seedDemoData(testDb(), { organizationId: orgId, now: NOW });
  await runReconciliationForOrganization(testDb(), {
    organizationId: orgId,
    trigger: "manual",
    now: NOW,
  });
}

describe("reconciliation run lifecycle", () => {
  it("is idempotent: a second run over identical data creates nothing new", async () => {
    const { alpha } = await createTwoTenants();
    await seedAndRun(alpha.orgId);

    const first = await listExceptions(testDb(), { organizationId: alpha.orgId, pageSize: 100 });
    expect(first.total).toBe(10);

    const second = await runReconciliationForOrganization(testDb(), {
      organizationId: alpha.orgId,
      trigger: "manual",
      now: NOW,
    });

    expect(second.created).toBe(0);
    expect(second.reopened).toBe(0);
    expect(second.unchanged).toBe(10);

    const after = await listExceptions(testDb(), { organizationId: alpha.orgId, pageSize: 100 });
    expect(after.total).toBe(10);
  });

  it("REOPENS a resolved exception when the problem is detected again", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();
    await seedAndRun(alpha.orgId);

    const { items } = await listExceptions(db, { organizationId: alpha.orgId, pageSize: 100 });
    const target = items[0];
    if (!target) throw new Error("expected an exception");

    await transitionException(db, {
      organizationId: alpha.orgId,
      exceptionId: target.id,
      toState: "resolved",
      expectedVersion: target.version,
      actorUserId: alpha.userId,
      note: "Fixed the webhook handler",
    });

    const resolved = await getException(db, alpha.orgId, target.id);
    expect(resolved?.state).toBe("resolved");
    expect(resolved?.resolvedAt).not.toBeNull();

    // The underlying data is unchanged, so the next run sees the same problem.
    const rerun = await runReconciliationForOrganization(db, {
      organizationId: alpha.orgId,
      trigger: "scheduled",
      now: NOW,
    });

    expect(rerun.reopened).toBe(1);

    const reopened = await getException(db, alpha.orgId, target.id);
    expect(reopened?.state).toBe("reopened");
    // Reopening clears the resolution so the inbox does not show stale closure.
    expect(reopened?.resolvedAt).toBeNull();

    // History is preserved rather than overwritten.
    const timeline = await getExceptionTimeline(db, alpha.orgId, target.id);
    const actions = timeline.map((entry) => entry.action);
    expect(actions).toContain("created");
    expect(actions).toContain("state_changed");
    expect(actions).toContain("reopened");
  });

  it("does NOT reset an acknowledged exception when it is detected again", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();
    await seedAndRun(alpha.orgId);

    const { items } = await listExceptions(db, { organizationId: alpha.orgId, pageSize: 100 });
    const target = items[0];
    if (!target) throw new Error("expected an exception");

    await transitionException(db, {
      organizationId: alpha.orgId,
      exceptionId: target.id,
      toState: "acknowledged",
      expectedVersion: target.version,
      actorUserId: alpha.userId,
    });

    await runReconciliationForOrganization(db, {
      organizationId: alpha.orgId,
      trigger: "scheduled",
      now: NOW,
    });

    // Re-detection must not erase an operator's triage every hour.
    const after = await getException(db, alpha.orgId, target.id);
    expect(after?.state).toBe("acknowledged");
  });

  it("does not invalidate an operator's held version when a run merely re-detects", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();
    await seedAndRun(alpha.orgId);

    const { items } = await listExceptions(db, { organizationId: alpha.orgId, pageSize: 100 });
    const target = items[0];
    if (!target) throw new Error("expected an exception");
    const versionOperatorIsHolding = target.version;

    // A scheduled run lands while the operator has the detail page open.
    await runReconciliationForOrganization(db, {
      organizationId: alpha.orgId,
      trigger: "scheduled",
      now: NOW,
    });

    // Their acknowledge must still succeed. If re-detection bumped the version,
    // every scheduled run would reject in-flight operator actions with a 409.
    await expect(
      transitionException(db, {
        organizationId: alpha.orgId,
        exceptionId: target.id,
        toState: "acknowledged",
        expectedVersion: versionOperatorIsHolding,
        actorUserId: alpha.userId,
      }),
    ).resolves.toMatchObject({ toState: "acknowledged" });
  });

  it("rejects a stale write with a conflict (optimistic concurrency)", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();
    await seedAndRun(alpha.orgId);

    const { items } = await listExceptions(db, { organizationId: alpha.orgId, pageSize: 100 });
    const target = items[0];
    if (!target) throw new Error("expected an exception");
    const staleVersion = target.version;

    // First operator wins.
    await transitionException(db, {
      organizationId: alpha.orgId,
      exceptionId: target.id,
      toState: "acknowledged",
      expectedVersion: staleVersion,
      actorUserId: alpha.userId,
    });

    // Second operator was looking at the pre-change page and loses.
    await expect(
      transitionException(db, {
        organizationId: alpha.orgId,
        exceptionId: target.id,
        toState: "resolved",
        expectedVersion: staleVersion,
        actorUserId: alpha.userId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const after = await getException(db, alpha.orgId, target.id);
    expect(after?.state).toBe("acknowledged");
  });

  it("rejects an illegal state transition", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();
    await seedAndRun(alpha.orgId);

    const { items } = await listExceptions(db, { organizationId: alpha.orgId, pageSize: 100 });
    const target = items[0];
    if (!target) throw new Error("expected an exception");

    // open -> reopened is not a legal move; only resolved may reopen.
    await expect(
      transitionException(db, {
        organizationId: alpha.orgId,
        exceptionId: target.id,
        toState: "reopened",
        expectedVersion: target.version,
        actorUserId: alpha.userId,
      }),
    ).rejects.toThrow(/Cannot move an exception/i);
  });

  it("records revenue at risk per currency without ever combining currencies", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();
    await seedAndRun(alpha.orgId);

    const rows = await db
      .select({ currency: exceptions.currency, amount: exceptions.revenueAtRiskMinor })
      .from(exceptions)
      .where(eq(exceptions.organizationId, alpha.orgId));

    const currencies = new Set(rows.map((row) => row.currency));
    // The demo data deliberately spans more than one currency.
    expect(currencies.size).toBeGreaterThan(1);
    // Every exception carrying an amount also carries its own currency.
    for (const row of rows) {
      if (row.amount !== null) expect(row.currency).toBeTruthy();
    }
  });
});

describe("database guards", () => {
  it("makes audit events immutable at the database level", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();

    await recordAudit(db, {
      organizationId: alpha.orgId,
      actor: { type: "user", userId: alpha.userId },
      action: "organization.updated",
      metadata: { field: "name" },
    });

    // An ordinary application path must not be able to rewrite history.
    await expectDatabaseRejection(
      db
        .update(auditEvents)
        .set({ action: "tampered" })
        .where(eq(auditEvents.organizationId, alpha.orgId)),
      /append-only/i,
    );

    await expectDatabaseRejection(
      db.delete(auditEvents).where(eq(auditEvents.organizationId, alpha.orgId)),
      /append-only/i,
    );

    const [row] = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, alpha.orgId))
      .limit(1);
    expect(row?.action).toBe("organization.updated");
  });

  it("never lets an organization lose its last owner", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();

    // Demote the only owner.
    await expect(
      changeMemberRole(db, {
        organizationId: alpha.orgId,
        actorRole: "owner",
        targetUserId: alpha.userId,
        newRole: "admin",
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Remove the only owner.
    await expect(
      removeMember(db, {
        organizationId: alpha.orgId,
        actorRole: "owner",
        targetUserId: alpha.userId,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // Still an owner.
    const [row] = await db
      .select({ role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, alpha.orgId));
    expect(row?.role).toBe("owner");
  });

  it("blocks the last-owner rule even from a direct database write", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();

    // Bypassing the repository entirely still hits the trigger.
    await expectDatabaseRejection(
      db.execute(
        sql`delete from organization_members where organization_id = ${alpha.orgId}::uuid`,
      ),
      /at least one owner/i,
    );
  });

  it("allows ownership transfer, which is the supported way out", async () => {
    const db = testDb();
    const { alpha } = await createTwoTenants();
    const successor = await createTestUser();

    await db.insert(organizationMembers).values({
      organizationId: alpha.orgId,
      userId: successor.id,
      role: "admin",
    });

    await transferOwnership(db, {
      organizationId: alpha.orgId,
      currentOwnerUserId: alpha.userId,
      newOwnerUserId: successor.id,
    });

    const rows = await db
      .select({ userId: organizationMembers.userId, role: organizationMembers.role })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, alpha.orgId));

    const byUser = new Map(rows.map((row) => [row.userId, row.role]));
    expect(byUser.get(successor.id)).toBe("owner");
    expect(byUser.get(alpha.userId)).toBe("admin");
  });
});
