import { randomUUID } from "node:crypto";
import {
  ENCRYPTION_VERSION,
  buildAad,
  decrypt,
  encrypt,
  type Keyring,
} from "@payrecon/auth/crypto";
import { PublicError } from "@payrecon/domain";
import { toSingleLine, truncate } from "./escaping";
import { sanitizeErrorMessage } from "./transports";
import type {
  DestinationRow,
  DestinationStatus,
  NotificationKind,
  NotificationStore,
} from "./store";

/**
 * Notification destinations.
 *
 * A Slack webhook URL is a credential: anyone holding it can post into the
 * customer's workspace. It is therefore treated exactly like a Stripe
 * restricted key — encrypted at rest with AES-256-GCM under an AAD that binds
 * the ciphertext to `(organization, purpose, destination)`, decrypted only in
 * `loadSlackWebhook` immediately before a POST, and never returned, logged, or
 * placed in audit metadata. Only a non-secret `secretHint` is readable.
 *
 * An email address is not a credential and is stored in `target` directly.
 *
 * A destination is created `pending_verification` and only becomes `active`
 * after a test message has actually been delivered (see `sendTestMessage`).
 */

/** AAD purpose. Changing this string invalidates every existing ciphertext. */
export const SLACK_WEBHOOK_PURPOSE = "slack_webhook";

const SLACK_WEBHOOK_HOST = "hooks.slack.com";
/** Slack's documented shape: /services/{team}/{channel}/{token}. */
const SLACK_WEBHOOK_PATH = /^\/services\/[A-Za-z0-9]{4,}\/[A-Za-z0-9]{4,}\/[A-Za-z0-9]{8,}$/;

const MAX_NAME_CHARS = 80;
const MAX_EMAIL_CHARS = 254; // RFC 5321 maximum path length
const MAX_EMAIL_LOCAL_CHARS = 64;

/**
 * Deliberately narrower than RFC 5322.
 *
 * Quoted local parts and the characters that would be dangerous in a
 * `To:` header or in HTML (`"`, `'`, `<`, `>`, `;`, `,`, whitespace) are
 * rejected outright. Refusing an exotic-but-legal address is a far better
 * outcome than accepting one that can inject a header.
 */
