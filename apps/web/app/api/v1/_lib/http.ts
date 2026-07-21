import "server-only";
import { redactObject, redactSecretsInText } from "@payrecon/domain";
import {
  INGESTION_ERROR_STATUS,
  isIngestionError,
  type IngestionErrorCode,
} from "@payrecon/ingestion";
import type { FieldError } from "@payrecon/domain";

/**
 * Shared response plumbing for the versioned ingestion API.
 *
 * A leading underscore keeps this directory out of Next's route table, so it is
 * a library rather than an endpoint.
 *
 * Two rules hold everywhere in here:
 *
 *  1. A stack trace, a driver message or an internal identifier NEVER reaches
 *     the caller. Only `IngestionError` — whose messages are written to be
 *     read by a customer — is passed through; anything else becomes a generic
 *     500.
 *  2. A bigint is NEVER emitted as a JSON number. `JSON.stringify` throws on
 *     bigint anyway, and coercing to Number would silently lose precision above
 *     2^53, which for money is unacceptable.
 */

export interface ApiErrorBody {
  error: {
    code: IngestionErrorCode;
    message: string;
    fieldErrors?: FieldError[];
  };
}

/** Recursively convert bigints to decimal strings so a body is serialisable. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]),
    );
  }
  return value;
}

export function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(jsonSafe(body)), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Ingestion responses are per-request and tenant-specific; caching them
      // anywhere would be a cross-tenant disclosure risk.
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function errorBody(
  code: IngestionErrorCode,
  message: string,
  fieldErrors?: FieldError[],
): ApiErrorBody {
  return {
    error: {
      code,
      message: redactSecretsInText(message),
      ...(fieldErrors && fieldErrors.length > 0 ? { fieldErrors } : {}),
    },
  };
}

export function errorResponse(
  code: IngestionErrorCode,
  message: string,
  options: { headers?: Record<string, string>; fieldErrors?: FieldError[] } = {},
): Response {
  return jsonResponse(
    errorBody(code, message, options.fieldErrors),
    INGESTION_ERROR_STATUS[code],
    options.headers,
  );
}

const GENERIC_FAILURE =
  "The request could not be completed. Please retry, and contact support if it persists.";

/**
 * Log a failure without leaking its content, and return a safe response.
 *
 * The log line records the SHAPE of the failure — route, error class, tenant —
 * and never the message of an unexpected error, because that message may embed
 * a query, a connection string or customer data.
 */
export function handleUnexpected(
  route: string,
  error: unknown,
  context: { organizationId?: string | null; apiKeyId?: string | null } = {},
  headers: Record<string, string> = {},
): Response {
  if (isIngestionError(error)) {
    // Deliberately disclosable: these messages exist to tell the caller what to
    // fix. They are still scrubbed for credential-shaped substrings.
    return errorResponse(error.errorCode, error.message, { headers });
  }

  console.error(
    "ingestion_api_error",
    redactObject({
      route,
      errorName: error instanceof Error ? error.name : "unknown",
      organizationId: context.organizationId ?? null,
      apiKeyId: context.apiKeyId ?? null,
    }),
  );

  return errorResponse("internal_error", GENERIC_FAILURE, { headers });
}

/** Extract a bearer token from the Authorization header. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer[ ]+(\S+)$/.exec(header.trim());
  return match?.[1] ?? null;
}
