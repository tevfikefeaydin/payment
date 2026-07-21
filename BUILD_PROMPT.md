# PayRecon — Production-Grade Payment Reliability & Reconciliation SaaS

## Instructions to the coding agent

Read this file completely before making any changes. Treat it as the authoritative product and engineering specification.

Build the application described below from beginning to end. Do not stop after producing a plan or a scaffold. Inspect the repository first, preserve sound existing work, create the required planning documents, and then implement the product phase by phase.

Work autonomously until the application is complete or a genuine external blocker prevents further progress. Do not wait for approval between phases. When a requirement is ambiguous, choose the simplest secure design that satisfies the product goal, record the decision, and continue.

After every meaningful phase:

1. Run the relevant formatting, lint, typecheck, unit, integration, end-to-end, and build checks.
2. Fix every reproducible failure caused by the implementation.
3. Update `docs/IMPLEMENTATION_STATUS.md` with completed work, changed areas, commands executed, exact results, known limitations, and the next incomplete task.
4. Commit only if the surrounding environment explicitly asks for commits. Never expose secrets.

Never claim a feature is complete without exercising its real path. Do not replace critical behavior with placeholders, mocked success responses, dead buttons, or TODO comments.

---

## 1. Product definition

The temporary product name is **PayRecon**. Keep the public product name and related metadata centralized so it can be renamed easily.

PayRecon is a multi-tenant B2B SaaS for small software companies. It compares payment-provider data with a company's internal payment, order, subscription, and account records. It detects mismatches before they become lost revenue, customer-support incidents, or month-end reconciliation work.

Primary promise:

> Catch payment bugs before they become lost revenue.

Supporting message:

> Monitor Stripe and your application's payment records from one exception inbox.

The MVP is an observability and reconciliation product. It must not hold, transmit, route, exchange, or custody customer funds. It must never write to a connected customer's Stripe account. It must not initiate refunds, replay Stripe events, modify subscriptions, or move money.

### Target customer

- B2B SaaS and digital-product companies with roughly 3–30 employees.
- Teams using Stripe and maintaining payment or subscription state in their own application database.
- Companies processing at least hundreds or thousands of payment-related events monthly.
- Founders, finance operators, support leads, and engineers who investigate payment inconsistencies manually.

### Primary jobs to be done

- Detect when Stripe says a payment succeeded but the internal system does not show it as paid.
- Detect internal paid records with no matching provider payment.
- Detect amount and currency mismatches.
- Detect duplicate successful payments.
- Detect refund, invoice, and subscription-state mismatches.
- Identify stale internal pending payments.
- Quantify revenue at risk in exact minor units.
- Give an operator one prioritized exception inbox with evidence, probable cause, and recommended next action.
- Notify the organization when new high-value or critical exceptions appear.
- Preserve an immutable audit trail of access and operator actions.

### MVP success flow

An authenticated user creates an organization, loads realistic demo data or connects a restricted read-only Stripe key, imports internal payment records, runs reconciliation, sees exceptions, filters and investigates them, assigns and acknowledges them, resolves or reopens them, and reviews their audit timeline.

---

## 2. Scope boundaries

### Required in the MVP

- Responsive marketing page and authenticated application shell.
- Email/password authentication with secure session management.
- Organizations, invitations, membership, and role-based access control.
- Roles: owner, admin, analyst, viewer.
- Strict organization/tenant isolation.
- Demo organization and deterministic demo-data workflow.
- Restricted read-only Stripe connection.
- Encrypted credential storage.
- Background Stripe synchronization.
- CSV import with preview, validation, and column mapping.
- Versioned internal payment records REST API.
- Hashed organization API keys, rate limiting, and idempotency.
- PostgreSQL-backed durable job execution.
- Deterministic reconciliation engine.
- Exception inbox and exception detail/audit timeline.
- Revenue-at-risk calculations using exact monetary representations.
- Email and Slack notifications.
- PayRecon's own SaaS subscription billing, fully separated from customer Stripe data connections.
- Audit logging, retention controls, health checks, observability, and safe error redaction.
- Unit, integration, tenant-isolation, security, worker, and Playwright end-to-end tests.
- Docker-based local dependencies and deployable web/worker services.
- CI, CodeQL, and dependency update configuration.
- Complete developer and operator documentation.

