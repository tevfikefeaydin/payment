import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { applyGuards, createDatabase } from "@payrecon/db";

/**
 * Prepare the end-to-end database.
 *
 * Applies the real migrations to an empty database — which also proves, on every
 * E2E run, that the checked-in migrations work from scratch — then clears any
 * data left by a previous run so tests start from a known state.
 */
export default async function globalSetup(): Promise<void> {
  loadDotenv({ path: resolve(process.cwd(), ".env"), quiet: true });

  const connectionString =
    process.env.E2E_DATABASE_URL ??
    "postgresql://postgres:payrecon_dev_pw@127.0.0.1:55432/payrecon_e2e";

  if (!/e2e/i.test(connectionString)) {
    throw new Error("E2E_DATABASE_URL must point at a dedicated e2e database: it is wiped.");
  }

  const { db, pool } = createDatabase({ connectionString, maxConnections: 1 });
  try {
    await migrate(db, { migrationsFolder: resolve(process.cwd(), "packages/db/drizzle") });
    await applyGuards(db);

    const rows = await db.execute<{ tablename: string }>(sql`
      select tablename from pg_tables
      where schemaname = 'public' and tablename <> '__drizzle_migrations'
    `);
    const tables = rows.rows.map((row) => `"public"."${row.tablename}"`);

    if (tables.length > 0) {
      await db.execute(sql`alter table audit_events disable trigger audit_events_no_delete`);
      try {
        await db.execute(sql.raw(`truncate table ${tables.join(", ")} restart identity cascade`));
      } finally {
        await db.execute(sql`alter table audit_events enable trigger audit_events_no_delete`);
      }
    }
  } finally {
    await pool.end();
  }
}
