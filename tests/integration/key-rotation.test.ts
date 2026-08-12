import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  auditEvents,
  createOrganization,
  notificationDestinations,
  stripeConnections,
  stripeCredentials,
} from "@payrecon/db";
import { buildAad, decrypt, encrypt, type Keyring, type MasterKey } from "@payrecon/auth";
import { credentialAad } from "@payrecon/stripe-customer-data";
import { SLACK_WEBHOOK_PURPOSE } from "@payrecon/notifications";
import { rotateStoredEnvelopes } from "@payrecon/jobs";
import { createTestUser, testDb } from "./helpers";

/**
 * The key re-encryption driver against a real database.
 *
 * Seeds ciphertexts under a retired key, rotates with a keyring whose active
 * key is new, and proves the rows are readable under the NEW key alone — the
 * property that lets the retired key be removed from the environment.
 */

function masterKey(id: string, fill: number): MasterKey {
  return { id, key: Buffer.alloc(32, fill) };
}

const oldKey = masterKey("key-old", 1);
const newKey = masterKey("key-new", 2);
const strayKey = masterKey("key-stray", 3);

const oldRing: Keyring = { active: oldKey };
const rotationRing: Keyring = { active: newKey, previous: oldKey };
const newOnlyRing: Keyring = { active: newKey };

async function seedOrgWithConnection(): Promise<{ orgId: string; connectionId: string }> {
  const user = await createTestUser();
  const org = await createOrganization(testDb(), {
    name: `Rotate ${Date.now()}`,
    ownerUserId: user.id,
  });
  const [connection] = await testDb()
    .insert(stripeConnections)
    .values({ organizationId: org.id, name: "conn" })
    .returning({ id: stripeConnections.id });
  if (!connection) throw new Error("failed to insert connection");
  return { orgId: org.id, connectionId: connection.id };
}

async function seedCredential(orgId: string, connectionId: string, ring: Keyring): Promise<string> {
  const envelope = encrypt("rk_test_secret1234", credentialAad(orgId, connectionId), ring);
  const [row] = await testDb()
    .insert(stripeCredentials)
    .values({
      organizationId: orgId,
      connectionId,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      authTag: envelope.authTag,
      keyId: envelope.keyId,
      encryptionVersion: envelope.version,
      keyKind: "rk_test",
      keyLastFour: "1234",
    })
    .returning({ id: stripeCredentials.id });
  if (!row) throw new Error("failed to insert credential");
  return row.id;
}

async function seedSlackDestination(orgId: string, ring: Keyring): Promise<string> {
  const id = randomUUID();
  const envelope = encrypt(
    "https://hooks.slack.com/services/T0000/B0000/secretsecret",
    buildAad({ organizationId: orgId, purpose: SLACK_WEBHOOK_PURPOSE, recordId: id }),
    ring,
  );
  await testDb()
    .insert(notificationDestinations)
    .values({
      id,
      organizationId: orgId,
      kind: "slack",
      name: `slack-${id.slice(0, 8)}`,
      secretCiphertext: envelope.ciphertext,
      secretNonce: envelope.nonce,
      secretAuthTag: envelope.authTag,
      secretKeyId: envelope.keyId,
    });
  return id;
}

describe("rotateStoredEnvelopes", () => {
  it("re-encrypts credentials and Slack secrets under the active key", async () => {
    const db = testDb();
    const { orgId, connectionId } = await seedOrgWithConnection();
    const credentialId = await seedCredential(orgId, connectionId, oldRing);
    const destinationId = await seedSlackDestination(orgId, oldRing);

    const summary = await rotateStoredEnvelopes(db, rotationRing);
    expect(summary).toEqual({
      stripeCredentialsRotated: 1,
      slackWebhooksRotated: 1,
      failed: 0,
    });

    // Both rows must now decrypt under the NEW key alone.
    const [credential] = await db
      .select()
      .from(stripeCredentials)
      .where(eq(stripeCredentials.id, credentialId));
    if (!credential) throw new Error("credential row disappeared");
    expect(credential.keyId).toBe(newKey.id);
    expect(
      decrypt(
        {
          ciphertext: credential.ciphertext,
          nonce: credential.nonce,
          authTag: credential.authTag,
          keyId: credential.keyId,
          version: credential.encryptionVersion,
        },
        credentialAad(orgId, connectionId),
        newOnlyRing,
      ),
    ).toBe("rk_test_secret1234");

    const [destination] = await db
      .select()
      .from(notificationDestinations)
      .where(eq(notificationDestinations.id, destinationId));
    if (
      !destination?.secretCiphertext ||
      !destination.secretNonce ||
      !destination.secretAuthTag ||
      !destination.secretKeyId
    ) {
      throw new Error("destination secret disappeared");
    }
    expect(destination.secretKeyId).toBe(newKey.id);
    expect(
      decrypt(
        {
          ciphertext: destination.secretCiphertext,
          nonce: destination.secretNonce,
          authTag: destination.secretAuthTag,
          keyId: destination.secretKeyId,
          version: 1,
        },
        buildAad({
          organizationId: orgId,
          purpose: SLACK_WEBHOOK_PURPOSE,
          recordId: destinationId,
        }),
        newOnlyRing,
      ),
    ).toBe("https://hooks.slack.com/services/T0000/B0000/secretsecret");

    // One per-organization audit row with counts only.
    const audit = await db
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, orgId),
          eq(auditEvents.action, "encryption.envelopes_rotated"),
        ),
      );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.metadata).toEqual({
      stripeKeyEnvelopes: 1,
      slackWebhookEnvelopes: 1,
      failed: 0,
    });
  });

  it("is idempotent: a second sweep touches nothing", async () => {
    const db = testDb();
    const { orgId, connectionId } = await seedOrgWithConnection();
    await seedCredential(orgId, connectionId, oldRing);

    await rotateStoredEnvelopes(db, rotationRing);
    const second = await rotateStoredEnvelopes(db, rotationRing);
    expect(second).toEqual({ stripeCredentialsRotated: 0, slackWebhooksRotated: 0, failed: 0 });
  });

  it("counts a row under an unknown key as failed and leaves it untouched", async () => {
    const db = testDb();
    const { orgId, connectionId } = await seedOrgWithConnection();
    const credentialId = await seedCredential(orgId, connectionId, { active: strayKey });

    const summary = await rotateStoredEnvelopes(db, rotationRing);
    expect(summary).toEqual({ stripeCredentialsRotated: 0, slackWebhooksRotated: 0, failed: 1 });

    const [row] = await db
      .select({ keyId: stripeCredentials.keyId })
      .from(stripeCredentials)
      .where(eq(stripeCredentials.id, credentialId));
    expect(row?.keyId).toBe(strayKey.id);
  });

  it("skips revoked credentials", async () => {
    const db = testDb();
    const { orgId, connectionId } = await seedOrgWithConnection();
    const credentialId = await seedCredential(orgId, connectionId, oldRing);
    await db
      .update(stripeCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(stripeCredentials.id, credentialId));

    const summary = await rotateStoredEnvelopes(db, rotationRing);
    expect(summary).toEqual({ stripeCredentialsRotated: 0, slackWebhooksRotated: 0, failed: 0 });
  });
});
