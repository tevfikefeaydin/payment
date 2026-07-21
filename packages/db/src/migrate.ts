import { migrate } from "drizzle-orm/node-postgres/migrator";
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { createDatabase } from "./client";
import { applyGuards } from "./guards";

/**
 * Migration runner.
 *
 * Applies checked-in SQL migrations, then re-applies the database guards
 * (append-only audit log, last-owner protection). Guards are idempotent, so
 * running this repeatedly is safe.
 *
 * Usage:
 *   pnpm db:migrate                  # uses DATABASE_URL
 *   DATABASE_URL=... pnpm db:migrate # explicit target
 */
async function main(): Promise<void> {
  loadDotenv({ path: resolve(import.meta.dirname, "../../../.env"), quiet: true });

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    // Report the NAME only. Never echo a connection string: it contains a password.
    console.error("DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const { db, pool } = createDatabase({ connectionString, maxConnections: 1 });

  try {
    console.warn("Applying migrations…");
    await migrate(db, { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });

    console.warn("Applying database guards…");
    await applyGuards(db);

    console.warn("Migrations complete.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // Migration errors are operator-facing and must not be swallowed. We print
  // the message and the underlying driver cause (which carries the PostgreSQL
  // error code and detail), but never the connection string, which holds a
  // password.
  if (error instanceof Error) {
    console.error("Migration failed:", error.message);
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof Error) {
      const pgError = cause as Error & { code?: string; detail?: string; hint?: string };
      console.error("  cause:", pgError.message);
      if (pgError.code) console.error("  code: ", pgError.code);
      if (pgError.detail) console.error("  detail:", pgError.detail);
      if (pgError.hint) console.error("  hint: ", pgError.hint);
    }
  } else {
    console.error("Migration failed: unknown error");
  }
  process.exit(1);
});
