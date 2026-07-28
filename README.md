# PayRecon

[![CI](https://github.com/tevfikefeaydin/payment/actions/workflows/ci.yml/badge.svg)](https://github.com/tevfikefeaydin/payment/actions/workflows/ci.yml)
[![CodeQL](https://github.com/tevfikefeaydin/payment/actions/workflows/codeql.yml/badge.svg)](https://github.com/tevfikefeaydin/payment/actions/workflows/codeql.yml)

**Catch payment bugs before they become lost revenue.**

Monitor Stripe and your application's payment records from one exception inbox.

PayRecon is a multi-tenant B2B SaaS for small software companies. It compares
what a payment provider says happened with what the company's own database says
happened, and raises a prioritised, evidence-backed exception whenever the two
disagree — before the mismatch becomes lost revenue, a support incident, or
month-end reconciliation work.

---

## What it does

- Detects the ten mismatch classes documented in
  [`docs/RECONCILIATION_RULES.md`](docs/RECONCILIATION_RULES.md): payments Stripe
  captured that your system never recorded, internal "paid" records with no
  provider payment, amount and currency mismatches, duplicate charges, refund
  disagreements, paid invoices on cancelled subscriptions, failed invoices on
  active subscriptions, and stale pending payments.
- Quantifies **revenue at risk** in exact minor units, reported per currency and
  never summed across currencies.
- Gives one operator inbox with provider evidence, internal evidence, the
  differences highlighted, probable causes and recommended next actions.
- Keeps an append-only audit trail of access and operator actions, enforced by a
  database trigger rather than by convention.

## What it explicitly does **not** do

PayRecon is an observability and reconciliation product. It is not a payments
processor and holds no financial position of any kind.

- **Never holds, routes, transmits, exchanges or custodies funds.** There is no
  wallet, no balance, no settlement.
- **Never writes to a connected customer's Stripe account.** Only restricted
  read keys (`rk_test_…` / `rk_live_…`) are accepted; secret keys (`sk_…`) and
  publishable keys (`pk_…`) are rejected at the boundary
  (`packages/stripe-customer-data/src/key-validation.ts`).
- **Never initiates refunds, subscription changes, or webhook replays.**
  Recommended actions are advice for a human to carry out in Stripe.
- **No custody, no stablecoins, no crypto, no bank-account connectivity.**
- **No LLM in the reconciliation path.** Every rule is deterministic, versioned
  TypeScript with fixtures and unit tests.
- **Not an accounting ledger** and not tax or accounting advice.

PayRecon's own subscription billing is a completely separate Stripe context from
the customer data integration — separate environment variables, packages,
tables, clients and tests. See
[`docs/adr/0007-stripe-context-separation.md`](docs/adr/0007-stripe-context-separation.md).

---

## Repository layout

```text
apps/
  web/                      Next.js App Router application
  worker/                   Persistent Node.js worker (jobs, schedules, health)
packages/
  config/                   Env validation, plan definitions, product metadata
  domain/                   Money, matching, rules, permissions, redaction (pure)
  db/                       Drizzle schema, migrations, guards, repositories
  auth/                     Crypto, passwords, tokens, sessions, authorization
  ingestion/                CSV parsing and internal-record storage
  jobs/                     pg-boss queue definitions and handlers
  notifications/            Email/Slack rendering, transports, delivery
  stripe-customer-data/     Customer read-only Stripe integration
  platform-billing/         PayRecon's own Stripe billing (separate context)
docs/                       Architecture, data model, security, ADRs
tests/integration/          Vitest suite requiring a real PostgreSQL
e2e/                        Playwright end-to-end suite
```

---

## Prerequisites

| Requirement | Version             | Notes                                            |
| ----------- | ------------------- | ------------------------------------------------ |
| Node.js     | >= 22 (24.x tested) | `engines.node` in `package.json`                 |
| pnpm        | 10.34.5             | `packageManager` in `package.json`; use corepack |
| PostgreSQL  | 17                  | System of record and the job queue's storage     |

> **This build machine has no system Node.js and no system PostgreSQL.** A
> portable toolchain lives in `.toolchain/` (git-ignored) and
> `scripts/setup-local.ps1` bootstraps it. Both setup paths are documented
> below — use whichever matches your machine.

---

## Setup path A — normal (system Node + Docker Compose)

Use this if you have Node and Docker installed.

```bash
# 1. Install dependencies
corepack enable
pnpm install --frozen-lockfile

# 2. Start local dependencies (PostgreSQL 17 + Mailpit for SMTP)
docker compose up -d

# 3. Create your environment file
cp .env.example .env
```

Then fill in the two secrets in `.env`. Both must be generated, never reused
from another environment, and never committed:

```bash
# ENCRYPTION_KEY — must decode to exactly 32 bytes (AES-256)
openssl rand -base64 32

# AUTH_SECRET — at least 32 characters
openssl rand -base64 48
```

`docker-compose.yml` publishes PostgreSQL on port **55432** so it matches the
connection strings already present in `.env.example`:

```dotenv
DATABASE_URL=postgresql://postgres:payrecon_dev_pw@127.0.0.1:55432/payrecon_dev
TEST_DATABASE_URL=postgresql://postgres:payrecon_dev_pw@127.0.0.1:55432/payrecon_test
```

Apply migrations and start the two processes:

```bash
pnpm db:migrate     # applies SQL migrations, then re-applies database guards
pnpm dev            # web app on http://localhost:3000
pnpm dev:worker     # worker; health on http://localhost:3001/health/live
```

## Setup path B — bootstrap (no system Node, no Docker)

`scripts/setup-local.ps1` reproduces exactly the toolchain this repository was
built with: portable Node 24, pnpm, portable PostgreSQL 17 binaries, an
`initdb` cluster in `.toolchain/pgdata` listening on `127.0.0.1:55432`, the
`payrecon_dev` and `payrecon_test` databases, and a `.env` with freshly
generated `ENCRYPTION_KEY` and `AUTH_SECRET` values.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1
```

The script is idempotent: re-running it re-uses anything already present and
never overwrites an existing `.env` or an existing cluster.

After setup, Windows users can double-click **`start.cmd`** in the repository
root. It starts PostgreSQL, applies migrations, and opens the web app and worker
in separate terminal windows. From `cmd.exe`, the equivalent command is:

```bat
C:\Users\efea\Desktop\payment\start.cmd
```

The web app is then available at <http://localhost:3000>. Keep both terminal
windows open while using it; press `Ctrl+C` in each window to stop the processes.

To start only one process, use `scripts\start-web.cmd` or
`scripts\start-worker.cmd`. These launchers configure the portable toolchain
automatically, so the PowerShell `$env:PATH=...` command is not needed.

Because the portable Node is not on the system `PATH`, **every** subsequent
manual `pnpm` command must be prefixed:

```powershell
$env:PATH="C:\Users\efea\Desktop\payment\.toolchain\node-v24.18.0-win-x64;$env:APPDATA\npm;$env:PATH"
Set-Location "C:\Users\efea\Desktop\payment"
```

Database helpers:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-db.ps1   # start the cluster
powershell -ExecutionPolicy Bypass -File scripts\stop-db.ps1    # stop it
```

Then continue exactly as in path A from `pnpm db:migrate`.

---

## Verifying the install

```bash
pnpm typecheck
pnpm test:unit          # pure tests; no database required
pnpm test:integration   # requires TEST_DATABASE_URL to be reachable
pnpm verify             # format:check + lint + typecheck + test + build
```

There is also a standalone script that exercises the reconciliation core
end-to-end against a real database — it seeds the demo dataset into a scratch
organization, runs the production engine and persistence path, asserts all ten
rules fire and that a second run is idempotent, then purges the scratch data:

```bash
pnpm --filter @payrecon/db exec tsx src/verify-core.ts
```

---

## Scripts

Every script below is defined in the root `package.json`.

| Script                  | Command                                              | What it does                                                           |
| ----------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm dev`              | `pnpm --filter @payrecon/web dev`                    | Next.js dev server on port 3000                                        |
| `pnpm dev:worker`       | `pnpm --filter @payrecon/worker dev`                 | Worker with `tsx watch`; health server on port 3001                    |
| `pnpm build`            | web `next build`, then worker `tsc --noEmit`         | Production build of both apps                                          |
| `pnpm format`           | `prettier --write .`                                 | Format the repository                                                  |
| `pnpm format:check`     | `prettier --check .`                                 | Fail if anything is unformatted (used by CI)                           |
| `pnpm lint`             | `eslint .`                                           | Flat-config ESLint, including the money and Stripe-context guard rules |
| `pnpm typecheck`        | `tsc --noEmit` for the root and `apps/web` projects  | Type checking across the workspace                                     |
| `pnpm test`             | `vitest run`                                         | Both Vitest projects (`unit` and `integration`)                        |
| `pnpm test:unit`        | `vitest run --project unit`                          | Pure tests only; no external services                                  |
| `pnpm test:integration` | `vitest run --project integration`                   | Requires `TEST_DATABASE_URL`; truncates that database between files    |
| `pnpm test:watch`       | `vitest`                                             | Watch mode                                                             |
| `pnpm test:e2e`         | `playwright test`                                    | Playwright suite against its own `payrecon_e2e` database               |
| `pnpm test:e2e:install` | `playwright install --with-deps chromium`            | Install the browser Playwright needs                                   |
| `pnpm db:generate`      | `pnpm --filter @payrecon/db generate`                | Regenerate SQL migrations from the Drizzle schema (drizzle-kit)        |
| `pnpm db:migrate`       | `pnpm --filter @payrecon/db migrate`                 | Apply migrations, then re-apply database guards idempotently           |
| `pnpm db:studio`        | `pnpm --filter @payrecon/db studio`                  | Drizzle Studio                                                         |
| `pnpm verify`           | `format:check && lint && typecheck && test && build` | The core non-E2E quality gate                                          |

---

## Environment variables

`.env.example` documents every variable with its purpose and constraints.
Configuration is validated at startup by `packages/config/src/env.ts`, which
reports the **name** of any missing or invalid variable and never prints its
value.

Highlights:

- `ENCRYPTION_KEY` must decode to exactly 32 bytes. Losing it makes every stored
  credential permanently unreadable. `ENCRYPTION_KEY_ID` labels the active key so
  rotation is unambiguous; `ENCRYPTION_KEY_PREVIOUS` / `_PREVIOUS_ID` exist only
  during a rotation.
- `STRIPE_CUSTOMER_TRANSPORT=fake` selects the deterministic in-repo adapter used
  by tests and the demo, so no live Stripe credential is ever required to run the
  suite.
- `PLATFORM_STRIPE_*` are PayRecon's **own** billing credentials and must never be
  used to read a customer's operational data. Leave them blank to run with
  billing disabled.
- `WORKER_HEALTH_PORT` (default `3001`) is read directly by
  `apps/worker/src/main.ts`. It is not part of the validated schema and is not
  listed in `.env.example`.

---

## Documentation

| Document                                                         | Contents                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| [`CLAUDE.md`](CLAUDE.md)                                         | Operating guide: commands, hard invariants, key paths         |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                   | Components, data flow, Stripe contexts, job queue             |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md)                       | Every table, tenancy, constraints, cascades, deletion order   |
| [`docs/SECURITY.md`](docs/SECURITY.md)                           | Secrets, encryption, sessions, CSRF, permission matrix        |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md)                   | Assets, trust boundaries, threats, mitigations, residual risk |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md)                       | Deploy, migrate, health, retries, backups, deletion runbook   |
| [`docs/RECONCILIATION_RULES.md`](docs/RECONCILIATION_RULES.md)   | All ten rules in full detail                                  |
| [`docs/API.md`](docs/API.md)                                     | Versioned REST ingestion API reference                        |
| [`docs/adr/`](docs/adr/)                                         | Architecture decision records                                 |
| [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) | Live, evidence-backed status of what is and is not built      |

---

## Current state

This repository is under active construction. **`docs/IMPLEMENTATION_STATUS.md`
is the authoritative record** of what has been verified.

Known gaps at the time this documentation was written:

- Four of the eight job queues have **no registered handler**:
  `stripe.sync`, `import.process`, `notification.dispatch` and
  `notification.send-pending`. They are created at startup and accept jobs, but
  nothing consumes them, so work sent to them will sit in the queue. Registered
  handlers: `reconciliation.run`, `reconciliation.schedule-tick`,
  `retention.cleanup`, `session.cleanup`.
- Retention cleanup only clears `import_batches.raw_content` and dead sessions.
  Expired idempotency records, elapsed rate-limit windows and provider-data
  retention are not implemented.
- There is no dead-letter UI; failed jobs must be inspected with SQL against the
  `pgboss` schema (`docs/OPERATIONS.md` §6).
- There is no metrics backend. Structured logs and the reconciliation run
  counters are the only telemetry.
- No live Stripe credential exists in this environment, so both Stripe contexts
  are verified through controlled adapters and signed test fixtures rather than
  against Stripe's API.
