import { describe, expect, it } from "vitest";
import { PublicError } from "@payrecon/domain";
import { buildFakeStripeData, createFakeStripeTransport } from "./fake-transport";
import { createMemoryStore, type MemoryStripeDataStore } from "./memory-store";
import { boundMetadata, runSync } from "./sync";
import type { ProviderPaymentRow, ProviderRefundRow } from "./store";
import type { SleepFn } from "./retry";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const NOW_1 = new Date("2026-06-01T00:00:00.000Z");
const NOW_2 = new Date("2026-06-02T00:00:00.000Z");
const NOW_3 = new Date("2026-06-03T00:00:00.000Z");

/** Never actually waits; records the backoff schedule for assertions. */
function recordingSleep(): { sleep: SleepFn; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

async function seedConnection(
  store: MemoryStripeDataStore,
  organizationId = ORG_A,
): Promise<string> {
  const connection = await store.insertConnection({
    organizationId,
    name: "Acme production",
    livemode: false,
    status: "active",
    createdByUserId: null,
    now: NOW_1,
  });
  return connection.id;
}

/** Deterministic: zero jitter, so asserted delays are exact. */
const NO_JITTER = () => 0.5;

describe("runSync tenant isolation", () => {
  it("refuses a connection id belonging to another organization", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store, ORG_A);

    await expect(
      runSync(store, {
        organizationId: ORG_B,
        connectionId,
        transport: createFakeStripeTransport(),
        isInitial: true,
        now: NOW_1,
      }),
    ).rejects.toBeInstanceOf(PublicError);

    // Not even a run row is created for the wrong tenant.
    expect(store.syncRunsFor(ORG_B)).toHaveLength(0);
    expect(store.syncRunsFor(ORG_A)).toHaveLength(0);
  });

  it("refuses a soft-deleted connection", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    await store.updateConnection(ORG_A, connectionId, { deletedAt: NOW_1, updatedAt: NOW_1 });

    await expect(
      runSync(store, {
        organizationId: ORG_A,
        connectionId,
        transport: createFakeStripeTransport(),
        isInitial: true,
        now: NOW_1,
      }),
    ).rejects.toBeInstanceOf(PublicError);
  });
});

describe("runSync idempotency", () => {
  it("produces the same number of rows when run twice", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const data = buildFakeStripeData({
      customers: 5,
      charges: 7,
      paymentIntents: 4,
      invoices: 3,
      subscriptions: 2,
      refunds: 3,
      disputes: 1,
      balanceTransactions: 6,
      payouts: 2,
    });
    const transport = createFakeStripeTransport({ data, pageSize: 2 });

    const first = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
    });
    expect(first.status).toBe("succeeded");

    const countsAfterFirst = {
      customers: await store.countProviderRows(ORG_A, "customers"),
      charges: await store.countProviderRows(ORG_A, "charges"),
      payment_intents: await store.countProviderRows(ORG_A, "payment_intents"),
      invoices: await store.countProviderRows(ORG_A, "invoices"),
      subscriptions: await store.countProviderRows(ORG_A, "subscriptions"),
      refunds: await store.countProviderRows(ORG_A, "refunds"),
      disputes: await store.countProviderRows(ORG_A, "disputes"),
      balance_transactions: await store.countProviderRows(ORG_A, "balance_transactions"),
      payouts: await store.countProviderRows(ORG_A, "payouts"),
    };
    expect(countsAfterFirst).toEqual({
      customers: 5,
      charges: 7,
      payment_intents: 4,
      invoices: 3,
      subscriptions: 2,
      refunds: 3,
      disputes: 1,
      balance_transactions: 6,
      payouts: 2,
    });

    const second = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_2,
    });
    expect(second.status).toBe("succeeded");

    const countsAfterSecond = {
      customers: await store.countProviderRows(ORG_A, "customers"),
      charges: await store.countProviderRows(ORG_A, "charges"),
      payment_intents: await store.countProviderRows(ORG_A, "payment_intents"),
      invoices: await store.countProviderRows(ORG_A, "invoices"),
      subscriptions: await store.countProviderRows(ORG_A, "subscriptions"),
      refunds: await store.countProviderRows(ORG_A, "refunds"),
      disputes: await store.countProviderRows(ORG_A, "disputes"),
      balance_transactions: await store.countProviderRows(ORG_A, "balance_transactions"),
      payouts: await store.countProviderRows(ORG_A, "payouts"),
    };
    expect(countsAfterSecond).toEqual(countsAfterFirst);
  });

  it("refreshes an existing row instead of duplicating it", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const data = buildFakeStripeData({ charges: 1 });
    const transport = createFakeStripeTransport({ data });

    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
    });

    // The same charge comes back with a larger refund, as Stripe would report
    // after a partial refund settles.
    const charge = data.charges[0];
    if (!charge) throw new Error("fixture missing");
    transport.seed({ charges: [{ ...charge, amountRefundedMinor: 999n }] });

    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_2,
      resources: ["charges"],
    });

    expect(await store.countProviderRows(ORG_A, "charges")).toBe(1);
    const [row] = store.providerRowsFor(ORG_A, "charges") as unknown as ProviderPaymentRow[];
    expect(row?.amountRefundedMinor).toBe(999n);
  });
});

