import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Opaque token generation and verification.
 *
 * Covers session tokens, invitation tokens, password-reset tokens and API keys.
 * The rules are the same for all of them:
 *
 *   - generated from a CSPRNG with at least 256 bits of entropy,
 *   - stored ONLY as a SHA-256 hash, so a database disclosure yields nothing
 *     directly usable,
 *   - compared in constant time,
 *   - shown to the user exactly once.
 *
 * SHA-256 (rather than scrypt) is correct here because these tokens are already
 * high-entropy random values: there is no low-entropy secret to slow down
 * guessing for, and lookups must stay cheap.
 */

const TOKEN_BYTES = 32; // 256 bits

/** Base64url without padding: URL- and cookie-safe. */
function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function generateToken(): string {
  return toBase64Url(randomBytes(TOKEN_BYTES));
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function tokenHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

/**
 * An API key is `prefix.secret`:
 *   - `prefix` is stored in clear and identifies the key in the UI and logs,
 *   - `secret` is the high-entropy part and is never stored.
 *
 * Splitting them means a lookup can find the row by prefix (indexed) and then
 * verify the secret in constant time, without a table scan over hashes.
 */
export interface GeneratedApiKey {
  /** Full key, shown to the user exactly once. */
  plaintext: string;
  /** Non-secret identifier, safe to display and log. */
  prefix: string;
  /** SHA-256 of the full plaintext key. */
  hash: string;
}

export function generateApiKey(livemode = false): GeneratedApiKey {
  const environment = livemode ? "live" : "test";
  // 8 random chars are enough to make the prefix unique without being guessable
  // on its own; the prefix is not a secret.
  const prefixSuffix = toBase64Url(randomBytes(6)).slice(0, 8);
  const prefix = `prk_${environment}_${prefixSuffix}`;
  const secret = generateToken();
  const plaintext = `${prefix}.${secret}`;
  return { plaintext, prefix, hash: hashToken(plaintext) };
}

/** Extract the non-secret prefix from a presented key, for the indexed lookup. */
export function apiKeyPrefix(presented: string): string | null {
  const separator = presented.indexOf(".");
  if (separator <= 0) return null;
  const prefix = presented.slice(0, separator);
  if (!/^prk_(test|live)_[A-Za-z0-9_-]{4,16}$/.test(prefix)) return null;
  return prefix;
}

// ---------------------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------------------

/**
 * Double-submit CSRF token bound to the session.
 *
 * The cookie value is an HMAC over the session id keyed by AUTH_SECRET, so a
 * token issued for one session is invalid for another, and an attacker who
 * cannot read the session cookie cannot forge a matching token.
 */
export function deriveCsrfToken(sessionId: string, secret: string): string {
  return createHmac("sha256", secret).update(`csrf:${sessionId}`, "utf8").digest("base64url");
}

export function verifyCsrfToken(presented: string, sessionId: string, secret: string): boolean {
  const expected = deriveCsrfToken(sessionId, secret);
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented, "utf8"), Buffer.from(expected, "utf8"));
}

// ---------------------------------------------------------------------------
// Client fingerprints
// ---------------------------------------------------------------------------

/**
 * Hash a client IP before storing it.
 *
 * Sessions and audit rows record where a request came from, but the raw address
 * is personal data that reconciliation does not need. Keying the hash with
 * AUTH_SECRET prevents trivial rainbow-table reversal of the IPv4 space.
 */
export function hashIp(ip: string | null | undefined, secret: string): string | null {
  if (!ip) return null;
  return createHmac("sha256", secret).update(`ip:${ip}`, "utf8").digest("hex").slice(0, 32);
}
