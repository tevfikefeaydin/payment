// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Flat ESLint config for the PayRecon monorepo.
 *
 * Beyond ordinary code quality, this config mechanically enforces two of the
 * specification's hard architectural invariants:
 *
 *  1. The two Stripe contexts (customer read-only data vs. PayRecon's own
 *     platform billing) may never import each other. See
 *     docs/adr/0007-stripe-context-separation.md.
 *  2. Money is never handled with floating-point helpers.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      ".toolchain/**",
      "packages/db/drizzle/**",
      "**/*.tsbuildinfo",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["error", { allow: ["warn", "error"] }],
      "prefer-const": "error",
      "no-var": "error",
    },
  },

  // ---------------------------------------------------------------------------
  // Money safety: floating-point helpers must never touch monetary values.
  // Minor units are represented as `bigint` throughout the domain layer.
  // ---------------------------------------------------------------------------
  {
    files: ["packages/domain/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "parseFloat", message: "Money is bigint minor units. Use @payrecon/domain/money." },
        { name: "parseInt", message: "Use BigInt() or the money helpers instead of parseInt." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "round", message: "Never round money. Use bigint arithmetic." },
        { object: "Math", property: "floor", message: "Never floor money. Use bigint arithmetic." },
        { object: "Math", property: "ceil", message: "Never ceil money. Use bigint arithmetic." },
        { object: "Number", property: "parseFloat", message: "Money is bigint minor units." },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Stripe context separation, enforced in both directions.
  // ---------------------------------------------------------------------------
  {
    files: ["packages/platform-billing/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@payrecon/stripe-customer-data", "@payrecon/stripe-customer-data/*"],
              message: "Platform billing must never touch customer Stripe data. See ADR 0007.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/stripe-customer-data/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@payrecon/platform-billing", "@payrecon/platform-billing/*"],
              message: "Customer data integration must never touch platform billing. See ADR 0007.",
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Browser-side code.
  // ---------------------------------------------------------------------------
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },

  // ---------------------------------------------------------------------------
  // Tests and scripts may be noisier.
  // ---------------------------------------------------------------------------
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/tests/**/*.ts",
      "**/scripts/**/*.ts",
      "e2e/**/*.ts",
    ],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
