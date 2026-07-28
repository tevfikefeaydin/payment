"use server";

import { isPlanKey } from "@payrecon/config";
import { loadEnv } from "@payrecon/config/env";
import {
  createCheckoutSession,
  createDrizzleBillingStore,
  createPortalSession,
  isBillingConfigured,
} from "@payrecon/platform-billing";
import { actionError, actionSuccess, orgAction, type ActionState } from "./actions";
import { db } from "./db";

function billingUrls(organizationId: string): {
  successUrl: string;
  cancelUrl: string;
  returnUrl: string;
} {
  const env = loadEnv();
  const path = `/orgs/${organizationId}/billing`;
  const returnUrl = new URL(path, env.APP_URL).toString();
  return {
    returnUrl,
    successUrl: new URL(`${path}?checkout=success`, env.APP_URL).toString(),
    cancelUrl: new URL(`${path}?checkout=canceled`, env.APP_URL).toString(),
  };
}

const checkoutHandler = orgAction("billing:manage", async (context, formData) => {
  const planKey = formData.get("planKey");
  if (typeof planKey !== "string" || !isPlanKey(planKey) || planKey === "free") {
    return actionError("Choose a paid plan.");
  }
  if (!isBillingConfigured()) {
    return actionError("Subscription checkout has not been configured for this deployment.");
  }

  const urls = billingUrls(context.org.organizationId);
  const session = await createCheckoutSession(createDrizzleBillingStore(db()), {
    organizationId: context.org.organizationId,
    planKey,
    successUrl: urls.successUrl,
    cancelUrl: urls.cancelUrl,
    actorUserId: context.org.user.id,
  });
  return actionSuccess(undefined, session.url);
});

export async function startCheckoutAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return checkoutHandler(previous, formData);
}

const portalHandler = orgAction("billing:manage", async (context) => {
  if (!isBillingConfigured()) {
    return actionError("Subscription management has not been configured for this deployment.");
  }

  const portal = await createPortalSession(createDrizzleBillingStore(db()), {
    organizationId: context.org.organizationId,
    returnUrl: billingUrls(context.org.organizationId).returnUrl,
    actorUserId: context.org.user.id,
  });
  return actionSuccess(undefined, portal.url);
});

export async function openBillingPortalAction(
  previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return portalHandler(previous, formData);
}
