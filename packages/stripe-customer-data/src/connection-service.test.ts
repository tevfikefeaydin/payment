import { describe, expect, it } from "vitest";
import { parseMasterKey, type Keyring } from "@payrecon/auth/crypto";
import { PublicError } from "@payrecon/domain";
import {
  createConnection,
  deleteConnection,
  disableConnection,
  enableConnection,
  probeReadableResources,
  revalidateConnection,
  type StripeTransportFactory,
} from "./connection-service";
import { loadCredential } from "./credentials";
import {
  buildFakeStripeData,
  createFakeStripeTransport,
  type FakeStripeTransport,
} from "./fake-transport";
import { createMemoryStore, type MemoryStripeDataStore } from "./memory-store";

const RK_LIVE = "rk_live_ZYXWVUTS9876543210zyxwvuABCD";
const SK_LIVE = "sk_live_ZYXWVUTS9876543210zyxwvuABCD";
const PK_TEST = "pk_test_ABCDEFGH0123456789abcdefXYZW";
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-06-01T00:00:00.000Z");

function testKeyring(): Keyring {
  return { active: parseMasterKey("test-key-1", Buffer.alloc(32, 7).toString("base64")) };
}

/**
 * Records the key the factory was handed, so a test can prove the credential
 * survived the encrypt/decrypt round trip end to end.
 */
function factoryFor(transport: FakeStripeTransport): {
  factory: StripeTransportFactory;
  revealed: string[];
} {
  const revealed: string[] = [];
  return {
    revealed,
    factory: ({ restrictedKey }) => {
      revealed.push(restrictedKey.reveal());
      return transport;
    },
  };
}

async function connect(
  store: MemoryStripeDataStore,
  transport: FakeStripeTransport,
  overrides: { organizationId?: string; plaintextKey?: string } = {},
) {
  const { factory, revealed } = factoryFor(transport);
  const result = await createConnection(store, {
    organizationId: overrides.organizationId ?? ORG_A,
    name: "Acme production",
    plaintextKey: overrides.plaintextKey ?? RK_LIVE,
    createdByUserId: null,
    keyring: testKeyring(),
    transportFactory: factory,
    now: NOW,
  });
  return { ...result, revealed };
}

