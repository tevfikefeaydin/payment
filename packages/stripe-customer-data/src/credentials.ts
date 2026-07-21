/**
 * Storage, retrieval, rotation and revocation of a customer's restricted key.
 *
 * READ-ONLY CONTEXT: the credential handled here can only ever be used to issue
 * Stripe list and retrieve calls. This package performs no Stripe writes.
 *
 * This module is the ONLY place in PayRecon that turns ciphertext back into a
 * usable key, and `loadCredential` is the narrow path the specification requires
 * that decryption be confined to. Three things protect the plaintext:
 *
 *  1. The prefix is validated BEFORE encryption, so a secret key is never
 *     accepted into the store in the first place.
 *  2. The ciphertext is bound with AAD to `(organizationId, purpose,
 *     connectionId)`. A row copied into another tenant's connection fails to
 *     decrypt instead of silently working — a stolen ciphertext is inert
 *     outside the exact record it was created for.
 *  3. The plaintext is returned inside `RestrictedKey`, whose `toString`,
 *     `toJSON` and Node inspect output are all `[redacted]`. Logging it,
 *     JSON-serialising it into audit metadata, or snapshotting it in a test
 *     yields nothing useful; a caller must ask for `.reveal()` explicitly.
 *
 * Every function requires `organizationId` and filters on it. An unscoped read
 * of a credential is not expressible through this API.
 */
import {
  buildAad,
  decrypt,
  encrypt,
  ENCRYPTION_VERSION,
  type Keyring,
} from "@payrecon/auth/crypto";
import { REDACTED } from "@payrecon/domain";
import { assertRestrictedKey, keyKindOf, keyLastFour, normalizeStripeKey } from "./key-validation";
import { resolveStore, type StripeDataStoreLike } from "./store";

/** AAD purpose. Changing this string invalidates every existing ciphertext. */
export const STRIPE_CREDENTIAL_PURPOSE = "stripe_restricted_key";

/**
 * Bind a ciphertext to its tenant and connection.
 *
 * Exported so tests can prove that decrypting under a different organization
 * fails, which is the property that makes cross-tenant ciphertext reuse useless.
 */
export function credentialAad(organizationId: string, connectionId: string): Buffer {
  return buildAad({
    organizationId,
    purpose: STRIPE_CREDENTIAL_PURPOSE,
    recordId: connectionId,
  });
}

/**
 * A decrypted restricted key that resists accidental disclosure.
 *
 * The value lives in a `#private` field, so it is unreachable by property
 * enumeration, spreading, `Object.entries`, structured cloning, or a serialiser
 * walking the object graph.
 */
export class RestrictedKey {
  readonly #value: string;
  readonly livemode: boolean;

  constructor(value: string) {
    // Defence in depth: even a value that somehow reached the database without
    // passing admission control cannot be handed to a Stripe client from here.
    const classification = assertRestrictedKey(value);
    this.#value = normalizeStripeKey(value);
    this.livemode = classification.livemode;
  }

  /** The plaintext. Pass it straight to a Stripe client; never store it. */
  reveal(): string {
    return this.#value;
  }

  get kind(): "rk_live" | "rk_test" {
    return keyKindOf(this.livemode);
  }

