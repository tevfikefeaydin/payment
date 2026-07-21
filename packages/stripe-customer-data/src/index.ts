/**
 * @payrecon/stripe-customer-data — the customer's READ-ONLY Stripe integration.
 *
 * HARD CONSTRAINTS, enforced throughout this package:
 *
 *  1. READ-ONLY. No code path performs a Stripe write. The transport contract in
 *     transport.ts exposes list and retrieve only; adding a mutating method
 *     would be a specification violation, not a feature.
 *
 *  2. RESTRICTED KEYS ONLY. `rk_test_` and `rk_live_` are accepted. `sk_test_`,
 *     `sk_live_`, `pk_test_`, `pk_live_` and anything unrecognised are rejected,
 *     each with its own message. The supplied key is never echoed, logged, or
 *     returned.
 *
 *  3. NEVER IMPORTS @payrecon/platform-billing. PayRecon's own billing is a
 *     separate Stripe context with separate credentials, tables and services.
 *     ESLint enforces the boundary in both directions; see ADR 0007.
 */
export * from "./key-validation";
export * from "./errors";
export * from "./retry";
export * from "./transport";
export * from "./fake-transport";
export * from "./live-transport";
export * from "./transport-factory";
export * from "./store";
export * from "./drizzle-store";
export * from "./memory-store";
export * from "./credentials";
export * from "./connection-service";
export * from "./sync";