describe("runSync checkpoint safety", () => {
  it("does not advance or discard a checkpoint when a later page fails", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const data = buildFakeStripeData({ charges: 6 });
    const transport = createFakeStripeTransport({ data, pageSize: 2 });
    const { sleep } = recordingSleep();

    // Run 1: clean sweep establishes a checkpoint.
    const first = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
      pageSize: 2,
      sleep,
      random: NO_JITTER,
    });
    expect(first.status).toBe("succeeded");

    const earned = await store.findCheckpoint(ORG_A, connectionId, "charges");
    expect(earned?.lastSuccessfulAt).toEqual(NOW_1);
    expect(earned?.syncedThrough).toEqual(NOW_1);
    expect(await store.countProviderRows(ORG_A, "charges")).toBe(6);

    // Run 2: page 2 fails permanently, so the sweep cannot complete.
    transport.failAt({ target: "charges", page: 2, category: "permanent" });
    const second = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_2,
      resources: ["charges"],
      pageSize: 2,
      sleep,
      random: NO_JITTER,
    });
    expect(second.status).toBe("failed");

    const afterFailure = await store.findCheckpoint(ORG_A, connectionId, "charges");
    // The checkpoint earned by run 1 survives untouched...
    expect(afterFailure?.lastSuccessfulAt).toEqual(NOW_1);
    expect(afterFailure?.syncedThrough).toEqual(NOW_1);
    expect(afterFailure?.cursor).toBe(earned?.cursor);
    // ...while the attempt is still recorded.
    expect(afterFailure?.lastAttemptedAt).toEqual(NOW_2);

    // Data fetched before the failure is never deleted.
    expect(await store.countProviderRows(ORG_A, "charges")).toBe(6);

    // Run 3: the failure heals and the sweep completes from the intact checkpoint.
    transport.clearFailures();
    const third = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_3,
      resources: ["charges"],
      pageSize: 2,
      sleep,
      random: NO_JITTER,
    });
    expect(third.status).toBe("succeeded");

    const afterRecovery = await store.findCheckpoint(ORG_A, connectionId, "charges");
    expect(afterRecovery?.lastSuccessfulAt).toEqual(NOW_3);
    expect(afterRecovery?.syncedThrough).toEqual(NOW_3);
    // Still no duplicates: the re-read pages were upserted, not appended.
    expect(await store.countProviderRows(ORG_A, "charges")).toBe(6);
  });

  it("records an attempt even when the very first page fails", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({
      data: buildFakeStripeData({ charges: 2 }),
      pageSize: 2,
    });
    transport.failAt({ target: "charges", page: 1, category: "auth" });
    const { sleep } = recordingSleep();

    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
      sleep,
      random: NO_JITTER,
    });

    const checkpoint = await store.findCheckpoint(ORG_A, connectionId, "charges");
    expect(checkpoint?.lastAttemptedAt).toEqual(NOW_1);
    expect(checkpoint?.lastSuccessfulAt).toBeNull();
    expect(checkpoint?.syncedThrough).toBeNull();
  });

  it("uses the stored window on an incremental run, and ignores it on a backfill", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({
      data: buildFakeStripeData({ charges: 3 }),
      pageSize: 10,
    });

    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
    });
    expect(transport.requestsFor("charges")[0]?.createdGte).toBeNull();

    transport.resetRequestLog();
    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: false,
      now: NOW_2,
      resources: ["charges"],
    });
    expect(transport.requestsFor("charges")[0]?.createdGte).toEqual(NOW_1);

    transport.resetRequestLog();
    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_3,
      resources: ["charges"],
    });
    expect(transport.requestsFor("charges")[0]?.createdGte).toBeNull();
  });
});

