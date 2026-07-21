import { createHash } from "node:crypto";
import { IngestionError } from "./errors";
import type { IngestionStore } from "./store";

/**
 * Idempotency for mutating API requests.
 *
 * The contract: a client that retries after a timeout must never create a
 * second batch. A key claims a slot BEFORE the work runs, so a retry that
 * arrives while the original is still executing is told to wait rather than
 * being allowed to duplicate the write.
 *
 * The key is scoped to the organization — the unique index is
 * `(organization_id, idempotency_key)` — so two tenants may use the identical
 * key string without ever seeing each other's result. The request hash detects
 * a key reused with different content, which is a client bug and is rejected
 * loudly instead of silently returning someone else's answer.
 */

/** How long a key is remembered. After this the same key may be reused. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const MIN_IDEMPOTENCY_KEY_LENGTH = 8;

/**
 * Validate the `Idempotency-Key` header.
 *
 * A minimum length is enforced because a short key (`"1"`) collides across
 * unrelated requests from the same organization and would replay the wrong
 * response. The charset is restricted so the value is safe to store and log.
 */
export function requireIdempotencyKey(header: string | null | undefined): string {
  if (header === null || header === undefined || header.trim().length === 0) {
    throw new IngestionError(
      "idempotency_key_required",
      "An Idempotency-Key header is required for this request. Use a unique value per logical request, for example a UUID.",
    );
  }
  const key = header.trim();
  if (key.length < MIN_IDEMPOTENCY_KEY_LENGTH || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new IngestionError(
      "idempotency_key_invalid",
      `Idempotency-Key must be between ${MIN_IDEMPOTENCY_KEY_LENGTH} and ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    );
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new IngestionError(
      "idempotency_key_invalid",
      "Idempotency-Key may contain only letters, digits, and the characters . _ : -",
    );
  }
  return key;
}

/**
 * Serialise a value so that two structurally equal bodies produce identical
 * text.
 *
 * Object keys are sorted, because `{"a":1,"b":2}` and `{"b":2,"a":1}` are the
 * same request and a client's JSON serialiser may order them either way. Array
 * order is PRESERVED: for a bulk upsert the order of records decides which
 * write wins, so a reordered array is genuinely a different request.
 */
export function canonicalizeBody(body: unknown): string {
  const normalize = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") {
      return typeof value === "bigint" ? value.toString(10) : value;
    }
    if (Array.isArray(value)) return value.map(normalize);
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, normalize(v)]));
  };
  return JSON.stringify(normalize(body)) ?? "null";
}

/** SHA-256 over method, path and canonical body. */
export function hashRequest(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method.toUpperCase()}\n${path}\n${canonicalizeBody(body)}`, "utf8")
    .digest("hex");
}

export interface IdempotentExecution<T> {
  httpStatus: number;
  body: T;
}

export type IdempotencyResult<T> =
  | { outcome: "executed"; httpStatus: number; body: T }
  /** Served from the stored response; the work did NOT run again. */
  | { outcome: "replayed"; httpStatus: number; body: unknown };

export interface WithIdempotencyParams {
  organizationId: string;
  apiKeyId: string | null;
  idempotencyKey: string;
  method: string;
  path: string;
  body: unknown;
  now?: Date;
  ttlMs?: number;
}

/**
 * Run `execute` at most once for a given `(organization, key)` pair.
 *
 * @throws {IngestionError} `idempotency_key_reused` when the key was already
 * used with different content, or `request_in_progress` when the original
 * request has not finished yet.
 */
export async function withIdempotency<T>(
  store: IngestionStore,
  params: WithIdempotencyParams,
  execute: () => Promise<IdempotentExecution<T>>,
): Promise<IdempotencyResult<T>> {
  const now = params.now ?? new Date();
  const ttlMs = params.ttlMs ?? IDEMPOTENCY_TTL_MS;
  const requestHash = hashRequest(params.method, params.path, params.body);

  const claim = async (): Promise<
    | { claimed: true }
    | { claimed: false; row: Awaited<ReturnType<IngestionStore["claimIdempotencyRecord"]>>["row"] }
  > => {
    const result = await store.claimIdempotencyRecord({
      organizationId: params.organizationId,
      apiKeyId: params.apiKeyId,
      idempotencyKey: params.idempotencyKey,
      requestHash,
      expiresAt: new Date(now.getTime() + ttlMs),
    });
    return result.claimed ? { claimed: true } : { claimed: false, row: result.row };
  };

  let attempt = await claim();

  if (!attempt.claimed && attempt.row.expiresAt.getTime() <= now.getTime()) {
    // The stored result has aged out. Drop it and let the key be claimed again,
    // which is what makes a bounded TTL usable rather than a permanent burn of
    // every key a client has ever sent.
    await store.deleteIdempotencyRecord(params.organizationId, params.idempotencyKey);
    attempt = await claim();
  }

  if (!attempt.claimed) {
    const existing = attempt.row;

    if (existing.requestHash !== requestHash) {
      throw new IngestionError(
        "idempotency_key_reused",
        "This Idempotency-Key was already used with a different request body. Use a new key for a different request.",
      );
    }
    if (existing.responseStatus === null) {
      throw new IngestionError(
        "request_in_progress",
        "A request with this Idempotency-Key is still being processed. Retry in a moment.",
      );
    }
    return {
      outcome: "replayed",
      httpStatus: existing.responseStatus,
      body: existing.responseBody,
    };
  }

  try {
    const result = await execute();
    await store.completeIdempotencyRecord({
      organizationId: params.organizationId,
      idempotencyKey: params.idempotencyKey,
      responseStatus: result.httpStatus,
      responseBody: result.body,
      completedAt: new Date(),
    });
    return { outcome: "executed", httpStatus: result.httpStatus, body: result.body };
  } catch (error) {
    // The work failed for an unknown reason, so nothing is cached and the claim
    // is released. Leaving it in place would wedge the key in "in progress" for
    // the whole TTL and block the client's legitimate retry.
    await store.deleteIdempotencyRecord(params.organizationId, params.idempotencyKey);
    throw error;
  }
}
