/**
 * Lifecycle of a customer's READ-ONLY Stripe connection.
 *
 * READ-ONLY CONTEXT: validation retrieves the account and probes each resource
 * with a one-item list. No operation in this file writes to Stripe.
 *
 * The ordering in `createConnection` is deliberate and load-bearing: validate
 * the key format, then persist the ciphertext, then talk to Stripe. A key that
 * fails admission control never reaches the database or the network, and a key
 * that fails validation ends up REVOKED rather than merely flagged — a
 * connection that never proved itself must not be usable by a scheduled sync.
 */
import { PublicError } from "@payrecon/domain";
import type { AuditActor } from "@payrecon/db";
import { classifyStripeError, describeCategory, type StripeErrorCategory } from "./errors";
import { assertRestrictedKey } from "./key-validation";
import {
  loadCredential,
  revokeCredential,
  storeCredential,
  type RestrictedKey,
} from "./credentials";
import { resolveStore, type ConnectionRecord, type StripeDataStoreLike } from "./store";
import {
  SYNC_RESOURCE_ORDER,
  listResource,
  type StripeReadTransport,
  type SyncResource,
} from "./transport";
import type { Keyring } from "@payrecon/auth/crypto";

/**
 * Builds a read-only client for one connection.
 *
 * The key is passed as a `RestrictedKey` so the factory cannot accidentally log
 * it: reaching the plaintext requires an explicit `.reveal()`.
 */
export type StripeTransportFactory = (context: {
  restrictedKey: RestrictedKey;
  livemode: boolean;
}) => StripeReadTransport | Promise<StripeReadTransport>;

export interface ConnectionValidation {
  ok: boolean;
  category: StripeErrorCategory | null;
  /** Sanitised and safe to render. Never contains key material. */
  message: string | null;
}

export interface ConnectionResult {
  connection: ConnectionRecord;
  validation: ConnectionValidation;
}

export interface CreateConnectionInput {
  organizationId: string;
  name: string;
  plaintextKey: string;
  createdByUserId: string | null;
  keyring: Keyring;
  transportFactory: StripeTransportFactory;
  now?: Date;
  actor?: AuditActor;
}

export async function createConnection(
  db: StripeDataStoreLike,
  input: CreateConnectionInput,
): Promise<ConnectionResult> {
  const store = resolveStore(db);
  const now = input.now ?? new Date();
  const actor = input.actor ?? { type: "system" };

  // Throws a user-safe PublicError. Nothing is persisted for a rejected key.
  const { livemode } = assertRestrictedKey(input.plaintextKey);

  const connection = await store.insertConnection({
    organizationId: input.organizationId,
    name: input.name,
    livemode,
    status: "pending_validation",
    createdByUserId: input.createdByUserId,
    now,
  });

  await storeCredential(store, {
    organizationId: input.organizationId,
    connectionId: connection.id,
    plaintextKey: input.plaintextKey,
    keyring: input.keyring,
    now,
  });

  await store.recordAuditEvent({
    organizationId: input.organizationId,
    actor,
    action: "connection.created",
    targetType: "stripe_connection",
    targetId: connection.id,
    metadata: { name: input.name, livemode },
  });

  return validateConnection(db, {
    organizationId: input.organizationId,
    connectionId: connection.id,
    keyring: input.keyring,
    transportFactory: input.transportFactory,
    now,
    actor,
  });
}

export interface RevalidateConnectionInput {
  organizationId: string;
  connectionId: string;
  keyring: Keyring;
  transportFactory: StripeTransportFactory;
  now?: Date;
  actor?: AuditActor;
}

/** Re-run validation against Stripe, e.g. after a key rotation. */
export async function revalidateConnection(
  db: StripeDataStoreLike,
  input: RevalidateConnectionInput,
): Promise<ConnectionResult> {
  return validateConnection(db, input);
}

