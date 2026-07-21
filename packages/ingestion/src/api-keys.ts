import { apiKeyPrefix, generateApiKey, hashToken, tokenHashEquals } from "@payrecon/auth";
import { IngestionError } from "./errors";
import type { ApiKeySummary, IngestionStore } from "./store";

/**
 * Organization API keys.
 *
 * The plaintext key exists in memory exactly once, inside `createApiKey`, and is
 * returned to the caller from there. Only a short non-secret prefix and a
 * SHA-256 hash are persisted, so a database disclosure yields nothing directly
 * usable. Verification finds the row by the indexed prefix and then compares
 * hashes in constant time.
 */

export const API_KEY_SCOPES = ["records:read", "records:write"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const DEFAULT_API_KEY_SCOPES: ApiKeyScope[] = ["records:write"];

/**
 * How stale `lastUsedAt` is allowed to become.
 *
 * Without this, every authenticated request would issue a write, turning a
 * read-mostly auth path into a write-heavy one and creating row contention on
 * the hottest key in the system. A minute of staleness is irrelevant for the
 * "when was this key last used" question the column exists to answer.
 */
export const LAST_USED_THROTTLE_MS = 60_000;

const MAX_KEY_NAME_LENGTH = 100;

export interface CreateApiKeyInput {
  organizationId: string;
  name: string;
  createdByUserId: string | null;
  /** Optional expiry. A key with no expiry stays valid until revoked. */
  expiresAt?: Date | null;
  scopes?: readonly string[];
  /** Chooses the `prk_live_`/`prk_test_` prefix. Cosmetic; not a permission. */
  livemode?: boolean;
}

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  /**
   * The full key, in plaintext.
   *
   * Returned exactly once, from this call. It is not stored and cannot be
   * recovered — a lost key must be revoked and replaced. Never log this value.
   */
  plaintext: string;
}

/** The authenticated context a verified key establishes. */
export interface ApiKeyContext {
  organizationId: string;
  apiKeyId: string;
  scopes: string[];
}

function validateScopes(scopes: readonly string[]): ApiKeyScope[] {
  const invalid = scopes.filter((scope) => !(API_KEY_SCOPES as readonly string[]).includes(scope));
  if (invalid.length > 0) {
    throw new IngestionError(
      "validation_failed",
      `Unknown scope(s): ${invalid.join(", ")}. Valid scopes are ${API_KEY_SCOPES.join(", ")}.`,
    );
  }
  return [...new Set(scopes)] as ApiKeyScope[];
}

export async function createApiKey(
  store: IngestionStore,
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> {
  const name = input.name.trim();
  if (name.length === 0 || name.length > MAX_KEY_NAME_LENGTH) {
    throw new IngestionError(
      "validation_failed",
      `API key name must be between 1 and ${MAX_KEY_NAME_LENGTH} characters.`,
    );
  }

  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
    throw new IngestionError("validation_failed", "The expiry date must be in the future.");
  }

  const scopes = validateScopes(input.scopes ?? DEFAULT_API_KEY_SCOPES);
  const generated = generateApiKey(input.livemode ?? false);

  const row = await store.insertApiKey({
    organizationId: input.organizationId,
    name,
    prefix: generated.prefix,
    keyHash: generated.hash,
    scopes,
    createdByUserId: input.createdByUserId,
    expiresAt,
  });

  // The prefix is safe in an audit trail; the plaintext and hash are not, and
  // are deliberately absent here.
  await store.recordAudit({
    organizationId: input.organizationId,
    actor: { type: "user", userId: input.createdByUserId },
    action: "api_key.created",
    targetType: "api_key",
    targetId: row.id,
    metadata: {
      prefix: row.prefix,
      name: row.name,
      scopes,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });

  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    plaintext: generated.plaintext,
  };
}

/**
 * Verify a presented key and resolve its tenant.
 *
 * Returns null for every failure — malformed, unknown, wrong secret, revoked or
 * expired — so a caller cannot distinguish "no such key" from "revoked key" and
 * probe an organization's key state.
 */
export async function verifyApiKey(
  store: IngestionStore,
  presentedKey: string,
  now: Date = new Date(),
): Promise<ApiKeyContext | null> {
  const prefix = apiKeyPrefix(presentedKey);
  if (prefix === null) return null;

  const row = await store.findApiKeyByPrefix(prefix);
  if (row === null) return null;

  // Constant-time: a byte-by-byte early exit would let an attacker who can
  // observe timing recover the hash one character at a time.
  const presentedHash = hashToken(presentedKey);
  if (!tokenHashEquals(presentedHash, row.keyHash)) return null;

  // State checks come AFTER the secret is proven, so an attacker holding only a
  // prefix learns nothing about whether that key is live.
  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) return null;

  if (
    row.lastUsedAt === null ||
    now.getTime() - row.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS
  ) {
    await store.touchApiKeyLastUsed(row.id, now);
  }

  return { organizationId: row.organizationId, apiKeyId: row.id, scopes: row.scopes };
}

export function hasScope(context: ApiKeyContext, scope: ApiKeyScope): boolean {
  return context.scopes.includes(scope);
}

export async function revokeApiKey(
  store: IngestionStore,
  params: { organizationId: string; apiKeyId: string; actorUserId?: string | null; now?: Date },
): Promise<boolean> {
  const revoked = await store.revokeApiKey(
    params.organizationId,
    params.apiKeyId,
    params.now ?? new Date(),
  );
  if (!revoked) return false;

  await store.recordAudit({
    organizationId: params.organizationId,
    actor: { type: "user", userId: params.actorUserId ?? null },
    action: "api_key.revoked",
    targetType: "api_key",
    targetId: params.apiKeyId,
  });
  return true;
}

export type ApiKeyStatus = "active" | "revoked" | "expired";

export interface ApiKeyListItem extends ApiKeySummary {
  status: ApiKeyStatus;
}

/** List an organization's keys. The result never contains a hash or plaintext. */
export async function listApiKeys(
  store: IngestionStore,
  organizationId: string,
  now: Date = new Date(),
): Promise<ApiKeyListItem[]> {
  const rows = await store.listApiKeys(organizationId);
  return rows.map((row) => ({
    ...row,
    status:
      row.revokedAt !== null
        ? "revoked"
        : row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()
          ? "expired"
          : "active",
  }));
}
