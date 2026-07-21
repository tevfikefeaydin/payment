import "server-only";
import { MAX_API_BODY_BYTES } from "@payrecon/domain";
import {
  IngestionError,
  consumeRateLimit,
  createDrizzleIngestionStore,
  rateLimitHeaders,
  verifyApiKey,
  type ApiKeyContext,
  type IngestionStore,
  type RateLimitDecision,
} from "@payrecon/ingestion";
import { db } from "@/server/db";
import { bearerToken } from "./http";

/**
 * The common front half of every authenticated v1 endpoint: body-size check,
 * API-key verification, and rate limiting — in that order.
 *
 * The order matters. The size check comes first because it is the only defence
 * against an unbounded read, and it must apply even to an unauthenticated
 * caller. Key verification comes next so that the rate-limit bucket can be
 * keyed by a REAL tenant rather than by something an anonymous caller controls.
 */

export interface AuthenticatedRequest {
  store: IngestionStore;
  context: ApiKeyContext;
  rateLimit: RateLimitDecision;
  /** Headers that must be echoed on whatever response the handler builds. */
  headers: Record<string, string>;
}

/**
 * Read the body, enforcing the size cap twice.
 *
 * `Content-Length` is a cheap pre-check, but it is a client-supplied claim: a
 * chunked request may omit it, and a hostile one may understate it. The decisive
 * check is on the bytes actually read.
 *
 * @throws {IngestionError} `payload_too_large`
 */
export async function readBoundedText(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > MAX_API_BODY_BYTES) {
      throw new IngestionError(
        "payload_too_large",
        `The request body exceeds the maximum of ${MAX_API_BODY_BYTES} bytes.`,
      );
    }
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_API_BODY_BYTES) {
    throw new IngestionError(
      "payload_too_large",
      `The request body exceeds the maximum of ${MAX_API_BODY_BYTES} bytes.`,
    );
  }
  return text;
}

/** @throws {IngestionError} `invalid_json` */
export function parseJsonBody(text: string): unknown {
  if (text.trim().length === 0) {
    throw new IngestionError("invalid_json", "The request body is empty; expected a JSON object.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The parser's own message can echo body content back at the caller, so it
    // is replaced rather than forwarded.
    throw new IngestionError("invalid_json", "The request body is not valid JSON.");
  }
}

/**
 * Verify the bearer key and consume one unit of the tenant's rate-limit
 * allowance.
 *
 * @throws {IngestionError} `unauthorized`, `invalid_api_key` or `rate_limited`
 */
export async function authenticate(request: Request): Promise<AuthenticatedRequest> {
  const store = createDrizzleIngestionStore(db());

  const presented = bearerToken(request);
  if (presented === null) {
    throw new IngestionError(
      "unauthorized",
      "Provide an organization API key as `Authorization: Bearer <key>`.",
    );
  }

  const context = await verifyApiKey(store, presented);
  if (context === null) {
    // One message for unknown, wrong, revoked and expired keys alike, so that a
    // caller cannot probe which of those a given key is.
    throw new IngestionError("invalid_api_key", "The API key is invalid, revoked, or expired.");
  }

  const decision = await consumeRateLimit(store, {
    organizationId: context.organizationId,
    apiKeyId: context.apiKeyId,
  });
  const headers = rateLimitHeaders(decision);

  if (!decision.allowed) {
    throw Object.assign(
      new IngestionError(
        "rate_limited",
        `Rate limit exceeded: at most ${decision.limit} requests per minute per API key. Retry after ${decision.retryAfterSeconds} seconds.`,
      ),
      // Carried so the 429 still emits the standard headers.
      { rateLimitHeaders: headers },
    );
  }

  return { store, context, rateLimit: decision, headers };
}

/** Recover rate-limit headers from a thrown 429 so they are not lost. */
export function headersFromError(error: unknown): Record<string, string> {
  if (error !== null && typeof error === "object" && "rateLimitHeaders" in error) {
    const candidate = (error as { rateLimitHeaders: unknown }).rateLimitHeaders;
    if (candidate !== null && typeof candidate === "object") {
      return candidate as Record<string, string>;
    }
  }
  return {};
}
