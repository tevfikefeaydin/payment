import { serializeAmountMinor } from "@payrecon/domain";
import { hasScope } from "@payrecon/ingestion";
import { getInternalRecordByExternalId } from "@payrecon/db";
import { db } from "@/server/db";
import { authenticate, headersFromError } from "../../_lib/authenticate";
import { errorResponse, handleUnexpected, jsonResponse } from "../../_lib/http";

/**
 * GET /api/v1/records/{externalId} — read one internal payment record.
 *
 * The organization is derived from the API key and passed to the repository as
 * a required argument, so an externalId belonging to another tenant is
 * indistinguishable from one that does not exist: both are a plain 404, with no
 * timing or message difference to probe.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTE = "GET /api/v1/records/[externalId]";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ externalId: string }> },
): Promise<Response> {
  let organizationId: string | null = null;
  let apiKeyId: string | null = null;

  try {
    const { context, headers } = await authenticate(request);
    organizationId = context.organizationId;
    apiKeyId = context.apiKeyId;

    if (!hasScope(context, "records:read") && !hasScope(context, "records:write")) {
      return errorResponse(
        "insufficient_scope",
        "This API key does not carry the records:read scope.",
        { headers },
      );
    }

    const { externalId } = await params;
    const decoded = decodeURIComponent(externalId).trim();

    if (decoded.length === 0) {
      return errorResponse("not_found", "No record matches that externalId.", { headers });
    }

    const record = await getInternalRecordByExternalId(db(), {
      organizationId: context.organizationId,
      externalId: decoded,
    });

    if (record === null) {
      return errorResponse("not_found", "No record matches that externalId.", { headers });
    }

    return jsonResponse(
      {
        externalId: record.externalId,
        customerId: record.customerId,
        orderId: record.orderId,
        subscriptionId: record.subscriptionId,
        providerTransactionId: record.providerTransactionId,
        // A decimal STRING, never a JSON number: above 2^53 a number would
        // silently lose cents.
        amountMinor: serializeAmountMinor(record.amountMinor),
        currency: record.currency,
        status: record.status,
        occurredAt: record.occurredAt.toISOString(),
        updatedAt: record.recordUpdatedAt?.toISOString() ?? null,
        metadata: record.metadata ?? {},
        source: record.source,
        createdAt: record.createdAt.toISOString(),
        // The internal row id is deliberately absent: `externalId` is the
        // caller's own key and the only identifier the API contract exposes.
      },
      200,
      headers,
    );
  } catch (error) {
    return handleUnexpected(ROUTE, error, { organizationId, apiKeyId }, headersFromError(error));
  }
}
