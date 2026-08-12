import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { listFailedJobs } from "@payrecon/jobs";
import { testDb } from "./helpers";

/**
 * The tenant-scoped dead-letter view against a real database.
 *
 * The pg-boss schema is created here with the same columns the query touches,
 * because the integration database never runs a worker. Inserts use literal
 * states so the statements work identically against this plain table and the
 * real enum-typed partitioned one.
 */

async function ensurePgBossTable(): Promise<void> {
  const db = testDb();
  await db.execute(sql`create schema if not exists pgboss`);
  await db.execute(sql`
    create table if not exists pgboss.job (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      data jsonb,
      state text not null default 'created',
      retry_count int not null default 0,
      created_on timestamptz not null default now(),
      completed_on timestamptz,
      output jsonb
    )
  `);
}

async function insertJob(input: {
  name: string;
  state: string;
  organizationId?: string;
  output?: unknown;
  completedOn?: Date | null;
  retryCount?: number;
}): Promise<string> {
  const id = randomUUID();
  const data = input.organizationId ? { organizationId: input.organizationId } : {};
  await testDb().execute(sql`
    insert into pgboss.job (id, name, data, state, retry_count, completed_on, output)
    values (
      ${id}::uuid,
      ${input.name},
      ${JSON.stringify(data)}::jsonb,
      ${input.state},
      ${input.retryCount ?? 0},
      ${input.completedOn ?? null},
      ${input.output === undefined ? null : JSON.stringify(input.output)}::jsonb
    )
  `);
  return id;
}

describe("listFailedJobs", () => {
  it("returns only this organization's terminal failures, redacted", async () => {
    await ensurePgBossTable();
    const orgId = randomUUID();
    const otherOrgId = randomUUID();

    const failedId = await insertJob({
      name: "stripe.sync",
      state: "failed",
      organizationId: orgId,
      retryCount: 6,
      completedOn: new Date(),
      output: { message: "auth failed for rk_live_abcdefgh12345678 while syncing" },
    });
    await insertJob({
      name: "import.process",
      state: "completed",
      organizationId: orgId,
      completedOn: new Date(),
    });
    await insertJob({
      name: "stripe.sync",
      state: "failed",
      organizationId: otherOrgId,
      completedOn: new Date(),
      output: { message: "other tenant failure" },
    });
    await insertJob({
      name: "retention.cleanup",
      state: "failed",
      completedOn: new Date(),
      output: { message: "instance-wide failure with no tenant" },
    });

    const jobs = await listFailedJobs(testDb(), orgId);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(failedId);
    expect(jobs[0]?.queue).toBe("stripe.sync");
    expect(jobs[0]?.retryCount).toBe(6);
    expect(jobs[0]?.failedAt).toBeInstanceOf(Date);
    // The Stripe key must not survive into the rendered message.
    expect(jobs[0]?.error).not.toContain("rk_live_abcdefgh12345678");
    expect(jobs[0]?.error).toContain("auth failed");
  });

  it("handles a failure with no recorded output", async () => {
    await ensurePgBossTable();
    const orgId = randomUUID();
    await insertJob({ name: "import.process", state: "failed", organizationId: orgId });

    const jobs = await listFailedJobs(testDb(), orgId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.error).toBeNull();
    expect(jobs[0]?.failedAt).toBeNull();
  });

  it("returns an empty list for an organization with no failures", async () => {
    await ensurePgBossTable();
    expect(await listFailedJobs(testDb(), randomUUID())).toEqual([]);
  });
});
