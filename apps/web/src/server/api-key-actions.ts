"use server";

import {
  API_KEY_SCOPES,
  createApiKey,
  createDrizzleIngestionStore,
  revokeApiKey,
} from "@payrecon/ingestion";
import { actionError, actionSuccess, orgAction, type ActionState } from "./actions";
import { db } from "./db";

/**
 * Organization API-key actions.
 *
 * The key itself is returned in the success message exactly once. It is never
 * written to an audit row, log entry, cookie, or database field.
 */

const createHandler = orgAction("apikeys:create", async (context, formData) => {
  const name = formData.get("name");
  if (typeof name !== "string") return actionError("Enter a name for this API key.");

  const rawExpiry = formData.get("expiresAt");
  let expiresAt: Date | null = null;
  if (typeof rawExpiry === "string" && rawExpiry.length > 0) {
    const parsed = new Date(`${rawExpiry}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return actionError("Enter a valid expiry date.");
    expiresAt = parsed;
  }

  const scopes = formData
    .getAll("scopes")
    .filter((scope): scope is string => typeof scope === "string")
    .filter((scope) => (API_KEY_SCOPES as readonly string[]).includes(scope));
  if (scopes.length === 0) return actionError("Choose at least one scope.");

  const created = await createApiKey(createDrizzleIngestionStore(db()), {
    organizationId: context.org.organizationId,
    name,
    createdByUserId: context.org.user.id,
    scopes,
    expiresAt,
  });

  return actionSuccess(`Copy this key now. It will never be shown again: ${created.plaintext}`);
});

export async function createApiKeyAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return createHandler(previous, formData);
}

const revokeHandler = orgAction("apikeys:revoke", async (context, formData) => {
  const apiKeyId = formData.get("apiKeyId");
  if (typeof apiKeyId !== "string" || apiKeyId.length === 0) {
    return actionError("Missing API key.");
  }

  const revoked = await revokeApiKey(createDrizzleIngestionStore(db()), {
    organizationId: context.org.organizationId,
    apiKeyId,
    actorUserId: context.org.user.id,
  });
  if (!revoked) return actionError("This API key is no longer active.", "not_found");

  return actionSuccess("API key revoked. Requests using it are now rejected.");
});

export async function revokeApiKeyAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return revokeHandler(previous, formData);
}
