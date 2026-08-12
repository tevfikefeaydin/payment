import { and, eq, isNotNull, isNull, ne } from "drizzle-orm";
import {
  notificationDestinations,
  recordAudit,
  stripeCredentials,
  type Database,
} from "@payrecon/db";
import { buildAad, ENCRYPTION_VERSION, rotateEnvelope, type Keyring } from "@payrecon/auth";
import { jobsLogger } from "./log";
import { credentialAad } from "@payrecon/stripe-customer-data";
import { SLACK_WEBHOOK_PURPOSE } from "@payrecon/notifications";

/**
 * Drive `rotateEnvelope` over every table that stores an encrypted credential.
 *
 * Run after the active master key changes (the old key moves to
 * ENCRYPTION_KEY_PREVIOUS): each ciphertext still under the retired key is
 * decrypted and re-encrypted under the active key, row by row, so the retired
 * key can eventually be removed from the environment entirely.
 *
 * Selection filters on `key_id <> active` in SQL, so the steady-state run —
 * nothing to rotate — reads no ciphertext at all. Plaintext exists only inside
 * `rotateEnvelope` and is never returned, logged or audited.
 *
 * A row that fails to rotate (its key id matches nothing in the keyring, or the
 * ciphertext no longer authenticates) is left untouched, counted, and reported
 * per organization in the audit log; one poisoned row must not stop the sweep.
 */

export interface EnvelopeRotationSummary {
  stripeCredentialsRotated: number;
  slackWebhooksRotated: number;
  failed: number;
}

interface OrgCounts {
  stripeCredentials: number;
  slackWebhooks: number;
  failed: number;
}

export async function rotateStoredEnvelopes(
  db: Database,
  keyring: Keyring,
): Promise<EnvelopeRotationSummary> {
  const perOrg = new Map<string, OrgCounts>();
  const counts = (organizationId: string): OrgCounts => {
    let entry = perOrg.get(organizationId);
    if (!entry) {
      entry = { stripeCredentials: 0, slackWebhooks: 0, failed: 0 };
      perOrg.set(organizationId, entry);
    }
    return entry;
  };

  // Active credentials only. Revoked rows are kept purely as audit trail; their
  // plaintext is never needed again, so re-encrypting them would only widen the
  // set of rows the retired key's removal has to wait for.
  const credentials = await db
    .select({
      id: stripeCredentials.id,
      organizationId: stripeCredentials.organizationId,
      connectionId: stripeCredentials.connectionId,
      ciphertext: stripeCredentials.ciphertext,
      nonce: stripeCredentials.nonce,
      authTag: stripeCredentials.authTag,
      keyId: stripeCredentials.keyId,
      encryptionVersion: stripeCredentials.encryptionVersion,
    })
    .from(stripeCredentials)
    .where(
      and(isNull(stripeCredentials.revokedAt), ne(stripeCredentials.keyId, keyring.active.id)),
    );

  for (const row of credentials) {
    const entry = counts(row.organizationId);
    try {
      const rotated = rotateEnvelope(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authTag: row.authTag,
          keyId: row.keyId,
          version: row.encryptionVersion,
        },
        credentialAad(row.organizationId, row.connectionId),
        keyring,
      );
      if (!rotated) continue;

      // Guarded on the old key id: if an operator replaced the credential
      // concurrently, this update matches nothing instead of clobbering it.
      const updated = await db
        .update(stripeCredentials)
        .set({
          ciphertext: rotated.ciphertext,
          nonce: rotated.nonce,
          authTag: rotated.authTag,
          keyId: rotated.keyId,
          encryptionVersion: rotated.version,
        })
        .where(and(eq(stripeCredentials.id, row.id), eq(stripeCredentials.keyId, row.keyId)))
        .returning({ id: stripeCredentials.id });
      if (updated.length > 0) entry.stripeCredentials += 1;
    } catch {
      // Deliberately generic: the reason (unknown key vs. tampering) must not
      // be distinguishable from a log line either.
      entry.failed += 1;
      jobsLogger().error(
        { table: "stripe_credentials", rowId: row.id },
        "envelope rotation failed",
      );
    }
  }

  const destinations = await db
    .select({
      id: notificationDestinations.id,
      organizationId: notificationDestinations.organizationId,
      ciphertext: notificationDestinations.secretCiphertext,
      nonce: notificationDestinations.secretNonce,
      authTag: notificationDestinations.secretAuthTag,
      keyId: notificationDestinations.secretKeyId,
    })
    .from(notificationDestinations)
    .where(
      and(
        isNotNull(notificationDestinations.secretCiphertext),
        isNotNull(notificationDestinations.secretKeyId),
        ne(notificationDestinations.secretKeyId, keyring.active.id),
      ),
    );

  for (const row of destinations) {
    if (!row.ciphertext || !row.nonce || !row.authTag || !row.keyId) continue;
    const entry = counts(row.organizationId);
    try {
      const rotated = rotateEnvelope(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authTag: row.authTag,
          keyId: row.keyId,
          // Destinations carry no version column; they are always current.
          version: ENCRYPTION_VERSION,
        },
        buildAad({
          organizationId: row.organizationId,
          purpose: SLACK_WEBHOOK_PURPOSE,
          recordId: row.id,
        }),
        keyring,
      );
      if (!rotated) continue;

      const updated = await db
        .update(notificationDestinations)
        .set({
          secretCiphertext: rotated.ciphertext,
          secretNonce: rotated.nonce,
          secretAuthTag: rotated.authTag,
          secretKeyId: rotated.keyId,
        })
        .where(
          and(
            eq(notificationDestinations.id, row.id),
            eq(notificationDestinations.secretKeyId, row.keyId),
          ),
        )
        .returning({ id: notificationDestinations.id });
      if (updated.length > 0) entry.slackWebhooks += 1;
    } catch {
      entry.failed += 1;
      jobsLogger().error(
        { table: "notification_destinations", rowId: row.id },
        "envelope rotation failed",
      );
    }
  }

  const summary: EnvelopeRotationSummary = {
    stripeCredentialsRotated: 0,
    slackWebhooksRotated: 0,
    failed: 0,
  };
  for (const [organizationId, entry] of perOrg) {
    summary.stripeCredentialsRotated += entry.stripeCredentials;
    summary.slackWebhooksRotated += entry.slackWebhooks;
    summary.failed += entry.failed;
    if (entry.stripeCredentials === 0 && entry.slackWebhooks === 0 && entry.failed === 0) continue;

    await recordAudit(db, {
      organizationId,
      actor: { type: "system" },
      action: "encryption.envelopes_rotated",
      targetType: "encryption_key",
      // Counts only — never key ids of failing rows, never material. Field
      // names avoid the sensitive-key redaction patterns ("credential" would
      // be blanked to [redacted] by recordAudit).
      metadata: {
        stripeKeyEnvelopes: entry.stripeCredentials,
        slackWebhookEnvelopes: entry.slackWebhooks,
        failed: entry.failed,
      },
    });
  }
  return summary;
}
