/**
 * In-memory implementation of the persistence port.
 *
 * Used by the default test suite and by the demo path, which must run with no
 * external services and no production secrets. To be worth anything as a test
 * double it enforces the SAME constraints the database does:
 *
 *   - every read and write is filtered by `organization_id`;
 *   - `(organization_id, provider_id)` is unique per provider table, so an
 *     upsert genuinely replaces rather than appending;
 *   - `(connection_id, resource)` is unique for checkpoints;
 *   - at most one non-revoked credential exists per connection;
 *   - audit metadata passes through the same `redactObject` production uses.
 *
 * Records are deep-copied on the way in and out. A test that asserts a
 * checkpoint did not advance would otherwise be fooled by shared references.
 */
import { redactObject } from "@payrecon/domain";
import type { SyncResource } from "./transport";
import type {
  ConnectionRecord,
  CredentialRecord,
  InsertConnectionInput,
  InsertCredentialInput,
  InsertSyncRunInput,
  ProviderPaymentRow,
  RecordAuditInput,
  StripeDataStore,
  SyncCheckpointRecord,
  SyncRunRecord,
  UpdateConnectionPatch,
  UpdateSyncRunPatch,
  UpsertCheckpointInput,
  UpsertProviderRowsInput,
} from "./store";

/** A stored provider row, keyed the way the unique index keys it. */
interface StoredProviderRow {
  organizationId: string;
  connectionId: string;
  resource: SyncResource;
  providerId: string;
  syncedAt: Date;
  data: Record<string, unknown>;
}

export interface RecordedAuditEvent {
  organizationId: string;
  action: string;
  actorType: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
}

interface MemoryState {
  connections: ConnectionRecord[];
  credentials: CredentialRecord[];
  syncRuns: SyncRunRecord[];
  checkpoints: SyncCheckpointRecord[];
  providerRows: StoredProviderRow[];
  auditEvents: RecordedAuditEvent[];
  nextId: number;
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Buffer.isBuffer(value)) return Buffer.from(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = cloneValue(item);
  }
  return out as T;
}

/**
 * Which table a resource lands in. `payment_intents` and `charges` share
 * `provider_payments` in the real schema, so they must share it here too —
 * otherwise a collision between a charge id and a payment intent id would go
 * undetected in tests.
 */
const RESOURCE_TABLE: Readonly<Record<SyncResource, string>> = {
  customers: "provider_customers",
  payment_intents: "provider_payments",
  charges: "provider_payments",
  invoices: "provider_invoices",
  subscriptions: "provider_subscriptions",
  refunds: "provider_refunds",
  disputes: "provider_disputes",
  balance_transactions: "provider_balance_transactions",
  payouts: "provider_payouts",
};

export class MemoryStripeDataStore implements StripeDataStore {
  readonly storeKind = "stripe-data-store" as const;

  private state: MemoryState = {
    connections: [],
    credentials: [],
    syncRuns: [],
    checkpoints: [],
    providerRows: [],
    auditEvents: [],
    nextId: 1,
  };

  /** Deterministic, uuid-shaped ids so output is stable across runs. */
  private newId(): string {
    const n = this.state.nextId++;
    return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  }

  async insertConnection(input: InsertConnectionInput): Promise<ConnectionRecord> {
    const record: ConnectionRecord = {
      id: this.newId(),
      organizationId: input.organizationId,
      name: input.name,
      stripeAccountId: null,
      accountDisplayName: null,
      livemode: input.livemode,
      status: input.status,
      lastValidatedAt: null,
      lastValidationError: null,
      readableResources: [],
      createdByUserId: input.createdByUserId,
      createdAt: input.now,
      updatedAt: input.now,
      disabledAt: null,
      deletedAt: null,
    };
    this.state.connections.push(cloneValue(record));
    return cloneValue(record);
  }

