import { checkDatabaseConnection } from "@payrecon/db";
import { db } from "@/server/db";

/**
 * GET /api/v1/health — unauthenticated liveness and readiness probe.
 *
 * Unauthenticated on purpose: a load balancer or uptime monitor must be able to
 * call it without holding a customer credential. Because it is unauthenticated,
 * it discloses NOTHING beyond whether the service can serve traffic — no
 * version, no commit, no environment name, no hostname, no connection details,
 * no counts. Those are the details an attacker uses to fingerprint a
 * deployment, and none of them help a monitor decide "up or down".
 *
 * 200 = ready to serve. 503 = alive but not ready, so a load balancer drains
 * this instance instead of sending it traffic that will fail.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  let databaseReady = false;
  try {
    // Returns a boolean rather than throwing, so a connection error's text
    // (which can contain the host, user and database name) never escapes.
    databaseReady = await checkDatabaseConnection(db());
  } catch {
    databaseReady = false;
  }

  const body = {
    status: databaseReady ? "ok" : "degraded",
    checks: { database: databaseReady },
    time: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    status: databaseReady ? 200 : 503,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
