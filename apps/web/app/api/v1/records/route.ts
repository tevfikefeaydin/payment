import {
  bulkUpsertSchema,
  normalizeRecordInput,
  toFieldErrors,
  MAX_BULK_RECORDS,
} from "@payrecon/domain";
import {
  USAGE_METRIC_INGESTED_RECORDS,
  checkMonthlyIngestionLimit,
  requireIdempotencyKey,
  withIdempotency,
  type IdempotentExecution,
} from "@payrecon/ingestion";
import {
  getOrganization,
  getUsage,
  incrementUsage,
  upsertInternalRecords,
  type UpsertOutcome,
} from "@payrecon/db";
import { db } from "@/server/db";
import {
  authenticate,
  headersFromError,
  parseJsonBody,
  readBoundedText,
} from "../_lib/authenticate";
import {
  errorBody,
  errorResponse,
  handleUnexpected,
  jsonResponse,
  type ApiErrorBody,
} from "../_lib/http";

/**
 * Every branch of the handler produces one of these, and all of them are stored
 * under the idempotency key. Annotating the union explicitly stops inference
 * from locking onto whichever branch appears first.
 */
type UpsertResponseBody = UpsertOutcome | ApiErrorBody;

/**
 * POST /api/v1/records — idempotent bulk upsert of internal payment records.
 *
 * The checks run in a fixed order, cheapest and most protective first:
 *
 *   1. body size          — bounds the read before anything else happens
 *   2. API key            — establishes the tenant; nothing is scoped until now
 *   3. rate limit         — per organization AND key
 *   4. idempotency        — claims the key BEFORE any write, so a retry that
 *                           arrives mid-flight cannot duplicate the batch
 *   5. schema validation  — structured 422 with field-level detail
 *   6. plan limit         — the whole batch, never a partial application
 *   7. upsert + usage + audit
 *
 * Steps 5-7 run INSIDE the idempotency claim, so a 422 or a plan-limit refusal
 * is cached too: replaying the identical request returns the identical answer
 * rather than re-doing the work.
 */

// This route reads request headers and a body, and must never be prerendered
// or cached.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "POST /api/v1/records";

export async function POST(request: Request): Promise<Response> {
  let organizationId: string | null = null;
  let apiKeyId: string | null = null;

  try {
    // 1 — body size, before authentication, because it is the only bound on
    //     how much an anonymous caller can make this process read.
    const rawBody = await readBoundedText(request);

    // 2, 3 — key verification then rate limiting.
    const { store, context, headers } = await authenticate(request);
    organizationId = context.organizationId;
    apiKeyId = context.apiKeyId;

    const idempotencyKey = requireIdempotencyKey(request.headers.get("idempotency-key"));
    const body = parseJsonBody(rawBody);

    // 4 — claim the key, then do the work exactly once.
    const result = await withIdempotency(
      store,
      {
        organizationId: context.organizationId,
        apiKeyId: context.apiKeyId,
        idempotencyKey,
        method: "POST",
        path: "/api/v1/records",
        body,
      },
      async (): Promise<IdempotentExecution<UpsertResponseBody>> => {
        // 5 — validation.
        const parsed = bulkUpsertSchema.safeParse(body);
        if (!parsed.success) {
          return {
            httpStatus: 422,
            body: errorBody(
              "validation_failed",
              `The request contains invalid records. At most ${MAX_BULK_RECORDS} records are accepted per request.`,
              toFieldErrors(parsed.error),
            ),
          };
        }

        const records = parsed.data.records.map(normalizeRecordInput);

        // 6 — plan limit on monthly ingested records.
        const organization = await getOrganization(db(), context.organizationId);
        if (organization === null) {
          return {
            httpStatus: 404,
            body: errorBody("not_found", "The organization for this API key no longer exists."),
          };
        }

        const used = await getUsage(db(), {
          organizationId: context.organizationId,
          metric: USAGE_METRIC_INGESTED_RECORDS,
        });
        const planLimit = checkMonthlyIngestionLimit({
          planKey: organization.planKey,
          used,
          requested: records.length,
        });

        if (!planLimit.allowed) {
          return {
            httpStatus: 402,
            body: errorBody(
              "plan_limit_exceeded",
              `This organization has ingested ${planLimit.used} of ${planLimit.limit} records permitted this month by the ${organization.planKey} plan. Upgrade the plan or wait for the next billing month. Existing data and exports are unaffected.`,
            ),
          };
        }

        // 7 — write, count, audit.
        const outcome = await upsertInternalRecords(db(), {
          organizationId: context.organizationId,
          source: "api",
          records,
        });

        await incrementUsage(db(), {
          organizationId: context.organizationId,
          metric: USAGE_METRIC_INGESTED_RECORDS,
          amount: outcome.total,
        });

        await store.recordAudit({
          organizationId: context.organizationId,
          actor: { type: "api_key", apiKeyId: context.apiKeyId },
          action: "records.upserted",
          targetType: "internal_payment_records",
          // Counts only. Record contents never enter the audit trail.
          metadata: {
            source: "api",
            inserted: outcome.inserted,
            updated: outcome.updated,
            total: outcome.total,
          },
        });

        return { httpStatus: 200, body: outcome };
      },
    );

    return jsonResponse(result.body, result.httpStatus, {
      ...headers,
      // Lets a client tell a fresh execution from a replay of an earlier one.
      "Idempotency-Replayed": result.outcome === "replayed" ? "true" : "false",
    });
  } catch (error) {
    return handleUnexpected(ROUTE, error, { organizationId, apiKeyId }, headersFromError(error));
  }
}

/** Anything other than POST is refused explicitly rather than 404-ing. */
export async function GET(): Promise<Response> {
  return errorResponse(
    "method_not_allowed",
    "Use POST to upsert records, or GET /api/v1/records/{externalId} to read one.",
    { headers: { Allow: "POST" } },
  );
}