async function validateConnection(
  db: StripeDataStoreLike,
  input: RevalidateConnectionInput,
): Promise<ConnectionResult> {
  const store = resolveStore(db);
  const now = input.now ?? new Date();
  const actor = input.actor ?? { type: "system" };

  const existing = await requireConnection(store, input.organizationId, input.connectionId);

  try {
    const restrictedKey = await loadCredential(store, {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      keyring: input.keyring,
    });
    if (!restrictedKey) {
      throw new PublicError(
        "stripe_credential_missing",
        "This connection has no usable restricted key. Add one to continue.",
        409,
      );
    }

    const transport = await input.transportFactory({
      restrictedKey,
      livemode: restrictedKey.livemode,
    });
    const account = await transport.retrieveAccount();

    const connection = await store.updateConnection(input.organizationId, input.connectionId, {
      stripeAccountId: account.id,
      accountDisplayName: account.displayName,
      livemode: account.livemode,
      status: "active",
      lastValidatedAt: now,
      lastValidationError: null,
      updatedAt: now,
    });

    await store.recordAuditEvent({
      organizationId: input.organizationId,
      actor,
      action: "connection.validated",
      targetType: "stripe_connection",
      targetId: input.connectionId,
      metadata: { stripeAccountId: account.id, livemode: account.livemode },
    });

    return {
      connection: connection ?? existing,
      validation: { ok: true, category: null, message: null },
    };
  } catch (caught) {
    const { category, message } = describeValidationFailure(caught);

    // A credential that could not be validated is revoked, not kept: leaving it
    // active would let a scheduled sync keep hammering Stripe with a key that
    // has already been shown not to work.
    await revokeCredential(store, {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      now,
    });

    const connection = await store.updateConnection(input.organizationId, input.connectionId, {
      status: "pending_validation",
      lastValidationError: message,
      updatedAt: now,
    });

    await store.recordAuditEvent({
      organizationId: input.organizationId,
      actor,
      action: "connection.validation_failed",
      targetType: "stripe_connection",
      targetId: input.connectionId,
      metadata: { category },
    });

    return {
      connection: connection ?? existing,
      validation: { ok: false, category, message },
    };
  }
}

/**
 * Turn any validation failure into a category plus a message safe to store in
 * `last_validation_error` and render on a settings page.
 */
function describeValidationFailure(caught: unknown): {
  category: StripeErrorCategory;
  message: string;
} {
  if (caught instanceof PublicError) {
    // Already written for an end user; PublicError messages carry no internals.
    return { category: "permanent", message: caught.message };
  }
  const error = classifyStripeError(caught);
  return { category: error.category, message: describeCategory(error.category) };
}

export interface ConnectionMutationInput {
  organizationId: string;
  connectionId: string;
  now?: Date;
  actor?: AuditActor;
}

/**
 * Stop future syncs without destroying anything.
 *
 * The credential is intentionally left intact so the connection can be re-enabled
 * without the operator having to produce the key again; `status` is what the
 * scheduler checks.
 */
export async function disableConnection(
  db: StripeDataStoreLike,
  input: ConnectionMutationInput,
): Promise<ConnectionRecord> {
  const store = resolveStore(db);
  const now = input.now ?? new Date();
  await requireConnection(store, input.organizationId, input.connectionId);

  const connection = await store.updateConnection(input.organizationId, input.connectionId, {
    status: "disabled",
    disabledAt: now,
    updatedAt: now,
  });
  if (!connection) throw connectionNotFound();

  await store.recordAuditEvent({
    organizationId: input.organizationId,
    actor: input.actor ?? { type: "system" },
    action: "connection.disabled",
    targetType: "stripe_connection",
    targetId: input.connectionId,
  });
  return connection;
}

/**
 * Re-enable a disabled connection.
 *
 * Goes back to `pending_validation` when no active credential remains, so an
 * operator is told to supply a key rather than the connection silently sitting
 * "active" and failing every sync.
 */
