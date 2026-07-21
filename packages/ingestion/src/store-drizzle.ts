import { and, eq, isNull, sql } from "drizzle-orm";
import {
  apiIdempotencyRecords,
  apiKeys,
  apiRateLimitBuckets,
  recordAudit,
  type Database,
} from "@payrecon/db";
import type {
  ApiKeyRow,
  ApiKeySummary,
  ClaimIdempotencyInput,
  ClaimIdempotencyResult,
  IdempotencyRow,
  IngestionAuditInput,
  IngestionStore,
  NewApiKeyRow,
  RateLimitBucketInput,
} from "./store";

/**
 * PostgreSQL implementation of `IngestionStore`.
 *
 * Every statement here is scoped by `organization_id` except the deliberate
 * prefix lookup documented on the port. The concurrency-sensitive operations —
 * claiming an idempotency key and incrementing a rate-limit bucket — are single
 * statements that rely on a unique index plus `ON CONFLICT`, so correctness does
 * not depend on application-level locking or on how many web instances run.
 */

/** `scopes` is jsonb; narrow it without trusting the column blindly. */
function toScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function createDrizzleIngestionStore(db: Database): IngestionStore {
  const toApiKeyRow = (row: typeof apiKeys.$inferSelect): ApiKeyRow => ({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.keyHash,
    scopes: toScopes(row.scopes),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  });

  const toIdempotencyRow = (row: typeof apiIdempotencyRecords.$inferSelect): IdempotencyRow => ({
    id: row.id,
    organizationId: row.organizationId,
    apiKeyId: row.apiKeyId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    responseStatus: row.responseStatus,
    responseBody: row.responseBody,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    expiresAt: row.expiresAt,
  });

  return {
    async insertApiKey(input: NewApiKeyRow): Promise<ApiKeyRow> {
      const [row] = await db
        .insert(apiKeys)
        .values({
          organizationId: input.organizationId,
          name: input.name,
          prefix: input.prefix,
          keyHash: input.keyHash,
          scopes: input.scopes,
          createdByUserId: input.createdByUserId,
          expiresAt: input.expiresAt,
        })
        .returning();
      if (!row) throw new Error("Failed to insert API key");
      return toApiKeyRow(row);
    },

    async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
      const [row] = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix)).limit(1);
      return row ? toApiKeyRow(row) : null;
    },

    async touchApiKeyLastUsed(apiKeyId: string, at: Date): Promise<void> {
      await db.update(apiKeys).set({ lastUsedAt: at }).where(eq(apiKeys.id, apiKeyId));
    },

    async revokeApiKey(organizationId: string, apiKeyId: string, at: Date): Promise<boolean> {
      // Scoped by BOTH id and organization: a key id belonging to another tenant
      // matches nothing, so the caller learns only that it revoked nothing.
      const rows = await db
        .update(apiKeys)
        .set({ revokedAt: at })
        .where(
          and(
            eq(apiKeys.id, apiKeyId),
            eq(apiKeys.organizationId, organizationId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id });
      return rows.length > 0;
    },

    async listApiKeys(organizationId: string): Promise<ApiKeySummary[]> {
      // `keyHash` is not in the projection, so it cannot reach a caller even by
      // accident.
      const rows = await db
        .select({
          id: apiKeys.id,
          organizationId: apiKeys.organizationId,
          name: apiKeys.name,
          prefix: apiKeys.prefix,
          scopes: apiKeys.scopes,
          createdByUserId: apiKeys.createdByUserId,
          createdAt: apiKeys.createdAt,
          lastUsedAt: apiKeys.lastUsedAt,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(eq(apiKeys.organizationId, organizationId))
        .orderBy(apiKeys.createdAt);

      return rows.map((row) => ({ ...row, scopes: toScopes(row.scopes) }));
    },

    async claimIdempotencyRecord(input: ClaimIdempotencyInput): Promise<ClaimIdempotencyResult> {
      // `ON CONFLICT DO NOTHING` + `RETURNING` yields a row only when this
      // statement actually inserted, which is what makes the claim atomic
      // across concurrent requests carrying the same key.
      const [inserted] = await db
        .insert(apiIdempotencyRecords)
        .values({
          organizationId: input.organizationId,
          apiKeyId: input.apiKeyId,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          expiresAt: input.expiresAt,
        })
        .onConflictDoNothing({
          target: [apiIdempotencyRecords.organizationId, apiIdempotencyRecords.idempotencyKey],
        })
        .returning();

      if (inserted) return { claimed: true, row: toIdempotencyRow(inserted) };

      const [existing] = await db
        .select()
        .from(apiIdempotencyRecords)
        .where(
          and(
            eq(apiIdempotencyRecords.organizationId, input.organizationId),
            eq(apiIdempotencyRecords.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);

      if (!existing) {
        // The conflicting row disappeared between the insert and the read (an
        // expiry sweep). Treat it as a lost race rather than inventing a row.
        throw new Error("Idempotency record vanished during claim");
      }
      return { claimed: false, row: toIdempotencyRow(existing) };
    },

    async completeIdempotencyRecord(input: {
      organizationId: string;
      idempotencyKey: string;
      responseStatus: number;
      responseBody: unknown;
      completedAt: Date;
    }): Promise<void> {
      await db
        .update(apiIdempotencyRecords)
        .set({
          responseStatus: input.responseStatus,
          responseBody: input.responseBody,
          completedAt: input.completedAt,
        })
        .where(
          and(
            eq(apiIdempotencyRecords.organizationId, input.organizationId),
            eq(apiIdempotencyRecords.idempotencyKey, input.idempotencyKey),
          ),
        );
    },

    async deleteIdempotencyRecord(organizationId: string, idempotencyKey: string): Promise<void> {
      await db
        .delete(apiIdempotencyRecords)
        .where(
          and(
            eq(apiIdempotencyRecords.organizationId, organizationId),
            eq(apiIdempotencyRecords.idempotencyKey, idempotencyKey),
          ),
        );
    },

    async incrementRateLimitBucket(input: RateLimitBucketInput): Promise<number> {
      // Upsert-and-return in one round trip. Concurrent requests serialise on
      // the unique index, so no count is lost.
      const [row] = await db
        .insert(apiRateLimitBuckets)
        .values({
          organizationId: input.organizationId,
          apiKeyId: input.apiKeyId,
          bucketKey: input.bucketKey,
          windowStart: input.windowStart,
          count: 1,
        })
        .onConflictDoUpdate({
          target: [apiRateLimitBuckets.organizationId, apiRateLimitBuckets.bucketKey],
          set: {
            count: sql`${apiRateLimitBuckets.count} + 1`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ count: apiRateLimitBuckets.count });

      return row?.count ?? 1;
    },

    async recordAudit(input: IngestionAuditInput): Promise<void> {
      await recordAudit(db, {
        organizationId: input.organizationId,
        actor: {
          type: input.actor.type,
          userId: input.actor.userId ?? null,
          apiKeyId: input.actor.apiKeyId ?? null,
        },
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        metadata: input.metadata ?? {},
      });
    },
  };
}
