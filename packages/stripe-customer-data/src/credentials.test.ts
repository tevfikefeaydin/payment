import { describe, expect, it } from "vitest";
import { EncryptionError, decrypt, parseMasterKey, type Keyring } from "@payrecon/auth/crypto";
import { PublicError, REDACTED } from "@payrecon/domain";
import {
  RestrictedKey,
  credentialAad,
  describeCredential,
  loadCredential,
  revokeCredential,
  rotateCredential,
  storeCredential,
} from "./credentials";
import { createMemoryStore, type MemoryStripeDataStore } from "./memory-store";

const RK_LIVE = "rk_live_ZYXWVUTS9876543210zyxwvuABCD";
const RK_LIVE_ROTATED = "rk_live_QQQQQQQQ1111111111wwwwwwEEEE";
const RK_TEST = "rk_test_ABCDEFGH0123456789abcdefXYZW";
const SK_LIVE = "sk_live_ZYXWVUTS9876543210zyxwvuABCD";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

/** Fixed key material: tests must never depend on the environment. */
function testKeyring(): Keyring {
  return {
    active: parseMasterKey("test-key-1", Buffer.alloc(32, 7).toString("base64")),
  };
}

async function newConnection(
  store: MemoryStripeDataStore,
  organizationId: string,
): Promise<string> {
  const connection = await store.insertConnection({
    organizationId,
    name: "Acme production",
    livemode: true,
    status: "pending_validation",
    createdByUserId: null,
    now: new Date("2026-03-01T00:00:00.000Z"),
  });
  return connection.id;
}

describe("storeCredential / loadCredential", () => {
  it("round-trips the restricted key through encryption", async () => {
    const store = createMemoryStore();
    const keyring = testKeyring();
    const connectionId = await newConnection(store, ORG_A);

    const summary = await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring,
    });

    expect(summary.keyKind).toBe("rk_live");
    expect(summary.keyLastFour).toBe(RK_LIVE.slice(-4));
    expect(summary.livemode).toBe(true);

    const loaded = await loadCredential(store, { organizationId: ORG_A, connectionId, keyring });
    expect(loaded).not.toBeNull();
    expect(loaded?.reveal()).toBe(RK_LIVE);
    expect(loaded?.livemode).toBe(true);
  });

  it("stores ciphertext, never the plaintext", async () => {
    const store = createMemoryStore();
    const connectionId = await newConnection(store, ORG_A);
    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring: testKeyring(),
    });

    const [record] = store.credentialsFor(ORG_A, connectionId);
    if (!record) throw new Error("credential missing");
    expect(record.ciphertext.toString("utf8")).not.toContain(RK_LIVE);
    expect(record.ciphertext.toString("utf8")).not.toContain("rk_live_");
    expect(record.nonce).toHaveLength(12);
    expect(record.authTag).toHaveLength(16);
    // Nothing about the record, serialised, reveals the key.
    expect(JSON.stringify(record)).not.toContain(RK_LIVE.slice(8));
  });

  it("uses a fresh nonce for every encryption", async () => {
    const store = createMemoryStore();
    const keyring = testKeyring();
    const connectionId = await newConnection(store, ORG_A);

    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring,
    });
    await rotateCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring,
    });

    const records = store.credentialsFor(ORG_A, connectionId);
    expect(records).toHaveLength(2);
    expect(records[0]?.nonce.toString("hex")).not.toBe(records[1]?.nonce.toString("hex"));
    expect(records[0]?.ciphertext.toString("hex")).not.toBe(records[1]?.ciphertext.toString("hex"));
  });

  it("refuses a secret key before anything is persisted", async () => {
    const store = createMemoryStore();
    const connectionId = await newConnection(store, ORG_A);

    await expect(
      storeCredential(store, {
        organizationId: ORG_A,
        connectionId,
        plaintextKey: SK_LIVE,
        keyring: testKeyring(),
      }),
    ).rejects.toBeInstanceOf(PublicError);

    expect(store.credentialsFor(ORG_A, connectionId)).toHaveLength(0);
  });

  it("returns null when there is no credential", async () => {
    const store = createMemoryStore();
    const connectionId = await newConnection(store, ORG_A);
    await expect(
      loadCredential(store, { organizationId: ORG_A, connectionId, keyring: testKeyring() }),
    ).resolves.toBeNull();
  });
});

