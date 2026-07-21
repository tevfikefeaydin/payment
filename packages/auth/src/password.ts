import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt (RFC 7914).
 *
 * scrypt is memory-hard and ships in Node's standard library, so there is no
 * native build step and no third-party dependency in the authentication path.
 * Parameters are stored INSIDE the hash string, so they can be raised later and
 * existing hashes stay verifiable; `needsRehash` reports when an old hash should
 * be upgraded on next successful sign-in.
 *
 * Format: scrypt$N$r$p$<salt-base64>$<hash-base64>
 */

/** ~64 MiB of memory per hash: deliberately expensive to attack in bulk. */
const DEFAULT_N = 2 ** 16;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

/** Node's default maxmem (32 MiB) is too low for N=2^16; raise it explicitly. */
const MAXMEM = 256 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export class PasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasswordError";
  }
}

/**
 * Validate password strength.
 *
 * Length is the dominant factor in resisting offline attack, so the policy is a
 * generous minimum length rather than composition rules that push users toward
 * predictable substitutions.
 */
export function validatePasswordStrength(password: string): { ok: boolean; message?: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, message: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  if (/^\s+$/.test(password)) {
    return { ok: false, message: "Password must not be only whitespace." };
  }
  return { ok: true };
}

export async function hashPassword(password: string): Promise<string> {
  const strength = validatePasswordStrength(password);
  if (!strength.ok) throw new PasswordError(strength.message ?? "Password is not acceptable.");

  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: MAXMEM,
  });

  return [
    "scrypt",
    DEFAULT_N,
    DEFAULT_R,
    DEFAULT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6) return null;
  const [scheme, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  if (scheme !== "scrypt") return null;

  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  // Refuse absurd parameters that could be used to force a denial of service.
  if (N < 2 ** 12 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;

  try {
    return {
      N,
      r,
      p,
      salt: Buffer.from(saltRaw ?? "", "base64"),
      hash: Buffer.from(hashRaw ?? "", "base64"),
    };
  } catch {
    return null;
  }
}

/**
 * Verify a password against a stored hash.
 *
 * Always performs the full derivation and a constant-time comparison. Returns
 * false rather than throwing for a malformed stored hash, so a corrupt row
 * cannot be distinguished from a wrong password by timing or by error type.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;

  try {
    const derived = await scrypt(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAXMEM,
    });
    if (derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

/** True when a stored hash uses weaker parameters than the current policy. */
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return parsed.N < DEFAULT_N || parsed.r < DEFAULT_R || parsed.p < DEFAULT_P;
}
