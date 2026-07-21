# 0003 — Authentication: a focused DB-backed implementation

**Status:** Accepted

## Context

The specification suggested Better Auth "if it supports all required behaviors
safely in the selected version". The required behaviours are unusually specific:

- email/password with a modern hashing scheme,
- sessions with **both** idle and absolute expiry,
- **immediate** revocation on sign-out, password change and account disablement,
- organizations with four roles and a centralised permission matrix,
- invitations that expire, are unguessable, and are stored hashed,
- **last-owner protection** — the final owner can neither leave nor be demoted,
- CSRF protection bound to the session,
- an audit event for every security-relevant action,
- tenant resolution that returns 404, not 403, for cross-tenant access.

The organization semantics are the difficult part. Last-owner protection and
"only an owner may create another owner" are product rules that a general
framework either does not express or expresses differently from what is needed
here — and a subtly different interpretation of "who may promote whom" is a
privilege-escalation bug.

## Decision

Implement authentication directly, in `packages/auth`, on Node's standard
library plus Drizzle. No third-party authentication framework.

| Concern           | Implementation                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password hashing  | scrypt (`node:crypto`), N=2^16, r=8, p=1, 64-byte key, 16-byte salt, parameters stored **inside** the hash string so they can be raised later; `needsRehash` upgrades on next sign-in |
| Session tokens    | 256-bit CSPRNG, base64url. The database stores only the SHA-256 hash                                                                                                                  |
| Session validity  | Absolute expiry enforced **in SQL** on every lookup; idle expiry enforced in code so the dead row can be **revoked** rather than merely rejected                                      |
| Account state     | The session lookup joins `users` and requires `disabled_at is null`                                                                                                                   |
| CSRF              | Double-submit token that is an HMAC-SHA256 over the session id, keyed by `AUTH_SECRET` — a token from one session is invalid in another                                               |
| Invitations       | 256-bit token, SHA-256 hash stored, `expires_at`, and a partial unique index allowing at most one outstanding invitation per email per organization                                   |
| Authorization     | A single `Permission` union and matrix in `packages/domain/src/permissions.ts`, asserted server-side by `assertPermission`                                                            |
| Tenant resolution | `resolveOrgContext` proves membership; cross-tenant access is 404, never 403                                                                                                          |

Sessions live in PostgreSQL rather than in a signed cookie or a JWT.

## Consequences

**What this buys.**

- **Immediate revocation.** Because session state is a database row,
  signing out, disabling an account or changing a password invalidates access on
  the very next request. With a stateless token there is always a window in which
  a revoked credential still works, and closing it requires a denylist — which is
  server-side session state under a different name, with worse ergonomics.
- **Exact last-owner semantics.** `wouldRemoveLastOwner` and `canAssignRole`
  express precisely the intended rules — the final owner cannot leave or be
  demoted, and only an owner may create another owner — and are backed by a
  database trigger (`payrecon_require_owner`) for any path that forgets. A
  framework's organization plugin would have to be bent into this shape, and a
  bent-into-shape authorization rule is one nobody fully trusts.
- **Exact invitation semantics.** Expiry, hashed storage, and "at most one
  outstanding invitation per email per organization" as a partial unique index
  rather than an application check.
- **404-over-403 everywhere.** The policy is a property of one function, not
  something to override per framework route.
- **A small, readable authentication path.** Every branch is inspectable, which
  matters most in the code that decides who is who.
- **No third-party dependency in the credential path**, and no native build step.
  `packages/auth` depends only on `node:crypto`, Drizzle and internal packages.

**Costs — stated honestly.**

- **We own the bugs.** Rolling your own authentication is normally poor advice.
  The mitigation is scope: this implementation uses only standard-library
  primitives in their intended shapes (scrypt for passwords, SHA-256 for
  high-entropy tokens, HMAC for CSRF, `timingSafeEqual` for comparisons) and
  invents no cryptography. It is also unit-tested and reviewed against the threat
  model. That is a mitigation, not a guarantee.
- **Features that come free elsewhere must be built.** OAuth/social sign-in,
  magic links, WebAuthn, TOTP and SSO are not implemented. Adding any of them is
  real work, whereas a framework would offer them as configuration.
- **Password reset and email verification are not wired up.** The `auth_tokens`
  table and the token primitives exist; the flows do not. A framework would have
  shipped them.
- **A database round trip per request** to validate the session, versus verifying
  a signature in memory. Mitigated by an indexed lookup on `token_hash` and by
  advancing `last_seen_at` at most once a minute. This is a deliberate trade:
  correctness of revocation over per-request latency.
- **We track security advisories ourselves.** No upstream maintainer will publish
  a fix for a flaw in this code.
- **scrypt is not Argon2id.** Argon2id is the current preference, but every Node
  implementation is a native module. Given the constraint of a portable
  bootstrapped toolchain with no build tools, standard-library scrypt at N=2^16
  (~64 MiB per hash) is a defensible choice. Parameters live inside the hash, so
  they can be raised, and migrating to Argon2id later is possible because
  `parseHash` already dispatches on the scheme prefix.

**Revisit if:** SSO or social sign-in becomes a requirement, or the organization
semantics stop being unusual. At that point the cost of maintaining this
implementation exceeds the cost of adapting to a framework's model.