describe("tenant isolation of credentials", () => {
  /**
   * The core AAD property: a ciphertext row lifted into another tenant's
   * connection must be inert, not silently decryptable.
   */
  it("fails to decrypt when the AAD organization differs", async () => {
    const store = createMemoryStore();
    const keyring = testKeyring();
    const connectionA = await newConnection(store, ORG_A);

    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId: connectionA,
      plaintextKey: RK_LIVE,
      keyring,
    });
    const [stolen] = store.credentialsFor(ORG_A, connectionA);
    if (!stolen) throw new Error("credential missing");

    // Attacker replays the exact ciphertext into their own tenant's row.
    const connectionB = await newConnection(store, ORG_B);
    await store.insertCredential({
      organizationId: ORG_B,
      connectionId: connectionB,
      ciphertext: stolen.ciphertext,
      nonce: stolen.nonce,
      authTag: stolen.authTag,
      keyId: stolen.keyId,
      encryptionVersion: stolen.encryptionVersion,
      keyKind: stolen.keyKind,
      keyLastFour: stolen.keyLastFour,
      now: new Date("2026-03-02T00:00:00.000Z"),
    });

    await expect(
      loadCredential(store, {
        organizationId: ORG_B,
        connectionId: connectionB,
        keyring,
      }),
    ).rejects.toBeInstanceOf(EncryptionError);
  });

  it("fails to decrypt when only the AAD organization is swapped", async () => {
    const store = createMemoryStore();
    const keyring = testKeyring();
    const connectionId = await newConnection(store, ORG_A);
    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring,
    });
    const [record] = store.credentialsFor(ORG_A, connectionId);
    if (!record) throw new Error("credential missing");

    const envelope = {
      ciphertext: record.ciphertext,
      nonce: record.nonce,
      authTag: record.authTag,
      keyId: record.keyId,
      version: record.encryptionVersion,
    };

    expect(decrypt(envelope, credentialAad(ORG_A, connectionId), keyring)).toBe(RK_LIVE);
    expect(() => decrypt(envelope, credentialAad(ORG_B, connectionId), keyring)).toThrow(
      EncryptionError,
    );
  });

  it("fails to decrypt when the AAD connection differs", async () => {
    const store = createMemoryStore();
    const keyring = testKeyring();
    const connectionId = await newConnection(store, ORG_A);
    const otherConnectionId = await newConnection(store, ORG_A);
    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring,
    });
    const [record] = store.credentialsFor(ORG_A, connectionId);
    if (!record) throw new Error("credential missing");

    expect(() =>
      decrypt(
        {
          ciphertext: record.ciphertext,
          nonce: record.nonce,
          authTag: record.authTag,
          keyId: record.keyId,
          version: record.encryptionVersion,
        },
        credentialAad(ORG_A, otherConnectionId),
        keyring,
      ),
    ).toThrow(EncryptionError);
  });

  it("does not return another organization's credential", async () => {
    const store = createMemoryStore();
    const keyring = testKeyring();
    const connectionId = await newConnection(store, ORG_A);
    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring,
    });

    await expect(
      loadCredential(store, { organizationId: ORG_B, connectionId, keyring }),
    ).resolves.toBeNull();
  });
});

describe("tamper detection", () => {
  async function storeTampered(
    mutate: (record: { ciphertext: Buffer; nonce: Buffer; authTag: Buffer }) => {
      ciphertext: Buffer;
      nonce: Buffer;
      authTag: Buffer;
    },
  ): Promise<{ store: MemoryStripeDataStore; connectionId: string; keyring: Keyring }> {
    const store = createMemoryStore();
    const keyring = testKeyring();
    const connectionId = await newConnection(store, ORG_A);
    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring,
    });

    const [original] = store.credentialsFor(ORG_A, connectionId);
    if (!original) throw new Error("credential missing");
    const now = new Date("2026-03-03T00:00:00.000Z");
    await store.revokeActiveCredentials(ORG_A, connectionId, now);

    const mutated = mutate({
      ciphertext: Buffer.from(original.ciphertext),
      nonce: Buffer.from(original.nonce),
      authTag: Buffer.from(original.authTag),
    });
    await store.insertCredential({
      organizationId: ORG_A,
      connectionId,
      ...mutated,
      keyId: original.keyId,
      encryptionVersion: original.encryptionVersion,
      keyKind: original.keyKind,
      keyLastFour: original.keyLastFour,
      now,
    });

    return { store, connectionId, keyring };
  }

  it("rejects a tampered ciphertext", async () => {
    const { store, connectionId, keyring } = await storeTampered((record) => {
      const ciphertext = Buffer.from(record.ciphertext);
      ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
      return { ...record, ciphertext };
    });

    await expect(
      loadCredential(store, { organizationId: ORG_A, connectionId, keyring }),
    ).rejects.toBeInstanceOf(EncryptionError);
  });

  it("rejects a tampered authentication tag", async () => {
    const { store, connectionId, keyring } = await storeTampered((record) => {
      const authTag = Buffer.from(record.authTag);
      authTag[0] = (authTag[0] ?? 0) ^ 0xff;
      return { ...record, authTag };
    });

    await expect(
      loadCredential(store, { organizationId: ORG_A, connectionId, keyring }),
    ).rejects.toBeInstanceOf(EncryptionError);
  });

  it("rejects a tampered nonce", async () => {
    const { store, connectionId, keyring } = await storeTampered((record) => {
      const nonce = Buffer.from(record.nonce);
      nonce[0] = (nonce[0] ?? 0) ^ 0xff;
      return { ...record, nonce };
    });

    await expect(
      loadCredential(store, { organizationId: ORG_A, connectionId, keyring }),
    ).rejects.toBeInstanceOf(EncryptionError);
  });

  it("rejects a ciphertext encrypted under a different master key", async () => {
    const store = createMemoryStore();
    const connectionId = await newConnection(store, ORG_A);
    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring: testKeyring(),
    });

    const foreignKeyring: Keyring = {
      active: parseMasterKey("test-key-1", Buffer.alloc(32, 9).toString("base64")),
    };
    await expect(
      loadCredential(store, { organizationId: ORG_A, connectionId, keyring: foreignKeyring }),
    ).rejects.toBeInstanceOf(EncryptionError);
  });
});