describe("runSync retry behaviour", () => {
  it("retries a transient failure with exponential backoff and jitter", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({
      data: buildFakeStripeData({ charges: 2 }),
      pageSize: 10,
    });
    // Fails twice, then heals.
    transport.failAt({ target: "charges", page: 1, category: "transient", times: 2 });
    const { sleep, delays } = recordingSleep();

    const result = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
      retryPolicy: { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 800, jitterRatio: 0.25 },
      sleep,
      random: NO_JITTER,
    });

    expect(result.status).toBe("succeeded");
    // Three real transport calls: two failures and the success.
    expect(transport.requestsFor("charges")).toHaveLength(3);
    expect(result.stats.charges?.attempts).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(await store.countProviderRows(ORG_A, "charges")).toBe(2);
  });

  it("applies jitter around the base delay", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({ data: buildFakeStripeData({ charges: 1 }) });
    transport.failAt({ target: "charges", page: 1, category: "rate_limited", times: 1 });
    const { sleep, delays } = recordingSleep();

    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
      retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 800, jitterRatio: 0.25 },
      sleep,
      random: () => 0,
    });

    expect(delays).toEqual([75]);
  });

  it("does not retry a permanent failure", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({ data: buildFakeStripeData({ charges: 2 }) });
    transport.failAt({ target: "charges", page: 1, category: "permanent" });
    const { sleep, delays } = recordingSleep();

    const result = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
      sleep,
      random: NO_JITTER,
    });

    expect(result.status).toBe("failed");
    expect(transport.requestsFor("charges")).toHaveLength(1);
    expect(result.stats.charges?.attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  it("does not retry an auth failure", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({ data: buildFakeStripeData({ charges: 2 }) });
    transport.failAt({ target: "charges", page: 1, category: "auth" });
    const { sleep, delays } = recordingSleep();

    const result = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
      sleep,
      random: NO_JITTER,
    });

    expect(result.stats.charges?.errorCategory).toBe("auth");
    expect(transport.requestsFor("charges")).toHaveLength(1);
    expect(delays).toEqual([]);
  });
});

describe("runSync partial failures", () => {
  it("keeps syncing other resources when one fails, and reports partial", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({
      data: buildFakeStripeData({ customers: 4, charges: 3, payouts: 2 }),
      pageSize: 10,
    });
    transport.failAt({ target: "customers", page: 1, category: "permission" });
    const { sleep } = recordingSleep();

    const result = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["customers", "charges", "payouts"],
      sleep,
      random: NO_JITTER,
    });

    expect(result.status).toBe("partial");
    expect(result.errorCategory).toBe("permission");
    expect(result.stats.customers?.status).toBe("failed");
    expect(result.stats.charges?.status).toBe("succeeded");
    expect(result.stats.payouts?.status).toBe("succeeded");

    expect(await store.countProviderRows(ORG_A, "customers")).toBe(0);
    expect(await store.countProviderRows(ORG_A, "charges")).toBe(3);
    expect(await store.countProviderRows(ORG_A, "payouts")).toBe(2);

    // Only the failed resource keeps a null success marker.
    expect(
      (await store.findCheckpoint(ORG_A, connectionId, "customers"))?.lastSuccessfulAt,
    ).toBeNull();
    expect((await store.findCheckpoint(ORG_A, connectionId, "charges"))?.lastSuccessfulAt).toEqual(
      NOW_1,
    );
  });

  it("reports failed when every resource fails", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({ data: buildFakeStripeData({ charges: 1 }) });
    transport.failAt({ target: "charges", page: 1, category: "auth" });
    transport.failAt({ target: "payouts", page: 1, category: "auth" });
    const { sleep } = recordingSleep();

    const result = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges", "payouts"],
      sleep,
      random: NO_JITTER,
    });

    expect(result.status).toBe("failed");
    expect(result.errorCategory).toBe("auth");
  });

  it("does not delete previously synced data when a later run fails", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({ data: buildFakeStripeData({ charges: 4 }) });
    const { sleep } = recordingSleep();

    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
      sleep,
    });
    expect(await store.countProviderRows(ORG_A, "charges")).toBe(4);

    transport.failAt({ target: "charges", page: 1, category: "auth" });
    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_2,
      resources: ["charges"],
      sleep,
    });

    expect(await store.countProviderRows(ORG_A, "charges")).toBe(4);
  });
});

