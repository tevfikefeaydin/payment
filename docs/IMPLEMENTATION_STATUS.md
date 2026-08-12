# Implementation status

Live, evidence-backed record of what exists and what does not. Every "verified"
claim corresponds to a command that was actually run, with its real output.

**Last updated:** 2026-08-10

---

## Environment note

The build machine had **no Node.js, no package manager, no Docker and no
PostgreSQL** — only `git`. A local toolchain was bootstrapped into `.toolchain/`
(git-ignored) so the project could actually be built and verified rather than
merely written:

| Component  | Version | How it runs                                                          |
| ---------- | ------- | -------------------------------------------------------------------- |
| Node.js    | 24.18.0 | portable zip in `.toolchain/node-v24.18.0-win-x64`                   |
| pnpm       | 10.34.5 | installed via npm                                                    |
| PostgreSQL | 17.6    | portable binaries, cluster in `.toolchain/pgdata`, `127.0.0.1:55432` |

Databases: `payrecon_dev`, `payrecon_test`, `payrecon_e2e`.
`scripts/setup-local.ps1` reproduces this from scratch.

Because Node is not on the system `PATH`, prefix commands with:

```powershell
$env:PATH="C:\Users\efea\Desktop\payment\.toolchain\node-v24.18.0-win-x64;$env:APPDATA\npm;$env:PATH"
```

---

## Full verification — `pnpm verify`

Actual output of the complete gate chain (format, lint, typecheck, all tests, build):

```
All matched files use Prettier code style!     # format:check
                                               # lint — no output, clean
                                               # typecheck (packages, web, worker) — clean
 Test Files  33 passed (33)
      Tests  734 passed (734)
✓ Compiled successfully                        # production build
```

### End-to-end (Playwright, real browser, production build, worker running)

```
ok 1 registers, loads demo data, reconciles, and resolves an exception (11.9s)
ok 2 keeps two organizations completely separate                       (8.7s)
ok 3 requires authentication for application routes                    (1.9s)
ok 4 rejects a sign-in with the wrong password without revealing
     whether the account exists                                        (5.6s)
ok 5 the marketing page loads and links to sign up                     (2.5s)
ok 6 reconciliation is idempotent from the UI                          (15.4s)
6 passed
```

These run against a **production build** of the web app with the **real worker
process** consuming jobs from pg-boss. Nothing is stubbed: the exceptions the
tests assert on are produced by the production reconciliation engine.

### Migrations

```
pnpm db:migrate
→ Applying migrations…  → Applying database guards…  → Migrations complete.
```

37 tables across two checked-in migrations, applied to an empty database.

### Reconciliation core

`packages/db/src/verify-core.ts` seeds the demo dataset, runs reconciliation
through the production path, then purges:

```
run 1 -> created=10 reopened=0 unchanged=0
ALL 10 RULES FIRED   (exactly one exception per rule)
run 2 -> created=0 reopened=0 unchanged=10
IDEMPOTENT: second run created 0 new exceptions
open by severity: critical=3, high=6, medium=1
revenue at risk per currency: EUR=8900 (1), USD=121000 (9)
```

Revenue at risk is reported **per currency and never summed across currencies**.

### Security properties verified against a live database

- Cross-tenant reads, transitions and assignments refused (IDOR).
- The same `externalId` coexists in two tenants without collision.
- Identical data in two tenants produces **disjoint** exception fingerprints.
- Audit log rejects UPDATE and DELETE even from a direct SQL statement.
- An organization cannot lose its last owner, even via raw SQL.
- A resolved exception **reopens** when the problem returns; an **acknowledged**
  one is not reset by re-detection.
- Optimistic concurrency rejects a genuinely stale write with 409, while a
  routine re-detection does **not** invalidate an operator's held version.

### The read-only Stripe guarantee is enforced by test

