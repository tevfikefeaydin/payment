import { sql } from "drizzle-orm";
import type { Database } from "@payrecon/db";
import { redactSecretsInText } from "@payrecon/domain";

/**
 * Read-only view over pg-boss's terminal failures for ONE tenant.
 *
 * pg-boss keeps a failed job's row (state `failed`) in `pgboss.job` until its
 * retention elapses; until now the only way to see one was SQL by hand. This
 * surfaces them per organization by matching the tenant id every queue payload
 * carries — a job with no `organizationId` (the scheduled maintenance ticks) is
 * instance-wide and deliberately never shown to a tenant.
 *
 * Only queue name, timing, retry count and a REDACTED failure message leave
 * this function. The payload itself is never returned: it is operator input to
 * the worker, not something to render in a browser.
 */

export interface DeadLetterJob {
  id: string;
  queue: string;
  retryCount: number;
  createdAt: Date;
  failedAt: Date | null;
  /** Sanitised failure message; never contains payloads or key material. */
  error: string | null;
}

const MAX_ERROR_CHARS = 300;

interface FailedJobRow extends Record<string, unknown> {
  id: string;
  name: string;
  retry_count: number;
  created_on: Date;
  completed_on: Date | null;
  output: unknown;
}

function extractError(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  const message =
    typeof output === "string"
      ? output
      : typeof output === "object" && typeof (output as { message?: unknown }).message === "string"
        ? (output as { message: string }).message
        : null;
  if (!message) return null;
  return redactSecretsInText(message).slice(0, MAX_ERROR_CHARS);
}

export async function listFailedJobs(
  db: Database,
  organizationId: string,
  limit = 20,
): Promise<DeadLetterJob[]> {
  let rows: FailedJobRow[];
  try {
    const result = await db.execute<FailedJobRow>(sql`
      select id, name, retry_count, created_on, completed_on, output
      from pgboss.job
      where state = 'failed'
        and data ->> 'organizationId' = ${organizationId}
      order by completed_on desc nulls last, created_on desc
      limit ${limit}
    `);
    rows = result.rows;
  } catch (error) {
    // 42P01 undefined_table: the worker has never started against this
    // database, so pg-boss's schema does not exist — and neither do failures.
    if (typeof error === "object" && error !== null) {
      const cause = (error as { cause?: unknown }).cause ?? error;
      if ((cause as { code?: unknown }).code === "42P01") return [];
    }
    throw error;
  }

  return rows.map((row) => ({
    id: row.id,
    queue: row.name,
    retryCount: row.retry_count,
    createdAt: new Date(row.created_on),
    failedAt: row.completed_on ? new Date(row.completed_on) : null,
    error: extractError(row.output),
  }));
}
