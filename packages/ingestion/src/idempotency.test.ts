import { beforeEach, describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_TTL_MS,
  canonicalizeBody,
  hashRequest,
  requireIdempotencyKey,
  withIdempotency,
} from "./idempotency";
import { createMemoryIngestionStore, type MemoryIngestionStore } from "./memory-store";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const KEY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IDEMPOTENCY_KEY = "3f6b1c4e-2b7d-4a19-9a0e-5f2c8d1b7e44";

const BODY = { records: [{ externalId: "ord-1", amountMinor: "1050" }] };
const OTHER_BODY = { records: [{ externalId: "ord-2", amountMinor: "999" }] };

let store: MemoryIngestionStore;

beforeEach(() => {
  store = createMemoryIngestionStore();
});

function params(overrides: Partial<Parameters<typeof withIdempotency>[1]> = {}) {
  return {
    organizationId: ORG_A,
    apiKeyId: KEY_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    method: "POST",
    path: "/api/v1/records",
    body: BODY,
    ...overrides,
  };
}

describe("requireIdempotencyKey", () => {
  it("accepts a well-formed key", () => {
    expect(requireIdempotencyKey(`  ${IDEMPOTENCY_KEY}  `)).toBe(IDEMPOTENCY_KEY);
  });

  it("rejects a missing or blank header", () => {
    expect(() => requireIdempotencyKey(null)).toThrow(/Idempotency-Key header is required/);
    expect(() => requireIdempotencyKey("   ")).toThrow(/required/);
  });

  it("rejects a key too short to be unique", () => {
    // A key like "1" would collide across unrelated requests and replay the
    // wrong response, so it is refused rather than accepted.
    expect(() => requireIdempotencyKey("1")).toThrow(/between 8 and 255/);
  });

  it("rejects unsafe characters", () => {
    expect(() => requireIdempotencyKey("key with spaces")).toThrow(/may contain only/);
    expect(() => requireIdempotencyKey("key\nwith\nnewlines")).toThrow(/may contain only/);
  });
});

describe("canonicalizeBody / hashRequest", () => {
  it("treats key order as insignificant", () => {
    expect(canonicalizeBody({ a: 1, b: 2 })).toBe(canonicalizeBody({ b: 2, a: 1 }));
  });

  it("treats array order as significant, because it decides which write wins", () => {
    expect(canonicalizeBody([1, 2])).not.toBe(canonicalizeBody([2, 1]));
  });

  it("distinguishes method and path", () => {
    expect(hashRequest("POST", "/api/v1/records", BODY)).not.toBe(
      hashRequest("PUT", "/api/v1/records", BODY),
    );
    expect(hashRequest("POST", "/api/v1/records", BODY)).not.toBe(
      hashRequest("POST", "/api/v2/records", BODY),
    );
  });

  it("produces a stable SHA-256 hex digest", () => {
    const hash = hashRequest("POST", "/api/v1/records", BODY);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRequest("POST", "/api/v1/records", { records: BODY.records })).toBe(hash);
  });
});