describe("createConnection", () => {
  it("validates, stores the account identity, and activates the connection", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport({
      account: { id: "acct_live_1", displayName: "Acme Inc", livemode: true },
    });

    const { connection, validation, revealed } = await connect(store, transport);

    expect(validation).toEqual({ ok: true, category: null, message: null });
    expect(connection.status).toBe("active");
    expect(connection.stripeAccountId).toBe("acct_live_1");
    expect(connection.accountDisplayName).toBe("Acme Inc");
    expect(connection.livemode).toBe(true);
    expect(connection.lastValidatedAt).toEqual(NOW);
    expect(connection.lastValidationError).toBeNull();

    // The credential survived the round trip and is usable.
    expect(revealed).toEqual([RK_LIVE]);
    const loaded = await loadCredential(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      keyring: testKeyring(),
    });
    expect(loaded?.reveal()).toBe(RK_LIVE);
  });

  it("audits creation and validation without recording key material", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();
    await connect(store, transport);

    const events = store.auditEvents();
    expect(events.map((event) => event.action)).toEqual([
      "connection.created",
      "connection.validated",
    ]);
    expect(JSON.stringify(events)).not.toContain("rk_live_");
    expect(JSON.stringify(events)).not.toContain(RK_LIVE.slice(8));
  });

  it("rejects a secret key before creating anything", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();

    await expect(connect(store, transport, { plaintextKey: SK_LIVE })).rejects.toBeInstanceOf(
      PublicError,
    );
    expect(store.auditEvents()).toHaveLength(0);
  });

  it("rejects a publishable key before creating anything", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();

    await expect(connect(store, transport, { plaintextKey: PK_TEST })).rejects.toBeInstanceOf(
      PublicError,
    );
    expect(store.auditEvents()).toHaveLength(0);
  });

  it("leaves a failed validation pending and its credential revoked", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();
    transport.failAt({ target: "account", category: "permission" });

    const { connection, validation } = await connect(store, transport);

    expect(validation.ok).toBe(false);
    expect(validation.category).toBe("permission");
    expect(connection.status).toBe("pending_validation");
    expect(connection.stripeAccountId).toBeNull();
    expect(connection.lastValidationError).toBe(validation.message);

    // The unusable credential must not be left active for a scheduled sync.
    await expect(
      loadCredential(store, {
        organizationId: ORG_A,
        connectionId: connection.id,
        keyring: testKeyring(),
      }),
    ).resolves.toBeNull();
    const credentials = store.credentialsFor(ORG_A, connection.id);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.revokedAt).not.toBeNull();

    const actions = store.auditEvents().map((event) => event.action);
    expect(actions).toEqual(["connection.created", "connection.validation_failed"]);
  });

  it("stores a sanitised validation error that leaks no Stripe detail", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();
    transport.failAt({
      target: "account",
      throws: () =>
        Object.assign(new Error("Invalid API Key provided: rk_live_ZYXWVUTS9876543210zyxwvuABCD"), {
          statusCode: 401,
        }),
    });

    const { connection, validation } = await connect(store, transport);

    expect(validation.category).toBe("auth");
    for (const text of [validation.message ?? "", connection.lastValidationError ?? ""]) {
      expect(text).not.toContain("rk_live_");
      expect(text).not.toContain("ZYXWVUTS9876543210zyxwvuABCD");
      expect(text).not.toContain("Invalid API Key");
    }
  });
});

describe("revalidateConnection", () => {
  it("recovers a previously failed connection once Stripe answers", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport({ account: { id: "acct_1" } });
    transport.failAt({ target: "account", category: "transient" });

    const { connection } = await connect(store, transport);
    expect(connection.status).toBe("pending_validation");

    // The credential was revoked, so it must be supplied again before revalidating.
    const { storeCredential } = await import("./credentials");
    await storeCredential(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      plaintextKey: RK_LIVE,
      keyring: testKeyring(),
    });

    transport.clearFailures();
    const revalidated = await revalidateConnection(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      keyring: testKeyring(),
      transportFactory: factoryFor(transport).factory,
      now: NOW,
    });

    expect(revalidated.validation.ok).toBe(true);
    expect(revalidated.connection.status).toBe("active");
    expect(revalidated.connection.stripeAccountId).toBe("acct_1");
  });

  it("reports a missing credential without contacting Stripe", async () => {
    const store = createMemoryStore();
    const connection = await store.insertConnection({
      organizationId: ORG_A,
      name: "No key",
      livemode: false,
      status: "pending_validation",
      createdByUserId: null,
      now: NOW,
    });
    const transport = createFakeStripeTransport();

    const result = await revalidateConnection(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      keyring: testKeyring(),
      transportFactory: factoryFor(transport).factory,
      now: NOW,
    });

    expect(result.validation.ok).toBe(false);
    expect(result.validation.message).toContain("restricted key");
    expect(transport.requestsFor("account")).toHaveLength(0);
  });

  it("refuses a connection belonging to another organization", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();
    const { connection } = await connect(store, transport);

    await expect(
      revalidateConnection(store, {
        organizationId: ORG_B,
        connectionId: connection.id,
        keyring: testKeyring(),
        transportFactory: factoryFor(transport).factory,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(PublicError);
  });
});

