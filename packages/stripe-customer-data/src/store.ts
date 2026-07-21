/**
 * The persistence port for the READ-ONLY customer Stripe integration.
 *
 * Why a port rather than passing Drizzle around directly: the checkpoint,
 * idempotency and tenant-isolation guarantees in sync.ts are the whole point of
 * this package, and they must be provable by the DEFAULT test suite — which is
 * required to run with no external services and no production secrets. A narrow
 * interface lets those properties be exercised against an in-memory
 * implementation that enforces the same constraints the database does, while
 * production still runs the real Drizzle statements in drizzle-store.ts.
 *
 * TENANT ISOLATION: every operation takes `organizationId` as a required
 * argument rather than an optional filter, so an unscoped read or write is not
 * expressible through this API.
 */
import type {
  connectionStatusEnum,
  providerInvoiceStatusEnum,
  providerPaymentStatusEnum,
  providerRefundStatusEnum,
  providerSubscriptionStatusEnum,
  syncStatusEnum,
} from "@payrecon/db/schema";
import type { AuditAction, AuditActor, Database } from "@payrecon/db";
import { createDrizzleStore } from "./drizzle-store";
import type { SyncResource } from "./transport";

export type ConnectionStatus = (typeof connectionStatusEnum.enumValues)[number];
export type SyncStatus = (typeof syncStatusEnum.enumValues)[number];
export type ProviderPaymentStatus = (typeof providerPaymentStatusEnum.enumValues)[number];
export type ProviderRefundStatus = (typeof providerRefundStatusEnum.enumValues)[number];
export type ProviderInvoiceStatus = (typeof providerInvoiceStatusEnum.enumValues)[number];
export type ProviderSubscriptionStatus = (typeof providerSubscriptionStatusEnum.enumValues)[number];

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface ConnectionRecord {
  id: string;
  organizationId: string;
  name: string;
  stripeAccountId: string | null;
  accountDisplayName: string | null;
  livemode: boolean;
  status: ConnectionStatus;
  lastValidatedAt: Date | null;
  lastValidationError: string | null;
  readableResources: SyncResource[];
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  disabledAt: Date | null;
  deletedAt: Date | null;
}

export interface InsertConnectionInput {
  organizationId: string;
  name: string;
  livemode: boolean;
  status: ConnectionStatus;
  createdByUserId: string | null;
  now: Date;
}

export interface UpdateConnectionPatch {
  name?: string;
  stripeAccountId?: string | null;
  accountDisplayName?: string | null;
  livemode?: boolean;
  status?: ConnectionStatus;
  lastValidatedAt?: Date | null;
  lastValidationError?: string | null;
  readableResources?: SyncResource[];
  disabledAt?: Date | null;
  deletedAt?: Date | null;
  updatedAt: Date;
}

/**
 * An encrypted credential row. `ciphertext`/`nonce`/`authTag` are opaque here:
 * this layer never decrypts, so a store implementation cannot leak plaintext.
 */
