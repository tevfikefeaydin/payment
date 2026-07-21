/**
 * The persistence port for API-key authentication, rate limiting and
 * idempotency.
 *
 * Every method that touches tenant data takes `organizationId` as a required
 * argument rather than as an optional filter, so an unscoped read or write is
 * not expressible through this API. The single exception is
 * `findApiKeyByPrefix`, which is inherently pre-tenant: the whole point of the
 * lookup is to DISCOVER which organization a presented key belongs to. The row
 * it returns carries its `organizationId`, and every operation afterwards is
 * scoped by it.
 *
 * The port exists so the verification, throttling and replay logic can be
 * exercised for real by unit tests with no database, while production uses the
 * Drizzle adapter in `store-drizzle.ts`. `memory-store.ts` is the test double
 * and reproduces the same uniqueness constraints the schema enforces.
 * This mirrors the arrangement already used by `@payrecon/notifications`.
 */

/** Audit actions this package is allowed to write. Subset of `AuditAction`. */
export type IngestionAuditAction = "api_key.created" | "api_key.revoked" | "records.upserted";

export interface IngestionAuditInput {
  organizationId: string;
  actor: { type: "user" | "api_key" | "system"; userId?: string | null; apiKeyId?: string | null };
  action: IngestionAuditAction;
  targetType?: string | undefined;
  targetId?: string | undefined;
  /** Redacted before it is written. Never put key material here. */
  metadata?: Record<string, unknown> | undefined;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export interface ApiKeyRow {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  /** SHA-256 hex of the full plaintext key. Never leaves the server. */
  keyHash: string;
  scopes: string[];
  createdByUserId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface NewApiKeyRow {
  organizationId: string;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  createdByUserId: string | null;
  expiresAt: Date | null;
}

/** An API key as it may safely be shown. Deliberately has no `keyHash`. */
export interface ApiKeySummary {
  id: string;
  organizationId: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdByUserId: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

export interface IdempotencyRow {
  id: string;
  organizationId: string;
  apiKeyId: string | null;
  idempotencyKey: string;
  requestHash: string;
  /** Null while the original request is still in flight. */
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date;
}

export interface ClaimIdempotencyInput {
  organizationId: string;
  apiKeyId: string | null;
  idempotencyKey: string;
  requestHash: string;
  expiresAt: Date;
}

export interface ClaimIdempotencyResult {
  /** True when THIS caller won the race and must execute the request. */
  claimed: boolean;
  /** The row now occupying `(organizationId, idempotencyKey)`. */
  row: IdempotencyRow;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export interface RateLimitBucketInput {
  organizationId: string;
  apiKeyId: string | null;
  /** Discriminator for the window; always contains the tenant and key. */
  bucketKey: string;
  windowStart: Date;
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface IngestionStore {
  // --- API keys ---
  insertApiKey(row: NewApiKeyRow): Promise<ApiKeyRow>;
  /**
   * Look up by the indexed, non-secret prefix. Pre-tenant by necessity: this is
   * how the organization is discovered. The secret is verified by the caller in
   * constant time against `keyHash`.
   */
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null>;
  touchApiKeyLastUsed(apiKeyId: string, at: Date): Promise<void>;
  /** Tenant-scoped. Returns false when the key does not belong to the org. */
  revokeApiKey(organizationId: string, apiKeyId: string, at: Date): Promise<boolean>;
  /** Never returns `keyHash`. */
  listApiKeys(organizationId: string): Promise<ApiKeySummary[]>;

  // --- idempotency ---
  claimIdempotencyRecord(input: ClaimIdempotencyInput): Promise<ClaimIdempotencyResult>;
  completeIdempotencyRecord(input: {
    organizationId: string;
    idempotencyKey: string;
    responseStatus: number;
    responseBody: unknown;
    completedAt: Date;
  }): Promise<void>;
  /** Used to release an unfinished claim so a retry is not blocked forever. */
  deleteIdempotencyRecord(organizationId: string, idempotencyKey: string): Promise<void>;

  // --- rate limiting ---
  /** Atomically increment the bucket and return the new count. */
  incrementRateLimitBucket(input: RateLimitBucketInput): Promise<number>;

  // --- audit ---
  recordAudit(input: IngestionAuditInput): Promise<void>;
}
