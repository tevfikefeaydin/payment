# AGENTS.md — repository operating guide

Concise reference for working in this repository. Product overview and setup are
in [`README.md`](README.md); verified status is in
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md).

---

## Environment

Node is **not** on this machine's system `PATH`. A portable toolchain lives in
`.toolchain/`. Prefix every PowerShell command:

```powershell
$env:PATH="C:\Users\efea\Desktop\payment\.toolchain\node-v24.18.0-win-x64;$env:APPDATA\npm;$env:PATH"
Set-Location "C:\Users\efea\Desktop\payment"
```

PostgreSQL 17 runs from `.toolchain/pgsql` with its cluster in
`.toolchain/pgdata` on `127.0.0.1:55432`. Start and stop it with
`scripts/start-db.ps1` and `scripts/stop-db.ps1`.

---

## Commands

```bash
pnpm install --frozen-lockfile   # never edit versions by hand; see the catalog
pnpm db:migrate                  # migrations + idempotent database guards
pnpm dev                         # web, port 3000
pnpm dev:worker                  # worker, health on port 3001
pnpm verify                      # format:check + lint + typecheck + test + build
```

Run one test file:

```bash
pnpm vitest run packages/domain/src/reconciliation.test.ts
```

Run one test by name:

```bash
pnpm vitest run packages/domain/src/money.test.ts -t "zero-decimal"
```

Integration tests need `TEST_DATABASE_URL` and run serially because they
truncate shared tables:

```bash
pnpm test:integration
pnpm vitest run --project integration tests/integration/tenant-isolation.test.ts
```

End-to-end verification of the reconciliation core against a real database:

```bash
pnpm --filter @payrecon/db exec tsx src/verify-core.ts
```

---

## Hard invariants

These are not style preferences. Breaking one is a defect.

1. **Money is `bigint` minor units plus an uppercase ISO-4217 code.** No floats,
   ever. Use `packages/domain/src/money.ts`. ESLint bans `Math.round`,
   `Math.floor`, `Math.ceil`, `parseFloat` and `parseInt` inside
   `packages/domain/**`.
2. **Never sum unlike currencies.** `addMoney` throws on a currency mismatch, and
   `MoneyBag` deliberately has no `.total()` — callers iterate per currency.
   Revenue at risk is always reported per currency.
3. **Every tenant query is scoped by `organization_id`, server-side.** An
   organization id from the browser is never trusted; it is resolved through
   `resolveOrgContext` / `requireOrgContext`
   (`packages/auth/src/authorization.ts`), and queries use the id from the
   resulting context.
4. **Not-found over forbidden.** Touching another tenant's resource returns 404,
   not 403. A 403 would confirm the id exists.
5. **The two Stripe contexts never mix.** `@payrecon/stripe-customer-data`
   (customer read-only data) and `@payrecon/platform-billing` (PayRecon's own
   subscriptions) may not import each other; ESLint `no-restricted-imports`
   enforces this in both directions. No code path writes to a customer's Stripe
   account, and only `rk_test_` / `rk_live_` keys are accepted.
6. **The audit log is append-only.** A database trigger rejects `UPDATE` and
   `DELETE` on `audit_events`. Only the privileged `purgeOrganization` path
   suspends it, inside a single transaction.
7. **Viewer is read-only.** The role/permission matrix lives in
   `packages/domain/src/permissions.ts` and nowhere else. Never write a string
   role comparison in a component; resolve a `Permission` and check it on the
   server.
8. **Secrets never leave the process.** Env validation reports variable _names_
   only. Logs, audit metadata and user-facing errors pass through
   `packages/domain/src/redaction.ts`. Decrypted credentials never reach the
   browser, telemetry, audit rows or test snapshots.
9. **Jobs are idempotent and carry tenant context**, which handlers re-verify
   against the database rather than trusting the payload.
10. **Dependency versions live in the `pnpm-workspace.yaml` catalog.** Packages
    reference `catalog:`. TypeScript is pinned to 5.9.3 — see ADR 0001.

---

## Key paths

| Concern                            | Path                                             |
| ---------------------------------- | ------------------------------------------------ |
| Money arithmetic                   | `packages/domain/src/money.ts`                   |
| Reconciliation rules (all ten)     | `packages/domain/src/reconciliation.ts`          |
| Provider ↔ internal matching       | `packages/domain/src/matching.ts`                |
| Exception fingerprints             | `packages/domain/src/fingerprint.ts`             |
| Exception state machine            | `packages/domain/src/exception-state.ts`         |
| Role/permission matrix             | `packages/domain/src/permissions.ts`             |
| Redaction, safe errors, CSV safety | `packages/domain/src/redaction.ts`               |
| Boundary validation and limits     | `packages/domain/src/validation.ts`              |
| Schema (one file per area)         | `packages/db/src/schema/*.ts`                    |
| Database triggers                  | `packages/db/src/guards.ts`                      |
| Migration runner                   | `packages/db/src/migrate.ts`                     |
| Run orchestration                  | `packages/db/src/services/run-reconciliation.ts` |
| Demo dataset                       | `packages/db/src/services/demo-data.ts`          |
| Soft delete vs purge               | `packages/db/src/services/purge-organization.ts` |
| AES-256-GCM envelope               | `packages/auth/src/crypto.ts`                    |
| scrypt passwords                   | `packages/auth/src/password.ts`                  |
| Tokens, API keys, CSRF             | `packages/auth/src/tokens.ts`                    |
| Sessions                           | `packages/auth/src/session.ts`                   |
| Tenant resolution + authz          | `packages/auth/src/authorization.ts`             |
| Queue names, payloads, retries     | `packages/jobs/src/queue.ts`                     |
| Job handlers                       | `packages/jobs/src/handlers.ts`                  |
| Worker entry + health              | `apps/worker/src/main.ts`                        |
| Env schema                         | `packages/config/src/env.ts`                     |
| Plans and limits                   | `packages/config/src/plans.ts`                   |
| Product name / cookie names        | `packages/config/src/product.ts`                 |

---

## Conventions

- Package imports resolve through `exports` maps to `src/*.ts` directly — there
  is no build step for workspace packages. Vitest mirrors this in
  `vitest.config.ts`; **alias order matters** there (specific subpaths before the
  generic regex).
- Prettier: 100 columns, double quotes, trailing commas, LF.
- `no-console` is an error outside tests and scripts; `console.warn` and
  `console.error` are allowed for operator-facing output.
- Never hard-code the string "PayRecon" outside `packages/config/src/product.ts`
  — import `PRODUCT`.
- Regenerate migrations with `pnpm db:generate` after any schema change; never
  hand-edit `packages/db/drizzle/*.sql`.

## Not yet implemented

Do not describe these as working:

- **Four queues have no handler**: `stripe.sync`, `import.process`,
  `notification.dispatch`, `notification.send-pending`. They accept jobs; nothing
  consumes them. See `registerHandlers` in `packages/jobs/src/handlers.ts`.
- Retention cleanup clears only `import_batches.raw_content` and dead sessions —
  not expired idempotency records, elapsed rate-limit windows, or provider data.
- No dead-letter UI (inspect `pgboss.job` with SQL) and no metrics backend.
- No key re-encryption job. `rotateEnvelope` exists; nothing drives it over the
  tables.
