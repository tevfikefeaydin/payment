/**
 * PostgreSQL implementation of the persistence port, via Drizzle.
 *
 * READ-ONLY CONTEXT: these statements write PayRecon's own tables. Nothing here
 * — and nothing reachable from here — writes to a customer's Stripe account.
 *
 * Every provider upsert targets the tenant-scoped unique index
 * `(organization_id, provider_id)` with `on conflict do update`, which is what
 * makes re-running a sync idempotent: a repeated page refreshes the existing row
 * instead of inserting a duplicate, and a partial failure therefore never leaves
 * the table doubled up.
 */
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Database } from "@payrecon/db";
import {
  providerBalanceTransactions,
  providerCustomers,
  providerDisputes,
  providerInvoices,
  providerPayments,
  providerPayouts,
  providerRefunds,
  providerSubscriptions,
  stripeConnections,
  stripeCredentials,
  syncCheckpoints,
  syncRuns,
} from "@payrecon/db/schema";
import { recordAudit } from "@payrecon/db";
import type { SyncResource } from "./transport";
import type {
  ConnectionRecord,
  CredentialRecord,
  InsertConnectionInput,
  InsertCredentialInput,
  InsertSyncRunInput,
  ProviderBalanceTransactionRow,
  ProviderCustomerRow,
  ProviderDisputeRow,
  ProviderInvoiceRow,
  ProviderPaymentRow,
  ProviderPayoutRow,
  ProviderRefundRow,
  ProviderSubscriptionRow,
  RecordAuditInput,
  StripeDataStore,
  SyncCheckpointRecord,
  SyncRunRecord,
  UpdateConnectionPatch,
  UpdateSyncRunPatch,
  UpsertCheckpointInput,
  UpsertProviderRowsInput,
} from "./store";

/**
 * A `Database` or a transaction handle. Derived from Drizzle's own callback
 * signature so that a Drizzle version bump cannot silently desynchronise it.
 */
type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Drizzle returns jsonb as `unknown`; narrow it without trusting the column. */
function toResourceList(value: unknown): SyncResource[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SyncResource => typeof item === "string");
}

function toStatsObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface ConnectionRow {
  id: string;
  organizationId: string;
  name: string;
  stripeAccountId: string | null;
  accountDisplayName: string | null;
  livemode: boolean;
  status: ConnectionRecord["status"];
  lastValidatedAt: Date | null;
  lastValidationError: string | null;
  readableResources: unknown;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
  deletedAt: Date | null;
}

function toConnectionRecord(row: ConnectionRow): ConnectionRecord {
  return { ...row, readableResources: toResourceList(row.readableResources) };
}

interface SyncRunRow {
  id: string;
  organizationId: string;
  connectionId: string;
  status: SyncRunRecord["status"];
  isInitial: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  stats: unknown;
  errorCategory: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

function toSyncRunRecord(row: SyncRunRow): SyncRunRecord {
  return { ...row, stats: toStatsObject(row.stats) };
}

class DrizzleStripeDataStore implements StripeDataStore {
  readonly storeKind = "stripe-data-store" as const;

  /**
   * `executor` may be a transaction; `root` is always the pool-backed database.
   * Audit writes use `root` deliberately — an audit event describing a failed
   * operation must survive that operation's rollback.
   */
  constructor(
    private readonly executor: Executor,
    private readonly root: Database,
  ) {}

