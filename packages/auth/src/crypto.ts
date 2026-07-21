import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Authenticated encryption for credentials at rest.
 *
 * Scheme: AES-256-GCM.
 *   - A fresh 96-bit nonce is generated for EVERY encryption. Nonce reuse under
 *     GCM is catastrophic, so the nonce is never derived from data.
 *   - The 128-bit authentication tag is stored separately.
 *   - Additional Authenticated Data (AAD) binds the ciphertext to its tenant and
 *     record. Moving a ciphertext row to another organization makes decryption
 *     fail rather than silently succeed.
 *   - `keyId` records which master key produced the ciphertext, so keys can be
 *     rotated and rows re-encrypted incrementally.
 *
 * The master key is loaded from the environment only. Plaintext returned by
 * `decrypt` must never be logged, serialised into audit metadata, returned to a
 * browser, or captured in a test snapshot.
 *
 * See docs/adr/0005-credential-encryption.md.
 */

/** Current envelope format. Bump only for an incompatible scheme change. */
export const ENCRYPTION_VERSION = 1;

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12; // 96 bits: the GCM-recommended size
const TAG_BYTES = 16; // 128 bits
const KEY_BYTES = 32; // AES-256

export class EncryptionError extends Error {
  constructor(message: string) {
    // Deliberately generic: an attacker must not learn WHY decryption failed
    // (wrong key vs. tampered ciphertext vs. wrong tenant).
    super(message);
    this.name = "EncryptionError";
  }
}

export interface EncryptedEnvelope {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyId: string;
  version: number;
}

/** A master key plus the identifier recorded alongside anything it encrypts. */
export interface MasterKey {
  id: string;
  key: Buffer;
}

/**
 * Key material available to this process: the active key used for all new
 * encryption, plus any retired keys still needed to read old rows.
 */
export interface Keyring {
  active: MasterKey;
  previous?: MasterKey;
}

/** Decode and validate a base64 master key. Throws if it is not exactly 32 bytes. */
export function parseMasterKey(id: string, base64Key: string): MasterKey {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(base64Key, "base64");
  } catch {
    throw new EncryptionError("Encryption key is not valid base64");
  }
  if (decoded.byteLength !== KEY_BYTES) {
    // Report the expected size, never the supplied value.
    throw new EncryptionError(
      `Encryption key must be exactly ${KEY_BYTES} bytes (got ${decoded.byteLength})`,
    );
  }
  if (id.length === 0) throw new EncryptionError("Encryption key id must not be empty");
  return { id, key: decoded };
}

/**
 * Build the AAD that binds a ciphertext to its context.
 *
 * Any change to these components invalidates the ciphertext, which is exactly
 * what prevents a row being copied between tenants or between purposes.
 */
export function buildAad(parts: {
  organizationId: string;
  purpose: string;
  recordId?: string;
}): Buffer {
  const canonical = [
    `org=${parts.organizationId}`,
    `purpose=${parts.purpose}`,
    `record=${parts.recordId ?? ""}`,
    `v=${ENCRYPTION_VERSION}`,
  ].join("|");
  return Buffer.from(canonical, "utf8");
}

/** Encrypt a UTF-8 secret with the keyring's ACTIVE key. */
export function encrypt(plaintext: string, aad: Buffer, keyring: Keyring): EncryptedEnvelope {
  if (plaintext.length === 0) throw new EncryptionError("Refusing to encrypt an empty value");

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, keyring.active.key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext,
    nonce,
    authTag,
    keyId: keyring.active.id,
    version: ENCRYPTION_VERSION,
  };
}

/**
 * Decrypt an envelope.
 *
 * Selects the key by `keyId` so that rows encrypted under a retired key remain
 * readable during a rotation. Throws a generic error on any failure: a wrong
 * key, a tampered ciphertext, a tampered tag and a mismatched AAD are
 * indistinguishable to the caller by design.
 */
export function decrypt(envelope: EncryptedEnvelope, aad: Buffer, keyring: Keyring): string {
  if (envelope.version !== ENCRYPTION_VERSION) {
    throw new EncryptionError("Unsupported encryption envelope version");
  }
  if (envelope.nonce.byteLength !== NONCE_BYTES) {
    throw new EncryptionError("Invalid nonce");
  }
  if (envelope.authTag.byteLength !== TAG_BYTES) {
    throw new EncryptionError("Invalid authentication tag");
  }

  const key = selectKey(envelope.keyId, keyring);
  if (!key) throw new EncryptionError("No key available for this ciphertext");

  try {
    const decipher = createDecipheriv(ALGORITHM, key.key, envelope.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new EncryptionError("Unable to decrypt value");
  }
}

function selectKey(keyId: string, keyring: Keyring): MasterKey | null {
  if (constantTimeEquals(keyId, keyring.active.id)) return keyring.active;
  if (keyring.previous && constantTimeEquals(keyId, keyring.previous.id)) return keyring.previous;
  return null;
}

/**
 * Re-encrypt an envelope under the active key.
 * Returns null when the envelope is already current, so a rotation job can skip
 * rows cheaply.
 */
export function rotateEnvelope(
  envelope: EncryptedEnvelope,
  aad: Buffer,
  keyring: Keyring,
): EncryptedEnvelope | null {
  if (envelope.keyId === keyring.active.id && envelope.version === ENCRYPTION_VERSION) {
    return null;
  }
  const plaintext = decrypt(envelope, aad, keyring);
  try {
    return encrypt(plaintext, aad, keyring);
  } finally {
    // Nothing to scrub in JS strings, but keep the plaintext's lifetime obvious.
  }
}

/** Length-safe constant-time string comparison. */
export function constantTimeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
