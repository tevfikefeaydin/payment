# 0010 — Retention and deletion

**Status:** Accepted

## Context

Three requirements pull against each other.

- **Data minimisation.** PayRecon should keep only what reconciliation needs, for
  only as long as it needs it. Raw uploaded CSV content is the most sensitive
  thing stored: it is customer-supplied, unstructured, and may contain fields the
  product never asked for.
- **Auditability.** Security- and finance-relevant history must be tamper-evident.
  An audit log an application can rewrite is not an audit log.
- **Erasure obligations.** A customer may have a legal right to have their data
  deleted, and PayRecon must be able to comply.

The tension is direct: "delete everything about this tenant" collides with "audit
rows can never be deleted". Choosing one horn naïvely gives either an audit log
that any bug can erase, or an inability to honour an erasure request.

A concrete instance of this appeared during development. `audit_events` cascades
from `organizations`, and the append-only trigger correctly rejected the cascade,
so deleting an organization failed outright.

## Decision

### Append-only audit, enforced by the database

`applyGuards` (`packages/db/src/guards.ts`) installs triggers that raise
`restrict_violation` on `UPDATE` and `DELETE` against `audit_events`. This is
enforced by PostgreSQL, not by application convention, so a buggy or compromised
code path holding the application's own credentials cannot rewrite history.

Guards are written as `create or replace function` plus
`drop trigger if exists` / `create trigger`, making them idempotent, and
`pnpm db:migrate` **re-applies them after every migration run**. A guard cannot be
silently lost by a schema change that recreated a table, and a freshly restored
database ends up with the same protections as a long-lived one.

Metadata passes through `redactObject` before it is written, so credentials,
tokens, raw Stripe payloads and imported row content never enter the audit log in
the first place.

### Two deletion operations, not one

The naïve fix for the cascade problem would have been to weaken the trigger. That
was rejected: a guard with an exception for "the ordinary delete path" is a guard
any code path can invoke. Instead, deletion was split, because **"delete my
organization" and "erase every trace of this tenant" are genuinely different
requests with different risk**.

**1. `softDeleteOrganization` — the ordinary product path.**

Sets `organizations.deleted_at`. Access ends immediately, because
`resolveOrgContext` and `listUserOrganizations` both filter deleted rows and
`assertLiveOrganization` stops queued jobs. **Nothing is destroyed**, so an
accidental deletion is recoverable via `restoreOrganization` and the audit trail
survives. This is what the product's delete button does.

**2. `purgeOrganization` — the privileged maintenance path.**

Physically removes the tenant, including its audit events. It disables
`audit_events_no_delete` **inside a single transaction**, deletes the
organization, and re-enables the trigger in a `finally`. PostgreSQL DDL is
transactional, so a failed delete restores the trigger automatically.
`ALTER TABLE` takes an ACCESS EXCLUSIVE lock, which is acceptable for a rare
operator-initiated action and is one more reason an ordinary request cannot reach
it.

Because every tenant-owned table declares
`organization_id ... onDelete: "cascade"`, PostgreSQL removes children before the
parent in one statement — **no manual ordering is required**. Tables referencing a
_user_ use `set null`, so purging a tenant never deletes a user who belongs to
other organizations. `billing_webhook_events.organization_id` is also `set null`,
so PayRecon's own billing receipts survive.

The runbook — record the reason durably **outside** the tenant first, since the
organization's own audit rows are among the data being destroyed — is in
`OPERATIONS.md` §8.

### The last-owner trigger, and the same lesson

`payrecon_require_owner` enforces that an organization always retains an owner.
It also initially blocked legitimate organization deletion, because the cascade
removes every member including the owner. The fix was not to weaken it: the
function checks whether the parent organization row still exists and skips the
check when it does not. The guard stays absolute for the case it was written for.

### What retention cleanup actually removes

`retention.cleanup` runs daily at 03:00. For each live organization, with
`cutoff = now - organizations.retention_days`:

1. `import_batches.raw_content` is set to `NULL` for batches created before the
   cutoff.
2. An `audit_events` row (`retention.cleanup_ran`) records how many batches were
   cleared and the retention window used.

**That is all it removes today.** Specifically, it does **not** touch:

- the `import_batches` row itself, or its `import_row_errors` — an operator must
  still be able to see that an import happened and what failed;
- `internal_payment_records` — these are the normalised, minimised data the
  product exists to reconcile;
- any `provider_*` data;
- exceptions or reconciliation runs — the aggregate findings must outlive the raw
  inputs;
- `audit_events` — append-only, removed only by the privileged purge.

The principle: **delete the raw source, keep the derived findings and the audit
trail.** Raw CSV content is the highest-risk, lowest-value thing stored — it is
the copy of the customer's file, and once it has been parsed into
`internal_payment_records` the product has no further use for it.

`session.cleanup` (daily at 03:30) separately deletes sessions expired or revoked
more than 30 days ago.

### Retention bounds

`organizations.retention_days` defaults to 90 and is constrained by a check to
`between 7 and 365`, matching `RETENTION_MIN_DAYS` / `RETENTION_MAX_DAYS` in
`@payrecon/config`. A tenant can tune retention but cannot set it so short that
the product's own guarantees break, nor so long that data accumulates
indefinitely by accident. A plan may lower the effective maximum but never below
the floor.

## Consequences

**Good.**

- The audit log is genuinely immutable against the application — verified directly
  against PostgreSQL, where `UPDATE` and `DELETE` both raise
  `audit_events is append-only` and the row survives unchanged.
- Erasure is possible without weakening the guard, because the exception is a
  single documented function taking an exclusive lock, not a general capability.
- The ordinary delete path is safe and reversible, so the destructive operation is
  never the one anyone reaches by accident.
- Cascade ordering is the database's problem, not a hand-maintained list that
  silently rots when a table is added.
- The highest-risk stored data expires automatically, on a per-tenant schedule.

**Costs.**

- **`purgeOrganization` destroys the audit trail it was protecting.** That is
  unavoidable — the audit rows are the tenant's data — which is exactly why the
  runbook requires the reason to be recorded durably outside the tenant first.
- **The ACCESS EXCLUSIVE lock briefly blocks all access to `audit_events`**, which
  every write path touches. Purges belong in a maintenance window.
- **A crash between disabling and re-enabling the trigger** would leave it
  disabled. The `finally` and transactional DDL make this very unlikely, and
  `pnpm db:migrate` re-applies the guards idempotently. `OPERATIONS.md` includes
  the `pg_trigger` verification query in the weekly checks for exactly this
  reason.
- **A database superuser can disable any trigger**, so this defends against a
  compromised application, not a compromised DBA. Audit rows are not signed,
  hash-chained, or shipped to an external append-only store — recorded as residual
  risk in `THREAT_MODEL.md` T10.
- **Soft-deleted organizations accumulate.** There is no automatic promotion from
  soft delete to purge after a grace period; purging is always a deliberate
  operator action.
- **Retention coverage is narrower than the design implies.** Expired
  `api_idempotency_records`, elapsed `api_rate_limit_buckets` windows and
  provider-data retention are **not implemented**. Only raw CSV content and dead
  sessions are cleaned up today, which means two tables grow without bound in a
  busy tenant.
