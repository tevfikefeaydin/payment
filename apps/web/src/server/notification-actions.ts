"use server";

import { getKeyring } from "@payrecon/auth";
import { loadEnv } from "@payrecon/config/env";
import { checkLimit, describeLimit } from "@payrecon/platform-billing";
import { isValidCurrency, normalizeCurrency, parseDecimalToMinor } from "@payrecon/domain";
import {
  createDrizzleNotificationStore,
  createEmailDestination,
  createPolicy,
  createSlackDestination,
  createTransports,
  deleteDestination,
  deletePolicy,
  sendTestMessage,
  setPolicyEnabled,
} from "@payrecon/notifications";
import { actionError, actionSuccess, orgAction, type ActionState } from "./actions";
import { db } from "./db";

const createHandler = orgAction("notifications:manage", async (context, formData) => {
  const kind = formData.get("kind");
  const name = formData.get("name");
  if ((kind !== "email" && kind !== "slack") || typeof name !== "string") {
    return actionError("Choose a destination type and enter a name.");
  }

  const limit = await checkLimit(db(), {
    organizationId: context.org.organizationId,
    metric: "notificationDestinations",
    requested: 1,
  });
  if (!limit.allowed) return actionError(describeLimit(limit), "plan_limit");

  const store = createDrizzleNotificationStore(db());
  if (kind === "email") {
    const email = formData.get("email");
    if (typeof email !== "string") return actionError("Enter an email address.");
    await createEmailDestination(store, {
      organizationId: context.org.organizationId,
      name,
      email,
      createdByUserId: context.org.user.id,
    });
  } else {
    const webhookUrl = formData.get("webhookUrl");
    if (typeof webhookUrl !== "string") return actionError("Enter a Slack webhook URL.");
    await createSlackDestination(store, {
      organizationId: context.org.organizationId,
      name,
      webhookUrl,
      createdByUserId: context.org.user.id,
      keyring: getKeyring(),
    });
  }

  return actionSuccess("Destination created. Send a test message to activate it.");
});

export async function createNotificationDestinationAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return createHandler(previous, formData);
}

const testHandler = orgAction("notifications:test", async (context, formData) => {
  const destinationId = formData.get("destinationId");
  if (typeof destinationId !== "string" || destinationId.length === 0) {
    return actionError("Missing notification destination.");
  }

  const env = loadEnv();
  const result = await sendTestMessage(createDrizzleNotificationStore(db()), {
    organizationId: context.org.organizationId,
    destinationId,
    actorUserId: context.org.user.id,
    appUrl: env.APP_URL,
    keyring: getKeyring(),
    transports: createTransports({
      email: {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        secure: env.SMTP_SECURE,
        from: env.EMAIL_FROM,
      },
    }),
  });

  return result.ok
    ? actionSuccess("Test message sent. This destination is now active.")
    : actionError(result.error ?? "The test message could not be delivered.", "delivery_failed");
});

export async function testNotificationDestinationAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return testHandler(previous, formData);
}

const deleteHandler = orgAction("notifications:manage", async (context, formData) => {
  const destinationId = formData.get("destinationId");
  if (typeof destinationId !== "string" || destinationId.length === 0) {
    return actionError("Missing notification destination.");
  }

  const deleted = await deleteDestination(createDrizzleNotificationStore(db()), {
    organizationId: context.org.organizationId,
    destinationId,
    actorUserId: context.org.user.id,
  });
  if (!deleted) return actionError("That notification destination was not found.", "not_found");

  return actionSuccess("Notification destination deleted.");
});

export async function deleteNotificationDestinationAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return deleteHandler(previous, formData);
}

const createPolicyHandler = orgAction("notifications:manage", async (context, formData) => {
  const destinationId = formData.get("destinationId");
  const minSeverity = formData.get("minSeverity");
  const digest = formData.get("digest");
  if (
    typeof destinationId !== "string" ||
    destinationId.length === 0 ||
    typeof minSeverity !== "string" ||
    typeof digest !== "string"
  ) {
    return actionError("Choose a destination, a minimum severity and a cadence.");
  }

  const rawCurrency = formData.get("currency");
  let currency: string | null = null;
  if (typeof rawCurrency === "string" && rawCurrency.trim().length > 0) {
    if (!isValidCurrency(rawCurrency)) {
      return actionError("Enter a valid three-letter currency code, for example USD.");
    }
    currency = normalizeCurrency(rawCurrency);
  }

  const rawThreshold = formData.get("minRevenueAtRisk");
  let minRevenueAtRiskMinor: bigint | null = null;
  if (typeof rawThreshold === "string" && rawThreshold.trim().length > 0) {
    if (!currency) {
      return actionError("A revenue threshold needs a currency (for example USD).");
    }
    try {
      minRevenueAtRiskMinor = parseDecimalToMinor(rawThreshold.trim(), currency);
    } catch {
      return actionError(
        "Enter the revenue threshold as a plain amount, for example 250 or 99.50.",
      );
    }
  }

  await createPolicy(createDrizzleNotificationStore(db()), {
    organizationId: context.org.organizationId,
    destinationId,
    minSeverity,
    digest,
    minRevenueAtRiskMinor,
    currency,
    criticalBypassesDigest: formData.get("criticalBypassesDigest") === "on",
    actorUserId: context.org.user.id,
  });

  return actionSuccess("Notification policy created. Matching exceptions will now notify.");
});

export async function createNotificationPolicyAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return createPolicyHandler(previous, formData);
}

const togglePolicyHandler = orgAction("notifications:manage", async (context, formData) => {
  const policyId = formData.get("policyId");
  const enable = formData.get("enable");
  if (typeof policyId !== "string" || policyId.length === 0 || typeof enable !== "string") {
    return actionError("Missing notification policy.");
  }

  const updated = await setPolicyEnabled(createDrizzleNotificationStore(db()), {
    organizationId: context.org.organizationId,
    policyId,
    enabled: enable === "true",
    actorUserId: context.org.user.id,
  });
  if (!updated) return actionError("That notification policy was not found.", "not_found");

  return actionSuccess(updated.enabled ? "Policy enabled." : "Policy disabled.");
});

export async function toggleNotificationPolicyAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return togglePolicyHandler(previous, formData);
}

const deletePolicyHandler = orgAction("notifications:manage", async (context, formData) => {
  const policyId = formData.get("policyId");
  if (typeof policyId !== "string" || policyId.length === 0) {
    return actionError("Missing notification policy.");
  }

  const deleted = await deletePolicy(createDrizzleNotificationStore(db()), {
    organizationId: context.org.organizationId,
    policyId,
    actorUserId: context.org.user.id,
  });
  if (!deleted) return actionError("That notification policy was not found.", "not_found");

  return actionSuccess("Notification policy deleted.");
});

export async function deleteNotificationPolicyAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return deletePolicyHandler(previous, formData);
}