describe("withIdempotency", () => {
  it("executes once and replays the stored response on retry, without re-running", async () => {
    // A real side effect, so "did not re-execute" is observable rather than a
    // claim about a mock.
    const written: string[] = [];
    const execute = async () => {
      written.push("batch");
      return { httpStatus: 200, body: { inserted: 1, updated: 0, total: 1 } };
    };

    const first = await withIdempotency(store, params(), execute);
    const second = await withIdempotency(store, params(), execute);

    expect(first.outcome).toBe("executed");
    expect(second.outcome).toBe("replayed");

    // The side effect happened exactly once.
    expect(written).toEqual(["batch"]);

    // The replay carries the identical response.
    expect(second.httpStatus).toBe(200);
    expect(second.body).toEqual({ inserted: 1, updated: 0, total: 1 });
  });

  it("replays a non-2xx response too, so a retry cannot slip past validation", async () => {
    let calls = 0;
    const execute = async () => {
      calls += 1;
      return { httpStatus: 422, body: { error: { code: "validation_failed" } } };
    };

    await withIdempotency(store, params(), execute);
    const replay = await withIdempotency(store, params(), execute);

    expect(calls).toBe(1);
    expect(replay.outcome).toBe("replayed");
    expect(replay.httpStatus).toBe(422);
  });

  it("rejects the same key used with a different body", async () => {
    const execute = async () => ({ httpStatus: 200, body: { total: 1 } });
    await withIdempotency(store, params(), execute);

    let ran = false;
    await expect(
      withIdempotency(store, params({ body: OTHER_BODY }), async () => {
        ran = true;
        return { httpStatus: 200, body: { total: 1 } };
      }),
    ).rejects.toMatchObject({ code: "idempotency_key_reused" });

    // The conflicting request must not have executed.
    expect(ran).toBe(false);
  });

  it("accepts the same body with keys reordered, because it is the same request", async () => {
    let calls = 0;
    const execute = async () => {
      calls += 1;
      return { httpStatus: 200, body: { total: 1 } };
    };

    await withIdempotency(store, params({ body: { a: 1, b: 2 } }), execute);
    const second = await withIdempotency(store, params({ body: { b: 2, a: 1 } }), execute);

    expect(second.outcome).toBe("replayed");
    expect(calls).toBe(1);
  });

  it("reports a request that is still in flight rather than duplicating it", async () => {
    // Claim the key without completing it, exactly as a crashed or slow request
    // would leave it.
    await store.claimIdempotencyRecord({
      organizationId: ORG_A,
      apiKeyId: KEY_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      requestHash: hashRequest("POST", "/api/v1/records", BODY),
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    });

    let ran = false;
    await expect(
      withIdempotency(store, params(), async () => {
        ran = true;
        return { httpStatus: 200, body: { total: 1 } };
      }),
    ).rejects.toMatchObject({ code: "request_in_progress" });

    expect(ran).toBe(false);
  });

  it("releases the claim when the work throws, so a retry is not wedged", async () => {
    await expect(
      withIdempotency(store, params(), async () => {
        throw new Error("database unavailable");
      }),
    ).rejects.toThrow("database unavailable");

    // Nothing is cached and the key is free again.
    expect(store.rawIdempotencyRecords()).toEqual([]);

    const retry = await withIdempotency(store, params(), async () => ({
      httpStatus: 200,
      body: { total: 1 },
    }));
    expect(retry.outcome).toBe("executed");
  });

  it("lets a key be reused once its record has expired", async () => {
    let calls = 0;
    const execute = async () => {
      calls += 1;
      return { httpStatus: 200, body: { call: calls } };
    };

    const t0 = new Date("2026-07-21T10:00:00.000Z");
    await withIdempotency(store, params({ now: t0 }), execute);

    // Just inside the TTL: still replayed.
    const withinTtl = new Date(t0.getTime() + IDEMPOTENCY_TTL_MS - 1_000);
    expect((await withIdempotency(store, params({ now: withinTtl }), execute)).outcome).toBe(
      "replayed",
    );
    expect(calls).toBe(1);

    // Past the TTL: the record is dropped and the key works again.
    const afterTtl = new Date(t0.getTime() + IDEMPOTENCY_TTL_MS + 1_000);
    const reused = await withIdempotency(store, params({ now: afterTtl }), execute);
    expect(reused.outcome).toBe("executed");
    expect(calls).toBe(2);
  });

  it("stores a bounded expiry of 24 hours", async () => {
    const t0 = new Date("2026-07-21T10:00:00.000Z");
    await withIdempotency(store, params({ now: t0 }), async () => ({
      httpStatus: 200,
      body: { total: 1 },
    }));

    const [row] = store.rawIdempotencyRecords();
    expect(row?.expiresAt.getTime()).toBe(t0.getTime() + 24 * 60 * 60 * 1_000);
  });
});

describe("withIdempotency — tenant isolation", () => {
  it("lets two organizations use the SAME key without colliding", async () => {
    const executions: string[] = [];

    const first = await withIdempotency(
      store,
      params({ organizationId: ORG_A, body: BODY }),
      async () => {
        executions.push(ORG_A);
        return { httpStatus: 200, body: { org: "a", inserted: 1 } };
      },
    );

    // Organization B, same key string, different body. This must NOT be seen
    // as a reuse conflict and must NOT replay A's response.
    const second = await withIdempotency(
      store,
      params({ organizationId: ORG_B, body: OTHER_BODY }),
      async () => {
        executions.push(ORG_B);
        return { httpStatus: 200, body: { org: "b", inserted: 7 } };
      },
    );

    expect(first.outcome).toBe("executed");
    expect(second.outcome).toBe("executed");
    expect(executions).toEqual([ORG_A, ORG_B]);

    expect(first.body).toEqual({ org: "a", inserted: 1 });
    expect(second.body).toEqual({ org: "b", inserted: 7 });

    // Two independent rows, one per tenant.
    const rows = store.rawIdempotencyRecords();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.organizationId).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(new Set(rows.map((r) => r.idempotencyKey))).toEqual(new Set([IDEMPOTENCY_KEY]));
  });

  it("replays within a tenant only", async () => {
    const execute = async (label: string) => async () => ({
      httpStatus: 200,
      body: { org: label },
    });

    await withIdempotency(store, params({ organizationId: ORG_A }), await execute("a"));
    const bResult = await withIdempotency(
      store,
      params({ organizationId: ORG_B }),
      await execute("b"),
    );

    // B executed its own work and got its own answer, not A's.
    expect(bResult.outcome).toBe("executed");
    expect(bResult.body).toEqual({ org: "b" });
  });
});
