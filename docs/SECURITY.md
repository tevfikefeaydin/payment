# Security

How PayRecon protects credentials, tenants and operator actions. This document
describes what is implemented; unimplemented controls are called out explicitly
at the end.

Threat analysis lives in [`THREAT_MODEL.md`](THREAT_MODEL.md); operational
procedures (key rotation, deletion runbook, recovery) live in
[`OPERATIONS.md`](OPERATIONS.md).

---

## 1. Secrets handling

Configuration is validated at startup by `packages/config/src/env.ts` before
anything else runs. The validator:

- reports the **name** of a missing or invalid variable and a reason, never its
  value. `issue.input` is deliberately never referenced so a secret cannot leak
  into a stack trace;
- decodes `ENCRYPTION_KEY` and asserts it is exactly 32 bytes — a character-count
  check would not catch a malformed base64 key;
- enforces cross-field rules zod cannot express alone: `ENCRYPTION_KEY_PREVIOUS`
  requires `ENCRYPTION_KEY_PREVIOUS_ID`; the previous key id must differ from the
  active one; `APP_URL` must be `https` in production because secure cookies
  require it; `PLATFORM_STRIPE_SECRET_KEY` requires
  `PLATFORM_STRIPE_WEBHOOK_SECRET` because an unverified webhook is worse than no
  webhook.

`checkEnv()` returns a structured result instead of throwing, so a health
endpoint can report readiness without printing configuration.

Rules that hold everywhere:

- `.env` is git-ignored; `.env.example` carries names and explanations only.
- No secret is ever baked into a container image (see `Dockerfile.web`,
  `Dockerfile.worker`) or into CI. The CI workflow **generates** an
  `ENCRYPTION_KEY` and `AUTH_SECRET` at job runtime for the test environment.
- A customer's Stripe key is never stored in the environment. Customers submit
  their own restricted key through the UI and it is encrypted at rest
  immediately.
- Decrypted credentials are used only inside the narrow server/worker path that
  needs them, and never reach browser code, telemetry, audit metadata, test
  snapshots or errors.

---

## 2. Credential encryption — AES-256-GCM

Implemented in `packages/auth/src/crypto.ts`. Used for customer Stripe restricted
keys (`stripe_credentials`) and Slack webhook URLs
(`notification_destinations.secret_*`) with equal rigour.

### The envelope