### Explicitly out of scope

- Custodial wallets or private-key storage.
- Stablecoin issuance, exchange, transfer, routing, or settlement.
- Bank-account connectivity in the first MVP.
- Automatic refunds or subscription changes.
- Writing to a connected customer's Stripe account.
- Automatic webhook replay.
- A general-purpose accounting ledger.
- Tax calculation or accounting advice.
- AI/LLM decision-making in reconciliation rules.
- Mobile native applications.
- Enterprise SSO unless already present and trivial to preserve.

---

## 3. Preferred architecture

Use a current, stable TypeScript stack. Before choosing exact versions, inspect the repository and official package documentation available in the environment. Prefer compatibility and maintained releases over novelty.

Default architecture when starting from an empty repository:

- pnpm workspace/monorepo.
- Next.js App Router web application with TypeScript.
- A separate persistent Node.js worker process.
- PostgreSQL as the system of record.
- Drizzle ORM and checked-in migrations.
- Better Auth for authentication and organizations if it supports all required behaviors safely in the selected version.
- `pg-boss` or an equivalently reliable PostgreSQL-backed job queue.
- Zod for runtime boundary validation.
- Tailwind CSS and accessible reusable UI primitives.
- Vitest for unit and integration tests.
- Playwright for browser end-to-end tests.
- Structured JSON logging with redaction.
- Docker Compose for local PostgreSQL and any required local mail/test service.

Suggested repository structure:

```text
apps/
  web/
  worker/
packages/
  db/
  domain/
  auth/
  stripe-customer-data/
  platform-billing/
  jobs/
  notifications/
  config/
  ui/
docs/
  adr/
  IMPLEMENTATION_PLAN.md
  IMPLEMENTATION_STATUS.md
  ARCHITECTURE.md
  SECURITY.md
  THREAT_MODEL.md
  OPERATIONS.md
  DATA_MODEL.md
```

Do not force this exact structure onto a sound existing codebase. Maintain clear boundaries even if directories differ.

### Required boundary: two Stripe contexts

There are two completely different Stripe uses:

1. **Customer data integration**: a customer's restricted key used only to read the customer's operational Stripe data for reconciliation.
2. **Platform billing**: PayRecon's own Stripe account used to sell PayRecon subscriptions.

These contexts must use separate environment variables, client factories, services, routes, webhook handlers, database entities, logs, permissions, and tests. A customer restricted key must never be passed to platform billing code. Platform credentials must never be used to fetch a customer's operational data.

---

## 4. Mandatory engineering principles

### Multi-tenancy

- Every tenant-owned table must carry an `organization_id` or be reachable only through an unambiguous tenant-owned parent.
- Every tenant query must be scoped by the authenticated organization on the server.
- Never trust an organization ID, role, price, entitlement, object owner, or resource ID supplied by the browser without server-side verification.
- Prefer repository/service APIs that require organization context, making unscoped access difficult.
- Add cross-tenant integration tests for reads and writes across routes, server actions, jobs, file imports, API keys, notifications, exports, and object IDs.
- Background jobs must carry and revalidate tenant context.
- Cache keys, storage paths, deduplication keys, and rate-limit buckets must include tenant context where appropriate.

### Money and time

- Store money in integer minor units using `bigint`/database `BIGINT`, plus an explicit uppercase ISO currency code.
- Never use JavaScript floating-point arithmetic for financial calculations.
- Do not add unlike currencies. Display separate totals per currency unless an explicit, sourced FX conversion exists. FX conversion is not required in the MVP.
- Validate Stripe currencies with zero-decimal and special minor-unit behavior correctly.
- Serialize bigint safely at API boundaries, preferably as decimal strings.
- Store timestamps in UTC with timezone-aware database types and render them in the user's locale.

### Security

