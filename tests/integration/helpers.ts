import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase, createOrganization, type Database } from "@payrecon/db";
import { users } from "@payrecon/db/schema";
import type pg from "pg";

/**
 * Shared harness for integration tests.
 *
 * Every test file gets a real PostgreSQL connection and a clean database. Tests
 * run serially (`fileParallelism: false`) because they share one database and
 * truncate between files.
 */

loadDotenv({ path: resolve(process.cwd(), ".env"), quiet: true });

let cached: { db: Database; pool: pg.Pool } | null = null;

export function testDb(): Database {
  if (!cached) {
    const connectionString = process.env.TEST_DATABASE_URL;
    if (!connectionString) throw new Error("TEST_DATABASE_URL is not set");
    cached = createDatabase({ connectionString, maxConnections: 5 });
  }
  return cached.db;
}

export async function closeTestDb(): Promise<void> {
  if (cached) {
    await cached.pool.end();
    cached = null;
  }
}

/**
 * Remove all data between test files.
 *
 * `audit_events` is append-only and its DELETE trigger would reject a normal
 * delete, so the guard is suspended for the truncate — the same privileged
 * pattern `purgeOrganization` uses in production. TRUNCATE ... CASCADE also
 * bypasses row triggers, but disabling explicitly keeps the intent obvious.
 */
export async function resetDatabase(): Promise<void> {
  const db = testDb();

  const rows = await db.execute<{ tablename: string }>(sql`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> '__drizzle_migrations'
  `);

  const tables = rows.rows.map((row) => `"public"."${row.tablename}"`);
  if (tables.length === 0) return;

  await db.execute(sql`alter table audit_events disable trigger audit_events_no_delete`);
  try {
    await db.execute(sql.raw(`truncate table ${tables.join(", ")} restart identity cascade`));
  } finally {
    await db.execute(sql`alter table audit_events enable trigger audit_events_no_delete`);
  }
}

/**
 * Assert that the DATABASE rejected an operation with a matching message.
 *
 * Drizzle wraps driver errors as `Failed query: ...` and puts the real
 * PostgreSQL message (which is what a trigger's RAISE produces) on `cause`.
 * Asserting on the top-level message alone would pass for any query failure,
 * including a typo — so this walks the cause chain and matches against the
 * combined text.
 */
export async function expectDatabaseRejection(
  operation: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let thrown: unknown;
  try {
    await operation;
  } catch (error) {
    thrown = error;
  }

  if (thrown === undefined) {
    throw new Error(`Expected the database to reject this operation, but it succeeded.`);
  }

  const messages: string[] = [];
  let current: unknown = thrown;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = (current as { cause?: unknown }).cause;
  }

  const combined = messages.join(" | ");
  if (!pattern.test(combined)) {
    throw new Error(`Expected a database error matching ${pattern}, but got: ${combined}`);
  }
}

let userCounter = 0;

export async function createTestUser(
  overrides: { email?: string; name?: string } = {},
): Promise<{ id: string; email: string }> {
  userCounter += 1;
  const email = overrides.email ?? `user${userCounter}-${Date.now()}@test.local`;
  const [row] = await testDb()
    .insert(users)
    .values({
      email,
      name: overrides.name ?? `Test User ${userCounter}`,
      // A structurally valid scrypt hash; tests that exercise sign-in create
      // their own real hash instead.
      passwordHash: "scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAA==",
    })
    .returning({ id: users.id, email: users.email });

  if (!row) throw new Error("failed to create test user");
  return row;
}

/**
 * Create two fully separate tenants.
 *
 * Most isolation tests need exactly this shape: two organizations, each with its
 * own owner, so that a query scoped to one must never see the other's rows.
 */
export async function createTwoTenants(): Promise<{
  alpha: { orgId: string; userId: string };
  beta: { orgId: string; userId: string };
}> {
  const alphaUser = await createTestUser();
  const betaUser = await createTestUser();

  const alphaOrg = await createOrganization(testDb(), {
    name: `Alpha ${Date.now()}`,
    ownerUserId: alphaUser.id,
  });
  const betaOrg = await createOrganization(testDb(), {
    name: `Beta ${Date.now()}`,
    ownerUserId: betaUser.id,
  });

  return {
    alpha: { orgId: alphaOrg.id, userId: alphaUser.id },
    beta: { orgId: betaOrg.id, userId: betaUser.id },
  };
}
