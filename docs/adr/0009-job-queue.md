# 0009 — Job queue

**Status:** Accepted

## Context

Several units of work must not run inside a browser request: an initial Stripe
backfill can take minutes, a 100 000-row CSV import is unbounded, reconciliation
scales with data volume, notification delivery depends on third parties, and
retention cleanup runs on a schedule.

Requirements:

- durable — a job must survive a process restart,
- retriable with bounded exponential backoff and jitter,
- **single-flight per tenant** for work where duplicate concurrent execution would
  be wrong,
- carrying tenant context that handlers can re-verify,
- observable enough to find and diagnose a failure,
- runnable on a bootstrapped local machine with no extra infrastructure.

## Decision

**pg-boss, on the same PostgreSQL instance as the domain data**, in its own
`pgboss` schema.

### Why the same database

- **One thing to operate.** One database to back up, monitor, restore and secure.
  A separate Redis or RabbitMQ would double the operational surface for a product
  whose entire job is catching _other people's_ infrastructure failures.
- **Job state and domain state are consistent by construction.** A job and the
  rows it produced live in the same database, so "did this run actually happen?"
  is answerable with a join rather than by correlating two systems.
- **No message loss window.** Redis-backed queues without persistence lose jobs on
  restart. PostgreSQL's durability guarantees apply to the queue too.
- **Local development needs nothing extra.** The bootstrapped PostgreSQL is the
  queue as well, which matters on a machine with no Docker.
- **Its own schema** (`schema: "pgboss"`) means pg-boss tables never collide with
  the domain schema and can be migrated independently.

### Design rules

**Payload schemas, validated twice.** Every queue declares a zod schema
(`reconciliationRunPayload`, `stripeSyncPayload`, …), validated on enqueue **and
again on execution**. A payload that was valid when queued can be invalid after a
deploy changes the schema, and discovering that at execution time is exactly when
it matters.

**Tenant context carried and re-verified.** Every payload carries
`organizationId`. Handlers do not trust it: `assertLiveOrganization` confirms the
organization still exists and is not soft-deleted, so a job queued before a
deletion returns early instead of resurrecting the tenant.

**Singleton keys for per-tenant single-flight.**

| Queue                | Singleton key    | Why                                                                                                                       |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `reconciliation.run` | `organizationId` | A burst of button clicks, a post-import trigger and the hourly schedule collapse into **one** queued run per organization |
| `stripe.sync`        | `connectionId`   | Concurrent syncs would fight over the same checkpoint rows                                                                |
| `import.process`     | `batchId`        | One processing job per uploaded batch                                                                                     |

The singleton key is the queue-level half of the duplicate-work defence. The
other half is the `pg_advisory_xact_lock(hashtextextended(organizationId))` taken
inside `persistCandidates`: the key prevents jobs piling up, the lock prevents two
workers racing if one is somehow enqueued anyway. `onConflictDoNothing` on the
`(organization_id, fingerprint)` insert is the third layer, so even a bypassed
lock cannot fail an entire run.

**Retry classes rather than per-job tuning.**

| Class         | Attempts | Base delay | Backoff     | Rationale                                           |
| ------------- | -------- | ---------- | ----------- | --------------------------------------------------- |
| `network`     | 6        | 30 s       | exponential | Rate limits and blips usually clear on a later try  |
| `compute`     | 3        | 60 s       | exponential | Expensive to repeat; fail visibly sooner            |
| `delivery`    | 5        | 60 s       | exponential | Third-party endpoints are flaky but usually recover |
| `maintenance` | 1        | 300 s      | none        | It will simply run again on its next schedule       |

pg-boss applies jitter on top of the exponential growth, which prevents a fleet
of workers retrying in lockstep after a shared outage — the thundering-herd
failure mode that turns a brief provider blip into a self-inflicted outage.

`expireInSeconds` bounds runtime (900 s reconciliation, 1800 s sync and import)
so a stalled job is treated as failed and retried rather than occupying a slot
forever.

**Fan-out instead of one cron per tenant.** `reconciliation.schedule-tick` fires
on `RECONCILIATION_SCHEDULE_CRON` and enqueues one job per live organization.
Registering a cron entry per tenant would not scale and would have to be
reconciled every time an organization is created or deleted. With fan-out, a slow
tenant cannot delay everyone else and each run gets its own retry budget.

**Handlers are idempotent**, because pg-boss guarantees at-least-once delivery.
Every domain write targets a unique constraint, so a redelivered job updates
rather than duplicates.

**Batch size 1, per-job error isolation.** pg-boss hands a handler an array of
jobs; each is processed in its own `try`/`catch` so one bad payload cannot fail
its whole batch. Failures log a sanitised summary — queue, job id, error
category, a 300-character redacted message — then rethrow so pg-boss applies the
retry policy.

**Graceful shutdown.** `stopQueue({ graceful: true, close: true })` lets in-flight
jobs finish rather than relying on retries to recover work that was moments from
completing.

## Consequences

**Good.**

- One datastore. One backup. One connection string.
- Durable across restarts, with no separate persistence configuration.
- Multiple workers are safe by construction, at three independent layers.
- Local development and CI need no extra service.
- Failed jobs are queryable with ordinary SQL against `pgboss.job`.

**Costs.**

- **Queue load lands on the transactional database.** At PayRecon's target scale
  (small teams, thousands of events per month) this is comfortably fine, but a
  high-throughput future would need the queue moved off. The abstraction in
  `packages/jobs/src/queue.ts` — named queues, typed payloads, enqueue helpers —
  is deliberately narrow so a swap is contained.
- **Polling, not push.** pg-boss polls, so there is latency between enqueue and
  execution and a steady low-level query load even when idle.
- **No dead-letter UI.** Terminal failures sit in the `pgboss` schema and must be
  inspected with SQL. `OPERATIONS.md` §6 documents the queries. Domain-level
  failures are separately visible on `reconciliation_runs`, `sync_runs` and
  `notification_deliveries`, which is where an operator will usually look first.
- **Singleton keys can hide work.** A run enqueued while another is already queued
  for the same organization is collapsed rather than queued behind it. That is
  the intent — the later run would evaluate the same data — but it means "I
  clicked run and nothing new happened" is expected behaviour that the UI needs to
  explain.
- **pg-boss v12 specifics leak slightly**: it exports `PgBoss` as a named export
  rather than a default, and queues must be created before work can be sent to
  them, so both the web tier and the worker call `createQueue` idempotently at
  startup.

**Current status.** Eight queues are defined and created at startup. Four have
registered handlers in `registerHandlers`: `reconciliation.run`,
`reconciliation.schedule-tick`, `retention.cleanup`, `session.cleanup`.
`stripe.sync`, `import.process`, `notification.dispatch` and
`notification.send-pending` accept jobs but **nothing consumes them yet** — work
sent to those queues will sit there. This is the most significant outstanding gap
in the job layer and is recorded in `ARCHITECTURE.md` and `OPERATIONS.md`.