describe("runSync run bookkeeping", () => {
  it("records a run row that ends in the reported status with per-resource stats", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({
      data: buildFakeStripeData({ charges: 5 }),
      pageSize: 2,
    });

    const result = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
      pageSize: 2,
    });

    const run = await store.findSyncRun(ORG_A, result.runId);
    expect(run?.status).toBe("succeeded");
    expect(run?.startedAt).toEqual(NOW_1);
    expect(run?.finishedAt).toEqual(NOW_1);
    expect(run?.isInitial).toBe(true);
    expect(run?.stats).toMatchObject({
      charges: { status: "succeeded", fetched: 5, upserted: 5, pages: 3 },
    });
    expect(run?.errorMessage).toBeNull();
  });

  it("writes sync.started and sync.succeeded audit events", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({ data: buildFakeStripeData({ charges: 1 }) });

    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
    });

    const actions = store.auditEvents().map((event) => event.action);
    expect(actions).toEqual(["sync.started", "sync.succeeded"]);
    for (const event of store.auditEvents()) {
      expect(event.organizationId).toBe(ORG_A);
      expect(event.targetId).toBe(connectionId);
    }
  });

  it("audits a partial run as a failure so the gap is visible", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({
      data: buildFakeStripeData({ charges: 1, payouts: 1 }),
    });
    transport.failAt({ target: "payouts", page: 1, category: "permission" });
    const { sleep } = recordingSleep();

    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges", "payouts"],
      sleep,
    });

    const actions = store.auditEvents().map((event) => event.action);
    expect(actions).toEqual(["sync.started", "sync.failed"]);
  });

  /**
   * The regression this guards: a Stripe message echoing the submitted key must
   * not reach `sync_runs`, the per-resource stats, or the audit trail.
   */
  it("keeps key material out of every stored error surface", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const transport = createFakeStripeTransport({ data: buildFakeStripeData({ charges: 1 }) });
    transport.failAt({
      target: "charges",
      page: 1,
      throws: () =>
        Object.assign(new Error("Invalid API Key provided: rk_live_ZYXWVUTS9876543210zyxwvuABCD"), {
          statusCode: 401,
        }),
    });
    const { sleep } = recordingSleep();

    const result = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["charges"],
      sleep,
    });

    const run = await store.findSyncRun(ORG_A, result.runId);
    const surfaces = [
      result.errorMessage ?? "",
      result.stats.charges?.errorMessage ?? "",
      JSON.stringify(run?.stats ?? {}),
      run?.errorMessage ?? "",
      JSON.stringify(store.auditEvents()),
    ];
    for (const surface of surfaces) {
      expect(surface).not.toContain("rk_live_");
      expect(surface).not.toContain("ZYXWVUTS9876543210zyxwvuABCD");
    }
    expect(result.stats.charges?.errorMessage).toContain("[redacted]");
  });
});