  async insertConnection(input: InsertConnectionInput): Promise<ConnectionRecord> {
    const [row] = await this.executor
      .insert(stripeConnections)
      .values({
        organizationId: input.organizationId,
        name: input.name,
        livemode: input.livemode,
        status: input.status,
        createdByUserId: input.createdByUserId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    if (!row) throw new Error("Failed to insert stripe connection");
    return toConnectionRecord(row);
  }

  async findConnection(
    organizationId: string,
    connectionId: string,
  ): Promise<ConnectionRecord | null> {
    const [row] = await this.executor
      .select()
      .from(stripeConnections)
      .where(
        and(
          eq(stripeConnections.organizationId, organizationId),
          eq(stripeConnections.id, connectionId),
        ),
      )
      .limit(1);
    return row ? toConnectionRecord(row) : null;
  }

  async updateConnection(
    organizationId: string,
    connectionId: string,
    patch: UpdateConnectionPatch,
  ): Promise<ConnectionRecord | null> {
    const [row] = await this.executor
      .update(stripeConnections)
      .set(patch)
      .where(
        and(
          eq(stripeConnections.organizationId, organizationId),
          eq(stripeConnections.id, connectionId),
        ),
      )
      .returning();
    return row ? toConnectionRecord(row) : null;
  }

  async insertCredential(input: InsertCredentialInput): Promise<CredentialRecord> {
    const [row] = await this.executor
      .insert(stripeCredentials)
      .values({
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
      })
      .returning();
    if (!row) throw new Error("Failed to insert stripe credential");
    return row;
  }

  async findActiveCredential(
    organizationId: string,
    connectionId: string,
  ): Promise<CredentialRecord | null> {
    const [row] = await this.executor
      .select()
      .from(stripeCredentials)
      .where(
        and(
          eq(stripeCredentials.organizationId, organizationId),
          eq(stripeCredentials.connectionId, connectionId),
          isNull(stripeCredentials.revokedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async revokeActiveCredentials(
    organizationId: string,
    connectionId: string,
    revokedAt: Date,
  ): Promise<number> {
    const rows = await this.executor
      .update(stripeCredentials)
      .set({ revokedAt })
      .where(
        and(
          eq(stripeCredentials.organizationId, organizationId),
          eq(stripeCredentials.connectionId, connectionId),
          isNull(stripeCredentials.revokedAt),
        ),
      )
      .returning({ id: stripeCredentials.id });
    return rows.length;
  }

  async insertSyncRun(input: InsertSyncRunInput): Promise<SyncRunRecord> {
    const [row] = await this.executor
      .insert(syncRuns)
      .values({
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        status: input.status,
        isInitial: input.isInitial,
        startedAt: input.startedAt,
        createdAt: input.now,
      })
      .returning();
    if (!row) throw new Error("Failed to insert sync run");
    return toSyncRunRecord(row);
  }

  async updateSyncRun(
    organizationId: string,
    runId: string,
    patch: UpdateSyncRunPatch,
  ): Promise<void> {
    await this.executor
      .update(syncRuns)
      .set(patch)
      .where(and(eq(syncRuns.organizationId, organizationId), eq(syncRuns.id, runId)));
  }

  async findSyncRun(organizationId: string, runId: string): Promise<SyncRunRecord | null> {
    const [row] = await this.executor
      .select()
      .from(syncRuns)
      .where(and(eq(syncRuns.organizationId, organizationId), eq(syncRuns.id, runId)))
      .limit(1);
    return row ? toSyncRunRecord(row) : null;
  }

  async findCheckpoint(
    organizationId: string,
    connectionId: string,
    resource: SyncResource,
  ): Promise<SyncCheckpointRecord | null> {
    const [row] = await this.executor
      .select()
      .from(syncCheckpoints)
      .where(
        and(
          eq(syncCheckpoints.organizationId, organizationId),
          eq(syncCheckpoints.connectionId, connectionId),
          eq(syncCheckpoints.resource, resource),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async upsertCheckpoint(input: UpsertCheckpointInput): Promise<SyncCheckpointRecord> {
    // Only the fields the caller actually earned appear in `set`, so an omitted
    // field keeps its stored value. This is the mechanism that stops a failed
    // page from clobbering a checkpoint an earlier successful run established.
    const set: Record<string, unknown> = { updatedAt: input.now };
    if (input.cursor !== undefined) set.cursor = input.cursor;
    if (input.syncedThrough !== undefined) set.syncedThrough = input.syncedThrough;
    if (input.lastSuccessfulAt !== undefined) set.lastSuccessfulAt = input.lastSuccessfulAt;
    if (input.lastAttemptedAt !== undefined) set.lastAttemptedAt = input.lastAttemptedAt;

    const [row] = await this.executor
      .insert(syncCheckpoints)
      .values({
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        resource: input.resource,
        cursor: input.cursor ?? null,
        syncedThrough: input.syncedThrough ?? null,
        lastSuccessfulAt: input.lastSuccessfulAt ?? null,
        lastAttemptedAt: input.lastAttemptedAt ?? null,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [syncCheckpoints.connectionId, syncCheckpoints.resource],
        set,
      })
      .returning();
    if (!row) throw new Error("Failed to upsert sync checkpoint");
    return row;
  }

  async upsertProviderRows<R extends SyncResource>(
    input: UpsertProviderRowsInput<R>,
  ): Promise<number> {
    if (input.rows.length === 0) return 0;
    const { organizationId, connectionId, syncedAt } = input;
    const base = { organizationId, connectionId, syncedAt };

    // Switch on the widened value so TypeScript narrows properly; `input.rows`
    // is then re-tied to the arm, which it cannot infer from the generic `R`.
    const resource: SyncResource = input.resource;
    switch (resource) {
      case "customers": {
        const rows = input.rows as readonly ProviderCustomerRow[];
        const written = await this.executor
          .insert(providerCustomers)
          .values(rows.map((row) => ({ ...base, ...row })))
          .onConflictDoUpdate({
            target: [providerCustomers.organizationId, providerCustomers.providerId],
            set: excluded(["email", "name", "provider_created_at", "synced_at"]),
          })
          .returning({ id: providerCustomers.id });
        return written.length;
      }
      case "payment_intents":
      case "charges": {
        const rows = input.rows as readonly ProviderPaymentRow[];
        const written = await this.executor
          .insert(providerPayments)
          .values(rows.map((row) => ({ ...base, ...row })))
          .onConflictDoUpdate({
            target: [providerPayments.organizationId, providerPayments.providerId],
            set: excluded([
              "kind",
              "status",
              "amount_minor",
              "amount_refunded_minor",
              "currency",
              "provider_customer_id",
              "provider_invoice_id",
              "payment_intent_id",
              "disputed",
              "metadata",
              "provider_created_at",
              "synced_at",
            ]),
          })
          .returning({ id: providerPayments.id });
        return written.length;
      }
      case "invoices": {
        const rows = input.rows as readonly ProviderInvoiceRow[];
        const written = await this.executor
          .insert(providerInvoices)
          .values(rows.map((row) => ({ ...base, ...row })))
          .onConflictDoUpdate({
            target: [providerInvoices.organizationId, providerInvoices.providerId],
            set: excluded([
              "status",
              "amount_due_minor",
              "amount_paid_minor",
              "currency",
              "provider_customer_id",
              "provider_subscription_id",
              "attempt_count",
              "provider_created_at",
              "paid_at",
              "synced_at",
            ]),
          })
          .returning({ id: providerInvoices.id });
        return written.length;
      }
      case "subscriptions": {
        const rows = input.rows as readonly ProviderSubscriptionRow[];
        const written = await this.executor
          .insert(providerSubscriptions)
          .values(rows.map((row) => ({ ...base, ...row })))
          .onConflictDoUpdate({
            target: [providerSubscriptions.organizationId, providerSubscriptions.providerId],
            set: excluded([
              "status",
              "provider_customer_id",
              "currency",
              "provider_created_at",
              "canceled_at",
              "current_period_start",
              "current_period_end",
              "synced_at",
            ]),
          })
          .returning({ id: providerSubscriptions.id });
        return written.length;
      }
      case "refunds": {
        const rows = input.rows as readonly ProviderRefundRow[];
        const written = await this.executor
          .insert(providerRefunds)
          .values(rows.map((row) => ({ ...base, ...row })))
          .onConflictDoUpdate({
            target: [providerRefunds.organizationId, providerRefunds.providerId],
            set: excluded([
              "provider_payment_id",
              "amount_minor",
              "currency",
              "status",
              "provider_created_at",
              "synced_at",
            ]),
          })
          .returning({ id: providerRefunds.id });
        return written.length;
      }
      case "disputes": {
        const rows = input.rows as readonly ProviderDisputeRow[];
        const written = await this.executor
          .insert(providerDisputes)
          .values(rows.map((row) => ({ ...base, ...row })))
          .onConflictDoUpdate({
            target: [providerDisputes.organizationId, providerDisputes.providerId],
            set: excluded([
              "provider_payment_id",
              "amount_minor",
              "currency",
              "status",
              "reason",
              "provider_created_at",
              "synced_at",
            ]),
          })
          .returning({ id: providerDisputes.id });
        return written.length;
      }
      case "balance_transactions": {
        const rows = input.rows as readonly ProviderBalanceTransactionRow[];
        const written = await this.executor
          .insert(providerBalanceTransactions)
          .values(rows.map((row) => ({ ...base, ...row })))
          .onConflictDoUpdate({
            target: [
              providerBalanceTransactions.organizationId,
              providerBalanceTransactions.providerId,
            ],
            set: excluded([
              "type",
              "amount_minor",
              "fee_minor",
              "net_minor",
              "currency",
              "source_id",
              "provider_created_at",
              "synced_at",
            ]),
          })
          .returning({ id: providerBalanceTransactions.id });
        return written.length;
      }
      case "payouts": {
        const rows = input.rows as readonly ProviderPayoutRow[];
        const written = await this.executor
          .insert(providerPayouts)
          .values(rows.map((row) => ({ ...base, ...row })))
          .onConflictDoUpdate({
            target: [providerPayouts.organizationId, providerPayouts.providerId],
            set: excluded([
              "amount_minor",
              "currency",
              "status",
              "arrival_date",
              "provider_created_at",
              "synced_at",
            ]),
          })
          .returning({ id: providerPayouts.id });
        return written.length;
      }
      default: {
        const unreachable: never = resource;
        throw new Error(`Unsupported sync resource: ${String(unreachable)}`);
      }
    }
  }

  /**
   * `payment_intents` and `charges` share `provider_payments`, so the count is
   * additionally narrowed by `kind`. Without that, a caller checking one
   * resource would see the other's rows.
   */
  async countProviderRows(organizationId: string, resource: SyncResource): Promise<number> {
    const count = sql<number>`count(*)::int`;

    switch (resource) {
      case "customers": {
        const [row] = await this.executor
          .select({ count })
          .from(providerCustomers)
          .where(eq(providerCustomers.organizationId, organizationId));
        return row?.count ?? 0;
      }
      case "payment_intents":
      case "charges": {
        const kind = resource === "charges" ? "charge" : "payment_intent";
        const [row] = await this.executor
          .select({ count })
          .from(providerPayments)
          .where(
            and(
              eq(providerPayments.organizationId, organizationId),
              eq(providerPayments.kind, kind),
            ),
          );
        return row?.count ?? 0;
      }
      case "invoices": {
        const [row] = await this.executor
          .select({ count })
          .from(providerInvoices)
          .where(eq(providerInvoices.organizationId, organizationId));
        return row?.count ?? 0;
      }
      case "subscriptions": {
        const [row] = await this.executor
          .select({ count })
          .from(providerSubscriptions)
          .where(eq(providerSubscriptions.organizationId, organizationId));
        return row?.count ?? 0;
      }
      case "refunds": {
        const [row] = await this.executor
          .select({ count })
          .from(providerRefunds)
          .where(eq(providerRefunds.organizationId, organizationId));
        return row?.count ?? 0;
      }
      case "disputes": {
        const [row] = await this.executor
          .select({ count })
          .from(providerDisputes)
          .where(eq(providerDisputes.organizationId, organizationId));
        return row?.count ?? 0;
      }
      case "balance_transactions": {
        const [row] = await this.executor
          .select({ count })
          .from(providerBalanceTransactions)
          .where(eq(providerBalanceTransactions.organizationId, organizationId));
        return row?.count ?? 0;
      }
      case "payouts": {
        const [row] = await this.executor
          .select({ count })
          .from(providerPayouts)
          .where(eq(providerPayouts.organizationId, organizationId));
        return row?.count ?? 0;
      }
      default: {
        const unreachable: never = resource;
        throw new Error(`Unsupported sync resource: ${String(unreachable)}`);
      }
    }
  }

  async recordAuditEvent(input: RecordAuditInput): Promise<void> {
    await recordAudit(this.root, {
      organizationId: input.organizationId,
      actor: input.actor,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata,
    });
  }

  async transaction<T>(fn: (tx: StripeDataStore) => Promise<T>): Promise<T> {
    return this.root.transaction(async (tx) => fn(new DrizzleStripeDataStore(tx, this.root)));
  }
}

/** Build the `set` clause of an upsert from the conflicting row's new values. */
function excluded(columns: readonly string[]): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const column of columns) {
    set[toCamelCase(column)] = sql.raw(`excluded.${column}`);
  }
  return set;
}

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** Wrap a Drizzle database as a `StripeDataStore`. */
export function createDrizzleStore(db: Database): StripeDataStore {
  return new DrizzleStripeDataStore(db, db);
}
