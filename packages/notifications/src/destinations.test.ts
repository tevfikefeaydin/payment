import { describe, expect, it } from "vitest";
import {
  ENCRYPTION_VERSION,
  EncryptionError,
  buildAad,
  decrypt,
  type Keyring,
} from "@payrecon/auth/crypto";
import { PublicError } from "@payrecon/domain";
import { createMemoryNotificationStore } from "./memory-store";
import {
  SLACK_WEBHOOK_PURPOSE,
  assertSlackWebhookUrl,
  buildSlackSecretHint,
  createEmailDestination,
  createSlackDestination,
  deleteDestination,
  disableDestination,
  loadSlackWebhook,
  markFailing,
  markVerified,
  normalizeEmailAddress,
} from "./destinations";
import type { DestinationRow } from "./store";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

/** A syntactically real Slack webhook. Not a live endpoint. */
const WEBHOOK = "https://hooks.slack.com/services/T0A1B2C3D/B9Z8Y7X6W/AbCdEfGhIjKlMnOpQrStUvWx";

function keyringWith(byte: number, id = "test-key-1"): Keyring {
  return { active: { id, key: Buffer.alloc(32, byte) } };
}

const keyring = keyringWith(0x11);

function onlyDestination(rows: DestinationRow[]): DestinationRow {
  const [row] = rows;
  if (!row) throw new Error("expected exactly one destination row");
  return row;
}

describe("email destinations", () => {
  it("starts pending_verification and stores the normalised address", async () => {
    const db = createMemoryNotificationStore();
    const view = await createEmailDestination(db, {
      organizationId: ORG,
      name: "Finance alerts",
      email: "  Alerts@Example.COM ",
      createdByUserId: USER,
    });

    expect(view.status).toBe("pending_verification");
    expect(view.target).toBe("alerts@example.com");
    expect(view.verifiedAt).toBeNull();
    expect(view.secretHint).toBeNull();
  });

  it("rejects addresses that are malformed or dangerous in a header", () => {
    const bad = [
      "",
      "no-at-sign",
      "a@b",
      "a@@b.com",
      "with space@example.com",
      'quote"@example.com',
      "angle<@example.com",
      "semi;colon@example.com",
      "header\r\ninjection@example.com",
      `${"x".repeat(65)}@example.com`,
    ];
    for (const value of bad) {
      expect(() => normalizeEmailAddress(value), value).toThrow(PublicError);
    }
  });

  it("accepts ordinary addresses", () => {
    expect(normalizeEmailAddress("ops@example.co.uk")).toBe("ops@example.co.uk");
    expect(normalizeEmailAddress("first.last+tag@sub.example.com")).toBe(
      "first.last+tag@sub.example.com",
    );
  });
});

describe("slack webhook validation", () => {
  it("accepts a well-formed hooks.slack.com URL", () => {
    expect(assertSlackWebhookUrl(WEBHOOK)).toBe(WEBHOOK);
  });

  it("rejects anything that is not an https hooks.slack.com/services URL", () => {
    const bad = [
      "",
      "not a url",
      "http://hooks.slack.com/services/T0A1B2C3D/B9Z8Y7X6W/AbCdEfGhIjKlMnOpQrSt",
      "https://hooks.slack.com.evil.test/services/T0A1B2C3D/B9Z8Y7X6W/AbCdEfGhIjKlMn",
      "https://evil.test/services/T0A1B2C3D/B9Z8Y7X6W/AbCdEfGhIjKlMnOp",
      "https://hooks.slack.com/webhook/T0A1B2C3D/B9Z8Y7X6W/AbCdEfGhIjKlMnOp",
      "https://hooks.slack.com/services/T0A1B2C3D/B9Z8Y7X6W",
      `${WEBHOOK}?redirect=https://evil.test`,
      `${WEBHOOK}#fragment`,
      "https://user:pass@hooks.slack.com/services/T0A1B2C3D/B9Z8Y7X6W/AbCdEfGhIjKlMnOp",
    ];
    for (const value of bad) {
      expect(() => assertSlackWebhookUrl(value), value).toThrow(PublicError);
    }
  });

  it("never echoes the supplied value back in the error", () => {
    try {
      assertSlackWebhookUrl(`${WEBHOOK}?leak=1`);
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PublicError);
      expect((error as PublicError).message).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
    }
  });

  it("builds a hint from the team segment only, never the secret token", () => {
    const hint = buildSlackSecretHint(WEBHOOK);
    expect(hint).toBe("hooks.slack.com/…/T0A1");
    expect(hint).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
    expect(hint).not.toContain("B9Z8Y7X6W");
  });
});