const EMAIL_PATTERN = /^[^\s@"'<>;,\\]+@[^\s@"'<>;,\\.]+(?:\.[^\s@"'<>;,\\.]+)+$/;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** A destination as it may be returned to an authorized user. Never a secret. */
export interface DestinationView {
  id: string;
  organizationId: string;
  kind: NotificationKind;
  name: string;
  /** Email address for `email` destinations; null for `slack`. */
  target: string | null;
  /** Non-secret fragment such as `hooks.slack.com/…/T0A1`. */
  secretHint: string | null;
  status: DestinationStatus;
  verifiedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toDestinationView(row: DestinationRow): DestinationView {
  // Constructed field by field rather than by spreading and deleting, so a new
  // secret column added to the row type cannot silently reach a caller.
  return {
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind,
    name: row.name,
    target: row.target,
    secretHint: row.secretHint,
    status: row.status,
    verifiedAt: row.verifiedAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function normalizeDestinationName(input: string): string {
  const name = truncate(toSingleLine(input), MAX_NAME_CHARS);
  if (name.length === 0) {
    throw new PublicError("notification.invalid_name", "A destination name is required.");
  }
  return name;
}

/** Validate and normalise an email address. Throws a user-safe error. */
export function normalizeEmailAddress(input: string): string {
  const email = toSingleLine(input).toLowerCase();
  const at = email.lastIndexOf("@");
  if (
    email.length === 0 ||
    email.length > MAX_EMAIL_CHARS ||
    at <= 0 ||
    at > MAX_EMAIL_LOCAL_CHARS ||
    !EMAIL_PATTERN.test(email)
  ) {
    throw new PublicError(
      "notification.invalid_email",
      "Enter a valid email address, for example alerts@example.com.",
    );
  }
  return email;
}

/**
 * Validate a Slack incoming-webhook URL.
 *
 * Returns the URL unchanged on success. The error message never echoes the
 * supplied value: a mistyped webhook is still a secret.
 */
export function assertSlackWebhookUrl(input: string): string {
  const invalid = (): never => {
    throw new PublicError(
      "notification.invalid_slack_webhook",
      `Enter a Slack incoming webhook URL that starts with https://${SLACK_WEBHOOK_HOST}/services/.`,
    );
  };

  const value = input.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }

  if (url.protocol !== "https:") return invalid();
  if (url.hostname !== SLACK_WEBHOOK_HOST) return invalid();
  // Credentials, query or fragment on a webhook URL indicate either a mistake
  // or an attempt to smuggle something past the host check.
  if (url.username || url.password || url.search || url.hash) return invalid();
  if (!SLACK_WEBHOOK_PATH.test(url.pathname)) return invalid();

  return value;
}

/**
 * Build the non-secret hint shown in the UI.
 *
 * Only the leading characters of the TEAM segment are used. The final path
 * segment is the actual secret and never appears here, not even partially.
 */
export function buildSlackSecretHint(webhookUrl: string): string {
  const segments = new URL(webhookUrl).pathname.split("/").filter(Boolean);
  const team = segments[1] ?? "";
  return `${SLACK_WEBHOOK_HOST}/…/${team.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface CreateEmailDestinationInput {
  organizationId: string;
  name: string;
  email: string;
  createdByUserId?: string | null;
  now?: Date;
}

export async function createEmailDestination(
  db: NotificationStore,
  input: CreateEmailDestinationInput,
): Promise<DestinationView> {
  const now = input.now ?? new Date();
  const row = await db.insertDestination({
    id: randomUUID(),
    organizationId: input.organizationId,
    kind: "email",
    name: normalizeDestinationName(input.name),
    target: normalizeEmailAddress(input.email),
    secretCiphertext: null,
    secretNonce: null,
    secretAuthTag: null,
    secretKeyId: null,
    secretHint: null,
    // Verification gates activation; nothing is sent here until a test message
    // has actually been delivered.
    status: "pending_verification",
    createdByUserId: input.createdByUserId ?? null,
    createdAt: now,
  });

  await db.recordAudit({
    organizationId: input.organizationId,
    actor: { type: "user", userId: input.createdByUserId ?? null },
    action: "notification.destination_created",
    targetType: "notification_destination",
    targetId: row.id,
    metadata: { kind: "email", name: row.name },
  });

  return toDestinationView(row);
}

export interface CreateSlackDestinationInput {
  organizationId: string;
  name: string;
  /** SECRET. Encrypted before it reaches the database and never echoed back. */
  webhookUrl: string;
  createdByUserId?: string | null;
  keyring: Keyring;
  now?: Date;
}

export async function createSlackDestination(
  db: NotificationStore,
  input: CreateSlackDestinationInput,
): Promise<DestinationView> {
  const now = input.now ?? new Date();
  const webhookUrl = assertSlackWebhookUrl(input.webhookUrl);

  // The id is generated here rather than by the database default because the
  // AAD binds the ciphertext to this exact record; it must exist before the
  // value is encrypted.
  const id = randomUUID();
  const envelope = encrypt(
    webhookUrl,
    buildAad({
      organizationId: input.organizationId,
      purpose: SLACK_WEBHOOK_PURPOSE,
      recordId: id,
    }),
    input.keyring,
  );

  const row = await db.insertDestination({
    id,
    organizationId: input.organizationId,
    kind: "slack",
    name: normalizeDestinationName(input.name),
    target: null,
    secretCiphertext: envelope.ciphertext,
    secretNonce: envelope.nonce,
    secretAuthTag: envelope.authTag,
    secretKeyId: envelope.keyId,
    secretHint: buildSlackSecretHint(webhookUrl),
    status: "pending_verification",
    createdByUserId: input.createdByUserId ?? null,
    createdAt: now,
  });

  await db.recordAudit({
    organizationId: input.organizationId,
    actor: { type: "user", userId: input.createdByUserId ?? null },
    action: "notification.destination_created",
    targetType: "notification_destination",
    targetId: row.id,
    // The hint is non-secret; the URL itself is deliberately absent.
    metadata: { kind: "slack", name: row.name, secretHint: row.secretHint },
  });

  return toDestinationView(row);
}

// ---------------------------------------------------------------------------
// Secret access
// ---------------------------------------------------------------------------

export interface LoadSlackWebhookInput {
  organizationId: string;
  destinationId: string;
  keyring: Keyring;
}

/**
 * Decrypt a Slack webhook URL.
 *
 * This is the ONLY path in the package that produces the plaintext, and the
 * only caller is the send path, which passes it straight to the HTTP transport.
 * The result must never be logged, returned to a browser, stored, or included
 * in an error.
 *
 * Returns null when the destination does not exist for this organization, is
 * not a Slack destination, or carries no ciphertext. Throws `EncryptionError`
 * when a ciphertext exists but fails authentication — a tampered row or a row
 * moved between tenants must be loud, not silently treated as absent.
 */
export async function loadSlackWebhook(
  db: NotificationStore,
  input: LoadSlackWebhookInput,
): Promise<string | null> {
  const row = await db.getDestination(input.organizationId, input.destinationId);
  if (!row || row.kind !== "slack") return null;
  if (!row.secretCiphertext || !row.secretNonce || !row.secretAuthTag || !row.secretKeyId) {
    return null;
  }

  return decrypt(
    {
      ciphertext: row.secretCiphertext,
      nonce: row.secretNonce,
      authTag: row.secretAuthTag,
      keyId: row.secretKeyId,
      version: ENCRYPTION_VERSION,
    },
    buildAad({
      organizationId: input.organizationId,
      purpose: SLACK_WEBHOOK_PURPOSE,
      recordId: input.destinationId,
    }),
    input.keyring,
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export interface DestinationRefInput {
  organizationId: string;
  destinationId: string;
  now?: Date;
}

/**
 * Promote a destination to `active`.
 *
 * Only ever called after a verification message has been delivered, which is
 * what makes "active" mean "we have proved this works" rather than "someone
 * typed something".
 */
export async function markVerified(
  db: NotificationStore,
  input: DestinationRefInput & { actorUserId?: string | null },
): Promise<DestinationView | null> {
  const now = input.now ?? new Date();
  const row = await db.updateDestination(input.organizationId, input.destinationId, {
    status: "active",
    verifiedAt: now,
    lastError: null,
    lastErrorAt: null,
    updatedAt: now,
  });
  if (!row) return null;

  await db.recordAudit({
    organizationId: input.organizationId,
    actor: { type: input.actorUserId ? "user" : "system", userId: input.actorUserId ?? null },
    action: "notification.destination_verified",
    targetType: "notification_destination",
    targetId: row.id,
    metadata: { kind: row.kind, name: row.name },
  });

  return toDestinationView(row);
}

/** Record that a destination is rejecting messages, with a sanitized reason. */
export async function markFailing(
  db: NotificationStore,
  input: DestinationRefInput & { error: unknown },
): Promise<DestinationView | null> {
  const now = input.now ?? new Date();
  const row = await db.updateDestination(input.organizationId, input.destinationId, {
    status: "failing",
    lastError: sanitizeErrorMessage(input.error),
    lastErrorAt: now,
    updatedAt: now,
  });
  return row ? toDestinationView(row) : null;
}

/** Stop sending to a destination without discarding its history. */
export async function disableDestination(
  db: NotificationStore,
  input: DestinationRefInput,
): Promise<DestinationView | null> {
  const now = input.now ?? new Date();
  const row = await db.updateDestination(input.organizationId, input.destinationId, {
    status: "disabled",
    updatedAt: now,
  });
  return row ? toDestinationView(row) : null;
}

export async function deleteDestination(
  db: NotificationStore,
  input: DestinationRefInput & { actorUserId?: string | null },
): Promise<boolean> {
  const deleted = await db.deleteDestination(input.organizationId, input.destinationId);
  if (!deleted) return false;

  await db.recordAudit({
    organizationId: input.organizationId,
    actor: { type: input.actorUserId ? "user" : "system", userId: input.actorUserId ?? null },
    action: "notification.destination_deleted",
    targetType: "notification_destination",
    targetId: input.destinationId,
  });

  return true;
}