export interface CredentialRecord {
  id: string;
  organizationId: string;
  connectionId: string;
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyId: string;
  encryptionVersion: number;
  keyKind: string;
  keyLastFour: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export type InsertCredentialInput = Omit<CredentialRecord, "id" | "createdAt" | "revokedAt"> & {
  now: Date;
};

export interface SyncRunRecord {
  id: string;
  organizationId: string;
  connectionId: string;
  status: SyncStatus;
  isInitial: boolean;
  startedAt: Date | null;
  finishedAt: Date | null;
  stats: Record<string, unknown>;
  errorCategory: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

export interface InsertSyncRunInput {
  organizationId: string;
  connectionId: string;
  status: SyncStatus;
  isInitial: boolean;
  startedAt: Date;
  now: Date;
}

export interface UpdateSyncRunPatch {
  status?: SyncStatus;
  finishedAt?: Date | null;
  stats?: Record<string, unknown>;
  errorCategory?: string | null;
  errorMessage?: string | null;
}

export interface SyncCheckpointRecord {
  id: string;
  organizationId: string;
  connectionId: string;
  resource: SyncResource;
  cursor: string | null;
  syncedThrough: Date | null;
  lastSuccessfulAt: Date | null;
  lastAttemptedAt: Date | null;
  updatedAt: Date;
}

/**
 * A checkpoint write.
 *
 * Fields are optional so a caller can advance exactly what it earned. Omitting
 * `cursor`, `syncedThrough` or `lastSuccessfulAt` leaves the stored value
 * untouched — that is what makes a mid-sweep failure non-destructive.
 */
export interface UpsertCheckpointInput {
  organizationId: string;
  connectionId: string;
  resource: SyncResource;
  cursor?: string | null;
  syncedThrough?: Date | null;
  lastSuccessfulAt?: Date | null;
  lastAttemptedAt?: Date | null;
  now: Date;
}

// ---------------------------------------------------------------------------
// Provider rows (minimised — see transport.ts for what is deliberately absent)
// ---------------------------------------------------------------------------

export interface ProviderCustomerRow {
  providerId: string;
  email: string | null;
  name: string | null;
  providerCreatedAt: Date;
}

export interface ProviderPaymentRow {
  providerId: string;
  kind: "payment_intent" | "charge";
  status: ProviderPaymentStatus;
  amountMinor: bigint;
  amountRefundedMinor: bigint;
  currency: string;
  providerCustomerId: string | null;
  providerInvoiceId: string | null;
  paymentIntentId: string | null;
  disputed: boolean;
  metadata: Record<string, string>;
  providerCreatedAt: Date;
}

export interface ProviderRefundRow {
  providerId: string;
  providerPaymentId: string | null;
  amountMinor: bigint;
  currency: string;
  status: ProviderRefundStatus;
  providerCreatedAt: Date;
}

export interface ProviderInvoiceRow {
  providerId: string;
  status: ProviderInvoiceStatus;
  amountDueMinor: bigint;
  amountPaidMinor: bigint;
  currency: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  attemptCount: number;
  providerCreatedAt: Date;
  paidAt: Date | null;
}

export interface ProviderSubscriptionRow {
  providerId: string;
  status: ProviderSubscriptionStatus;
  providerCustomerId: string | null;
  currency: string;
  providerCreatedAt: Date;
  canceledAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

export interface ProviderDisputeRow {
  providerId: string;
  providerPaymentId: string | null;
  amountMinor: bigint;
  currency: string;
  status: string;
  reason: string | null;
  providerCreatedAt: Date;
}

export interface ProviderPayoutRow {
  providerId: string;
  amountMinor: bigint;
  currency: string;
  status: string;
  arrivalDate: Date | null;
  providerCreatedAt: Date;
}

export interface ProviderBalanceTransactionRow {
  providerId: string;
  type: string;
  amountMinor: bigint;
  feeMinor: bigint;
  netMinor: bigint;
  currency: string;
  sourceId: string | null;
  providerCreatedAt: Date;
}

/** Row shape produced by each resource. Keeps the upsert call site type-safe. */
export interface ProviderRowsByResource {
  customers: ProviderCustomerRow;
  payment_intents: ProviderPaymentRow;
  charges: ProviderPaymentRow;
  invoices: ProviderInvoiceRow;
  subscriptions: ProviderSubscriptionRow;
  refunds: ProviderRefundRow;
  disputes: ProviderDisputeRow;
  balance_transactions: ProviderBalanceTransactionRow;
  payouts: ProviderPayoutRow;
}

export interface UpsertProviderRowsInput<R extends SyncResource> {
  organizationId: string;
  connectionId: string;
  resource: R;
  rows: ReadonlyArray<ProviderRowsByResource[R]>;
  syncedAt: Date;
}

export interface RecordAuditInput {
  organizationId: string;
  actor: AuditActor;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/**
 * Persistence operations required by this package, and no others.
 *
 * `storeKind` is a discriminator: it lets `resolveStore` accept either a Drizzle
 * `Database` or an already-built store without ambiguity, so the public service
 * functions can keep their `(db, input)` shape.
 */
export interface StripeDataStore {
  readonly storeKind: "stripe-data-store";

  insertConnection(input: InsertConnectionInput): Promise<ConnectionRecord>;
  findConnection(organizationId: string, connectionId: string): Promise<ConnectionRecord | null>;
  updateConnection(
    organizationId: string,
    connectionId: string,
    patch: UpdateConnectionPatch,
  ): Promise<ConnectionRecord | null>;

  insertCredential(input: InsertCredentialInput): Promise<CredentialRecord>;
  findActiveCredential(
    organizationId: string,
    connectionId: string,
  ): Promise<CredentialRecord | null>;
  /** Returns how many rows were revoked. Idempotent. */
  revokeActiveCredentials(
    organizationId: string,
    connectionId: string,
    revokedAt: Date,
  ): Promise<number>;

  insertSyncRun(input: InsertSyncRunInput): Promise<SyncRunRecord>;
  updateSyncRun(organizationId: string, runId: string, patch: UpdateSyncRunPatch): Promise<void>;
  findSyncRun(organizationId: string, runId: string): Promise<SyncRunRecord | null>;

  findCheckpoint(
    organizationId: string,
    connectionId: string,
    resource: SyncResource,
  ): Promise<SyncCheckpointRecord | null>;
  upsertCheckpoint(input: UpsertCheckpointInput): Promise<SyncCheckpointRecord>;

  /** Idempotent by (organization_id, provider_id). Returns rows written. */
  upsertProviderRows<R extends SyncResource>(input: UpsertProviderRowsInput<R>): Promise<number>;
  /** Row count for one resource. Used by tests and progress reporting. */
  countProviderRows(organizationId: string, resource: SyncResource): Promise<number>;

  recordAuditEvent(input: RecordAuditInput): Promise<void>;

  transaction<T>(fn: (tx: StripeDataStore) => Promise<T>): Promise<T>;
}

/**
 * What the public service functions accept as their first argument: either a
 * Drizzle database (production) or an already-built store (tests, demo).
 */
export type StripeDataStoreLike = Database | StripeDataStore;

export function isStripeDataStore(value: StripeDataStoreLike): value is StripeDataStore {
  return "storeKind" in value && value.storeKind === "stripe-data-store";
}

/** Normalise the first argument of every service function into a store. */
export function resolveStore(db: StripeDataStoreLike): StripeDataStore {
  return isStripeDataStore(db) ? db : createDrizzleStore(db);
}