  async findConnection(
    organizationId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | null> {
    const found = this.state.connections.find(
      (row) => row.organizationId === organizationId && row.id === connectionId,
    );
    return found ? cloneValue(found) : null;
  }

  async updateConnection(
    organizationId: string,
    connectionId: string,
    patch: UpdateConnectionPatch,
  ): Promise<ConnectionRecord | null> {
    const found = this.state.connections.find(
      (row) => row.organizationId === organizationId && row.id === connectionId,
    );
    if (!found) return null;
    Object.assign(found, cloneValue(patch));
    return cloneValue(found);
  }

  async insertCredential(input: InsertCredentialInput): Promise<CredentialRecord> {
    // Mirrors `stripe_credentials_active_uidx`.
    const conflicting = this.state.credentials.some(
      (row) => row.connectionId === input.connectionId && row.revokedAt === null,
    );
    if (conflicting) {
      throw new Error(
        "duplicate key value violates unique constraint stripe_credentials_active_uidx",
      );
    }
    if (input.keyLastFour.length > 4) {
      throw new Error("new row violates check constraint stripe_credentials_last_four_len");
    }

    const record: CredentialRecord = {
      id: this.newId(),
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      ciphertext: input.ciphertext,
      nonce: input.nonce,
      authTag: input.authTag,
      keyId: input.keyId,
      encryptionVersion: input.encryptionVersion,
      keyKind: input.keyKind,
      keyLastFour: input.keyLastFour,
      createdAt: input.now,
      revokedAt: null,
    };
    this.state.credentials.push(cloneValue(record));
    return cloneValue(record);
  }

  async findActiveCredential(
    organizationId: string,
    connectionId: string,
  ): Promise<CredentialRecord | null> {
    const found = this.state.credentials.find(
      (row) =>
        row.organizationId === organizationId &&
        row.connectionId === connectionId &&
        row.revokedAt === null,
    );
    return found ? cloneValue(found) : null;
  }

  async revokeActiveCredentials(
    organizationId: string,
    connectionId: string,
    revokedAt: Date,
  ): Promise<number> {
    let revoked = 0;
    for (const row of this.state.credentials) {
      if (
        row.organizationId === organizationId &&
        row.connectionId === connectionId &&
        row.revokedAt === null
      ) {
        row.revokedAt = new Date(revokedAt.getTime());
        revoked += 1;
      }
    }
    return revoked;
  }

  async insertSyncRun(input: InsertSyncRunInput): Promise<SyncRunRecord> {
    const record: SyncRunRecord = {
      id: this.newId(),
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      status: input.status,
      isInitial: input.isInitial,
      startedAt: input.startedAt,
      finishedAt: null,
      stats: {},
      errorCategory: null,
      errorMessage: null,
      createdAt: input.now,
    };
    this.state.syncRuns.push(cloneValue(record));
    return cloneValue(record);
  }

  async updateSyncRun(
    organizationId: string,
    runId: string,
    patch: UpdateSyncRunPatch,
  ): Promise<void> {
    const found = this.state.syncRuns.find(
      (row) => row.organizationId === organizationId && row.id === runId,
    );
    if (found) Object.assign(found, cloneValue(patch));
  }

  async findSyncRun(organizationId: string, runId: string): Promise<SyncRunRecord | null> {
    const found = this.state.syncRuns.find(
      (row) => row.organizationId === organizationId && row.id === runId,
    );
    return found ? cloneValue(found) : null;
  }

  async findCheckpoint(
    organizationId: string,
    connectionId: string,
    resource: SyncResource,
  ): Promise<SyncCheckpointRecord | null> {
    const found = this.state.checkpoints.find(
      (row) =>
        row.organizationId === organizationId &&
        row.connectionId === connectionId &&
        row.resource === resource,
    );
    return found ? cloneValue(found) : null;
  }

  async upsertCheckpoint(input: UpsertCheckpointInput): Promise<SyncCheckpointRecord> {
    const existing = this.state.checkpoints.find(
      (row) => row.connectionId === input.connectionId && row.resource === input.resource,
    );

    if (existing) {
      // An omitted field keeps its stored value — the in-memory equivalent of
      // leaving a column out of an `on conflict do update` set clause.
      if (input.cursor !== undefined) existing.cursor = input.cursor;
      if (input.syncedThrough !== undefined)
        existing.syncedThrough = cloneValue(input.syncedThrough);
      if (input.lastSuccessfulAt !== undefined) {
        existing.lastSuccessfulAt = cloneValue(input.lastSuccessfulAt);
      }
      if (input.lastAttemptedAt !== undefined) {
        existing.lastAttemptedAt = cloneValue(input.lastAttemptedAt);
      }
      existing.updatedAt = cloneValue(input.now);
      return cloneValue(existing);
    }

    const record: SyncCheckpointRecord = {
      id: this.newId(),
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      resource: input.resource,
      cursor: input.cursor ?? null,
      syncedThrough: input.syncedThrough ?? null,
      lastSuccessfulAt: input.lastSuccessfulAt ?? null,
      lastAttemptedAt: input.lastAttemptedAt ?? null,
      updatedAt: input.now,
    };
    this.state.checkpoints.push(cloneValue(record));
    return cloneValue(record);
  }

  async upsertProviderRows<R extends SyncResource>(
    input: UpsertProviderRowsInput<R>,
  ): Promise<number> {
    let written = 0;
    for (const row of input.rows) {
      const data = cloneValue(row) as unknown as Record<string, unknown>;
      const providerId = String(data.providerId);
      const table = RESOURCE_TABLE[input.resource];

      const existing = this.state.providerRows.find(
        (stored) =>
          stored.organizationId === input.organizationId &&
          RESOURCE_TABLE[stored.resource] === table &&
          stored.providerId === providerId,
      );

      if (existing) {
        existing.data = data;
        existing.connectionId = input.connectionId;
        existing.syncedAt = cloneValue(input.syncedAt);
        // The stored resource is refreshed so a charge id later seen as a
        // payment intent updates in place, exactly as the unique index forces.
        existing.resource = input.resource;
      } else {
        this.state.providerRows.push({
          organizationId: input.organizationId,
          connectionId: input.connectionId,
          resource: input.resource,
          providerId,
          syncedAt: cloneValue(input.syncedAt),
          data,
        });
      }
      written += 1;
    }
    return written;
  }

  async countProviderRows(organizationId: string, resource: SyncResource): Promise<number> {
    const table = RESOURCE_TABLE[resource];
    return this.state.providerRows.filter((row) => {
      if (row.organizationId !== organizationId) return false;
      if (RESOURCE_TABLE[row.resource] !== table) return false;
      if (table !== "provider_payments") return true;
      // Distinguish the two kinds that share provider_payments.
      const kind = (row.data as Partial<ProviderPaymentRow>).kind;
      return resource === "charges" ? kind === "charge" : kind === "payment_intent";
    }).length;
  }

  async recordAuditEvent(input: RecordAuditInput): Promise<void> {
    this.state.auditEvents.push({
      organizationId: input.organizationId,
      action: input.action,
      actorType: input.actor.type,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      // Same redaction production applies, so a leak here is a real failure.
      metadata: redactObject(input.metadata ?? {}),
    });
  }

  async transaction<T>(fn: (tx: StripeDataStore) => Promise<T>): Promise<T> {
    const snapshot = cloneValue(this.state);
    try {
      return await fn(this);
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Test inspection helpers. Read-only views over the state.
  // -------------------------------------------------------------------------

  auditEvents(): RecordedAuditEvent[] {
    return cloneValue(this.state.auditEvents);
  }

  credentialsFor(organizationId: string, connectionId: string): CredentialRecord[] {
    return cloneValue(
      this.state.credentials.filter(
        (row) => row.organizationId === organizationId && row.connectionId === connectionId,
      ),
    );
  }

  providerRowsFor(organizationId: string, resource: SyncResource): Array<Record<string, unknown>> {
    const table = RESOURCE_TABLE[resource];
    return cloneValue(
      this.state.providerRows
        .filter(
          (row) => row.organizationId === organizationId && RESOURCE_TABLE[row.resource] === table,
        )
        .map((row) => row.data),
    );
  }

  syncRunsFor(organizationId: string): SyncRunRecord[] {
    return cloneValue(this.state.syncRuns.filter((row) => row.organizationId === organizationId));
  }
}

export function createMemoryStore(): MemoryStripeDataStore {
  return new MemoryStripeDataStore();
}
