import { describe, expect, it } from "vitest";
import { StripeSyncError } from "./errors";
import { FIXTURE_EPOCH, buildFakeStripeData, createFakeStripeTransport } from "./fake-transport";

describe("buildFakeStripeData", () => {
  it("is deterministic: identical specs produce identical data", () => {
    const a = buildFakeStripeData({ customers: 3, charges: 5, refunds: 2 });
    const b = buildFakeStripeData({ customers: 3, charges: 5, refunds: 2 });
    // JSON cannot carry bigint, so compare through a replacer that can.
    const serialise = (value: unknown) =>
      JSON.stringify(value, (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      );
    expect(serialise(a)).toBe(serialise(b));
  });

  it("generates distinct ids and ascending timestamps", () => {
    const data = buildFakeStripeData({ charges: 4 });
    expect(new Set(data.charges.map((charge) => charge.id)).size).toBe(4);
    const created = data.charges.map((charge) => charge.created.getTime());
    expect(created).toEqual([...created].sort((x, y) => x - y));
    expect(created[0]).toBe(FIXTURE_EPOCH.getTime());
  });

  it("produces bigint minor amounts, never numbers", () => {
    const data = buildFakeStripeData({ charges: 3, payouts: 2 });
    for (const charge of data.charges) expect(typeof charge.amountMinor).toBe("bigint");
    for (const payout of data.payouts) expect(typeof payout.amountMinor).toBe("bigint");
  });

  it("links refunds and disputes to real charges", () => {
    const data = buildFakeStripeData({ charges: 3, refunds: 3, disputes: 2 });
    const chargeIds = new Set(data.charges.map((charge) => charge.id));
    for (const refund of data.refunds) expect(chargeIds.has(refund.chargeId ?? "")).toBe(true);
    for (const dispute of data.disputes) expect(chargeIds.has(dispute.chargeId ?? "")).toBe(true);
  });
});

describe("FakeStripeTransport pagination", () => {
  it("pages through a list with a cursor, newest first", async () => {
    const data = buildFakeStripeData({ customers: 5 });
    const transport = createFakeStripeTransport({ data, pageSize: 2 });

    const first = await transport.listCustomers({ limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.lastId).toBe(first.data[1]?.id);
    // Newest first, as Stripe returns.
    expect(first.data[0]?.created.getTime()).toBeGreaterThan(first.data[1]?.created.getTime() ?? 0);

    const second = await transport.listCustomers({ limit: 2, startingAfter: first.lastId ?? "" });
    expect(second.data).toHaveLength(2);
    expect(second.hasMore).toBe(true);

    const third = await transport.listCustomers({ limit: 2, startingAfter: second.lastId ?? "" });
    expect(third.data).toHaveLength(1);
    expect(third.hasMore).toBe(false);

    const seen = [...first.data, ...second.data, ...third.data].map((item) => item.id);
    expect(new Set(seen).size).toBe(5);
  });

  it("returns an empty terminal page for an empty resource", async () => {
    const transport = createFakeStripeTransport({ pageSize: 2 });
    const page = await transport.listPayouts({ limit: 2 });
    expect(page).toEqual({ data: [], hasMore: false, lastId: null });
  });

  it("filters by createdGte, as an incremental sync requires", async () => {
    const data = buildFakeStripeData({ charges: 5 });
    const transport = createFakeStripeTransport({ data, pageSize: 10 });
    const cutoff = data.charges[3]?.created;
    if (!cutoff) throw new Error("fixture missing");

    const page = await transport.listCharges({ limit: 10, createdGte: cutoff });
    expect(page.data).toHaveLength(2);
    for (const charge of page.data) {
      expect(charge.created.getTime()).toBeGreaterThanOrEqual(cutoff.getTime());
    }
  });

  it("records what was actually requested", async () => {
    const data = buildFakeStripeData({ charges: 3 });
    const transport = createFakeStripeTransport({ data, pageSize: 2 });
    await transport.listCharges({ limit: 2 });
    await transport.listCharges({ limit: 2, startingAfter: data.charges[1]?.id });

    const requests = transport.requestsFor("charges");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.startingAfter).toBeNull();
    expect(requests[0]?.page).toBe(1);
    expect(requests[1]?.startingAfter).toBe(data.charges[1]?.id);
  });
});

describe("FakeStripeTransport failure injection", () => {
  it("fails at the chosen page and lets earlier pages through", async () => {
    const data = buildFakeStripeData({ charges: 6 });
    const transport = createFakeStripeTransport({ data, pageSize: 2 });
    transport.failAt({ target: "charges", page: 2, category: "transient" });

    const first = await transport.listCharges({ limit: 2 });
    expect(first.data).toHaveLength(2);

    await expect(
      transport.listCharges({ limit: 2, startingAfter: first.lastId ?? "" }),
    ).rejects.toBeInstanceOf(StripeSyncError);
  });

  it("heals after the configured number of failures", async () => {
    const data = buildFakeStripeData({ charges: 2 });
    const transport = createFakeStripeTransport({ data, pageSize: 10 });
    transport.failAt({ target: "charges", page: 1, category: "transient", times: 2 });

    await expect(transport.listCharges({ limit: 10 })).rejects.toBeInstanceOf(StripeSyncError);
    await expect(transport.listCharges({ limit: 10 })).rejects.toBeInstanceOf(StripeSyncError);
    const page = await transport.listCharges({ limit: 10 });
    expect(page.data).toHaveLength(2);
  });

  it("can throw a raw Stripe-shaped error so classification is exercised", async () => {
    const transport = createFakeStripeTransport({ data: buildFakeStripeData({ charges: 1 }) });
    transport.failAt({
      target: "charges",
      page: 1,
      throws: () => Object.assign(new Error("Too many requests"), { statusCode: 429 }),
    });
    await expect(transport.listCharges({ limit: 10 })).rejects.toMatchObject({ statusCode: 429 });
  });

  it("can fail account retrieval, which is how validation failures are simulated", async () => {
    const transport = createFakeStripeTransport();
    transport.failAt({ target: "account", category: "permission" });
    await expect(transport.retrieveAccount()).rejects.toMatchObject({ category: "permission" });

    transport.clearFailures();
    await expect(transport.retrieveAccount()).resolves.toMatchObject({ livemode: false });
  });

  it("reports the account it was seeded with", async () => {
    const transport = createFakeStripeTransport({
      account: { id: "acct_seeded", displayName: "Acme", livemode: true },
    });
    await expect(transport.retrieveAccount()).resolves.toEqual({
      id: "acct_seeded",
      displayName: "Acme",
      livemode: true,
    });
  });
});