describe("slack webhook encryption", () => {
  it("round-trips through encryption and back", async () => {
    const db = createMemoryNotificationStore();
    const view = await createSlackDestination(db, {
      organizationId: ORG,
      name: "#payments",
      webhookUrl: WEBHOOK,
      createdByUserId: USER,
      keyring,
    });

    expect(view.status).toBe("pending_verification");
    expect(view.secretHint).toBe("hooks.slack.com/…/T0A1");

    const loaded = await loadSlackWebhook(db, {
      organizationId: ORG,
      destinationId: view.id,
      keyring,
    });
    expect(loaded).toBe(WEBHOOK);
  });

  it("stores ciphertext, not the URL, and never returns it in a view", async () => {
    const db = createMemoryNotificationStore();
    const view = await createSlackDestination(db, {
      organizationId: ORG,
      name: "#payments",
      webhookUrl: WEBHOOK,
      keyring,
    });

    const row = onlyDestination(db.listDestinations(ORG));
    expect(row.secretCiphertext).not.toBeNull();
    expect(row.secretCiphertext?.toString("utf8")).not.toContain("hooks.slack.com");
    expect(row.secretNonce).toHaveLength(12);
    expect(row.secretAuthTag).toHaveLength(16);
    expect(row.secretKeyId).toBe("test-key-1");
    expect(row.target).toBeNull();

    expect(JSON.stringify(view)).not.toContain(WEBHOOK);
    expect(JSON.stringify(view)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
  });

  it("fails to decrypt under a different organization id in the AAD", async () => {
    const db = createMemoryNotificationStore();
    const view = await createSlackDestination(db, {
      organizationId: ORG,
      name: "#payments",
      webhookUrl: WEBHOOK,
      keyring,
    });
    const row = onlyDestination(db.listDestinations(ORG));

    const envelope = {
      ciphertext: row.secretCiphertext as Buffer,
      nonce: row.secretNonce as Buffer,
      authTag: row.secretAuthTag as Buffer,
      keyId: row.secretKeyId as string,
      version: ENCRYPTION_VERSION,
    };

    // Correct tenant: succeeds.
    expect(
      decrypt(
        envelope,
        buildAad({
          organizationId: ORG,
          purpose: SLACK_WEBHOOK_PURPOSE,
          recordId: view.id,
        }),
        keyring,
      ),
    ).toBe(WEBHOOK);

    // Same row, another tenant: the AAD no longer authenticates.
    expect(() =>
      decrypt(
        envelope,
        buildAad({
          organizationId: OTHER_ORG,
          purpose: SLACK_WEBHOOK_PURPOSE,
          recordId: view.id,
        }),
        keyring,
      ),
    ).toThrow(EncryptionError);
  });

  it("fails to decrypt under a different purpose or record id", async () => {
    const db = createMemoryNotificationStore();
    const view = await createSlackDestination(db, {
      organizationId: ORG,
      name: "#payments",
      webhookUrl: WEBHOOK,
      keyring,
    });
    const row = onlyDestination(db.listDestinations(ORG));
    const envelope = {
      ciphertext: row.secretCiphertext as Buffer,
      nonce: row.secretNonce as Buffer,
      authTag: row.secretAuthTag as Buffer,
      keyId: row.secretKeyId as string,
      version: ENCRYPTION_VERSION,
    };

    expect(() =>
      decrypt(
        envelope,
        buildAad({ organizationId: ORG, purpose: "stripe_key", recordId: view.id }),
        keyring,
      ),
    ).toThrow(EncryptionError);

    expect(() =>
      decrypt(
        envelope,
        buildAad({
          organizationId: ORG,
          purpose: SLACK_WEBHOOK_PURPOSE,
          recordId: "44444444-4444-4444-8444-444444444444",
        }),
        keyring,
      ),
    ).toThrow(EncryptionError);
  });

  it("fails when the ciphertext or the auth tag has been tampered with", async () => {
    const db = createMemoryNotificationStore();
    const view = await createSlackDestination(db, {
      organizationId: ORG,
      name: "#payments",
      webhookUrl: WEBHOOK,
      keyring,
    });
    const row = onlyDestination(db.listDestinations(ORG));
    const aad = buildAad({
      organizationId: ORG,
      purpose: SLACK_WEBHOOK_PURPOSE,
      recordId: view.id,
    });

    const ciphertext = Buffer.from(row.secretCiphertext as Buffer);
    const nonce = row.secretNonce as Buffer;
    const authTag = row.secretAuthTag as Buffer;
    const keyId = row.secretKeyId as string;

    const flipped = Buffer.from(ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() =>
      decrypt(
        { ciphertext: flipped, nonce, authTag, keyId, version: ENCRYPTION_VERSION },
        aad,
        keyring,
      ),
    ).toThrow(EncryptionError);

    const badTag = Buffer.from(authTag);
    badTag[0] = (badTag[0] ?? 0) ^ 0xff;
    expect(() =>
      decrypt(
        { ciphertext, nonce, authTag: badTag, keyId, version: ENCRYPTION_VERSION },
        aad,
        keyring,
      ),
    ).toThrow(EncryptionError);
  });

  it("fails under an unrelated key", async () => {
    const db = createMemoryNotificationStore();
    const view = await createSlackDestination(db, {
      organizationId: ORG,
      name: "#payments",
      webhookUrl: WEBHOOK,
      keyring,
    });

    await expect(
      loadSlackWebhook(db, {
        organizationId: ORG,
        destinationId: view.id,
        // Same key id, different key material: authentication must fail.
        keyring: keyringWith(0x22),
      }),
    ).rejects.toBeInstanceOf(EncryptionError);
  });

  it("returns null for another tenant, an email destination, or a missing row", async () => {
    const db = createMemoryNotificationStore();
    const slack = await createSlackDestination(db, {
      organizationId: ORG,
      name: "#payments",
      webhookUrl: WEBHOOK,
      keyring,
    });
    const email = await createEmailDestination(db, {
      organizationId: ORG,
      name: "Finance alerts",
      email: "alerts@example.com",
    });

    await expect(
      loadSlackWebhook(db, {
        organizationId: OTHER_ORG,
        destinationId: slack.id,
        keyring,
      }),
    ).resolves.toBeNull();

    await expect(
      loadSlackWebhook(db, { organizationId: ORG, destinationId: email.id, keyring }),
    ).resolves.toBeNull();

    await expect(
      loadSlackWebhook(db, {
        organizationId: ORG,
        destinationId: "55555555-5555-4555-8555-555555555555",
        keyring,
      }),
    ).resolves.toBeNull();
  });

  it("keeps the webhook out of audit metadata", async () => {
    const db = createMemoryNotificationStore();
    await createSlackDestination(db, {
      organizationId: ORG,
      name: "#payments",
      webhookUrl: WEBHOOK,
      createdByUserId: USER,
      keyring,
    });

    const audit = JSON.stringify(db.listAuditEvents());
    expect(audit).toContain("notification.destination_created");
    expect(audit).not.toContain(WEBHOOK);
    expect(audit).not.toContain("hooks.slack.com");
    expect(audit).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
  });
});

describe("destination lifecycle", () => {
  it("becomes active only when explicitly verified", async () => {
    const db = createMemoryNotificationStore();
    const created = await createEmailDestination(db, {
      organizationId: ORG,
      name: "Finance alerts",
      email: "alerts@example.com",
    });
    expect(created.status).toBe("pending_verification");

    const now = new Date("2026-07-21T10:00:00.000Z");
    const verified = await markVerified(db, {
      organizationId: ORG,
      destinationId: created.id,
      now,
      actorUserId: USER,
    });

    expect(verified?.status).toBe("active");
    expect(verified?.verifiedAt).toEqual(now);
    expect(db.listAuditEvents().map((event) => event.action)).toContain(
      "notification.destination_verified",
    );
  });

  it("records a sanitized reason when marked failing", async () => {
    const db = createMemoryNotificationStore();
    const created = await createSlackDestination(db, {
      organizationId: ORG,
      name: "#payments",
      webhookUrl: WEBHOOK,
      keyring,
    });

    const failed = await markFailing(db, {
      organizationId: ORG,
      destinationId: created.id,
      error: new Error(`POST ${WEBHOOK} returned 500`),
      now: new Date("2026-07-21T10:00:00.000Z"),
    });

    expect(failed?.status).toBe("failing");
    expect(failed?.lastError).toContain("[redacted]");
    expect(failed?.lastError).not.toContain(WEBHOOK);
  });

  it("disables and deletes, scoped to the owning organization", async () => {
    const db = createMemoryNotificationStore();
    const created = await createEmailDestination(db, {
      organizationId: ORG,
      name: "Finance alerts",
      email: "alerts@example.com",
    });

    const disabled = await disableDestination(db, {
      organizationId: ORG,
      destinationId: created.id,
    });
    expect(disabled?.status).toBe("disabled");

    // Another tenant cannot touch it.
    await expect(
      deleteDestination(db, { organizationId: OTHER_ORG, destinationId: created.id }),
    ).resolves.toBe(false);
    expect(db.listDestinations(ORG)).toHaveLength(1);

    await expect(
      deleteDestination(db, { organizationId: ORG, destinationId: created.id, actorUserId: USER }),
    ).resolves.toBe(true);
    expect(db.listDestinations(ORG)).toHaveLength(0);
  });
});