describe("runSync normalisation", () => {
  it("stores bigint minor units and uppercase currencies", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const data = buildFakeStripeData({ charges: 2, refunds: 2 });
    const transport = createFakeStripeTransport({ data });

    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["refunds", "charges"],
    });

    const charges = store.providerRowsFor(ORG_A, "charges") as unknown as ProviderPaymentRow[];
    expect(charges).toHaveLength(2);
    for (const charge of charges) {
      expect(typeof charge.amountMinor).toBe("bigint");
      expect(charge.currency).toMatch(/^[A-Z]{3}$/);
    }

    const refunds = store.providerRowsFor(ORG_A, "refunds") as unknown as ProviderRefundRow[];
    for (const refund of refunds) expect(refund.currency).toMatch(/^[A-Z]{3}$/);
  });

  it("derives amountRefundedMinor and disputed for payment intents from other resources", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);

    const created = new Date("2026-01-01T00:00:00.000Z");
    const transport = createFakeStripeTransport({
      data: {
        ...buildFakeStripeData({}),
        paymentIntents: [
          {
            id: "pi_test_1",
            status: "succeeded",
            amountMinor: 5_000n,
            currency: "usd",
            customerId: "cus_1",
            invoiceId: null,
            created,
            metadata: {},
          },
        ],
        refunds: [
          {
            id: "re_1",
            chargeId: null,
            paymentIntentId: "pi_test_1",
            amountMinor: 1_200n,
            currency: "usd",
            status: "succeeded",
            created,
          },
          {
            id: "re_2",
            chargeId: null,
            paymentIntentId: "pi_test_1",
            amountMinor: 300n,
            currency: "usd",
            status: "succeeded",
            created,
          },
          // Failed refunds must not reduce the payment's value.
          {
            id: "re_3",
            chargeId: null,
            paymentIntentId: "pi_test_1",
            amountMinor: 900n,
            currency: "usd",
            status: "failed",
            created,
          },
        ],
        disputes: [
          {
            id: "dp_1",
            chargeId: null,
            paymentIntentId: "pi_test_1",
            amountMinor: 5_000n,
            currency: "usd",
            status: "needs_response",
            reason: "fraudulent",
            created,
          },
        ],
      },
    });

    await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["refunds", "disputes", "payment_intents"],
    });

    const [payment] = store.providerRowsFor(
      ORG_A,
      "payment_intents",
    ) as unknown as ProviderPaymentRow[];
    expect(payment?.amountRefundedMinor).toBe(1_500n);
    expect(payment?.disputed).toBe(true);
    expect(payment?.currency).toBe("USD");
    expect(payment?.kind).toBe("payment_intent");
  });

  it("skips records whose status or currency cannot be represented", async () => {
    const store = createMemoryStore();
    const connectionId = await seedConnection(store);
    const created = new Date("2026-01-01T00:00:00.000Z");

    const transport = createFakeStripeTransport({
      data: {
        ...buildFakeStripeData({}),
        paymentIntents: [
          {
            id: "pi_ok",
            status: "succeeded",
            amountMinor: 100n,
            currency: "usd",
            customerId: null,
            invoiceId: null,
            created,
            metadata: {},
          },
          {
            id: "pi_unknown_status",
            status: "some_future_stripe_status",
            amountMinor: 100n,
            currency: "usd",
            customerId: null,
            invoiceId: null,
            created,
            metadata: {},
          },
          {
            id: "pi_bad_currency",
            status: "succeeded",
            amountMinor: 100n,
            currency: "dollars",
            customerId: null,
            invoiceId: null,
            created,
            metadata: {},
          },
        ],
      },
    });

    const result = await runSync(store, {
      organizationId: ORG_A,
      connectionId,
      transport,
      isInitial: true,
      now: NOW_1,
      resources: ["payment_intents"],
    });

    expect(result.status).toBe("succeeded");
    expect(result.stats.payment_intents?.fetched).toBe(3);
    expect(result.stats.payment_intents?.skipped).toBe(2);
    expect(await store.countProviderRows(ORG_A, "payment_intents")).toBe(1);
  });
});

describe("boundMetadata", () => {
  it("keeps a bounded, sorted, redacted subset", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 25; i += 1) wide[`k${i.toString().padStart(2, "0")}`] = `v${i}`;

    const bounded = boundMetadata(wide);
    expect(Object.keys(bounded)).toHaveLength(10);
    expect(Object.keys(bounded)).toEqual([...Object.keys(bounded)].sort());
  });

  it("truncates long values and redacts credential-shaped ones", () => {
    const bounded = boundMetadata({
      note: "x".repeat(1_000),
      leaked: "key is rk_live_ZYXWVUTS9876543210zyxwvuABCD",
    });
    expect(bounded.note?.length).toBe(200);
    expect(bounded.leaked).not.toContain("rk_live_");
    expect(bounded.leaked).toContain("[redacted]");
  });
});
