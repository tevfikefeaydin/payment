# Implementation plan

The phased plan this build followed, with the acceptance gate for each phase and
whether that gate was actually met. Live status and evidence live in
[IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md).

## Phase 0 — Discovery and architecture

Inspect the repository, choose the stack, record decisions.

**Gate:** documents agree with the intended implementation; no critical unknown
left unrecorded.
**Met.** The repository was empty apart from the specification. The decisive
finding was that the machine had no Node, no package manager, no Docker and no
PostgreSQL, so a portable toolchain was bootstrapped rather than the work being
declared blocked. Decisions are in [adr/](./adr/).

## Phase 1 — Repository foundation

pnpm workspace, configuration validation, database schema, migrations, logging,
CI skeleton.

**Gate:** clean install, database startup and migration, lint, typecheck, test
and production build all succeed.
**Met.** 37 tables from checked-in migrations; database guards (append-only
audit log, last-owner protection) applied idempotently after every migration run.

## Phase 2 — Authentication and organizations

Sessions, organizations, invitations, roles, server-side authorization, audit
foundation, tenant-scoped data access.

**Gate:** role and cross-tenant tests pass.
**Met.** The permission matrix is asserted exhaustively (every role × every
permission). Cross-tenant isolation is proven against a live database across
reads, transitions, assignments, aggregates, audit reads and fingerprints.

## Phase 3 — Demo reconciliation vertical slice

Demo dataset, canonical models, deterministic engine, exception workflow,
dashboard, inbox, detail and audit timeline.

**Gate:** the complete Playwright demo flow and all tenant-isolation tests pass.
**Met.** All ten rules fire against the demo dataset, one exception each; a
second run creates nothing; the browser test drives register → demo → reconcile
→ investigate → acknowledge → resolve → timeline against a production build with
the real worker.

## Phase 4 — Customer Stripe read-only integration

Encrypted restricted-key connection, validation, worker sync, checkpoints,
source status, failure handling.

**Gate:** no customer write operation exists; encryption, isolation, retry,
idempotency and controlled-adapter tests pass.
**Met for the controlled path.** The read-only guarantee is enforced by a test
that scans the package's own source. Encryption round-trips, cross-tenant AAD
rejection and tamper detection are covered. **Not met for live Stripe:** no
credential was available, so the live transport has never executed.

## Phase 5 — Internal data ingestion

CSV flow, mapping, imports, API keys, versioned API, rate limiting, idempotency.

**Gate:** successful and invalid imports and API cases work; tenant and security
tests pass.
**Partially met.** The REST API is complete and was exercised over real HTTP
(401/400/409/422/413/404/405/200, replay returning the cached body, cross-tenant
idempotency-key reuse). The CSV parser, validation and worker handler are done
and tested. The upload/mapping **screens** are stubs.

## Phase 6 — Notifications and scheduling

Email and Slack destinations, policies, delivery jobs, deduplication, recurring
reconciliation.

**Gate:** delivery and retry tests pass with no secret exposure.
**Met at the package level.** Slack webhooks are encrypted with the same envelope
as Stripe keys; dedup, thresholds, retry/backoff and no-leak assertions are
covered. Management screens are stubs. Running it against a live database is what
surfaced the invalid-SQL bug in the delivery claim.

## Phase 7 — Platform billing

Separate billing client, checkout and portal, signed webhook processing, plans,
entitlements, usage limits.

**Gate:** the two Stripe contexts are demonstrably separated; webhook and
idempotency tests pass.
**Met for the fixture path.** Separation is enforced in both directions by
ESLint and by source-scanning tests. Webhook idempotency and out-of-order
tolerance are covered by fixtures. **No live Stripe account was used.**

## Phase 8 — Hardening and production readiness

Retention, observability, health, deployment, accessibility, security review,
clean-setup verification, documentation.

**Gate:** complete verification passes from a clean environment, or exact
blockers are documented.
**Partially met.** `pnpm verify` passes end to end and Playwright is green.
Health endpoints, Dockerfiles with non-root users, Compose, CI, CodeQL and
Dependabot are in place. Outstanding items and residual risks are listed
explicitly in IMPLEMENTATION_STATUS.md rather than glossed over.

---

## Remaining work, in priority order

1. CSV upload, preview and column-mapping screens over the tested parser.
2. Password reset and email verification flows over the existing token model.
3. Notification, API-key and billing management screens.
4. A live-credential verification pass for both Stripe contexts.
5. Metrics backend wiring and a dead-letter view for terminal job failures.
6. Rate limiting on authentication endpoints.
7. Key re-encryption driver for rotation.
