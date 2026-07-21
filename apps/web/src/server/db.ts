import "server-only";
import { getDatabase, type Database } from "@payrecon/db";
import { loadEnv } from "@payrecon/config/env";

/**
 * Process-wide database handle for the web tier.
 *
 * A single pool is shared across requests; creating one per request would
 * exhaust PostgreSQL's connection limit under any real traffic.
 *
 * `server-only` makes an accidental import from a client component a BUILD
 * error rather than a runtime secret leak.
 */

/**
 * Decide whether to require TLS to the database.
 *
 * Managed PostgreSQL providers require TLS, so production defaults to on. A
 * loopback address is the exception: a local cluster (development, the test
 * suite, the end-to-end run against a production build) has no certificate, and
 * the traffic never leaves the machine.
 *
 * `DATABASE_SSL` overrides the heuristic in either direction, because "is this
 * host remote?" is not something a connection string can always answer — a
 * hostname pointing at a sidecar looks remote but is not, and vice versa.
 */
function shouldUseSsl(databaseUrl: string, nodeEnv: string): boolean {
  const override = process.env.DATABASE_SSL;
  if (override !== undefined) return ["1", "true", "yes", "on"].includes(override.toLowerCase());

  if (nodeEnv !== "production") return false;

  try {
    const host = new URL(databaseUrl).hostname;
    const isLoopback =
      host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    return !isLoopback;
  } catch {
    // An unparseable URL will fail at connect time with a clearer error than
    // anything we could raise here; default to the safer choice.
    return true;
  }
}

export function db(): Database {
  const env = loadEnv();
  return getDatabase({
    connectionString: env.DATABASE_URL,
    maxConnections: 10,
    ssl: shouldUseSsl(env.DATABASE_URL, env.NODE_ENV),
  });
}