- Validate all external input at the boundary.
- Apply least privilege, deny by default, and enforce authorization on the server.
- Never log credentials, full API keys, session tokens, authorization headers, cookies, raw Stripe objects, or unnecessary personal data.
- Redact provider identifiers where full values are not required in logs.
- Protect state-changing browser requests against CSRF as appropriate to the auth framework.
- Apply secure cookie attributes and production-safe headers.
- Do not expose stack traces or internal exception details to users.
- Use parameterized ORM queries; isolate and review any unavoidable raw SQL.
- Sanitize spreadsheet output and CSV-derived values to prevent formula injection when exporting.
- Restrict upload type and size; stream or bound processing to prevent memory exhaustion.
- Avoid storing raw source payloads unless essential. If retained, minimize, encrypt where appropriate, and enforce retention.

### Reliability

- Design jobs as idempotent and safe to retry.
- Use database uniqueness constraints for deduplication where possible.
- Make checkpoints explicit and transaction boundaries intentional.
- Use bounded exponential backoff with jitter for transient failures.
- Mark terminal failures visibly and provide an operator retry path where safe.
- Never lose the last successful sync checkpoint because a later page fails.
- Ensure multiple workers cannot create duplicate domain results.

---

## 5. Authentication, organizations, and authorization

Implement secure registration, sign-in, sign-out, session refresh/expiry, password reset if supported, and basic account settings.

An organization has a name, stable ID, slug, created timestamp, settings, plan/entitlements, and memberships.

Roles:

- **owner**: all organization operations, billing, membership, connection deletion, and ownership-sensitive settings.
- **admin**: manage connections, imports, API keys, notification settings, exceptions, and most members; cannot silently take ownership.
- **analyst**: view and investigate data, run reconciliation, assign/acknowledge/resolve/reopen exceptions, and import data if policy permits.
- **viewer**: read-only access to dashboards, exceptions, sync status, and audit views permitted by policy.

Create a clear permission matrix in documentation and enforce it in code. Do not scatter string role checks through UI components. Centralize server-side authorization helpers and test each privileged action.

Invitation tokens must expire, be unguessable, and be stored safely. Prevent unauthorized membership escalation. Ensure the last owner cannot accidentally leave or be removed without a safe ownership-transfer flow.

---

## 6. Data model

Design and document a normalized schema. Include at least these concepts, adapting names as necessary:

- users, sessions, accounts, verification/reset tokens.
- organizations, organization memberships, invitations.
- customer Stripe connections and encrypted credential versions.
- sync runs, sync checkpoints, sync errors, imported provider objects.
- import files, import batches, mapping templates, row validation errors.
- organization API keys and API idempotency records.
- internal customers, payments, orders, subscriptions, refunds or a normalized internal payment record model.
- reconciliation runs and rule versions.
- exceptions, exception evidence, assignments, comments/notes if implemented, and state transitions.
- notification destinations, notification policies, notification deliveries.
- immutable audit events.
- platform billing customers, subscriptions, prices/plan mappings, webhook receipts, and entitlements.
- job metadata/dead-letter visibility if the queue does not supply sufficient durable metadata.

Use foreign keys, unique constraints, check constraints, and indexes deliberately. Important natural uniqueness examples include organization plus provider object ID, organization plus internal external ID, organization plus exception fingerprint, and idempotency scope plus idempotency key.

Soft deletion is acceptable only where it protects auditability or recovery. Credential deletion must make the credential unusable immediately. Document cascade behavior and data-retention deletion order.

---

## 7. Demo vertical slice

Build this before real Stripe connectivity.

Create a deterministic demo dataset containing healthy records and examples for every reconciliation rule. A user must be able to create/load a demo organization without external credentials.

The demo flow must prove:

1. Registration and sign-in.
2. Organization creation.
3. Role-aware navigation.
4. Demo data creation.
5. Reconciliation execution through the same domain engine used in production.
6. Exception list, filters, sorting, pagination, and summary metrics.
7. Exception detail with provider/internal evidence.
8. Acknowledge, assign, resolve, and reopen workflows.
9. Audit timeline.
10. Cross-tenant isolation.

