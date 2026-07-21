import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { checkEnv, loadEnv } from "@payrecon/config/env";
import { checkDatabaseConnection, createDatabase } from "@payrecon/db";
import { getQueue, registerHandlers, registerSchedules, stopQueue } from "@payrecon/jobs";

/**
 * Worker entry point.
 *
 * Runs every long, retriable or scheduled unit of work: reconciliation, Stripe
 * synchronisation, CSV import, notification delivery and retention cleanup.
 * None of these belong in a browser request.
 *
 * The process exposes a tiny HTTP health endpoint so a container orchestrator
 * can distinguish "alive" from "able to do work".
 */

loadDotenv({ path: resolve(process.cwd(), "../../.env"), quiet: true });

// Fail fast and loudly on misconfiguration, reporting NAMES only.
const envCheck = checkEnv();
if (!envCheck.ok) {
  console.error("Worker cannot start. Invalid configuration:");
  for (const problem of envCheck.problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const env = loadEnv();
const { db, pool } = createDatabase({
  connectionString: env.DATABASE_URL,
  maxConnections: Math.max(env.WORKER_CONCURRENCY * 2, 4),
});

let shuttingDown = false;

async function main(): Promise<void> {
  const queue = await getQueue({
    connectionString: env.DATABASE_URL,
    max: env.WORKER_CONCURRENCY,
  });

  await registerHandlers({
    db,
    queue,
    reconciliationCron: env.RECONCILIATION_SCHEDULE_CRON,
    integrations: {
      db,
      appUrl: env.APP_URL,
      smtp: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        secure: env.SMTP_SECURE,
        from: env.EMAIL_FROM,
      },
      stripeTransport: env.STRIPE_CUSTOMER_TRANSPORT,
      stripeRateLimitRps: env.STRIPE_CUSTOMER_RATE_LIMIT_RPS,
    },
  });
  await registerSchedules(queue, { reconciliationCron: env.RECONCILIATION_SCHEDULE_CRON });

  startHealthServer();

  console.warn(
    JSON.stringify({
      level: "info",
      component: "worker",
      action: "started",
      concurrency: env.WORKER_CONCURRENCY,
      reconciliationCron: env.RECONCILIATION_SCHEDULE_CRON,
    }),
  );
}

/**
 * Health endpoints.
 *   /health/live  — the process is running (never touches the database)
 *   /health/ready — configuration is valid AND the database is reachable
 * Neither response contains configuration values.
 */
function startHealthServer(): void {
  const port = env.WORKER_HEALTH_PORT;

  const server = createServer((request, response) => {
    const url = request.url ?? "/";

    if (url === "/health/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: shuttingDown ? "shutting_down" : "ok" }));
      return;
    }

    if (url === "/health/ready") {
      void (async () => {
        const configOk = checkEnv().ok;
        const dbOk = await checkDatabaseConnection(db);
        const ready = configOk && dbOk && !shuttingDown;
        response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: ready ? "ready" : "not_ready",
            checks: { configuration: configOk, database: dbOk },
          }),
        );
      })();
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  server.listen(port, () => {
    console.warn(
      JSON.stringify({ level: "info", component: "worker", action: "health_listening", port }),
    );
  });
}

/**
 * Graceful shutdown: stop accepting new jobs, let in-flight jobs finish, then
 * close the pool. Killing mid-job would rely on retries to recover work that
 * could simply have been allowed to complete.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(JSON.stringify({ level: "info", component: "worker", action: "shutdown", signal }));

  try {
    await stopQueue();
    await pool.end();
  } catch (error) {
    console.error("[worker] error during shutdown", {
      message: error instanceof Error ? error.message : "unknown",
    });
  } finally {
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandled rejection", {
    message: reason instanceof Error ? reason.message : "unknown",
  });
});

main().catch((error: unknown) => {
  console.error("[worker] failed to start", {
    message: error instanceof Error ? error.message : "unknown",
  });
  process.exit(1);
});
