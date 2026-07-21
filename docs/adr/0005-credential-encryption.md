# 0005 — Credential encryption

**Status:** Accepted

## Context

PayRecon stores two kinds of customer secret:

1. **Stripe restricted keys** — read access to a customer's entire Stripe
   account: payments, customers, invoices, payouts.
2. **Slack webhook URLs** — the ability to post arbitrary messages into a
   customer's Slack workspace.

Both are bearer credentials belonging to someone else. A database dump — a leaked
backup, a compromised replica, a misconfigured snapshot — must not hand an
attacker working credentials for every tenant.

There is a subtler threat than a plain dump. An attacker with **write** access to
the database, or a bug in a repository function, could copy tenant A's ciphertext
row into tenant B's connection. Under a shared master key, that ciphertext
decrypts perfectly, and tenant B is silently issued tenant A's Stripe key. Naïve
"encrypt the column" designs are wide open to this.

## Decision

**AES-256-GCM authenticated encryption, with the ciphertext bound to its tenant
and purpose through Additional Authenticated Data.** Implemented in
`packages/auth/src/crypto.ts` and used identically for Stripe keys and Slack
webhook URLs.

### Envelope

| Field                | Size / form         | Purpose                                                      |
| -------------------- | ------------------- | ------------------------------------------------------------ |
| `ciphertext`         | `bytea`             | The encrypted secret                                         |
| `nonce`              | 12 bytes (96 bits)  | **Fresh per encryption**, from `randomBytes` — never derived |
| `auth_tag`           | 16 bytes (128 bits) | Stored separately; detects tampering with ciphertext or AAD  |
| `key_id`             | text                | Which master key produced this row                           |
| `encryption_version` | integer             | Envelope format version                                      |

Non-secret companions for operator recognition: `key_kind` (`rk_live` /
`rk_test`) and `key_last_four`, constrained to at most four characters.

### Why GCM, and why a fresh nonce every time

GCM provides confidentiality **and** integrity: a modified ciphertext fails to
decrypt rather than producing plausible garbage. Nonce reuse under GCM is
catastrophic — two messages under the same key and nonce leak their XOR and can
destroy authentication — so the nonce is generated randomly for every encryption
and never derived from the data or the record id.

### Why AAD, and what it prevents

`buildAad` produces:

```
org=<organizationId>|purpose=<purpose>|record=<recordId>|v=<version>
```

GCM authenticates the AAD alongside the ciphertext, and the AAD is **not stored**
— it is reconstructed from the row's own context at decryption time.

So the cross-tenant copy attack fails: move tenant A's `stripe_credentials` row
into tenant B's organization, and decryption rebuilds the AAD with tenant B's
`organization_id`. The tag no longer verifies. Decryption fails, loudly, instead
of quietly handing over another company's Stripe key.

The `purpose` component gives the same protection across uses: a Slack webhook
ciphertext cannot be replayed into a Stripe credential slot, even within one
tenant.

### Key management

- The master key is read from `ENCRYPTION_KEY` in the environment only, never
  from the database.
- `parseMasterKey` **decodes** the base64 and asserts exactly 32 bytes. A
  character-count check would pass a malformed key. Errors report the expected
  size, never the supplied value.
- Startup validation (`packages/config/src/env.ts`) fails fast and reports
  variable names only.
- A `Keyring` holds an `active` key and an optional `previous` key. `decrypt`
  selects by `key_id` using a constant-time comparison, so rows written under a
  retired key stay readable during a rotation.
- `rotateEnvelope` re-encrypts under the active key and returns `null` when the
  envelope is already current, so a rotation pass can skip rows cheaply and is
  safe to interrupt and resume.

### Failure behaviour

`decrypt` throws a single generic `EncryptionError` for every failure. A wrong
key, a tampered ciphertext, a tampered tag and a mismatched AAD are
indistinguishable to the caller **by design** — an attacker probing the system
must not learn which of those they achieved.

### Immediate revocation

`stripe_credentials` has a partial unique index on
`connection_id where revoked_at is null`: exactly one active version per
connection. Setting `revoked_at` makes a credential unusable immediately without
destroying the audit trail.

### Handling of plaintext

Decryption happens only inside the narrow server/worker path that needs the
credential. Plaintext is never logged, never placed in audit metadata, never
returned to browser code, never captured in a test snapshot. Redaction patterns
in `packages/domain/src/redaction.ts` catch Stripe key shapes and Slack webhook
URLs as a second line of defence if one ever reaches a log line.

## Consequences

**Good.**

- A database dump alone yields nothing usable.
- Cross-tenant ciphertext reuse fails cryptographically, not by convention.
- Tampering is detected rather than producing corrupted plaintext.
- Rotation is possible without downtime and without a big-bang re-encryption.
- The envelope version and key id mean the scheme can evolve without ambiguity
  about how any given row was produced.

**Costs.**

- **A master-key compromise breaks every tenant at once.** There is no per-tenant
  key derivation and no HSM. Recorded as residual risk in `THREAT_MODEL.md`.
- **Losing `ENCRYPTION_KEY` is unrecoverable** — every stored credential becomes
  permanently unreadable. Key backup, separate from the database backup, is an
  operational requirement (`OPERATIONS.md` §7).
- Plaintext exists transiently in worker memory during a sync and would appear in
  a process core dump.
- Encrypted columns cannot be indexed or searched, which is why `key_last_four`
  and `secret_hint` exist as separate non-secret columns.
- **The rotation driver is not implemented.** `rotateEnvelope` exists; no job or
  CLI iterates the tables. The manual procedure is documented, but a batch runner
  is outstanding work.
- Four columns per secret (`ciphertext`, `nonce`, `auth_tag`, `key_id`) is more
  schema noise than a single opaque blob, but keeping them separate makes each
  component's role explicit and lets a rotation update `key_id` without parsing.

## Alternatives considered

**`pgcrypto` in the database.** Rejected: the key would have to be available to
the database, so a database compromise yields both. Keeping the key out of the
database is the entire point.

**A single encoded string blob.** Simpler schema, but it hides the nonce and tag
inside an ad-hoc format and makes rotation queries (`group by key_id`) awkward.

**Not encrypting Slack webhook URLs**, treating them as low-value. Rejected: a
webhook URL is a bearer credential for posting into someone's workspace, and the
specification explicitly requires it be protected with the same rigour as a
Stripe key.