export async function enableConnection(
  db: StripeDataStoreLike,
  input: ConnectionMutationInput,
): Promise<ConnectionRecord> {
  const store = resolveStore(db);
  const now = input.now ?? new Date();
  await requireConnection(store, input.organizationId, input.connectionId);

  const credential = await store.findActiveCredential(input.organizationId, input.connectionId);

  const connection = await store.updateConnection(input.organizationId, input.connectionId, {
    status: credential ? "active" : "pending_validation",
    disabledAt: null,
    updatedAt: now,
  });
  if (!connection) throw connectionNotFound();

  await store.recordAuditEvent({
    organizationId: input.organizationId,
    actor: input.actor ?? { type: "system" },
    action: "connection.enabled",
    targetType: "stripe_connection",
    targetId: input.connectionId,
    metadata: { hasCredential: credential !== null },
  });
  return connection;
}

/**
 * Soft-delete a connection and make its credential immediately unusable.
 *
 * Soft, not hard: already-synced provider rows remain as evidence for
 * reconciliations that referenced them, and the audit trail stays intact. The
 * credential revocation is the part that must be immediate.
 */
export async function deleteConnection(
  db: StripeDataStoreLike,
  input: ConnectionMutationInput,
): Promise<ConnectionRecord> {
  const store = resolveStore(db);
  const now = input.now ?? new Date();
  await requireConnection(store, input.organizationId, input.connectionId);

  await revokeCredential(store, {
    organizationId: input.organizationId,
    connectionId: input.connectionId,
    now,
  });

  const connection = await store.updateConnection(input.organizationId, input.connectionId, {
    status: "revoked",
    deletedAt: now,
    updatedAt: now,
  });
  if (!connection) throw connectionNotFound();

  await store.recordAuditEvent({
    organizationId: input.organizationId,
    actor: input.actor ?? { type: "system" },
    action: "connection.deleted",
    targetType: "stripe_connection",
    targetId: input.connectionId,
  });
  return connection;
}

export interface ProbeResult {
  readable: SyncResource[];
  unreadable: Array<{
    resource: SyncResource;
    category: StripeErrorCategory;
    /** Fixed wording per category. Deliberately omits Stripe's own detail. */
    message: string;
  }>;
}

export interface ProbeInput {
  organizationId: string;
  connectionId: string;
  transport: StripeReadTransport;
  now?: Date;
  resources?: readonly SyncResource[];
}

/**
 * Discover which resources the restricted key can actually read.
 *
 * Stripe offers no way to introspect a restricted key's grants, so the only
 * reliable probe is to attempt a one-item list of each resource. The result is
 * persisted on the connection so the UI can tell the operator exactly which
 * permission to add, without echoing Stripe's error text — which can name
 * internal routes and is more detail than a settings page should surface.
 */
export async function probeReadableResources(
  db: StripeDataStoreLike,
  input: ProbeInput,
): Promise<ProbeResult> {
  const store = resolveStore(db);
  const now = input.now ?? new Date();
  await requireConnection(store, input.organizationId, input.connectionId);

  const resources = input.resources ?? SYNC_RESOURCE_ORDER;
  const readable: SyncResource[] = [];
  const unreadable: ProbeResult["unreadable"] = [];

  for (const resource of resources) {
    try {
      await listResource(input.transport, resource, { limit: 1 });
      readable.push(resource);
    } catch (caught) {
      const error = classifyStripeError(caught);
      unreadable.push({
        resource,
        category: error.category,
        message: describeCategory(error.category),
      });
    }
  }

  await store.updateConnection(input.organizationId, input.connectionId, {
    readableResources: readable,
    updatedAt: now,
  });

  return { readable, unreadable };
}

async function requireConnection(
  store: ReturnType<typeof resolveStore>,
  organizationId: string,
  connectionId: string,
): Promise<ConnectionRecord> {
  const connection = await store.findConnection(organizationId, connectionId);
  if (!connection) throw connectionNotFound();
  return connection;
}

function connectionNotFound(): PublicError {
  // Same message whether the id is unknown or belongs to another tenant: the
  // response must not confirm that someone else's connection id exists.
  return new PublicError("connection_not_found", "That Stripe connection does not exist.", 404);
}