`packages/stripe-customer-data/src/read-only-invariant.test.ts` reads the
package's own source from disk on every run and fails if a write-capable Stripe
call, a non-GET verb, or an import of the platform-billing context appears. The
integration uses only `.list()` and `.retrieve()`.

`packages/platform-billing/src/context-separation.test.ts` does the mirror check
in the other direction.

---

## Bugs found by running the code, not by reading it

1. **Last-owner trigger blocked legitimate organization deletion** via the FK
   cascade. Fixed by skipping the check when the parent organization is gone.

2. **Append-only audit guard blocked organization deletion.** Rather than
   weakening the guard, deletion was split into `softDeleteOrganization` (the
   ordinary product path — revokes access immediately, destroys nothing) and
   `purgeOrganization` (a privileged path that suspends the guard inside one
   transaction). Better design than the original.

3. **Rule 4 aborted an entire tenant's run on one malformed currency.**
   `normalizeCurrency` was called unguarded, and because rule 4 runs before rule
   5 — the rule that _counts_ this case in `diagnostics.invalidCurrencyRecords` —
   the diagnostic was unreachable. Fixed in the rule and the shared evidence
   renderer.

4. **Every reconciliation run bumped `version` on every matched exception**,
   which invalidated the optimistic-concurrency token an operator was holding in
   an open form. Any scheduled run would have rejected their acknowledge/resolve
   with a spurious 409. `version` now advances only on a real state change.
   Caught because the E2E acknowledge step failed under load; an integration
   test now locks the behaviour in.

5. **`inArray(column, subquery)` produced invalid SQL** in the notification
   delivery claim, so the delivery job failed against real PostgreSQL while
   passing against the in-memory test store.

6. **Vitest string aliases silently mangled every subpath import.** A plain
   string alias in Vite is a prefix match, so `@payrecon/db/schema/enums`
   resolved to `.../src/index.ts/schema/enums`. All aliases are now anchored
   regexes.

7. **`Link` wrapping `Button` on the marketing page** — nested interactive
   content, invalid HTML, and it breaks the accessible name. Replaced with
   anchors styled as buttons (`buttonClassName`).

8. **drizzle-kit cannot serialise `bigint` column defaults**; `safeFilename`
   contained raw NUL bytes; `apps/worker/tsconfig.json` was missing, which broke
   `pnpm build`.

9. **TypeScript 7.0.2 would have silently broken linting.** The registry's
   current TypeScript is 7.0.2, but `typescript-eslint@8` requires `<6.1.0`. The
   toolchain is pinned to TypeScript 5.9.3 / ESLint 9.39.5. See ADR 0001.

---

## Not implemented

Stated plainly rather than described as done:

- ~~CSV import UI~~ **Done, verified live 2026-07-28**: upload, column mapping
  and amount-unit/date-format selection on the imports screen; a live upload of
  a 3-row file produced 2 inserted records and 1 recorded row error
  (`completed_with_errors`), all visible in the UI.
- ~~Password reset and email verification~~ **Done, verified live 2026-07-28**:
  the flows are wired to the UI and a real reset was completed end-to-end over
  SMTP in production.
- ~~Notification and API-key management screens are stubs~~ **Done, extended
  2026-08-10**: both screens were already implemented (destination CRUD + test
  message, API-key create/revoke). What was genuinely missing was **policy
  management** — without a policy row no notification is ever sent. Added
  `createPolicy`/`setPolicyEnabled`/`deletePolicy` to `@payrecon/notifications`
  (validated, audited via `notification.policy_changed`, threshold requires a
  currency so unlike currencies are never compared), policy CRUD in both
  stores, and a Policies section on the notifications screen (10 new unit
  tests over the memory store).
- ~~Billing screens~~ **Done, verified live 2026-07-28** against Stripe test
  mode: checkout session creation from the billing screen, webhook signature
  verification at `/api/billing/webhook`, subscribe → plan upgrade and cancel →
  downgrade all observed against the production database.
