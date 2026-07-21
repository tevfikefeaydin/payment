import { beforeEach, describe, expect, it } from "vitest";
import { createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "./api-keys";
import { createMemoryIngestionStore, type MemoryIngestionStore } from "./memory-store";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

let store: MemoryIngestionStore;

beforeEach(() => {
  store = createMemoryIngestionStore();
});

describe("createApiKey", () => {
  it("returns a usable plaintext key exactly once", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "CI pipeline",
      createdByUserId: USER,
    });

    expect(created.plaintext).toMatch(/^prk_test_[A-Za-z0-9_-]{4,16}\.[A-Za-z0-9_-]{20,}$/);
    expect(created.plaintext.startsWith(`${created.prefix}.`)).toBe(true);
    expect(created.scopes).toEqual(["records:write"]);

    // The only way to get the plaintext back is this return value: it is not
    // retrievable from any listing afterwards.
    const listed = await listApiKeys(store, ORG_A);
    expect(JSON.stringify(listed)).not.toContain(created.plaintext);
  });

  it("never stores the plaintext key", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "CI pipeline",
      createdByUserId: USER,
    });

    const [row] = store.rawApiKeys();
    expect(row).toBeDefined();
    // The whole stored row, serialised, must not contain the secret in any form.
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(created.plaintext);
    const secret = created.plaintext.slice(created.plaintext.indexOf(".") + 1);
    expect(serialised).not.toContain(secret);
    // What IS stored is a SHA-256 hex digest and a non-secret prefix.
    expect(row?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.prefix).toBe(created.prefix);
  });

  it("writes an audit event carrying the prefix but no key material", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "CI pipeline",
      createdByUserId: USER,
    });

    const [event] = store.auditEvents();
    expect(event?.action).toBe("api_key.created");
    expect(event?.organizationId).toBe(ORG_A);
    expect(event?.metadata.prefix).toBe(created.prefix);
    expect(JSON.stringify(event)).not.toContain(created.plaintext);
  });

  it("rejects an unknown scope", async () => {
    await expect(
      createApiKey(store, {
        organizationId: ORG_A,
        name: "bad",
        createdByUserId: USER,
        scopes: ["records:write", "billing:admin"],
      }),
    ).rejects.toThrow(/Unknown scope/);
  });

  it("rejects an expiry in the past", async () => {
    await expect(
      createApiKey(store, {
        organizationId: ORG_A,
        name: "stale",
        createdByUserId: USER,
        expiresAt: new Date(Date.now() - 1_000),
      }),
    ).rejects.toThrow(/expiry date must be in the future/);
  });

  it("gives every key a distinct prefix and secret", async () => {
    const a = await createApiKey(store, {
      organizationId: ORG_A,
      name: "a",
      createdByUserId: USER,
    });
    const b = await createApiKey(store, {
      organizationId: ORG_A,
      name: "b",
      createdByUserId: USER,
    });
    expect(a.prefix).not.toBe(b.prefix);
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});

describe("verifyApiKey", () => {
  it("verifies a freshly generated key and resolves its organization", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "CI pipeline",
      createdByUserId: USER,
      scopes: ["records:read", "records:write"],
    });

    const context = await verifyApiKey(store, created.plaintext);
    expect(context).toEqual({
      organizationId: ORG_A,
      apiKeyId: created.id,
      scopes: ["records:read", "records:write"],
    });
  });

  it("rejects a tampered key even though the prefix is correct", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "CI pipeline",
      createdByUserId: USER,
    });

    // Flip the final character of the secret; the prefix still resolves the row,
    // so only the hash comparison can catch this.
    const last = created.plaintext.slice(-1);
    const tampered = created.plaintext.slice(0, -1) + (last === "A" ? "B" : "A");
    expect(tampered).not.toBe(created.plaintext);

    expect(await verifyApiKey(store, tampered)).toBeNull();
  });

  it("rejects a key whose secret is replaced entirely", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "CI pipeline",
      createdByUserId: USER,
    });
    expect(await verifyApiKey(store, `${created.prefix}.totally-made-up-secret-value`)).toBeNull();
  });

  it("rejects malformed and unknown keys", async () => {
    expect(await verifyApiKey(store, "")).toBeNull();
    expect(await verifyApiKey(store, "not-a-key")).toBeNull();
    expect(await verifyApiKey(store, "prk_test_abcd1234")).toBeNull(); // no separator
    expect(await verifyApiKey(store, "prk_test_abcd1234.secret")).toBeNull(); // unknown prefix
    expect(await verifyApiKey(store, "Bearer prk_test_abcd1234.secret")).toBeNull();
  });

  it("rejects a revoked key", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "CI pipeline",
      createdByUserId: USER,
    });
    expect(await verifyApiKey(store, created.plaintext)).not.toBeNull();

    await revokeApiKey(store, { organizationId: ORG_A, apiKeyId: created.id, actorUserId: USER });

    expect(await verifyApiKey(store, created.plaintext)).toBeNull();
  });

  it("rejects an expired key", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "short lived",
      createdByUserId: USER,
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Valid now...
    expect(await verifyApiKey(store, created.plaintext)).not.toBeNull();
    // ...and rejected once the expiry has passed.
    const afterExpiry = new Date(Date.now() + 120_000);
    expect(await verifyApiKey(store, created.plaintext, afterExpiry)).toBeNull();
  });

  it("throttles lastUsedAt writes to at most once a minute", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "hot key",
      createdByUserId: USER,
    });

    const t0 = new Date("2026-07-21T10:00:00.000Z");
    await verifyApiKey(store, created.plaintext, t0);
    expect(store.rawApiKeys()[0]?.lastUsedAt?.toISOString()).toBe(t0.toISOString());

    // 30s later: still within the throttle window, so the column must not move.
    const t30s = new Date("2026-07-21T10:00:30.000Z");
    await verifyApiKey(store, created.plaintext, t30s);
    expect(store.rawApiKeys()[0]?.lastUsedAt?.toISOString()).toBe(t0.toISOString());

    // 61s later: past the window, so it updates.
    const t61s = new Date("2026-07-21T10:01:01.000Z");
    await verifyApiKey(store, created.plaintext, t61s);
    expect(store.rawApiKeys()[0]?.lastUsedAt?.toISOString()).toBe(t61s.toISOString());
  });

  it("resolves each key to its own organization", async () => {
    const keyA = await createApiKey(store, {
      organizationId: ORG_A,
      name: "a",
      createdByUserId: USER,
    });
    const keyB = await createApiKey(store, {
      organizationId: ORG_B,
      name: "b",
      createdByUserId: USER,
    });

    expect((await verifyApiKey(store, keyA.plaintext))?.organizationId).toBe(ORG_A);
    expect((await verifyApiKey(store, keyB.plaintext))?.organizationId).toBe(ORG_B);
  });
});

