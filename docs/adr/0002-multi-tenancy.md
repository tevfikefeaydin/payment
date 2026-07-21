# 0002 — Multi-tenancy model

**Status:** Accepted

## Context

PayRecon holds several organizations' payment data in one database. A single
missing `WHERE organization_id = …` would show one company its competitor's
revenue. This is the failure that would end the product, so the design must make
the correct thing easy and the wrong thing conspicuous.

Three broad approaches were available:

1. a database per tenant,
2. a schema per tenant,
3. shared tables with a tenant column.

The data is also reached from several directions — server actions, background
jobs, CSV imports, an API — so a defence that only covers HTTP requests is not
enough.

## Decision

**Shared tables, with `organization_id` on every tenant-owned table.**

The column is present **directly** on every tenant-owned table, even where
ownership could be derived through a join. `import_row_errors` carries
`organization_id` as well as `batch_id`; `exception_events` carries it as well as
`exception_id`. That redundancy is deliberate: an unscoped query becomes
obviously wrong when read, and every index can start with the tenant key, which
also makes tenant-scoped queries fast.

Only genuinely non-tenant tables omit it: `users` (a person may belong to several
organizations), `sessions` and `auth_tokens` (owned by a user).

**Repository and service APIs require tenant context.** Functions take an
`organizationId` (or an `OrgContext`) as a required parameter. Making the
tenant-unaware call impossible to write is stronger than remembering to add a
filter.

**Tenant context is resolved, never accepted.** An organization id from a URL
segment, form field, header or cookie is passed to `resolveOrgContext`
(`packages/auth/src/authorization.ts`), which:

- shape-checks it with `isUuid` before touching the database,
- joins `organization_members` to prove the authenticated user is a member,
- requires `organizations.deleted_at is null`,
- returns an `OrgContext` carrying the verified `organizationId` and the user's
  `role`.

Every subsequent query uses the id from that **context**, not the one from the
request.

**Not-found over forbidden.** `resolveOrgContext` returns `null` identically for
"does not exist", "soft-deleted" and "you are not a member", and
`requireOrgContext` turns all three into **404**. A 403 would confirm that the id
exists, letting an attacker enumerate UUIDs to map another tenant's resources or
confirm that a specific company is a customer. 403 remains correct for the other
case — a member whose _role_ forbids the action — where nothing is leaked because
the user already knows the organization exists.

**Background jobs re-derive tenant context.** Handlers call
`assertLiveOrganization` against the database rather than trusting the payload's
organization id, so a job queued before a deletion cannot resurrect the tenant.

**Tenant context in derived keys.** Rate-limit buckets, notification dedupe keys,
idempotency keys and exception fingerprints all embed the organization, so one
tenant can never consume, collide with, or read another's.

## Consequences

**Good.**

- One database to migrate, back up, monitor and restore. Connection pooling stays
  simple; there is no per-tenant connection explosion.
- Cross-tenant aggregate queries (product analytics, operational health) remain
  possible.
- Onboarding a tenant is an `INSERT`, not a provisioning workflow.
- Every tenant-scoped index starts with `organization_id`, which is also the best
  possible index prefix for the queries the product actually runs.
- The uniform column makes cross-tenant integration tests straightforward: create
  two organizations, attempt every access path across them, assert 404.

**Costs.**

- **Isolation is a code property, not an infrastructure one.** A new repository
  function that forgets the filter is not caught mechanically. There is no
  PostgreSQL row-level security policy as a backstop — that would be genuine
  defence in depth and is a known gap, recorded in `THREAT_MODEL.md`.
- The redundant column costs storage and must be kept correct on insert; an
  incorrect value is worse than a missing one.
- A "delete this tenant's data" operation touches many tables. Mitigated by
  `on delete cascade` throughout, so one statement suffices — see ADR 0010.
- A noisy tenant shares resources with quiet ones. Acceptable at the target
  customer size (3–30 employees, thousands of events per month).

## Alternatives considered

**Database per tenant.** Strongest isolation, but migrations must run N times,
connection pooling becomes a per-tenant problem, and onboarding needs a
provisioning pipeline. Disproportionate for the target scale, and it would
substitute an operational failure mode for a code-review one.

**Schema per tenant.** Migration and pooling complexity without full isolation —
one compromised connection still reaches every schema.

**Row-level security only.** Attractive, and still worth adding as defence in
depth, but making it the _primary_ mechanism requires every connection to set a
session variable correctly, which relocates the discipline problem rather than
solving it. Explicit tenant parameters are visible in code review; a missing
`SET` is not.
