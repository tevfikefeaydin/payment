"use server";

import { getKeyring } from "@payrecon/auth";
import { loadEnv } from "@payrecon/config/env";
import { checkLimit, describeLimit } from "@payrecon/platform-billing";
import {
  createDrizzleNotificationStore,
  createEmailDestination,
  createSlackDestination,
  createTransports,
  deleteDestination,
  sendTestMessage,
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