| Field                | Size / form         | Why                                                                                                                        |
| -------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ciphertext`         | `bytea`             | The encrypted secret                                                                                                       |
| `nonce`              | 12 bytes (96 bits)  | **Freshly generated for every single encryption.** Nonce reuse under GCM is catastrophic, so it is never derived from data |
| `auth_tag`           | 16 bytes (128 bits) | Stored separately; detects any tampering with ciphertext or AAD                                                            |
| `key_id`             | text                | Which master key produced this row, so keys can be rotated and rows re-encrypted incrementally                             |
| `encryption_version` | integer             | Envelope format version, so the scheme can evolve without ambiguity                                                        |

Non-secret companions are stored alongside for operator recognition only:
`key_kind` (`rk_live` / `rk_test`) and `key_last_four` — constrained to at most
four characters by a check constraint.

### AAD: why it prevents cross-tenant ciphertext reuse

`buildAad` binds the ciphertext to its context:

```
org=<organizationId>|purpose=<purpose>|record=<recordId>|v=<version>
```

GCM authenticates the AAD as well as the ciphertext. The AAD is **not** stored in
the ciphertext — it is reconstructed from the row's own context at decryption
time. So if an attacker with database write access copies tenant A's
`stripe_credentials` row into tenant B's organization, decryption reconstructs
the AAD with tenant B's `organization_id`, the tag no longer verifies, and
decryption fails. Without AAD binding the stolen ciphertext would decrypt
perfectly under the shared master key, and tenant B would be issued tenant A's
Stripe key.

The `purpose` component provides the same protection across uses: a Slack webhook
ciphertext cannot be replayed into a Stripe credential slot.

### Failure behaviour

`decrypt` throws a single generic `EncryptionError` regardless of cause. A wrong
key, a tampered ciphertext, a tampered tag and a mismatched AAD are
indistinguishable to the caller **by design** — an attacker must not learn which
of those they achieved.

### Key rotation

`Keyring` holds an `active` key and an optional `previous` key. `decrypt` selects
by `keyId` (compared in constant time), so rows written under a retired key stay
readable during a rotation. `rotateEnvelope` re-encrypts under the active key and
returns `null` when the envelope is already current, letting a rotation job skip
rows cheaply. The full procedure is in [`OPERATIONS.md`](OPERATIONS.md).

### Immediate revocation

`stripe_credentials` has a partial unique index on
`connection_id where revoked_at is null`: exactly one active version per
connection. Setting `revoked_at` makes a credential unusable immediately without
destroying the audit trail.

---

## 3. Password hashing — scrypt

Implemented in `packages/auth/src/password.ts`. scrypt (RFC 7914) is memory-hard
and ships in Node's standard library, so the authentication path has no native
build step and no third-party dependency.

| Parameter  | Value           | Note                                                        |
| ---------- | --------------- | ----------------------------------------------------------- |
| `N`        | 2^16 (65536)    | ~64 MiB per hash — deliberately expensive to attack in bulk |
| `r`        | 8               |                                                             |
| `p`        | 1               |                                                             |
| key length | 64 bytes        |                                                             |
| salt       | 16 random bytes | Fresh per password                                          |
| `maxmem`   | 256 MiB         | Node's 32 MiB default is too low for N=2^16                 |

**Parameters are stored inside the hash**, so they can be raised later without
invalidating existing hashes:

```
scrypt$65536$8$1$<salt-base64>$<hash-base64>
```

`needsRehash` reports when a stored hash uses weaker parameters than the current
policy, so it can be upgraded on the next successful sign-in.

`parseHash` refuses absurd parameters (`N` outside 2^12–2^20, `r` outside 1–32,
`p` outside 1–16), so a corrupted or hostile stored hash cannot be used to force
a denial of service.

`verifyPassword` always performs the full derivation and a `timingSafeEqual`
comparison, and returns `false` rather than throwing for a malformed stored hash
— a corrupt row is indistinguishable from a wrong password by timing or by error
type.

Policy: minimum 12 characters, maximum 200. Length dominates resistance to
offline attack, so there are no composition rules that push users toward
predictable substitutions.

---

## 4. Session model

Implemented in `packages/auth/src/session.ts`. Sessions live in PostgreSQL, not
in a signed cookie or a JWT.

- The cookie carries an **opaque 256-bit random token**; the database stores only
  its **SHA-256 hash** (`sessions_token_hash_uidx`). A database disclosure yields
  no usable session.
- **Absolute expiry** (`expires_at`, `SESSION_MAX_AGE_SECONDS`, default 30 days)
  is enforced in SQL on every lookup — `expires_at > now()` — not merely by
  cookie age, so a replayed cookie past its expiry is rejected server-side.
- **Idle expiry** (`SESSION_IDLE_TIMEOUT_SECONDS`, default 7 days) is enforced in
  application code so the dead row can be **revoked** as a side effect rather than
  merely rejected, preventing reuse.
- `last_seen_at` is advanced at most once a minute, avoiding a write on every
  request.
- The lookup also joins `users` and requires `disabled_at is null`, so disabling
  an account kills every session on the very next request.
- `revokeAllUserSessions` supports password change, account disablement and "sign
  out everywhere". Because state is in the database, revocation is **immediate and
  total** — the central reason for not adopting a stateless token scheme (see
  [`adr/0003-authentication.md`](adr/0003-authentication.md)).
- `validateSession` returns `null` for every failure mode: an invalid token and an
  expired one are indistinguishable to the caller.
- `ip_hash` is an HMAC (keyed with `AUTH_SECRET`) truncated to 32 hex characters.
  The raw address is never stored; the key prevents trivial rainbow-table
  reversal of the IPv4 space. `user_agent` is truncated to 500 characters.
- `purgeDeadSessions` (the `session.cleanup` job, daily) deletes sessions expired
  or revoked more than 30 days ago.

Cookie names come from `packages/config/src/product.ts`
(`payrecon_session`, `payrecon_csrf`, `payrecon_org`).

---

## 5. CSRF

Implemented in `packages/auth/src/tokens.ts` (`deriveCsrfToken`,
`verifyCsrfToken`), used by `apps/web/src/server/csrf.ts`.

Double-submit, but **not** a bare random cookie. The token is an HMAC-SHA256 over
the session id, keyed by `AUTH_SECRET`:

```
csrf_token = base64url(HMAC-SHA256(AUTH_SECRET, "csrf:" + sessionId))
```

Consequences:

- A token issued for one session is invalid for another, so an attacker cannot
  mint a token in their own session and replay it into a victim's.
- An attacker who cannot read the session cookie cannot compute a matching token,
  because they have neither the session id nor `AUTH_SECRET`.
- No server-side CSRF token storage is needed — the value is derivable.

Comparison is `timingSafeEqual` after a length check.

---

## 6. Role and permission matrix

Defined once, in `packages/domain/src/permissions.ts`, and enforced on the server
by `assertPermission` (`packages/auth/src/authorization.ts`). UI code may consult
the same helpers to decide whether to render a control, but **rendering is never
the security boundary**.

Legend: **Y** = granted.

| Permission               | owner | admin | analyst | viewer |
| ------------------------ | :---: | :---: | :-----: | :----: |
| `org:read`               |   Y   |   Y   |    Y    |   Y    |
| `org:update`             |   Y   |   Y   |         |        |
| `org:delete`             |   Y   |       |         |        |
| `org:transfer_ownership` |   Y   |       |         |        |
| `members:read`           |   Y   |   Y   |    Y    |   Y    |
| `members:invite`         |   Y   |   Y   |         |        |
| `members:remove`         |   Y   |   Y   |         |        |
| `members:change_role`    |   Y   |   Y   |         |        |
| `connections:read`       |   Y   |   Y   |    Y    |   Y    |
| `connections:create`     |   Y   |   Y   |         |        |
| `connections:update`     |   Y   |   Y   |         |        |
| `connections:delete`     |   Y   |   Y   |         |        |
| `imports:read`           |   Y   |   Y   |    Y    |   Y    |
| `imports:create`         |   Y   |   Y   |    Y    |        |
| `apikeys:read`           |   Y   |   Y   |         |        |
| `apikeys:create`         |   Y   |   Y   |         |        |
| `apikeys:revoke`         |   Y   |   Y   |         |        |
| `reconciliation:read`    |   Y   |   Y   |    Y    |   Y    |
| `reconciliation:run`     |   Y   |   Y   |    Y    |        |
| `exceptions:read`        |   Y   |   Y   |    Y    |   Y    |
| `exceptions:assign`      |   Y   |   Y   |    Y    |        |
| `exceptions:transition`  |   Y   |   Y   |    Y    |        |
| `notifications:read`     |   Y   |   Y   |    Y    |   Y    |
| `notifications:manage`   |   Y   |   Y   |         |        |
| `notifications:test`     |   Y   |   Y   |         |        |
| `billing:read`           |   Y   |   Y   |         |        |
| `billing:manage`         |   Y   |       |         |        |
| `audit:read`             |   Y   |   Y   |    Y    |   Y    |
| `settings:read`          |   Y   |   Y   |    Y    |   Y    |
| `settings:manage`        |   Y   |   Y   |         |        |
| `retention:manage`       |   Y   |   Y   |         |        |
| `demo:load`              |   Y   |   Y   |         |        |
| **Total**                |  32   |  29   |   13    |   9    |

Notes on specific decisions:

- **Viewer is strictly read-only.** Every viewer permission ends in `:read`.
- **Admins can see billing but not change it.** `billing:read` is admin+;
  `billing:manage` is owner-only, so an admin cannot alter PayRecon's
  subscription.
- **`demo:load` is admin+**, not analyst — seeding demo data replaces existing
  demo rows and is a configuration action, not an investigation action.
- **Only an owner may delete the organization or transfer ownership.**

### Escalation guards

Three helpers close the privilege-escalation paths a flat matrix leaves open:

- `canAssignRole(actor, target)` — an actor may never grant a role more senior
  than their own, and **only an owner may create another owner**. This is the
  "silent ownership grab" defence: an admin with `members:change_role` cannot
  promote themselves or anyone else to owner.
- `canManageMemberWithRole(actor, target)` — an admin may manage analysts,
  viewers and other admins, but **may not remove an owner**.
- `wouldRemoveLastOwner({ targetCurrentRole, targetNewRole, ownerCount })` — the
  final owner can neither leave nor be demoted; ownership must be transferred
  first. A database trigger (`payrecon_require_owner`) backs this up for any path
  that forgets.

The matrix is covered by unit tests in `packages/domain/src/permissions.test.ts`
that assert every role/permission pair, so an accidental widening of access fails
the build.

---

## 7. Tenant isolation and the not-found-over-forbidden policy

An organization id arriving from the browser — a URL segment, a form field, a
header, a cookie — is **never trusted**. It is resolved through
`resolveOrgContext` / `requireOrgContext`, which proves the authenticated user
has a membership row for that organization and that the organization is not
soft-deleted. Every subsequent query uses the organization id from the
**resulting context**, not the one from the request.

`resolveOrgContext` returns `null` for three different situations, and the caller
cannot tell them apart:

1. the organization does not exist,
2. the organization exists but is soft-deleted,
3. the organization exists and the user is simply not a member.

`requireOrgContext` converts all three into **404 Not found**, never 403
Forbidden.

**Why:** a 403 would confirm that the id exists. An attacker enumerating UUIDs
could use the 403/404 distinction to map another tenant's resource ids, learn how
many organizations exist, or confirm that a specific customer is a PayRecon user.
That is itself a cross-tenant information leak, so the response must be
indistinguishable from "this id is meaningless".

403 is still used, correctly, for the _other_ case: a user who **is** a member but
whose role does not permit the action. There is no leak there — the user already
knows the organization exists.

Organization ids are also shape-checked (`isUuid`) before any query, so a
malformed id cannot reach the database.

---

## 8. Redaction

`packages/domain/src/redaction.ts` is the single funnel for anything leaving the
process — a log line, audit metadata, a user-facing error, a CSV cell.

**Key-based redaction.** Any object key matching `password`, `secret`, `token`,
`api_key`, `authorization`, `auth`, `cookie`, `session`, `credential`,
`private_key`, `encryption_key`, `webhook_url`, `signature`, `otp`, `pin`, `cvv`,
`card_number`, `iban`, `ssn` (case-insensitive, at any nesting depth) has its
value replaced with `[redacted]`.

**Value-based redaction.** Free text is scanned for credential-shaped substrings
regardless of the key it appeared under:

| Pattern                              | Catches                           |
| ------------------------------------ | --------------------------------- |
| `[sr]k_(test\|live)_…`               | Stripe secret and restricted keys |
| `pk_(test\|live)_…`                  | Stripe publishable keys           |
| `whsec_…`                            | Stripe webhook signing secrets    |
| `Bearer …`                           | Bearer tokens                     |
| `https://hooks.slack.com/services/…` | Slack webhook URLs                |