describe("revokeApiKey", () => {
  it("is tenant-scoped: another organization cannot revoke a key it does not own", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "CI pipeline",
      createdByUserId: USER,
    });

    const revoked = await revokeApiKey(store, {
      organizationId: ORG_B,
      apiKeyId: created.id,
      actorUserId: USER,
    });

    expect(revoked).toBe(false);
    // The key is untouched and still works for its real owner.
    expect(await verifyApiKey(store, created.plaintext)).not.toBeNull();
    expect(store.auditEvents().some((e) => e.action === "api_key.revoked")).toBe(false);
  });

  it("records an audit event when it succeeds and is idempotent afterwards", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "CI pipeline",
      createdByUserId: USER,
    });

    expect(await revokeApiKey(store, { organizationId: ORG_A, apiKeyId: created.id })).toBe(true);
    // Revoking again changes nothing and does not double-audit.
    expect(await revokeApiKey(store, { organizationId: ORG_A, apiKeyId: created.id })).toBe(false);

    const revocations = store.auditEvents().filter((e) => e.action === "api_key.revoked");
    expect(revocations).toHaveLength(1);
    expect(revocations[0]?.targetId).toBe(created.id);
  });
});

describe("listApiKeys", () => {
  it("never returns a hash or any secret material", async () => {
    const created = await createApiKey(store, {
      organizationId: ORG_A,
      name: "CI pipeline",
      createdByUserId: USER,
    });
    const storedHash = store.rawApiKeys()[0]?.keyHash;
    expect(storedHash).toBeDefined();

    const listed = await listApiKeys(store, ORG_A);

    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty("keyHash");
    const serialised = JSON.stringify(listed);
    expect(serialised).not.toContain(storedHash as string);
    expect(serialised).not.toContain(created.plaintext);
    // The non-secret prefix IS returned, because the UI identifies keys by it.
    expect(listed[0]?.prefix).toBe(created.prefix);
  });

  it("returns only the requesting organization's keys", async () => {
    await createApiKey(store, { organizationId: ORG_A, name: "a-key", createdByUserId: USER });
    await createApiKey(store, { organizationId: ORG_B, name: "b-key", createdByUserId: USER });

    expect((await listApiKeys(store, ORG_A)).map((k) => k.name)).toEqual(["a-key"]);
    expect((await listApiKeys(store, ORG_B)).map((k) => k.name)).toEqual(["b-key"]);
  });

  it("derives active, revoked and expired status", async () => {
    const active = await createApiKey(store, {
      organizationId: ORG_A,
      name: "active",
      createdByUserId: USER,
    });
    const revoked = await createApiKey(store, {
      organizationId: ORG_A,
      name: "revoked",
      createdByUserId: USER,
    });
    const expiring = await createApiKey(store, {
      organizationId: ORG_A,
      name: "expiring",
      createdByUserId: USER,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await revokeApiKey(store, { organizationId: ORG_A, apiKeyId: revoked.id });

    const listed = await listApiKeys(store, ORG_A, new Date(Date.now() + 120_000));
    const byId = new Map(listed.map((k) => [k.id, k.status]));

    expect(byId.get(active.id)).toBe("active");
    expect(byId.get(revoked.id)).toBe("revoked");
    expect(byId.get(expiring.id)).toBe("expired");
  });
});