Do not implement a separate fake reconciliation path just for the demo.

---

## 8. Customer Stripe read-only connection

Only accept restricted Stripe keys beginning with `rk_test_` or `rk_live_`.

Explicitly reject `sk_test_`, `sk_live_`, `pk_test_`, `pk_live_`, and unknown formats. Never print or return the supplied key after submission.

### Credential encryption

- Encrypt restricted keys at rest with AES-256-GCM or an equally secure authenticated-encryption primitive.
- Use a random unique nonce/IV for every encryption.
- Store ciphertext, nonce, authentication tag if separate, encryption version, and key identifier.
- Load the master encryption secret only from environment/secret management.
- Validate encryption-key length and format at startup.
- Bind ciphertext to tenant/record context using authenticated additional data where practical.
- Support future key rotation and re-encryption.
- Decrypt only inside the narrow server/worker execution path that needs the credential.
- Never expose decrypted material to browser code, telemetry, audit metadata, test snapshots, or errors.

### Connection validation

- Validate key prefix before network usage.
- Retrieve the Stripe account identity and store only necessary account metadata.
- Determine live/test mode.
- Where technically possible, validate that required resources are readable and surface missing permissions clearly without leaking sensitive data.
- Record sanitized audit events for creation, validation, failed validation, disabling, rotation, and deletion.
- Never make a write request to the customer's Stripe account.

### Data to synchronize

Synchronize only fields necessary for matching and evidence from:

- customers
- payment intents
- charges
- invoices
- subscriptions
- refunds
- disputes
- balance transactions
- payouts
- relevant event metadata, only if required for reliability evidence

Minimize personal data. Avoid storing full billing details, payment method details, card information, addresses, or raw payloads when not required.

### Synchronization behavior

- Initial and incremental syncs run in the worker, never as a long browser request.
- Persist per-resource checkpoints/cursors.
- Paginate safely and respect Stripe rate limits.
- Normalize transient versus permanent errors.
- Retry transient failures with bounded backoff and jitter.
- Make upserts idempotent and enforce provider-object uniqueness.
- Expose last attempted sync, last successful sync, current state, progress where meaningful, sanitized error, and retry action.
- A partial failure must not erase previously valid data or advance an unsafe checkpoint.
- Deleting/disabling a connection stops future syncs and makes its credential unusable.

Add unit, integration, encryption, retry, idempotency, authorization, tenant-isolation, and relevant E2E tests. Use Stripe test fixtures or controlled adapters; never require live credentials for the default test suite.

---

## 9. Internal payment data ingestion

Support two MVP ingestion methods: CSV import and a versioned REST API.

### Canonical internal payment record

At minimum include:

```ts
interface InternalPaymentRecordInput {
  externalId: string;
  customerId?: string;
  orderId?: string;
  subscriptionId?: string;
  providerTransactionId?: string;
  amountMinor: string;
  currency: string;
  status: "pending" | "paid" | "failed" | "refunded" | "partially_refunded";
  occurredAt: string;
  updatedAt?: string;
  metadata?: Record<string, string>;
}
```

Keep metadata bounded, validated, and free of secrets. Define update/upsert semantics explicitly.

### CSV import

- Accept CSV only within a documented size and row limit.
- Provide upload, header detection, sample preview, column mapping, saved mapping templates, validation summary, and confirmation.
- Required fields must map clearly; amount units must be explicit.
- Detect invalid dates, amounts, currencies, statuses, duplicate external IDs, and malformed rows.
- Do not silently coerce ambiguous money values.
- Process large accepted imports in the worker.
- Show batch status and row-level errors without leaking one tenant's data to another.
- Make retries idempotent.
- Defend against CSV formula injection in later exports and unsafe filename/path handling.

### REST API