**Bounds.** `redactObject` limits recursion to depth 6, strings to 512 characters,
and arrays to 50 entries. A hostile or cyclic structure cannot hang the logger,
and an entire request body cannot be logged by accident.

**Minimisation helpers.** `maskTail` never reveals more than the last four
characters and returns `[redacted]` outright for short values.
`redactProviderId` keeps the operationally useful type prefix and truncates the
unique portion (`ch_ab…7f3d`). `redactEmail` preserves the domain and the first
character of the local part.

**User-facing errors.** Only a `PublicError` reaches the browser with its own
message (itself passed through `redactSecretsInText`). Everything else becomes a
generic message with code `internal_error` and status 500 — no stack traces, no
driver messages, no internal detail. `errorCategory` gives dashboards a failure
class without storing the text.

**Spreadsheet safety.** `sanitizeCsvValue` prefixes any cell starting with `=`,
`+`, `-`, `@`, tab or carriage return with an apostrophe, so Excel, Sheets and
LibreOffice treat it as text rather than executing it as a formula. `toCsvCell`
applies that first, then quotes. `safeFilename` strips control characters by code
point, replaces path separators, removes leading dots and truncates to 120
characters.

---

## 9. Stripe key acceptance

`packages/stripe-customer-data/src/key-validation.ts` accepts **only**
`rk_test_…` and `rk_live_…`. It rejects, with a distinct explanatory message
each:

- `sk_test_` / `sk_live_` — a secret key would grant write access to the
  customer's account;
- `pk_test_` / `pk_live_` — a publishable key cannot read the data needed;
- anything else, including a truncated paste such as `rk_live_`, as malformed.

The prefix is validated before any network call. The supplied key is never
printed or returned after submission. `livemode` is derived from the validated
key, and only non-secret account metadata (`acct_…`, display name) is stored.

---

## 10. Response headers

Configured in `apps/web/next.config.ts` for every route (`/:path*`):

| Header                      | Value                                                                                                                                                                                                                                                  | Purpose                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `default-src 'self'`; `script-src 'self' 'unsafe-inline'`; `style-src 'self' 'unsafe-inline'`; `img-src 'self' data:`; `font-src 'self'`; `connect-src 'self'`; `frame-ancestors 'none'`; `form-action 'self'`; `base-uri 'self'`; `object-src 'none'` | Same-origin only. No third-party script origins are needed because the application ships no external scripts, fonts or analytics |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`                                                                                                                                                                                                                  | Forces HTTPS; pairs with the `APP_URL` https rule                                                                                |
| `X-Content-Type-Options`    | `nosniff`                                                                                                                                                                                                                                              | Prevents MIME sniffing                                                                                                           |
| `X-Frame-Options`           | `DENY`                                                                                                                                                                                                                                                 | Clickjacking, alongside `frame-ancestors 'none'`                                                                                 |
| `Referrer-Policy`           | `strict-origin-when-cross-origin`                                                                                                                                                                                                                      | Stops URLs (which carry organization ids) leaking                                                                                |
| `Permissions-Policy`        | `camera=(), microphone=(), geolocation=(), payment=()`                                                                                                                                                                                                 | Denies powerful features the product never uses                                                                                  |

`poweredByHeader: false` and `productionBrowserSourceMaps: false` keep framework
details and source paths out of production responses.

**Known weakness:** `script-src` and `style-src` both allow `'unsafe-inline'`.
Next injects an inline bootstrap script and Tailwind emits style attributes, and
nonce-based CSP is not expressible in a static header here. `'unsafe-inline'` on
`script-src` materially weakens the CSP's XSS protection — this is a real
residual risk, not a formality, and is recorded in `THREAT_MODEL.md`.

---

## 11. Ingestion API authentication

`/api/v1/records` authenticates with organization API keys
(`apps/web/app/api/v1/_lib/authenticate.ts`).

- Keys are `prefix.secret`. The non-secret `prefix` is indexed for lookup; the
  full plaintext is SHA-256 hashed and compared in constant time. The plaintext
  is shown exactly once, at creation.
- **One error message for unknown, wrong, revoked and expired keys alike**, so
  the response cannot be used to distinguish "this key existed once" from "this
  key never existed".
- **Rate limiting** is enforced per organization and key via
  `packages/ingestion/src/rate-limit.ts`: a fixed window of
  `DEFAULT_RATE_LIMIT = 120` requests per `DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60`,
  counted in `api_rate_limit_buckets`. The bucket key embeds the organization,
  which also appears as an indexed column, so one tenant's traffic can never
  consume another's allowance. Standard rate-limit headers are emitted, and are
  deliberately recovered from a thrown 429 so they are not lost on rejection.
- **Idempotency** is enforced on mutations via `Idempotency-Key`, scoped by
  `(organization_id, idempotency_key)`. A `request_hash` over method, path and
  canonical body detects the same key reused with different content, which is
  rejected rather than answered with a stale result.

---

## 12. Boundary limits

From `packages/domain/src/validation.ts`:

| Limit                        | Value   | Protects against                            |
| ---------------------------- | ------- | ------------------------------------------- |
| `MAX_API_BODY_BYTES`         | 1 MiB   | Memory exhaustion from an oversized request |
| `MAX_BULK_RECORDS`           | 1000    | An unbounded bulk upsert                    |
| `MAX_CSV_BYTES`              | 20 MiB  | Oversized uploads                           |
| `MAX_CSV_ROWS`               | 100 000 | Unbounded parsing work                      |
| CSV error cap                | 1000    | An error list that dwarfs the file itself   |
| `MAX_TRANSITION_NOTE_LENGTH` | 2000    | Unbounded operator notes (also a DB check)  |
| `statement_timeout`          | 60 s    | A runaway query holding a connection        |
| `connectionTimeoutMillis`    | 10 s    | Queueing forever behind an exhausted pool   |

---

## 13. Audit log integrity

`audit_events` is append-only, **enforced by the database**. `applyGuards`
(`packages/db/src/guards.ts`) installs `audit_events_no_update` and
`audit_events_no_delete` triggers that raise `restrict_violation`. A buggy or
compromised code path holding the application's own credentials cannot rewrite
history.

The only sanctioned exception is `purgeOrganization`, which disables the delete
trigger inside a single transaction, deletes the organization, and re-enables it
in a `finally`. `ALTER TABLE` takes an ACCESS EXCLUSIVE lock — acceptable for a
rare operator-initiated action, and one more reason an ordinary request cannot
reach it.

Metadata passes through `redactObject` before it is written, so credentials,
tokens, raw Stripe payloads and imported row content never land in the audit log.
`actor_api_key_id` is deliberately not a foreign key, so an audit row outlives
the key it references.

---

## 14. Not yet implemented

Honest gaps, so nothing here is mistaken for a control that exists:

- **`'unsafe-inline'` in the CSP's `script-src`** (§10). A nonce-based policy
  would be materially stronger.
- **No rate limiting on authentication attempts.** The ingestion API is rate
  limited; sign-in is not, so password spraying against the deliberately
  expensive scrypt verification is also a CPU-exhaustion vector.
- **Password reset and email verification flows** are not wired up, although the
  `auth_tokens` table and the token primitives exist.
- **No key re-encryption driver.** `rotateEnvelope` exists; no job or CLI
  iterates the tables during a rotation.
- **Retention cleanup is narrower than the design.** Expired
  `api_idempotency_records` and elapsed `api_rate_limit_buckets` windows are not
  pruned.
- **No row-level security** as defence in depth behind the repository-level
  tenant scoping.
- **The audit log is not tamper-evident against a database superuser** — rows are
  not signed, hash-chained, or shipped to an external append-only store.
- **No end-to-end CSRF rejection test.** The token primitives are unit-tested;
  that a server action actually rejects a missing or foreign token is not.