  get lastFour(): string {
    return keyLastFour(this.#value);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** Makes `console.log` and Vitest's diff output safe too. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `RestrictedKey(${REDACTED})`;
  }
}

export interface StoreCredentialInput {
  organizationId: string;
  connectionId: string;
  /** Validated before use; never logged, echoed, or returned. */
  plaintextKey: string;
  keyring: Keyring;
  now?: Date;
}

/** Everything about a stored credential that is safe to display or audit. */
export interface StoredCredentialSummary {
  id: string;
  organizationId: string;
  connectionId: string;
  keyKind: string;
  keyLastFour: string;
  keyId: string;
  encryptionVersion: number;
  livemode: boolean;
  createdAt: Date;
}

/**
 * Encrypt and store a restricted key, replacing any active credential.
 *
 * The revoke and the insert happen in ONE transaction. The database enforces a
 * single active credential per connection, so doing them separately would either
 * violate that constraint or leave a window with no usable credential at all.
 */
export async function storeCredential(
  db: StripeDataStoreLike,
  input: StoreCredentialInput,
): Promise<StoredCredentialSummary> {
  const store = resolveStore(db);
  const now = input.now ?? new Date();

  // Prefix first: an unacceptable key must never be encrypted or persisted.
  const { livemode } = assertRestrictedKey(input.plaintextKey);
  const plaintext = normalizeStripeKey(input.plaintextKey);

  const envelope = encrypt(
    plaintext,
    credentialAad(input.organizationId, input.connectionId),
    input.keyring,
  );

  const record = await store.transaction(async (tx) => {
    await tx.revokeActiveCredentials(input.organizationId, input.connectionId, now);
    return tx.insertCredential({
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      authTag: envelope.authTag,
      keyId: envelope.keyId,
      encryptionVersion: envelope.version,
      keyKind: keyKindOf(livemode),
      keyLastFour: keyLastFour(plaintext),
      now,
    });
  });

  return {
    id: record.id,
    organizationId: record.organizationId,
    connectionId: record.connectionId,
    keyKind: record.keyKind,
    keyLastFour: record.keyLastFour,
    keyId: record.keyId,
    encryptionVersion: record.encryptionVersion,
    livemode,
    createdAt: record.createdAt,
  };
}

/**
 * Rotate a connection's credential.
 *
 * Identical mechanics to `storeCredential` — the previous version is revoked in
 * the same transaction — but named separately because rotation is an audited
 * operator action and the call sites read very differently.
 */
export async function rotateCredential(
  db: StripeDataStoreLike,
  input: StoreCredentialInput,
): Promise<StoredCredentialSummary> {
  return storeCredential(db, input);
}

export interface LoadCredentialInput {
  organizationId: string;
  connectionId: string;
  keyring: Keyring;
}

/**
 * Decrypt the active credential for a connection.
 *
 * Returns null when the credential is absent or revoked, so a disabled or
 * deleted connection simply has nothing to sync with rather than failing loudly
 * somewhere further down.
 *
 * @throws {EncryptionError} when the ciphertext, tag, key or tenant binding does
 * not check out. The error is deliberately generic — an attacker must not learn
 * which of those it was.
 */
export async function loadCredential(
  db: StripeDataStoreLike,
  input: LoadCredentialInput,
): Promise<RestrictedKey | null> {
  const store = resolveStore(db);
  const record = await store.findActiveCredential(input.organizationId, input.connectionId);
  if (!record) return null;

  const plaintext = decrypt(
    {
      ciphertext: record.ciphertext,
      nonce: record.nonce,
      authTag: record.authTag,
      keyId: record.keyId,
      version: record.encryptionVersion,
    },
    credentialAad(input.organizationId, input.connectionId),
    input.keyring,
  );

  return new RestrictedKey(plaintext);
}

export interface RevokeCredentialInput {
  organizationId: string;
  connectionId: string;
  now?: Date;
}

/**
 * Make a connection's credential immediately unusable.
 *
 * The row is kept, not deleted: the audit trail must still show which key was in
 * use and when it stopped being usable. `loadCredential` filters on
 * `revoked_at is null`, so revocation takes effect on the very next sync.
 */
export async function revokeCredential(
  db: StripeDataStoreLike,
  input: RevokeCredentialInput,
): Promise<boolean> {
  const store = resolveStore(db);
  const revoked = await store.revokeActiveCredentials(
    input.organizationId,
    input.connectionId,
    input.now ?? new Date(),
  );
  return revoked > 0;
}

/**
 * Non-secret description of the active credential, for a settings screen.
 * Returns null when there is none.
 */
export async function describeCredential(
  db: StripeDataStoreLike,
  input: { organizationId: string; connectionId: string },
): Promise<Omit<StoredCredentialSummary, "livemode"> | null> {
  const store = resolveStore(db);
  const record = await store.findActiveCredential(input.organizationId, input.connectionId);
  if (!record) return null;
  return {
    id: record.id,
    organizationId: record.organizationId,
    connectionId: record.connectionId,
    keyKind: record.keyKind,
    keyLastFour: record.keyLastFour,
    keyId: record.keyId,
    encryptionVersion: record.encryptionVersion,
    createdAt: record.createdAt,
  };
}

/** Current envelope version, re-exported so callers need not import auth. */
export { ENCRYPTION_VERSION };