- Version under `/api/v1` or an equivalent stable prefix.
- Provide an idempotent bulk upsert endpoint for internal payment records.
- Authenticate with organization API keys.
- Generate keys with secure randomness. Display the plaintext only once. Store only a strong hash plus a short non-secret prefix for identification.
- Support key name, scopes, creator, created time, last-used time, optional expiry, and revocation.
- Use constant-time verification where applicable.
- Rate-limit by organization/key and return standard headers.
- Require an `Idempotency-Key` for mutation requests, scope it safely, hash request content, store the result, and reject reuse with different content.
- Bound body size and batch size.
- Return structured validation errors and stable error codes.
- Document the API with examples that contain no real secrets.

---

## 10. Deterministic reconciliation engine

Do not use an LLM for financial matching or exception creation. Implement deterministic, versioned TypeScript rules with unit tests and fixtures.

Required initial rules:

1. `PAYMENT_SUCCEEDED_INTERNAL_MISSING`
2. `PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID`
3. `INTERNAL_PAID_PROVIDER_MISSING`
4. `PAYMENT_AMOUNT_MISMATCH`
5. `PAYMENT_CURRENCY_MISMATCH`
6. `DUPLICATE_SUCCEEDED_PAYMENT`
7. `REFUND_STATUS_MISMATCH`
8. `PAID_INVOICE_INACTIVE_SUBSCRIPTION`
9. `FAILED_INVOICE_ACTIVE_SUBSCRIPTION`
10. `STALE_INTERNAL_PENDING_PAYMENT`

For each rule document and test:

- inputs and required fields
- matching precedence
- time/tolerance windows
- exact trigger condition
- non-trigger condition
- severity
- revenue-at-risk calculation
- stable fingerprint/deduplication behavior
- evidence shown to the user
- probable causes
- recommended next actions
- behavior when source data later changes

Matching precedence should favor explicit provider transaction IDs. Use other identifiers only when safe and unambiguous. Never guess silently. Surface insufficient or ambiguous data separately rather than creating confident false positives.

A reconciliation run must record source versions/checkpoints, rule version, start/end state, counts, and sanitized errors. It must be idempotent for the same effective inputs and rule version.

Exception fingerprints must prevent duplicate open exceptions across runs while allowing resolved exceptions to reopen when the problem genuinely returns. Preserve state-transition history.

Revenue at risk must be exact and denominated per currency. Rules involving duplicate charges or refunds must avoid double-counting. Include strong tests for zero-decimal currencies, large integers, negative/refund signs, partial refunds, and duplicates.

---

## 11. Exception inbox and dashboard

### Dashboard

Show concise, actionable information:

- open exceptions by severity
- revenue at risk grouped by currency
- new exceptions over time
- source freshness and last successful sync/import
- reconciliation status
- recently changed critical/high exceptions

Do not combine currencies into a misleading single total.

### Exception list

Support server-side filtering/sorting/pagination by:

- state
- severity
- rule
- assignee
- source
- currency
- minimum/maximum revenue at risk
- creation/update date
- search by safe identifiers

Use shareable URL query parameters where practical.

### Exception detail

Show:

- plain-language problem summary
- severity and state
- exact revenue at risk and currency
- provider record evidence
- internal record evidence
- differences highlighted
- probable causes
- recommended action
- source freshness
- assignee
- timestamps
- complete audit/state timeline

Workflow states should include at least open, acknowledged, resolved, and reopened behavior. Define valid transitions centrally. State changes require authorization, optimistic concurrency or equivalent lost-update protection, and an audit event. Resolution should allow an optional bounded note; never place secrets in notes.

The UI must include real loading, empty, error, disabled, and success states. All controls must work. Meet reasonable keyboard, focus, label, color-contrast, and screen-reader accessibility expectations.

---

## 12. Notifications

Implement email and Slack notification destinations.

- Allow authorized users to configure destinations and severity/value thresholds.
- Send a verification/test message before marking a destination active.
- Prefer batched/digest notifications to alert storms, while allowing critical alerts if specified.
- Deduplicate deliveries for the same exception/event/policy.
- Track pending, sent, failed, attempt count, and sanitized error.
- Retry transient failures safely.
- Escape or sanitize untrusted values placed into message formats.
- Do not include credentials or unnecessary personal/payment data.
- Provide a link back to the authorized application page.

