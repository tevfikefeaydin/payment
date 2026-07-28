import {
  WebhookPayloadError,
  WebhookSignatureError,
  createDrizzleBillingStore,
  isBillingConfigured,
  processEvent,
  verifyAndParse,
} from "@payrecon/platform-billing";
import { db } from "@/server/db";

/**
 * POST /api/billing/webhook — Stripe webhooks for PayRecon's OWN billing.
 *
 * CONTEXT: PLATFORM BILLING. Events here are signed by PayRecon's Stripe
 * account and describe PayRecon subscriptions; they have nothing to do with any
 * customer's connected Stripe data.
 *
 * Status codes are chosen for Stripe's retry behaviour, not for a human:
 *
 *   - 400 signature/payload failure — permanent; retrying can never succeed.
 *   - 200 for duplicate/stale/unmapped/unhandled — the event is decided;
 *     redelivery would change nothing, so Stripe must stop.
 *   - 500 only for a processing failure — the receipt row stays `failed`, and
 *     Stripe's redelivery will be reprocessed rather than dismissed.
 *
 * The raw body is captured BEFORE any parsing: the signature is an HMAC over
 * the literal bytes, and any re-serialisation invalidates it (see the warning
 * on verifyAndParse).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!isBillingConfigured()) {
    // Deployed without platform billing: nothing can be verified, and the
    // response must not reveal whether the endpoint would otherwise exist.
    return json(503, { error: "billing_not_configured" });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";

  let event;
  try {
    event = verifyAndParse(rawBody, signature);
  } catch (error) {
    if (error instanceof WebhookSignatureError || error instanceof WebhookPayloadError) {
      return json(400, { error: "invalid_webhook" });
    }
    throw error;
  }

  const result = await processEvent(createDrizzleBillingStore(db()), event);

  if (result.status === "failed") {
    // Message is already sanitized by the package; still, keep the body terse.
    return json(500, { status: result.status });
  }

  return json(200, { status: result.status });
}