describe("connection lifecycle", () => {
  it("disables without destroying the credential, then re-enables", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();
    const { connection } = await connect(store, transport);

    const disabled = await disableConnection(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      now: NOW,
    });
    expect(disabled.status).toBe("disabled");
    expect(disabled.disabledAt).toEqual(NOW);
    // Still present, so re-enabling does not require the key again.
    await expect(
      loadCredential(store, {
        organizationId: ORG_A,
        connectionId: connection.id,
        keyring: testKeyring(),
      }),
    ).resolves.not.toBeNull();

    const enabled = await enableConnection(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      now: NOW,
    });
    expect(enabled.status).toBe("active");
    expect(enabled.disabledAt).toBeNull();
  });

  it("re-enables to pending_validation when no credential remains", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();
    const { connection } = await connect(store, transport);

    await disableConnection(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      now: NOW,
    });
    const { revokeCredential } = await import("./credentials");
    await revokeCredential(store, { organizationId: ORG_A, connectionId: connection.id, now: NOW });

    const enabled = await enableConnection(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      now: NOW,
    });
    expect(enabled.status).toBe("pending_validation");
  });

  it("deletes by soft-deleting and immediately revoking the credential", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();
    const { connection } = await connect(store, transport);

    const deleted = await deleteConnection(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      now: NOW,
    });

    expect(deleted.status).toBe("revoked");
    expect(deleted.deletedAt).toEqual(NOW);
    await expect(
      loadCredential(store, {
        organizationId: ORG_A,
        connectionId: connection.id,
        keyring: testKeyring(),
      }),
    ).resolves.toBeNull();

    expect(store.auditEvents().map((event) => event.action)).toContain("connection.deleted");
  });

  it("refuses lifecycle changes from another organization", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();
    const { connection } = await connect(store, transport);
    const foreign = { organizationId: ORG_B, connectionId: connection.id, now: NOW };

    await expect(disableConnection(store, foreign)).rejects.toBeInstanceOf(PublicError);
    await expect(enableConnection(store, foreign)).rejects.toBeInstanceOf(PublicError);
    await expect(deleteConnection(store, foreign)).rejects.toBeInstanceOf(PublicError);

    // Untouched.
    const unchanged = await store.findConnection(ORG_A, connection.id);
    expect(unchanged?.status).toBe("active");
    expect(unchanged?.deletedAt).toBeNull();
  });
});

describe("probeReadableResources", () => {
  it("records what the key can read and reports what it cannot", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport({
      data: buildFakeStripeData({ customers: 2, charges: 2, payouts: 1 }),
    });
    const { connection } = await connect(store, transport);

    transport.failAt({ target: "payouts", page: 1, category: "permission" });
    transport.failAt({ target: "balance_transactions", page: 1, category: "permission" });

    const probe = await probeReadableResources(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      transport,
      now: NOW,
    });

    expect(probe.readable).toContain("customers");
    expect(probe.readable).toContain("charges");
    expect(probe.readable).not.toContain("payouts");
    expect(probe.unreadable.map((entry) => entry.resource).sort()).toEqual([
      "balance_transactions",
      "payouts",
    ]);
    for (const entry of probe.unreadable) {
      expect(entry.category).toBe("permission");
      // Clear about the remedy, silent about Stripe internals.
      expect(entry.message).toContain("read access");
      expect(entry.message).not.toContain("Simulated");
    }

    const stored = await store.findConnection(ORG_A, connection.id);
    expect(stored?.readableResources).toEqual(probe.readable);
  });

  it("asks for exactly one item per resource", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport({ data: buildFakeStripeData({ charges: 5 }) });
    const { connection } = await connect(store, transport);
    transport.resetRequestLog();

    await probeReadableResources(store, {
      organizationId: ORG_A,
      connectionId: connection.id,
      transport,
      now: NOW,
      resources: ["charges"],
    });

    const requests = transport.requestsFor("charges");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.limit).toBe(1);
  });

  it("refuses to probe another organization's connection", async () => {
    const store = createMemoryStore();
    const transport = createFakeStripeTransport();
    const { connection } = await connect(store, transport);

    await expect(
      probeReadableResources(store, {
        organizationId: ORG_B,
        connectionId: connection.id,
        transport,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(PublicError);
  });
});