Slack webhook URLs are secrets and must be encrypted at rest with the same rigor as Stripe restricted keys.

---

## 13. PayRecon platform billing

Implement PayRecon's own subscription billing only after the core demo and reconciliation paths work.

Keep platform billing entirely separate from customer Stripe connections.

Required behavior:

- Organization is the billable entity.
- Central configuration maps internal plans to Stripe prices.
- Checkout/customer portal or equivalent supported flows.
- Server-derived prices and entitlements; never trust client-supplied price or plan data.
- Signed webhook verification against the raw body.
- Durable webhook receipt storage with Stripe event ID uniqueness.
- Idempotent, order-tolerant processing.
- Subscription state and entitlements derived from verified events plus safe reconciliation.
- Reasonable handling of trialing, active, past due, canceled, incomplete, and unpaid states.
- Authorization for billing actions restricted to owner/authorized admin policy.
- Test-mode fixtures and tests; no live account required.

Define simple plans and limits centrally. At minimum, enforce limits for monthly ingested events/records, connections, members or notification destinations as appropriate. Enforcement must occur server-side and produce clear product messages. Avoid destructive behavior when a plan downgrades; stop new over-limit usage while preserving access needed to export or resolve billing.

Never treat platform billing revenue as reconciled customer operational revenue.

---

## 14. Audit log

Create append-only audit events for security- and finance-relevant actions, including:

- authentication/security events where appropriate
- organization and membership changes
- role changes and invitations
- API key creation/revocation
- Stripe connection creation/validation/disable/delete/rotation
- imports and synchronization outcomes
- reconciliation runs
- exception assignment and state transitions
- notification settings changes and test sends
- billing actions and entitlement changes
- retention/deletion actions

Each event should include organization, actor type and ID when available, action, target type/ID, timestamp, request/correlation ID, and minimal redacted metadata. Do not include credentials, raw keys, session tokens, raw Stripe payloads, full authorization headers, or sensitive imported rows.

Prevent ordinary application paths from editing or deleting audit rows. Document retention and access permissions.

---

## 15. Background jobs and scheduling

Run long/retriable work in a persistent worker:

- initial/incremental Stripe sync
- CSV parsing/import
- reconciliation runs
- notification delivery
- retention cleanup
- billing-event processing if asynchronous
- scheduled recurring reconciliation

Each job must define payload validation, tenant context, uniqueness/idempotency semantics, retry class, max attempts, backoff, timeout/stall handling, and terminal failure visibility.

Add readiness/liveness checks for web and worker. A readiness check should verify required configuration and database connectivity without leaking secrets.

---

## 16. Privacy, retention, and observability

Collect only data needed for reconciliation. Document what is stored and why.

Provide organization-level retention settings within safe minimum/maximum bounds for imported raw/source data, while preserving required aggregate and audit information. Implement scheduled cleanup in batches with tenant scoping and audit records. Provide an organization deletion/export design and implement the parts required by the product specification.

Use structured logs with request/job correlation IDs, organization ID or a safe opaque reference, component, action, duration, outcome, and redacted error category. Never log secret environment values or entire request bodies.

Add basic metrics/counters for HTTP errors, job success/failure/retry, sync lag, reconciliation duration, exceptions created/reopened, notification failures, and billing webhook processing. If no telemetry backend is configured, keep the abstraction usable and document integration points.

---

## 17. UI and product quality

Create a calm, professional finance-operations interface, not a template demo.

Required pages/areas:

- marketing/home page
- sign up/sign in/account recovery
- organization creation/switching
- dashboard
- exceptions list
- exception detail and timeline
- sources/connections
- Stripe connection setup/status
- internal data imports and mapping
- API keys and API documentation link
- reconciliation runs
- notification settings
- members and roles
- billing and plan usage
- audit log
- organization/security settings

Use consistent navigation, typography, spacing, component states, and terminology. Avoid fake testimonials, fake usage numbers, fake scarcity, and unsupported claims. Make destructive actions explicit and confirm exact scope.

