import { PublicError } from "@payrecon/domain";

/**
 * Stable, machine-readable error codes for the ingestion API.
 *
 * These codes are part of the public contract documented in `docs/API.md`.
 * Clients branch on them, so a code is never renamed or repurposed once
 * shipped — a new situation gets a new code instead. Messages may be reworded;
 * codes may not.
 */
export const INGESTION_ERROR_CODES = [
  // authentication and authorization
  "unauthorized",
  "invalid_api_key",
  "insufficient_scope",

  // request shape and size
  "payload_too_large",
  "invalid_json",
  "validation_failed",
  "method_not_allowed",

  // idempotency
  "idempotency_key_required",
  "idempotency_key_invalid",
  "idempotency_key_reused",
  "request_in_progress",

  // quota
  "rate_limited",
  "plan_limit_exceeded",

  // resources
  "not_found",

  // catch-all
  "internal_error",
] as const;

export type IngestionErrorCode = (typeof INGESTION_ERROR_CODES)[number];

/** HTTP status paired with each code, so handlers cannot drift from the docs. */
export const INGESTION_ERROR_STATUS: Record<IngestionErrorCode, number> = {
  unauthorized: 401,
  invalid_api_key: 401,
  insufficient_scope: 403,
  payload_too_large: 413,
  invalid_json: 400,
  validation_failed: 422,
  method_not_allowed: 405,
  idempotency_key_required: 400,
  idempotency_key_invalid: 400,
  idempotency_key_reused: 409,
  request_in_progress: 409,
  rate_limited: 429,
  // 402 rather than 403: the request is well-formed and authorised, but the
  // organization's plan does not cover it. Upgrading resolves it.
  plan_limit_exceeded: 402,
  not_found: 404,
  internal_error: 500,
};

/**
 * An ingestion failure whose message is safe to return to the API caller.
 *
 * Extends `PublicError` so that the existing `toSafeError` boundary treats it as
 * disclosable; anything else thrown becomes a generic 500 with no detail.
 */
export class IngestionError extends PublicError {
  constructor(code: IngestionErrorCode, message: string) {
    super(code, message, INGESTION_ERROR_STATUS[code]);
    this.name = "IngestionError";
  }

  /**
   * The code, narrowed.
   *
   * `code` itself is deliberately NOT redeclared: the base constructor assigns
   * it, and with `useDefineForClassFields` a redeclared field would define the
   * property as `undefined` and erase that assignment. A `declare` field would
   * fix that but `declare override` is rejected by the bundler's parser, so a
   * getter is the portable way to expose the narrow type.
   */
  get errorCode(): IngestionErrorCode {
    return this.code as IngestionErrorCode;
  }
}

export function isIngestionError(error: unknown): error is IngestionError {
  return error instanceof IngestionError;
}

export function isIngestionErrorCode(value: string): value is IngestionErrorCode {
  return (INGESTION_ERROR_CODES as readonly string[]).includes(value);
}
