import { loadEnv } from "@payrecon/config/env";
import { parseMasterKey, type Keyring } from "./crypto";

/**
 * Build the encryption keyring from validated environment configuration.
 *
 * Cached per process: parsing is cheap, but re-reading key material on every
 * call would widen the window in which it appears on the heap.
 */
let cached: Keyring | null = null;

export function getKeyring(): Keyring {
  if (cached) return cached;

  const env = loadEnv();
  const active = parseMasterKey(env.ENCRYPTION_KEY_ID, env.ENCRYPTION_KEY);

  const keyring: Keyring =
    env.ENCRYPTION_KEY_PREVIOUS && env.ENCRYPTION_KEY_PREVIOUS_ID
      ? {
          active,
          previous: parseMasterKey(env.ENCRYPTION_KEY_PREVIOUS_ID, env.ENCRYPTION_KEY_PREVIOUS),
        }
      : { active };

  cached = keyring;
  return keyring;
}

/** Reset the cache. Tests only. */
export function resetKeyringCache(): void {
  cached = null;
}