---

## 18. Testing strategy

Use layered tests. Tests must fail for real regressions and must not merely assert mocks were called.

### Unit tests

- every reconciliation rule and edge case
- money/currency helpers
- exception fingerprinting and state transitions
- permission matrix
- validation and redaction helpers
- encryption/decryption, unique nonces, wrong-key/tamper failure
- idempotency request hashing and conflict behavior
- Stripe key-format rejection
- notification rendering/escaping

### Integration tests with PostgreSQL

- tenant-scoped repositories
- cross-tenant ID access denial
- API key creation/hash/verification/revocation
- idempotency and concurrent duplicate requests
- CSV import/upsert behavior
- sync upserts/checkpoints/retries
- reconciliation run persistence/dedup/reopen
- exception transitions and audit events
- notification delivery deduplication
- billing webhook idempotency and entitlements
- job uniqueness/concurrent worker safety

### End-to-end tests

- register, create organization, load demo data, run reconciliation, inspect and resolve an exception
- role restrictions for viewer/analyst/admin/owner
- organization switching without data leakage
- CSV import happy path and invalid-row path
- create/revoke API key UI path without ever showing it again
- simulated Stripe restricted connection and sync using a controlled test adapter
- billing test-mode flow or verified fixture path
- meaningful error, empty, and loading states

### Security regression tests

- IDOR attempts across organizations
- missing/expired authentication
- forbidden role actions
- unrestricted Stripe key rejection
- secret redaction in errors/logging adapters
- tampered encrypted values
- invalid webhook signatures and replayed events
- oversized/invalid uploads and request bodies
- CSV formula payload handling
- rate-limit behavior

The default test suite must be reproducible without production secrets.

---

## 19. Tooling, CI, and deployment

Provide documented commands for install, format, lint, typecheck, unit tests, integration tests, E2E tests, database migrations, development, worker development, production build, and full verification.

Create a single `pnpm verify` or equivalent command that runs the core non-E2E quality gates.

Provide:

- `.env.example` with names and explanations but no secrets.
- startup validation that reports missing variables without printing values.
- Dockerfiles for web and worker using non-root runtime users and minimal production output.
- Docker Compose for local PostgreSQL and supporting test/dev services.
- safe migration workflow.
- GitHub Actions or equivalent CI for install, format, lint, typecheck, unit/integration tests, build, and Playwright where feasible.
- CodeQL/security scanning configuration.
- Dependabot or equivalent dependency update configuration.

Pin action versions appropriately. Use lockfile-frozen installs in CI. Do not bake secrets into images.

---

## 20. Required documentation

Create and maintain:

- `CLAUDE.md`: concise repository operating guide, commands, invariants, and key paths.
- `README.md`: product overview and clean local setup.
- `docs/IMPLEMENTATION_PLAN.md`: phased plan with acceptance gates.
- `docs/IMPLEMENTATION_STATUS.md`: live evidence-backed status.
- `docs/ARCHITECTURE.md`: components and data flow.
- `docs/DATA_MODEL.md`: schema and tenancy relationships.
- `docs/SECURITY.md`: secrets, encryption, auth, authorization, redaction, and incident considerations.
- `docs/THREAT_MODEL.md`: assets, trust boundaries, threats, and mitigations.
- `docs/OPERATIONS.md`: deployment, migrations, worker operation, retries, backups, health, and recovery.
- API documentation for internal payment ingestion.
- ADRs for material choices such as tenancy, auth, job queue, money representation, encryption, reconciliation fingerprints, Stripe-context separation, and retention.

Documentation must describe the implementation that actually exists, not aspirational behavior.

---

## 21. Implementation phases and gates

### Phase 0 — Discovery and architecture

- Inspect repository and current state.
- Create plan, status file, architecture, threat model, schema design, and ADRs.
- Define exact commands and quality gates.

Gate: documents agree with the actual intended implementation and no critical unknown is left unrecorded.

### Phase 1 — Repository foundation

- Workspace, web, worker, shared packages, configuration validation, database, migrations, logging, local services, and CI skeleton.

