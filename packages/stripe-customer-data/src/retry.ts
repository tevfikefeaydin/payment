/**
 * Bounded retry with exponential backoff and jitter.
 *
 * READ-ONLY CONTEXT: every operation retried here is a Stripe list or retrieve,
 * so a retry is always safe — there is no write to double-apply.
 *
 * `sleep` and `random` are injected rather than imported. A test that exercises
 * retry behaviour must be able to assert the attempt count and the delay
 * schedule without actually waiting, and jitter must be reproducible.
 */
import { classifyStripeError, isRetryableCategory, type StripeSyncError } from "./errors";

export type SleepFn = (milliseconds: number) => Promise<void>;

export const defaultSleep: SleepFn = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  maxAttempts: number;
  baseDelayMs: number;
  /** Ceiling applied BEFORE jitter, so the worst case stays predictable. */
  maxDelayMs: number;
  /** Fraction of the delay that jitter may add or remove, in [0, 1]. */
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  jitterRatio: 0.25,
};

/**
 * Delay before `attempt` (1-based: the delay after attempt 1 has failed).
 *
 * Full jitter is deliberately NOT used. Symmetric jitter around a capped
 * exponential keeps the schedule bounded in both directions, so a worker's
 * worst-case run time is computable, while still de-correlating retries across
 * the connections a worker syncs concurrently.
 */
export function computeBackoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number,
): number {
  const exponent = Math.max(attempt - 1, 0);
  const capped = Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
  const spread = capped * policy.jitterRatio;
  // random() in [0,1) maps to [-spread, +spread).
  const jittered = capped + spread * (random() * 2 - 1);
  return Math.max(0, Math.round(jittered));
}

export interface RetryOptions {
  policy?: RetryPolicy;
  sleep?: SleepFn;
  random?: () => number;
  /** Observability hook. Called once per failed attempt, before sleeping. */
  onRetry?: (info: { attempt: number; delayMs: number; error: StripeSyncError }) => void;
}

export interface RetryOutcome<T> {
  value: T;
  /** Attempts actually made, including the successful one. */
  attempts: number;
}

/**
 * Run `operation`, retrying only categories that can plausibly succeed later.
 *
 * Auth, permission and permanent failures throw on the first attempt: retrying
 * a revoked key cannot help, and doing so would delay the operator seeing the
 * real problem by the full backoff schedule.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<RetryOutcome<T>> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxAttempts = Math.max(1, policy.maxAttempts);

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return { value: await operation(), attempts: attempt };
    } catch (caught) {
      const error = classifyStripeError(caught);
      const canRetry = isRetryableCategory(error.category) && attempt < maxAttempts;
      if (!canRetry) throw error;

      const delayMs = computeBackoffDelayMs(attempt, policy, random);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
