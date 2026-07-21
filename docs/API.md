# PayRecon Ingestion API v1

Stable, versioned HTTP API for pushing your own payment records into PayRecon so
they can be reconciled against your Stripe data.

Base URL: `https://app.payrecon.example/api/v1`
(substitute your deployment's `APP_URL`.)

All request and response bodies are JSON, UTF-8.

> Every key shown in this document is fake. `prk_test_EXAMPLE.xxxxx` is a
> placeholder, not a working credential. Never paste a real key into a
> document, an issue, or a support message.

---

## Contents

- [Authentication](#authentication)
- [The internal payment record](#the-internal-payment-record)
- [Limits](#limits)
- [Idempotency](#idempotency)
- [Rate limiting](#rate-limiting)
- [Errors](#errors)
- [Endpoints](#endpoints)
- [Recipes](#recipes)

---

## Authentication

Every endpoint except `/api/v1/health` requires an organization API key sent as a
bearer token:

```
Authorization: Bearer prk_test_EXAMPLE.xxxxx
```

### Key format

A key is `prefix.secret`:

| Part     | Example            | Secret? | Purpose                                  |
| -------- | ------------------ | ------- | ---------------------------------------- |
| `prefix` | `prk_test_EXAMPLE` | No      | Identifies the key in the UI and in logs |
| `secret` | `xxxxx`            | **Yes** | The high-entropy portion                 |

Live keys use the `prk_live_` prefix; test keys use `prk_test_`.

### Handling

- The plaintext key is shown **exactly once**, when it is created. It is not
  stored and cannot be recovered. If you lose it, revoke the key and issue a new
  one.
- Only a SHA-256 hash and the non-secret prefix are persisted. Verification is a
  constant-time comparison.
- Send keys only over HTTPS, only in the `Authorization` header. Never place a
  key in a URL, a query string, or a redirect.
- A key belongs to exactly one organization. Every request it makes is scoped to
  that organization; there is no way to widen that scope with a parameter.

### Scopes

| Scope           | Grants                        |
| --------------- | ----------------------------- |
| `records:read`  | Reading records               |
| `records:write` | Creating and updating records |

`records:write` implies read access to records. New keys get `records:write` by
default.

### Expiry and revocation

Keys may carry an optional expiry. A key that is expired or revoked is rejected
with `invalid_api_key` — the same code and message as an unknown key, so that a
caller cannot use the API to probe which keys exist or what state they are in.

---

## The internal payment record

```ts
type PaymentStatus = "pending" | "paid" | "failed" | "refunded" | "partially_refunded";

interface InternalPaymentRecordInput {
  // --- required ---
  externalId: string; // your own identifier for the payment
  amountMinor: string; // MINOR units, as a string
  currency: string; // ISO 4217, e.g. "USD"
  status: PaymentStatus;
  occurredAt: string; // ISO-8601

  // --- optional ---
  customerId?: string;
  orderId?: string;
  subscriptionId?: string;
  providerTransactionId?: string; // the Stripe object this should match
  updatedAt?: string; // ISO-8601, as reported by your system
  metadata?: Record<string, string>;
}
```

### Field rules

| Field                               | Rule                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `externalId`                        | 1–255 characters after trimming. Unique within your organization.             |
| `customerId` and other optional ids | At most 255 characters. An empty string is treated as absent.                 |
| `amountMinor`                       | A **string** of an integer number of minor units. See below.                  |
| `currency`                          | Three letters, any case; normalised to uppercase.                             |
| `status`                            | Exactly one of the five values. Case-sensitive over the API.                  |
| `occurredAt`,`updatedAt`            | ISO-8601 parsing to a real date between the years 2000 and 2100.              |
| `metadata`                          | At most 20 keys; keys ≤ 64 chars; values ≤ 500 chars; values must be strings. |

### Why `amountMinor` is a string of minor units

JSON numbers become IEEE-754 doubles, which lose precision above 2^53 — an
unacceptable failure mode for money. Amounts therefore travel as strings.

The value must be an **integer count of the currency's minor unit**. A decimal
point is rejected rather than guessed at:

| Value     | Currency | Result                                                      |
| --------- | -------- | ----------------------------------------------------------- |
| `"1050"`  | USD      | ✅ $10.50                                                   |
| `"10.50"` | USD      | ❌ `validation_failed` — is this 1050 or 10? Never assumed. |
| `"500"`   | JPY      | ✅ ¥500 — JPY has no minor unit                             |
| `"-250"`  | EUR      | ✅ −€2.50 — negatives are permitted                         |

Responses serialise amounts the same way: always a decimal string.

`metadata` must not contain credential-like keys (`password`, `secret`, `token`,
`api_key`, `authorization`, `credential`); such a request is rejected.

### Upsert semantics

`(organization, externalId)` is the natural key. Sending a record whose
`externalId` already exists **updates it in place**. This makes retries, CSV
re-imports and API replays converge on the same rows rather than multiplying
them.

---

## Limits

| Limit                               | Value                   | Exceeding it gives              |
| ----------------------------------- | ----------------------- | ------------------------------- |
| Request body size                   | 1 MiB (1,048,576 bytes) | `payload_too_large` (413)       |
| Records per bulk request            | 1,000                   | `validation_failed` (422)       |
| Duplicate `externalId` in a request | not allowed             | `validation_failed` (422)       |
| Requests per minute, per API key    | 120                     | `rate_limited` (429)            |
| `Idempotency-Key` length            | 8–255 chars             | `idempotency_key_invalid` (400) |
| Idempotency record lifetime         | 24 hours                | key becomes reusable            |
| CSV upload size (import UI)         | 20 MiB                  | rejected at upload              |
| CSV data rows (import UI)           | 100,000                 | rejected at validation          |

Monthly ingestion volume is additionally capped by your plan:

| Plan    | Records ingested per calendar month |
| ------- | ----------------------------------- |
| Free    | 5,000                               |
| Starter | 50,000                              |
| Growth  | 250,000                             |
| Scale   | unlimited                           |

Exceeding the plan limit returns `plan_limit_exceeded` (402). Enforcement is
never destructive: reads, exports and the billing screens keep working so you
can resolve it. The **whole batch** is refused rather than partially applied, so
you never have to work out which records landed.

---

## Idempotency

Every mutating request **must** carry an `Idempotency-Key` header.

```
Idempotency-Key: 3f6b1c4e-2b7d-4a19-9a0e-5f2c8d1b7e44
```

Use a fresh value — a UUID is ideal — for each logical request, and reuse the
same value when retrying that request after a network failure or timeout.

### The contract

| Situation                          | Result                                                         |
| ---------------------------------- | -------------------------------------------------------------- |
| New key                            | The request executes; its response is stored.                  |
| Same key, **same** body            | The stored response is returned. The work does **not** re-run. |
| Same key, **different** body       | `409 idempotency_key_reused`. Nothing executes.                |
| Same key, original still in flight | `409 request_in_progress`. Retry shortly.                      |
| Same key, more than 24 hours later | The old record has expired; the key may be used again.         |

Details worth knowing:

- **Scope is per organization.** The uniqueness constraint is
  `(organization_id, idempotency_key)`. Two organizations may use the identical
  key string without ever seeing each other's result.
- **The request fingerprint** is a SHA-256 over the method, the path, and a
  canonical serialisation of the body. Object keys are sorted, so key ordering
  does not matter; **array order is significant**, because for a bulk upsert the
  order of records decides which write wins.
- **Non-2xx responses are stored too.** Replaying a request that first returned
  422 returns that same 422, so a retry cannot slip past validation.
- **Failures release the key.** If the request fails unexpectedly, nothing is
  cached and the key is freed, so your retry is not wedged for 24 hours.
- Responses carry `Idempotency-Replayed: true|false` so you can tell a fresh
  execution from a replay.

---

## Rate limiting

Requests are limited per **organization and API key** using a fixed 60-second
window. Every response carries:

| Header                  | Meaning                                         |
| ----------------------- | ----------------------------------------------- |
| `X-RateLimit-Limit`     | Requests permitted per window                   |
| `X-RateLimit-Remaining` | Requests still permitted in the current window  |
| `X-RateLimit-Reset`     | Unix timestamp (seconds) when the window resets |

A rejected request additionally carries:

| Header        | Meaning                         |
| ------------- | ------------------------------- |
| `Retry-After` | Seconds to wait before retrying |

```
HTTP/1.1 429 Too Many Requests
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1784628060
Retry-After: 37
```

One organization's traffic never consumes another's allowance. Denied requests
still count against the window, so honour `Retry-After` rather than retrying
immediately.

---

## Errors

Every error has the same shape:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request contains invalid records. At most 1000 records are accepted per request.",
    "fieldErrors": [
      {
        "path": "records.0.amountMinor",
        "message": "amountMinor must be an integer number of minor units expressed as a string, for example \"1050\" for $10.50",
        "code": "custom"
      }
    ]
  }
}
```

`fieldErrors` is present only for `validation_failed`. `path` is a dotted path
into the request body.

### Error codes

Codes are stable: branch on `error.code`, not on `message` or, in most cases,
on the HTTP status alone.

| Code                       | HTTP | Meaning                                             | What to do                                                             |
| -------------------------- | ---- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| `unauthorized`             | 401  | No `Authorization: Bearer` header                   | Send the header.                                                       |
| `invalid_api_key`          | 401  | Key unknown, wrong, revoked, or expired             | Check the key; issue a new one if needed.                              |
| `insufficient_scope`       | 403  | The key lacks the required scope                    | Issue a key with the right scope.                                      |
| `plan_limit_exceeded`      | 402  | Monthly ingestion limit reached                     | Upgrade the plan or wait for the next month.                           |
| `payload_too_large`        | 413  | Body exceeds 1 MiB                                  | Split the batch.                                                       |
| `invalid_json`             | 400  | Body is empty or not valid JSON                     | Fix the serialisation.                                                 |
| `validation_failed`        | 422  | Body parsed but is not a valid request              | Read `fieldErrors` and correct those paths.                            |
| `method_not_allowed`       | 405  | Wrong HTTP method for the path                      | See `Allow`.                                                           |
| `idempotency_key_required` | 400  | Mutating request without `Idempotency-Key`          | Add the header.                                                        |
| `idempotency_key_invalid`  | 400  | Key too short, too long, or has unsafe characters   | Use a UUID.                                                            |
| `idempotency_key_reused`   | 409  | Key already used with a different body              | Use a new key for a different request.                                 |
| `request_in_progress`      | 409  | The original request with this key has not finished | Retry after a short delay.                                             |
| `rate_limited`             | 429  | Too many requests in the window                     | Wait `Retry-After` seconds.                                            |
| `not_found`                | 404  | No such record for this organization                | Check the `externalId`.                                                |
| `internal_error`           | 500  | Unexpected server failure                           | Retry with the same `Idempotency-Key`; contact support if it persists. |

Error responses never include stack traces, driver messages, SQL, hostnames, or
configuration. `internal_error` is deliberately opaque.

---

## Endpoints

### `POST /api/v1/records` — bulk upsert

Creates or updates up to 1,000 records in one request.

**Headers**

| Header            | Required | Value                      |
| ----------------- | -------- | -------------------------- |
| `Authorization`   | yes      | `Bearer <api key>`         |
| `Idempotency-Key` | yes      | Unique per logical request |
| `Content-Type`    | yes      | `application/json`         |

**Request**

```json
{
  "records": [
    {
      "externalId": "order-1001",
      "customerId": "cust-42",
      "providerTransactionId": "pi_3ExampleNotReal000001",
      "amountMinor": "1050",
      "currency": "USD",
      "status": "paid",
      "occurredAt": "2026-07-01T12:34:56Z",
      "metadata": { "channel": "web" }
    }
  ]
}
```

**Response `200`**

```json
{ "inserted": 1, "updated": 0, "total": 1 }
```

`inserted` counts records that did not previously exist; `updated` counts
records matched on `(organization, externalId)` and overwritten.

Checks are applied in this order: body size → API key → rate limit →
idempotency → schema validation → plan limit → write.

---

### `GET /api/v1/records/{externalId}` — read one record

Returns the record with that `externalId` **within the organization the API key
belongs to**. An `externalId` that belongs to a different organization returns
`404`, identically to one that does not exist anywhere.

URL-encode the `externalId` if it contains `/`, `?`, `#` or spaces.

**Response `200`**

```json
{
  "externalId": "order-1001",
  "customerId": "cust-42",
  "orderId": null,
  "subscriptionId": null,
  "providerTransactionId": "pi_3ExampleNotReal000001",
  "amountMinor": "1050",
  "currency": "USD",
  "status": "paid",
  "occurredAt": "2026-07-01T12:34:56.000Z",
  "updatedAt": null,
  "metadata": { "channel": "web" },
  "source": "api",
  "createdAt": "2026-07-01T12:35:02.000Z"
}
```

**Response `404`**

```json
{ "error": { "code": "not_found", "message": "No record matches that externalId." } }
```

---

### `GET /api/v1/health` — liveness and readiness

Unauthenticated. Intended for load balancers and uptime monitors.

```json
{
  "status": "ok",
  "checks": { "database": true },
  "time": "2026-07-21T09:00:00.000Z"
}
```

`200` when ready to serve; `503` when alive but not ready (for example, the
database is unreachable), so a load balancer drains the instance.

The response deliberately contains no version, commit, hostname, environment
name or configuration of any kind.

---

## Recipes

All examples use the obviously fake key `prk_test_EXAMPLE.xxxxx`. Replace it
with your own, and keep it in an environment variable rather than in your shell
history or a script.

```bash
export PAYRECON_API_KEY="prk_test_EXAMPLE.xxxxx"
export PAYRECON_URL="https://app.payrecon.example"
```

### Upsert a batch

```bash
curl -sS -X POST "$PAYRECON_URL/api/v1/records" \
  -H "Authorization: Bearer $PAYRECON_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "records": [
      {
        "externalId": "order-1001",
        "customerId": "cust-42",
        "providerTransactionId": "pi_3ExampleNotReal000001",
        "amountMinor": "1050",
        "currency": "USD",
        "status": "paid",
        "occurredAt": "2026-07-01T12:34:56Z"
      },
      {
        "externalId": "order-1002",
        "amountMinor": "2500",
        "currency": "EUR",
        "status": "refunded",
        "occurredAt": "2026-07-02T08:00:00Z"
      }
    ]
  }'
```

```json
{ "inserted": 2, "updated": 0, "total": 2 }
```

### Retry safely after a timeout

Reuse the **same** `Idempotency-Key`. The batch is not applied twice.

```bash
KEY="3f6b1c4e-2b7d-4a19-9a0e-5f2c8d1b7e44"

curl -sS -X POST "$PAYRECON_URL/api/v1/records" \
  -H "Authorization: Bearer $PAYRECON_API_KEY" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d @batch.json

# ... times out, so retry with the identical key and body:
curl -sS -i -X POST "$PAYRECON_URL/api/v1/records" \
  -H "Authorization: Bearer $PAYRECON_API_KEY" \
  -H "Idempotency-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d @batch.json
```

```
HTTP/1.1 200 OK
Idempotency-Replayed: true
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 118
X-RateLimit-Reset: 1784628060

{"inserted":2,"updated":0,"total":2}
```

### Read a record

```bash
curl -sS "$PAYRECON_URL/api/v1/records/order-1001" \
  -H "Authorization: Bearer $PAYRECON_API_KEY"
```

### Observe the ambiguous-amount rejection

```bash
curl -sS -X POST "$PAYRECON_URL/api/v1/records" \
  -H "Authorization: Bearer $PAYRECON_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"records":[{"externalId":"order-1003","amountMinor":"10.50","currency":"USD","status":"paid","occurredAt":"2026-07-01T12:34:56Z"}]}'
```

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request contains invalid records. At most 1000 records are accepted per request.",
    "fieldErrors": [
      {
        "path": "records.0.amountMinor",
        "message": "amountMinor must be an integer number of minor units expressed as a string, for example \"1050\" for $10.50",
        "code": "custom"
      }
    ]
  }
}
```

Send `"1050"` for $10.50. PayRecon will not guess.

### Check health

```bash
curl -sS "$PAYRECON_URL/api/v1/health"
```

---

## CSV import

The CSV path is available in the web UI rather than over this API, and shares
the same validation rules. Notable behaviours:

- **The amount unit is explicit.** You declare whether the amount column holds
  minor units or a decimal major-unit value. `"10.50"` mapped as _minor_ is
  **rejected**, never coerced.
- **Dates are explicit.** You choose the format from a closed list. `DD/MM/YYYY`
  and `MM/DD/YYYY` are separate choices, because `03/04/2026` cannot be resolved
  without being told which one it is.
- **Row numbers match your spreadsheet.** The header is row 1, so the first data
  row is row 2 — including when a quoted field spans several physical lines.
- **Errors are per row**, reporting the row number, the column, a readable
  message, and a short excerpt of the offending value. One bad row does not
  abort the file.
- **Duplicate `externalId` values within one file** are reported against the
  later row; the first occurrence is kept.
- **Exports are protected against formula injection.** A cell beginning with
  `=`, `+`, `-`, `@`, tab or carriage return is prefixed with an apostrophe so a
  spreadsheet treats it as text. A value such as `=cmd|'/c calc'!A1` is imported
  faithfully as data and neutralised on the way out.
