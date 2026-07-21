import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeRateLimit,
  rateLimitBucketKey,
  rateLimitHeaders,
  type RateLimitSubject,
} from "./rate-limit";
import { createMemoryIngestionStore, type MemoryIngestionStore } from "./memory-store";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const KEY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_A2 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const KEY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const NOW = new Date("2026-07-21T10:00:10.000Z");
const OPTIONS = { limit: 3, windowSeconds: 60, now: NOW };

const subjectA: RateLimitSubject = { organizationId: ORG_A, apiKeyId: KEY_A };
const subjectB: RateLimitSubject = { organizationId: ORG_B, apiKeyId: KEY_B };

let store: MemoryIngestionStore;

beforeEach(() => {
  store = createMemoryIngestionStore();
});

describe("consumeRateLimit", () => {
  it("allows requests up to the limit and denies the next one", async () => {
    const first = await consumeRateLimit(store, subjectA, OPTIONS);
    const second = await consumeRateLimit(store, subjectA, OPTIONS);
    const third = await consumeRateLimit(store, subjectA, OPTIONS);
    const fourth = await consumeRateLimit(store, subjectA, OPTIONS);

    expect([first.allowed, second.allowed, third.allowed]).toEqual([true, true, true]);
    expect(fourth.allowed).toBe(false);

    expect([first.remaining, second.remaining, third.remaining]).toEqual([2, 1, 0]);
    expect(fourth.remaining).toBe(0);
  });

  it("reports the window boundary as the reset time", async () => {
    const decision = await consumeRateLimit(store, subjectA, OPTIONS);
    // The window containing 10:00:10 with a 60s size starts at 10:00:00.
    expect(decision.resetAt.toISOString()).toBe("2026-07-21T10:01:00.000Z");
    // 50 seconds remain until the reset.
    expect(decision.retryAfterSeconds).toBe(50);
  });

  it("starts a fresh allowance in the next window", async () => {
    for (let i = 0; i < 4; i += 1) await consumeRateLimit(store, subjectA, OPTIONS);
    expect((await consumeRateLimit(store, subjectA, OPTIONS)).allowed).toBe(false);

    const nextWindow = new Date("2026-07-21T10:01:00.000Z");
    const afterReset = await consumeRateLimit(store, subjectA, { ...OPTIONS, now: nextWindow });

    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(2);
  });

  it("keeps buckets per organization: one exhausting its limit does not affect another", async () => {
    // Exhaust organization A completely.
    for (let i = 0; i < 5; i += 1) await consumeRateLimit(store, subjectA, OPTIONS);
    expect((await consumeRateLimit(store, subjectA, OPTIONS)).allowed).toBe(false);

    // Organization B is untouched and gets its full allowance.
    const b1 = await consumeRateLimit(store, subjectB, OPTIONS);
    const b2 = await consumeRateLimit(store, subjectB, OPTIONS);
    const b3 = await consumeRateLimit(store, subjectB, OPTIONS);

    expect([b1.allowed, b2.allowed, b3.allowed]).toEqual([true, true, true]);
    expect(b1.remaining).toBe(2);

    // And A is still blocked, so B's traffic did not reset it.
    expect((await consumeRateLimit(store, subjectA, OPTIONS)).allowed).toBe(false);
  });

  it("keeps buckets per API key within one organization", async () => {
    const keyOne: RateLimitSubject = { organizationId: ORG_A, apiKeyId: KEY_A };
    const keyTwo: RateLimitSubject = { organizationId: ORG_A, apiKeyId: KEY_A2 };

    for (let i = 0; i < 4; i += 1) await consumeRateLimit(store, keyOne, OPTIONS);
    expect((await consumeRateLimit(store, keyOne, OPTIONS)).allowed).toBe(false);

    expect((await consumeRateLimit(store, keyTwo, OPTIONS)).allowed).toBe(true);
  });

  it("writes one bucket row per (organization, key, window)", async () => {
    await consumeRateLimit(store, subjectA, OPTIONS);
    await consumeRateLimit(store, subjectA, OPTIONS);
    await consumeRateLimit(store, subjectB, OPTIONS);

    const buckets = store.rawRateLimitBuckets();
    expect(buckets).toHaveLength(2);
    expect(buckets.find((b) => b.organizationId === ORG_A)?.count).toBe(2);
    expect(buckets.find((b) => b.organizationId === ORG_B)?.count).toBe(1);
  });
});

describe("rateLimitBucketKey", () => {
  it("puts the tenant in the key, so two organizations can never collide", () => {
    const windowStart = new Date("2026-07-21T10:00:00.000Z");
    const a = rateLimitBucketKey({ organizationId: ORG_A, apiKeyId: KEY_A }, windowStart, 60);
    const b = rateLimitBucketKey({ organizationId: ORG_B, apiKeyId: KEY_A }, windowStart, 60);

    expect(a).toContain(ORG_A);
    expect(a).not.toBe(b);
  });

  it("changes with the window, which is what resets the allowance", () => {
    const subject = { organizationId: ORG_A, apiKeyId: KEY_A };
    const first = rateLimitBucketKey(subject, new Date("2026-07-21T10:00:00.000Z"), 60);
    const second = rateLimitBucketKey(subject, new Date("2026-07-21T10:01:00.000Z"), 60);
    expect(first).not.toBe(second);
  });
});

describe("rateLimitHeaders", () => {
  it("emits the standard headers on an allowed request, without Retry-After", async () => {
    const headers = rateLimitHeaders(await consumeRateLimit(store, subjectA, OPTIONS));
    expect(headers).toEqual({
      "X-RateLimit-Limit": "3",
      "X-RateLimit-Remaining": "2",
      "X-RateLimit-Reset": "1784628060",
    });
    expect(headers["Retry-After"]).toBeUndefined();
  });

  it("adds Retry-After once the request is denied", async () => {
    for (let i = 0; i < 3; i += 1) await consumeRateLimit(store, subjectA, OPTIONS);
    const denied = await consumeRateLimit(store, subjectA, OPTIONS);

    const headers = rateLimitHeaders(denied);
    expect(denied.allowed).toBe(false);
    expect(headers["X-RateLimit-Remaining"]).toBe("0");
    expect(headers["Retry-After"]).toBe("50");
  });
});
