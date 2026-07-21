import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { loadEnv } from "@payrecon/config/env";
import { db } from "@/server/db";

/**
 * Liveness and readiness probe.
 *
 * Liveness ("the process is running and can serve a request") is implied by
 * reaching this handler at all. Readiness additionally requires that the
 * environment validated and that PostgreSQL answers a trivial query.
 *
 * The response deliberately contains no configuration values, no connection
 * strings, no version numbers and no error text: a probe endpoint is
 * unauthenticated, so it must be useless to an attacker. Failures are reported
 * as a status only; the detail goes to the server log.
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(): Promise<NextResponse> {
  let configOk = false;
  try {
    loadEnv();
    configOk = true;
  } catch (error) {
    console.error("[health] configuration invalid", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }

  let databaseOk = false;
  if (configOk) {
    try {
      await db().execute(sql`select 1`);
      databaseOk = true;
    } catch (error) {
      console.error("[health] database unreachable", {
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const ready = configOk && databaseOk;

  return NextResponse.json(
    {
      status: ready ? "ok" : "degraded",
      live: true,
      ready,
      checks: {
        configuration: configOk ? "ok" : "failed",
        database: databaseOk ? "ok" : configOk ? "failed" : "skipped",
      },
      timestamp: new Date().toISOString(),
    },
    {
      // 503 lets a load balancer take this instance out of rotation while the
      // process itself stays alive and keeps being probed.
      status: ready ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
