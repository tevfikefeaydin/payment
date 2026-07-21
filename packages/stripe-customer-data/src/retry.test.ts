import { describe, expect, it } from "vitest";
import { StripeSyncError } from "./errors";
import { DEFAULT_RETRY_POLICY, computeBackoffDelayMs, withRetry, type RetryPolicy } from "./retry";

const POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 800,
  jitterRatio: 0.25,
};

/** Records the delays instead of waiting, so the suite stays instant. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("computeBackoffDelayMs", () => {
  it("doubles each attempt until the ceiling", () => {
    const noJitter = () => 0.5;
    expect(computeBackoffDelayMs(1, POLICY, noJitter)).toBe(100);
    expect(computeBackoffDelayMs(2, POLICY, noJitter)).toBe(200);
    expect(computeBackoffDelayMs(3, POLICY, noJitter)).toBe(400);
    expect(computeBackoffDelayMs(4, POLICY, noJitter)).toBe(800);
    // Capped, not doubled forever.
    expect(computeBackoffDelayMs(9, POLICY, noJitter)).toBe(800);
  });

  it("applies jitter in both directions, bounded by the ratio", () => {
    expect(computeBackoffDelayMs(1, POLICY, () => 0)).toBe(75);
    expect(computeBackoffDelayMs(1, POLICY, () => 1)).toBe(125);
  });

  it("stays within the worst case the policy promises, for any random value", () => {
    const worstCase = POLICY.maxDelayMs * (1 + POLICY.jitterRatio);
    for (const value of [0, 0.01, 0.25, 0.5, 0.75, 0.99]) {
      for (let attempt = 1; attempt <= 12; attempt += 1) {
        const delay = computeBackoffDelayMs(attempt, POLICY, () => value);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(worstCase);
      }
    }
  });

  it("never returns a negative delay even with an extreme jitter ratio", () => {
    const wild: RetryPolicy = { ...POLICY, jitterRatio: 3 };
    expect(computeBackoffDelayMs(1, wild, () => 0)).toBe(0);
  });
});

describe("withRetry", () => {
  it("returns immediately when the operation succeeds", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const outcome = await withRetry(
      async () => {
        calls += 1;
        return "ok";
      },
      { policy: POLICY, sleep, random: () => 0.5 },
    );
    expect(outcome).toEqual({ value: "ok", attempts: 1 });
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("retries a transient failure and eventually succeeds", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    const outcome = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new StripeSyncError("transient", "Stripe is unavailable");
        return calls;
      },
      { policy: POLICY, sleep, random: () => 0.5 },
    );

    // Real behaviour: the operation genuinely ran three times.
    expect(calls).toBe(3);
    expect(outcome.attempts).toBe(3);
    expect(outcome.value).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("gives up after maxAttempts and rethrows the classified error", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new StripeSyncError("rate_limited", "Too many requests");
        },
        { policy: POLICY, sleep, random: () => 0.5 },
      ),
    ).rejects.toBeInstanceOf(StripeSyncError);

    expect(calls).toBe(POLICY.maxAttempts);
    expect(delays).toHaveLength(POLICY.maxAttempts - 1);
  });

  it("does not retry a permanent failure", async () => {
    const { sleep, delays } = recordingSleep();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new StripeSyncError("permanent", "Invalid request");
        },
        { policy: POLICY, sleep, random: () => 0.5 },
      ),
    ).rejects.toMatchObject({ category: "permanent" });

    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it("does not retry auth or permission failures", async () => {
    for (const category of ["auth", "permission"] as const) {
      const { sleep } = recordingSleep();
      let calls = 0;
      await expect(
        withRetry(
          async () => {
            calls += 1;
            throw new StripeSyncError(category, "nope");
          },
          { policy: POLICY, sleep },
        ),
      ).rejects.toMatchObject({ category });
      expect(calls).toBe(1);
    }
  });

  it("classifies a raw error before deciding whether to retry", async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const raw = Object.assign(new Error("service unavailable"), { statusCode: 503 });
    const outcome = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw raw;
        return "recovered";
      },
      { policy: POLICY, sleep, random: () => 0.5 },
    );
    expect(outcome.value).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("reports each retry through the hook", async () => {
    const { sleep } = recordingSleep();
    const seen: Array<{ attempt: number; delayMs: number }> = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new StripeSyncError("transient", "flaky");
        return true;
      },
      {
        policy: POLICY,
        sleep,
        random: () => 0.5,
        onRetry: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }),
      },
    );
    expect(seen).toEqual([
      { attempt: 1, delayMs: 100 },
      { attempt: 2, delayMs: 200 },
    ]);
  });

  it("ships a bounded default policy", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBeLessThanOrEqual(30_000);
    expect(DEFAULT_RETRY_POLICY.jitterRatio).toBeGreaterThan(0);
  });
});