Gate: clean install, database startup/migration, lint, typecheck, test, and production build succeed.

### Phase 2 — Authentication and organizations

- Auth, sessions, organizations, invitations, roles, server authorization, audit foundation, tenant-scoped data access.

Gate: role and cross-tenant tests pass.

### Phase 3 — Demo reconciliation vertical slice

- Demo data, canonical models, deterministic engine, exception workflow, dashboard/inbox/detail UI, audit timeline.

Gate: complete Playwright demo flow and all tenant-isolation tests pass.

Do not begin real Stripe integration until Phase 0–3 gates pass.

### Phase 4 — Customer Stripe read-only integration

- Encrypted restricted-key connection, validation, worker sync, checkpoints, source status, failures, tests.

Gate: no customer write operation exists; encryption, isolation, retry, idempotency, and controlled-adapter E2E tests pass.

### Phase 5 — Internal data ingestion

- CSV flow, mapping, imports, API keys, versioned API, rate limiting, idempotency.

Gate: successful and invalid imports/API cases work; tenant/security tests pass.

### Phase 6 — Notifications and scheduling

- Email/Slack destinations, policies, delivery jobs, deduplication, recurring reconciliation.

Gate: delivery and retry tests pass with no secret exposure.

### Phase 7 — Platform billing

- Separate billing Stripe client, checkout/portal, signed webhook processing, plans, entitlements, usage limits.

Gate: platform and customer Stripe contexts are demonstrably separated; webhook/idempotency tests pass.

### Phase 8 — Hardening and production readiness

- Retention, observability, health, deployment, accessibility, security audit, performance review, clean-setup verification, full docs.

Gate: complete verification passes from a clean environment or exact external blockers are documented.

---

## 22. Definition of done

The project is complete only when all mandatory requirements are implemented and verified, including:

- A new developer can follow the README from a clean checkout.
- Web and worker start successfully with local dependencies.
- Migrations apply cleanly to an empty database.
- The demo vertical slice works end to end.
- Authentication, roles, and organization switching work.
- Automated tests demonstrate cross-tenant isolation.
- Restricted Stripe keys are encrypted and never exposed.
- Unrestricted and publishable Stripe keys are rejected for customer connections.
- No code path writes to a connected customer's Stripe account.
- Stripe sync is incremental, idempotent, retriable, and observable.
- CSV and REST ingestion validate and import real records safely.
- All ten reconciliation rules have meaningful fixtures and edge-case tests.
- Revenue-at-risk arithmetic is exact and currency-safe.
- Exception state transitions and audit history work.
- Notifications are configurable, deduplicated, and retriable.
- Platform billing is isolated from customer Stripe data.
- Audit logs cover sensitive actions without containing secrets.
- Health, retention, logging, deployment, and recovery are documented.
- No critical buttons are dead, no production path depends on fake data, and no critical TODO/FIXME remains.
- Format, lint, typecheck, unit, integration, tenant/security, E2E, migration, and production build checks pass.

If an external service credential or human-owned configuration prevents a live verification, implement and test the controlled local/test path, document the precise blocker, affected acceptance criterion, attempted command, sanitized error summary, required human action, and safe current state. Do not label the blocked item complete.

---

## 23. Final audit instructions

Before declaring completion:

1. Re-read this entire specification.
2. Compare every requirement with the actual repository.
3. Run the full clean verification suite.
4. Review the git diff and repository for secrets, missing authorization, missing tenant filters, unsafe raw SQL, floating-point money, sensitive logging, mixed Stripe contexts, insecure encryption, missing idempotency, weak retries, dead controls, mock production paths, and critical TODOs.
5. Review migrations, indexes, constraints, cascade behavior, job uniqueness, and source checkpoints.
6. Follow README setup from a clean environment.
7. Fix every reproducible problem.
8. Update `docs/IMPLEMENTATION_STATUS.md` with exact final commands and results.

Begin now by inspecting the repository and reading existing instructions. Then create or update the plan and proceed immediately into implementation.
