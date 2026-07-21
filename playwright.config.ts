import { defineConfig, devices } from "@playwright/test";
import { config as loadDotenv } from "dotenv";

loadDotenv({ path: ".env", quiet: true });

/**
 * End-to-end configuration.
 *
 * E2E runs against its OWN database (`payrecon_e2e`) so it never disturbs the
 * developer's data or races the integration suite, which truncates
 * `payrecon_test`.
 *
 * Both the web app AND the worker are started, because reconciliation genuinely
 * runs as a background job — exercising the real path rather than a shortcut is
 * the whole point of these tests.
 */

const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  "postgresql://postgres:payrecon_dev_pw@127.0.0.1:55432/payrecon_e2e";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;

/** Environment shared by the web and worker processes under test. */
const serverEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  NODE_ENV: "production",
  DATABASE_URL: E2E_DATABASE_URL,
  APP_URL: BASE_URL,
  PORT: String(PORT),
  // Reconciliation is triggered explicitly by the tests; a frequent schedule
  // would make assertions racy.
  RECONCILIATION_SCHEDULE_CRON: "0 4 * * *",
  STRIPE_CUSTOMER_TRANSPORT: "fake",
  LOG_LEVEL: "warn",
  WORKER_HEALTH_PORT: "3101",
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  globalSetup: "./e2e/global-setup.ts",

  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      command: "pnpm --filter @payrecon/web start",
      url: `${BASE_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: serverEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @payrecon/worker start",
      url: "http://127.0.0.1:3101/health/ready",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: serverEnv,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
