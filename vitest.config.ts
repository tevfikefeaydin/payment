import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Workspace aliases.
 *
 * Order matters: Vite applies the first matching entry. Directory subpaths such
 * as `@payrecon/db/schema` must be listed BEFORE the generic `*` regex, which
 * would otherwise rewrite them to a non-existent `schema.ts`.
 */
const alias = [
  // --- specific directory subpaths -----------------------------------------
  // Anchored regexes, NOT plain strings: a string alias in Vite is a PREFIX
  // match, so `"@payrecon/db/schema"` would also swallow
  // `@payrecon/db/schema/enums` and rewrite it to `.../schema/index.ts/enums`.
  { find: /^@payrecon\/db\/schema$/, replacement: r("./packages/db/src/schema/index.ts") },
  { find: /^@payrecon\/db\/schema\/(.*)$/, replacement: r("./packages/db/src/schema/$1.ts") },
  {
    find: /^@payrecon\/db\/repositories\/(.*)$/,
    replacement: r("./packages/db/src/repositories/$1.ts"),
  },
  { find: /^@payrecon\/db\/services\/(.*)$/, replacement: r("./packages/db/src/services/$1.ts") },

  // --- generic file subpaths ------------------------------------------------
  { find: /^@payrecon\/config\/(.*)$/, replacement: r("./packages/config/src/$1.ts") },
  { find: /^@payrecon\/domain\/(.*)$/, replacement: r("./packages/domain/src/$1.ts") },
  { find: /^@payrecon\/db\/(.*)$/, replacement: r("./packages/db/src/$1.ts") },
  { find: /^@payrecon\/auth\/(.*)$/, replacement: r("./packages/auth/src/$1.ts") },
  { find: /^@payrecon\/jobs\/(.*)$/, replacement: r("./packages/jobs/src/$1.ts") },
  {
    find: /^@payrecon\/notifications\/(.*)$/,
    replacement: r("./packages/notifications/src/$1.ts"),
  },
  { find: /^@payrecon\/ingestion\/(.*)$/, replacement: r("./packages/ingestion/src/$1.ts") },
  {
    find: /^@payrecon\/stripe-customer-data\/(.*)$/,
    replacement: r("./packages/stripe-customer-data/src/$1.ts"),
  },
  {
    find: /^@payrecon\/platform-billing\/(.*)$/,
    replacement: r("./packages/platform-billing/src/$1.ts"),
  },

  // --- package roots (anchored so they cannot swallow subpaths) -------------
  { find: /^@payrecon\/config$/, replacement: r("./packages/config/src/index.ts") },
  { find: /^@payrecon\/domain$/, replacement: r("./packages/domain/src/index.ts") },
  { find: /^@payrecon\/db$/, replacement: r("./packages/db/src/index.ts") },
  { find: /^@payrecon\/auth$/, replacement: r("./packages/auth/src/index.ts") },
  { find: /^@payrecon\/jobs$/, replacement: r("./packages/jobs/src/index.ts") },
  { find: /^@payrecon\/notifications$/, replacement: r("./packages/notifications/src/index.ts") },
  { find: /^@payrecon\/ingestion$/, replacement: r("./packages/ingestion/src/index.ts") },
  {
    find: /^@payrecon\/stripe-customer-data$/,
    replacement: r("./packages/stripe-customer-data/src/index.ts"),
  },
  {
    find: /^@payrecon\/platform-billing$/,
    replacement: r("./packages/platform-billing/src/index.ts"),
  },
];

/**
 * Two test projects with different requirements:
 *
 *  - `unit`        pure and fast, no external services. Runs anywhere.
 *  - `integration` requires a live PostgreSQL (TEST_DATABASE_URL). Files run
 *                  serially because they truncate shared tables between suites.
 *
 * Neither project requires production secrets or a live Stripe account.
 */
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
          exclude: ["**/node_modules/**", "**/dist/**", "tests/integration/**"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          exclude: ["**/node_modules/**"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
          globalSetup: ["tests/integration/global-setup.ts"],
          setupFiles: ["tests/integration/setup.ts"],
        },
      },
    ],
  },
});
