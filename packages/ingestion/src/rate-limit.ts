import type { IngestionStore } from "./store";

/**
 * PostgreSQL-backed fixed-window rate limiter for the ingestion API.
 *
 * A fixed window rather than a sliding one because it costs a single atomic
 * upsert per request and needs no background state; the burst that a fixed
 * window permits at a boundary (up to 2x the limit across two adjacent windows)
 * is acceptable for a bulk-ingestion endpoint whose real protection is the body
 * and batch-size caps.
 *
 * The bucket key ALWAYS contains the organization id. Tenant isolation is a
 * property of the key itself, not something a caller has to remember to pass.
 */

export const DEFAULT_RATE_LIMIT = 120;
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests permitted per window. */
  limit: number;
  /** Requests still permitted in this window; 0 once exhausted. */
  remaining: number;
  /** When the current window ends and the allowance resets. */
  resetAt: Date;
  /** Seconds to wait before retrying. Always >= 1 when denied. */
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  limit?: number;
  windowSeconds?: number;
  now?: Date;
}

export interface RateLimitSubject {
  organizationId: string;
  /** Null only for paths that authenticate without a key; still org-scoped. */
  apiKeyId: string | null;
}

/**
 * Build the bucket discriminator.
 *
 * Exported so a test can assert that two organizations never share a bucket.
 * The window start is part of the key, which is what makes the window "fixed":
 * a new window is a new row rather than a reset of an old one.
 */
export function rateLimitBucketKey(
  subject: RateLimitSubject,
  windowStart: Date,
  windowSeconds: number,
): string {
  return [
    "v1",
    subject.organizationId,
    subject.apiKeyId ?? "no-key",
    String(windowSeconds),
    String(windowStart.getTime()),
  ].join(":");
}

function windowStartFor(now: Date, windowSeconds: number): Date {
  const windowMs = windowSeconds * 1_000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}

/**
 * Count one request against the subject's allowance.
 *
 * Increments first and compares afterwards, so concurrent requests cannot both
 * observe "one slot left" and both proceed. A denied request still counts,
 * which is standard fixed-window behaviour and means a client that ignores 429s
 * stays blocked for the rest of the window instead of hammering through.
 */
export async function consumeRateLimit(
  store: IngestionStore,
  subject: RateLimitSubject,
  options: RateLimitOptions = {},
): Promise<RateLimitDecision> {
  const limit = options.limit ?? DEFAULT_RATE_LIMIT;
  const windowSeconds = options.windowSeconds ?? DEFAULT_RATE_LIMIT_WINDOW_SECONDS;
  const now = options.now ?? new Date();

  const windowStart = windowStartFor(now, windowSeconds);
  const resetAt = new Date(windowStart.getTime() + windowSeconds * 1_000);

  const count = await store.incrementRateLimitBucket({
    organizationId: subject.organizationId,
    apiKeyId: subject.apiKeyId,
    bucketKey: rateLimitBucketKey(subject, windowStart, windowSeconds),
    windowStart,
  });

  const allowed = count <= limit;
  const retryAfterMs = Math.max(resetAt.getTime() - now.getTime(), 0);

  return {
    allowed,
    limit,
    remaining: Math.max(limit - count, 0),
    resetAt,
    // Round up so a caller that waits exactly this long is past the boundary.
    retryAfterSeconds: Math.max(Math.ceil(retryAfterMs / 1_000), 1),
  };
}

/**
 * Headers describing the decision.
 *
 * `X-RateLimit-Reset` is a Unix timestamp in seconds, which is what the widely
 * deployed convention uses and what clients parse.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
    "X-RateLimit-Reset": String(Math.floor(decision.resetAt.getTime() / 1_000)),
  };
  if (!decision.allowed) headers["Retry-After"] = String(decision.retryAfterSeconds);
  return headers;
}
