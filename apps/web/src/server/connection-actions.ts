"use server";

import { getKeyring } from "@payrecon/auth";
import { loadEnv } from "@payrecon/config/env";
import {
  createConnection,
  createDrizzleStore,
  createTransportFactory,
  deleteConnection,
  disableConnection,
  enableConnection,
  revalidateConnection,
} from "@payrecon/stripe-customer-data";
import { enqueueStripeSync, getQueue } from "@payrecon/jobs";
import { actionError, actionSuccess, orgAction, type ActionState } from "./actions";
import { db } from "./db";

async function queueSync(
  organizationId: string,
  connectionId: string,
  correlationId: string,
  isInitial: boolean,
) {
  const queue = await getQueue({ connectionString: loadEnv().DATABASE_URL, max: 2 });
  await enqueueStripeSync(queue, { organizationId, connectionId, correlationId, isInitial });
}

const createHandler = orgAction("connections:create", async (context, formData) => {
  const name = formData.get("name");
  const restrictedKey = formData.get("restrictedKey");
  if (typeof name !== "string" || name.trim().length === 0)
    return actionError("Enter a connection name.");
  if (typeof restrictedKey !== "string" || restrictedKey.length === 0)
    return actionError("Enter a Stripe restricted key.");

  const result = await createConnection(createDrizzleStore(db()), {
    organizationId: context.org.organizationId,
    name: name.trim().slice(0, 100),
    plaintextKey: restrictedKey,
    createdByUserId: context.org.user.id,
    keyring: getKeyring(),
    transportFactory: createTransportFactory(),
    actor: { type: "user", userId: context.org.user.id },
  });
  if (!result.validation.ok)
    return actionError(result.validation.message ?? "The connection could not be validated.");

  await queueSync(context.org.organizationId, result.connection.id, context.correlationId, true);
  return actionSuccess("Stripe connection validated. Its initial read-only sync has been queued.");
});

export async function createConnectionAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return createHandler(previous, formData);
}

const revalidateHandler = orgAction("connections:update", async (context, formData) => {
  const connectionId = formData.get("connectionId");
  if (typeof connectionId !== "string" || connectionId.length === 0)
    return actionError("Missing connection.");
  const result = await revalidateConnection(createDrizzleStore(db()), {
    organizationId: context.org.organizationId,
    connectionId,
    keyring: getKeyring(),
    transportFactory: createTransportFactory(),
    actor: { type: "user", userId: context.org.user.id },
  });
  if (!result.validation.ok)
    return actionError(result.validation.message ?? "The connection could not be validated.");
  await queueSync(context.org.organizationId, connectionId, context.correlationId, false);
  return actionSuccess("Connection validated and sync queued.");
});

export async function revalidateConnectionAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return revalidateHandler(previous, formData);
}

const disableHandler = orgAction("connections:update", async (context, formData) => {
  const connectionId = formData.get("connectionId");
  if (typeof connectionId !== "string" || connectionId.length === 0)
    return actionError("Missing connection.");
  await disableConnection(createDrizzleStore(db()), {
    organizationId: context.org.organizationId,
    connectionId,
    actor: { type: "user", userId: context.org.user.id },
  });
  return actionSuccess("Connection disabled. No further syncs will run.");
});

export async function disableConnectionAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return disableHandler(previous, formData);
}

const enableHandler = orgAction("connections:update", async (context, formData) => {
  const connectionId = formData.get("connectionId");
  if (typeof connectionId !== "string" || connectionId.length === 0)
    return actionError("Missing connection.");
  await enableConnection(createDrizzleStore(db()), {
    organizationId: context.org.organizationId,
    connectionId,
    actor: { type: "user", userId: context.org.user.id },
  });
  return actionSuccess("Connection enabled. Validate it before requesting a new sync.");
});

export async function enableConnectionAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return enableHandler(previous, formData);
}

const deleteHandler = orgAction("connections:delete", async (context, formData) => {
  const connectionId = formData.get("connectionId");
  if (typeof connectionId !== "string" || connectionId.length === 0)
    return actionError("Missing connection.");
  await deleteConnection(createDrizzleStore(db()), {
    organizationId: context.org.organizationId,
    connectionId,
    actor: { type: "user", userId: context.org.user.id },
  });
  return actionSuccess(
    "Connection revoked and deleted. Previously synced evidence remains available.",
  );
});

export async function deleteConnectionAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return deleteHandler(previous, formData);
}
