import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { applyGuards, createDatabase } from "@payrecon/db";

/**
 * One-time setup for the integration suite.
 *
 * Applies migrations and database guards to TEST_DATABASE_URL before any test
 * file runs. Running the real migrations (rather than pushing the schema) means
 * the suite also proves that the checked-in migrations apply cleanly to an empty
 * database — which is one of the definition-of-done criteria.
 */
export default async function globalSetup(): Promise<void> {
  loadDotenv({ path: resolve(process.cwd(), ".env"), quiet: true });

  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need a database they are allowed to TRUNCATE.",
    );
  }

  // Refuse to run against anything that is not obviously a test database: this
  // suite truncates every table between files.
  if (!/test/i.test(connectionString)) {
    throw new Error(
      "TEST_DATABASE_URL does not look like a test database. Refusing to run: the suite truncates all tables.",
    );
  }

  const { db, pool } = createDatabase({ connectionString, maxConnections: 1 });
  try {
    await migrate(db, { migrationsFolder: resolve(process.cwd(), "packages/db/drizzle") });
    await applyGuards(db);
  } finally {
    await pool.end();
  }
}