describe("revocation and rotation", () => {
  it("returns null once the credential is revoked", async () => {
    const store = createMemoryStore();
    const keyring = testKeyring();
    const connectionId = await newConnection(store, ORG_A);
    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring,
    });

    await expect(
      loadCredential(store, { organizationId: ORG_A, connectionId, keyring }),
    ).resolves.not.toBeNull();

    expect(await revokeCredential(store, { organizationId: ORG_A, connectionId })).toBe(true);

    await expect(
      loadCredential(store, { organizationId: ORG_A, connectionId, keyring }),
    ).resolves.toBeNull();
    // The row survives for the audit trail.
    expect(store.credentialsFor(ORG_A, connectionId)).toHaveLength(1);
  });

  it("is a no-op when there is nothing to revoke", async () => {
    const store = createMemoryStore();
    const connectionId = await newConnection(store, ORG_A);
    expect(await revokeCredential(store, { organizationId: ORG_A, connectionId })).toBe(false);
  });

  it("does not revoke another organization's credential", async () => {
    const store = createMemoryStore();
    const keyring = testKeyring();
    const connectionId = await newConnection(store, ORG_A);
    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring,
    });

    expect(await revokeCredential(store, { organizationId: ORG_B, connectionId })).toBe(false);
    await expect(
      loadCredential(store, { organizationId: ORG_A, connectionId, keyring }),
    ).resolves.not.toBeNull();
  });

  it("leaves exactly one active credential after rotation", async () => {
    const store = createMemoryStore();
    const keyring = testKeyring();
    const connectionId = await newConnection(store, ORG_A);

    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE,
      keyring,
    });
    await rotateCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_LIVE_ROTATED,
      keyring,
    });

    const records = store.credentialsFor(ORG_A, connectionId);
    expect(records).toHaveLength(2);
    expect(records.filter((record) => record.revokedAt === null)).toHaveLength(1);

    const loaded = await loadCredential(store, { organizationId: ORG_A, connectionId, keyring });
    expect(loaded?.reveal()).toBe(RK_LIVE_ROTATED);
  });

  it("describes the active credential without revealing it", async () => {
    const store = createMemoryStore();
    const connectionId = await newConnection(store, ORG_A);
    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId,
      plaintextKey: RK_TEST,
      keyring: testKeyring(),
    });

    const described = await describeCredential(store, { organizationId: ORG_A, connectionId });
    expect(described?.keyKind).toBe("rk_test");
    expect(described?.keyLastFour).toBe(RK_TEST.slice(-4));
    expect(JSON.stringify(described)).not.toContain(RK_TEST.slice(8, 20));

    // Cross-tenant read finds nothing.
    await expect(
      describeCredential(store, { organizationId: ORG_B, connectionId }),
    ).resolves.toBeNull();
  });
});

describe("RestrictedKey", () => {
  it("hides the key from every accidental disclosure path", () => {
    const key = new RestrictedKey(RK_LIVE);

    expect(String(key)).toBe(REDACTED);
    expect(`${key}`).toBe(REDACTED);
    expect(JSON.stringify(key)).toBe(`"${REDACTED}"`);
    expect(JSON.stringify({ credential: key })).not.toContain("rk_live_");
    expect(Object.keys(key)).not.toContain("value");
    expect(JSON.stringify({ ...key })).not.toContain(RK_LIVE);
    // Only an explicit reveal produces the plaintext.
    expect(key.reveal()).toBe(RK_LIVE);
  });

  it("reports the non-secret descriptors", () => {
    const live = new RestrictedKey(RK_LIVE);
    const test = new RestrictedKey(RK_TEST);
    expect(live.kind).toBe("rk_live");
    expect(live.lastFour).toBe(RK_LIVE.slice(-4));
    expect(test.kind).toBe("rk_test");
    expect(test.livemode).toBe(false);
  });

  it("refuses to wrap anything that is not a restricted key", () => {
    expect(() => new RestrictedKey(SK_LIVE)).toThrow(PublicError);
    expect(() => new RestrictedKey("")).toThrow(PublicError);
  });
});
