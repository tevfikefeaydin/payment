import { describe, expect, it } from "vitest";
import { and, eq, isNotNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import {
  apiIdempotencyRecords,
  apiRateLimitBuckets,
  auditEvents,
  createOrganization,
  importBatches,
  organizations,
} from "@payrecon/db";
import { handleRetentionCleanup, type HandlerDeps } from "@payrecon/jobs";
import { createTestUser, testDb } from "./helpers";

/**
 * Retention cleanup against a real database.
 *
 * The handler must clear aged CSV content per organization AND sweep the
 * technical tables with an inherent TTL: expired idempotency records and
 * elapsed rate-limit buckets — while leaving live rows of each kind untouched.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function deps(): HandlerDeps {
  // The retention handler never touches the queue; a null stub keeps the test
  // honest about that.
  return { db: testDb(), queue: null as unknown as PgBoss, reconciliationCron: "0 * * * *" };
}

async function createOrg(): Promise<string> {
  const user = await createTestUser();
  const org = await createOrganization(testDb(), {
    name: `Retention ${Date.now()}`,
    ownerUserId: user.id,
  });
  return org.id;
}

describe("handleRetentionCleanup", () => {
  it("clears aged raw CSV content but keeps recent uploads and the batch rows", async () => {
    const db = testDb();
    const orgId = await createOrg();

    // Default retention is 90 days.
    const [aged] = await db
      .insert(importBatches)
      .values({
        organizationId: orgId,
        filename: "old.csv",
        byteSize: 10,
        rawContent: "a,b\n1,2",
        createdAt: new Date(Date.now() - 120 * DAY_MS),
      })
      .returning({ id: importBatches.id });
    const [fresh] = await db
      .insert(importBatches)
      .values({
        organizationId: orgId,
        filename: "new.csv",
        byteSize: 10,
        rawContent: "a,b\n3,4",
      })
      .returning({ id: importBatches.id });
    if (!aged || !fresh) throw new Error("failed to insert import batches");

    await handleRetentionCleanup(deps());

    const rows = await db
      .select({ id: importBatches.id, rawContent: importBatches.rawContent })
      .from(importBatches)
      .where(eq(importBatches.organizationId, orgId));
    const byId = new Map(rows.map((row) => [row.id, row.rawContent]));

    expect(byId.get(aged.id)).toBeNull();
    expect(byId.get(fresh.id)).toBe("a,b\n3,4");

    const audit = await db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(
        and(eq(auditEvents.organizationId, orgId), eq(auditEvents.action, "retention.cleanup_ran")),
      );
    expect(audit).toHaveLength(1);
  });

  it("deletes expired idempotency records and keeps unexpired ones", async () => {
    const db = testDb();
    const orgId = await createOrg();

    await db.insert(apiIdempotencyRecords).values([
      {
        organizationId: orgId,
        idempotencyKey: "expired-key-1",
        requestHash: "hash-1",
        responseStatus: 200,
        responseBody: { ok: true },
        expiresAt: new Date(Date.now() - 60_000),
      },
      {
        // An expired claim whose request never completed must also be swept,
        // otherwise a crashed request wedges the key forever.
        organizationId: orgId,
        idempotencyKey: "expired-in-flight",
        requestHash: "hash-2",
        expiresAt: new Date(Date.now() - 60_000),
      },
      {
        organizationId: orgId,
        idempotencyKey: "live-key-1",
        requestHash: "hash-3",
        responseStatus: 201,
        responseBody: { ok: true },
        expiresAt: new Date(Date.now() + DAY_MS),
      },
    ]);

    await handleRetentionCleanup(deps());

    const remaining = await db
      .select({ key: apiIdempotencyRecords.idempotencyKey })
      .from(apiIdempotencyRecords)
      .where(eq(apiIdempotencyRecords.organizationId, orgId));
    expect(remaining.map((row) => row.key)).toEqual(["live-key-1"]);
  });

  it("deletes rate-limit buckets whose window elapsed more than a day ago", async () => {
    const db = testDb();
    const orgId = await createOrg();

    await db.insert(apiRateLimitBuckets).values([
      {
        organizationId: orgId,
        bucketKey: `v1:${orgId}:no-key:60:old`,
        windowStart: new Date(Date.now() - 3 * DAY_MS),
        count: 5,
      },
      {
        organizationId: orgId,
        bucketKey: `v1:${orgId}:no-key:60:current`,
        windowStart: new Date(),
        count: 1,
      },
    ]);

    await handleRetentionCleanup(deps());

    const remaining = await db
      .select({ key: apiRateLimitBuckets.bucketKey })
      .from(apiRateLimitBuckets)
      .where(eq(apiRateLimitBuckets.organizationId, orgId));
    expect(remaining.map((row) => row.key)).toEqual([`v1:${orgId}:no-key:60:current`]);
  });

  it("does not run the CSV sweep for a soft-deleted organization", async () => {
    const db = testDb();
    const orgId = await createOrg();

    await db.insert(importBatches).values({
      organizationId: orgId,
      filename: "old.csv",
      byteSize: 10,
      rawContent: "a,b\n1,2",
      createdAt: new Date(Date.now() - 120 * DAY_MS),
    });
    await db
      .update(organizations)
      .set({ deletedAt: new Date() })
      .where(eq(organizations.id, orgId));

    await handleRetentionCleanup(deps());

    const stillThere = await db
      .select({ id: importBatches.id })
      .from(importBatches)
      .where(and(eq(importBatches.organizationId, orgId), isNotNull(importBatches.rawContent)));
    expect(stillThere).toHaveLength(1);
  });
});
