import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index";

/**
 * Database client.
 *
 * A single pool is shared per process. The web app and the worker each create
 * their own; neither shares a connection across tenants, and every query is
 * expected to be tenant-scoped by the repository layer rather than by the
 * connection.
 */

export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | null = null;
let database: Database | null = null;

export interface DbOptions {
  connectionString: string;
  /** Pool ceiling. Workers run fewer, longer queries than the web tier. */
  maxConnections?: number;
  /** Enables TLS. Required by most managed Postgres providers. */
  ssl?: boolean;
}

export function createPool(options: DbOptions): pg.Pool {
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
    // Fail fast rather than queueing forever behind an exhausted pool.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Guards against a runaway query holding a connection indefinitely.
    statement_timeout: 60_000,
  });
}

export function createDatabase(options: DbOptions): { db: Database; pool: pg.Pool } {
  const created = createPool(options);
  return { db: drizzle(created, { schema }), pool: created };
}

/**
 * Process-wide singleton, used by the web app where a new pool per request
 * would exhaust the server.
 */
export function getDatabase(options: DbOptions): Database {
  if (!database) {
    pool = createPool(options);
    database = drizzle(pool, { schema });
  }
  return database;
}

export function getPool(): pg.Pool | null {
  return pool;
}

/** Close the singleton pool. Used by tests and graceful shutdown. */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    database = null;
  }
}

/**
 * Readiness probe: confirms the database is reachable and responding.
 * Deliberately returns a boolean rather than the error, so a health endpoint
 * cannot leak connection details.
 */
export async function checkDatabaseConnection(db: Database): Promise<boolean> {
  try {
    await db.execute("select 1");
    return true;
  } catch {
    return false;
  }
}