- ~~Retention cleanup misses idempotency/rate-limit state~~ **Done 2026-08-10**:
  the nightly retention job now also deletes expired `api_idempotency_records`
  (including wedged in-flight claims) and `api_rate_limit_buckets` whose window
  elapsed more than a day ago, verified against a live database by
  `tests/integration/retention-cleanup.test.ts` (4 tests).
- **No external metrics backend.** What exists since **2026-08-10**
  (`@payrecon/observability`): a shared pino logger whose every line passes
  through the domain redaction (sensitive keys blanked, credential-shaped
  substrings scrubbed from fields and messages — 4 unit tests), plus
  in-process counters with a bounded series cap. The worker counts every job
  outcome per queue (`jobs_processed_total` / `jobs_failed_total`, 3 unit
  tests over the batch runner) and logs the cumulative snapshot once a minute
  as a greppable line. A scrape endpoint or shipping target remains a
  deployment decision.
- ~~No dead-letter UI~~ **Done 2026-08-10**: `listFailedJobs`
  (`packages/jobs/src/dead-letter.ts`) surfaces pg-boss terminal failures on
  the runs screen, scoped to the organization id each payload carries. Only
  queue name, timing, retry count and a redacted message are shown — never the
  payload; jobs without a tenant id (maintenance ticks) stay SQL-only. Verified
  by `tests/integration/dead-letter.test.ts` (3 tests, including cross-tenant
  exclusion and secret redaction).
- ~~No rate limiting on authentication~~ **Done 2026-07-28**: sign-in, sign-up
  and password-reset are fixed-window rate limited per keyed IP hash, using the
  append-only audit log as the counter (`apps/web/src/server/auth-rate-limit.ts`).
  Sign-up can additionally be made invite-only with `ALLOW_PUBLIC_SIGNUP=false`.
- ~~No key re-encryption driver~~ **Done 2026-08-10**: `rotateStoredEnvelopes`
  (`packages/jobs/src/key-rotation.ts`) sweeps `stripe_credentials` (active
  rows) and `notification_destinations` Slack secrets, re-encrypting anything
  still under a retired key; scheduled daily as `maintenance.rotate-envelopes`
  and audited per organization with counts only. Verified against a live
  database by `tests/integration/key-rotation.test.ts` (4 tests, including
  decrypt-under-new-key-alone, idempotence and a poisoned row).

## Known limitations

- **No live Stripe account was available.** The customer integration is verified
  through a deterministic fake transport; the live transport typechecks against
  the pinned `stripe@22.3.2` declarations but **has never run against Stripe's
  API**. Platform billing is likewise verified with hand-written fixtures and a
  fake client — no live key, no real webhook, no real checkout. This is recorded
  rather than claimed as complete.
- ~~`store-drizzle.ts` in notifications and platform-billing has thin
  live-database coverage~~ **Closed 2026-08-10**:
  `tests/integration/notification-store.test.ts` runs the Slack
  encrypt/decrypt round trip and the full policy lifecycle in SQL (3 tests),
  and `tests/integration/billing-store.test.ts` executes every
  `BillingStore` method against real PostgreSQL — plan updates,
  customer-insert race convergence, sparse-event subscription upserts,
  webhook claim idempotency and the limit counters (5 tests).
- **CSP allows `'unsafe-inline'` for scripts**, which materially weakens XSS
  protection. Next's inlined bootstrap requires it without a nonce-based setup.
  Recorded as residual risk in `docs/THREAT_MODEL.md`, not presented as solved.
- **Cross-tenant page access returns the not-found page but with HTTP 200** in
  one case: Next 16 streams the response, so headers are committed before the
  lookup completes. No data leaks; only the status code is imprecise.

## Next task

Decide where metrics are scraped or shipped (Prometheus endpoint vs.
log-derived), and revisit the two recorded residual risks: CSP
`'unsafe-inline'` and the 200-status not-found page on streamed routes.
