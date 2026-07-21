import { describe, expect, it } from "vitest";
import { MatchIndex } from "./matching";
import {
  DEFAULT_RECONCILIATION_CONFIG,
  type InternalPaymentRecord,
  type ProviderPayment,
  type ReconciliationConfig,
} from "./types";

const NOW = new Date("2026-03-01T12:00:00Z");
const ORG = "org_match";

const hoursBefore = (hours: number): Date => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

function payment(overrides: Partial<ProviderPayment> = {}): ProviderPayment {
  return {
    id: "pi_1",
    organizationId: ORG,
    connectionId: "conn_1",
    kind: "payment_intent",
    status: "succeeded",
    amountMinor: 10_000n,
    currency: "USD",
    amountRefundedMinor: 0n,
    createdAt: hoursBefore(5),
    customerId: "cus_1",
    invoiceId: null,
    paymentIntentId: null,
    disputed: false,
    metadata: {},
    ...overrides,
  };
}

function record(overrides: Partial<InternalPaymentRecord> = {}): InternalPaymentRecord {
  return {
    id: "rec_1",
    organizationId: ORG,
    externalId: "order-1",
    customerId: "cus_1",
    orderId: null,
    subscriptionId: null,
    providerTransactionId: null,
    amountMinor: 10_000n,
    currency: "USD",
    status: "paid",
    occurredAt: hoursBefore(5),
    recordUpdatedAt: null,
    metadata: {},
    ...overrides,
  };
}

const index = (
  payments: ProviderPayment[],
  records: InternalPaymentRecord[],
  config: ReconciliationConfig = DEFAULT_RECONCILIATION_CONFIG,
): MatchIndex => new MatchIndex(payments, records, config);

describe("strong matches", () => {
  it("matches when the internal record names the provider transaction id", () => {
    const p = payment({ id: "pi_abc", customerId: null });
    const r = record({ providerTransactionId: "pi_abc", customerId: null });
    const idx = index([p], [r]);

    expect(idx.findInternalFor(p)).toEqual({ value: r, confidence: "strong", ambiguous: false });
    expect(idx.findProviderFor(r)).toEqual({ value: p, confidence: "strong", ambiguous: false });
  });

  it("matches via the payrecon_external_id metadata key", () => {
    const p = payment({ customerId: null, metadata: { payrecon_external_id: "order-42" } });
    const r = record({ externalId: "order-42", customerId: null });
    const idx = index([p], [r]);

    expect(idx.findInternalFor(p)).toEqual({ value: r, confidence: "strong", ambiguous: false });
    expect(idx.findProviderFor(r)).toEqual({ value: p, confidence: "strong", ambiguous: false });
  });

  it("trims a metadata correlation id and ignores empty ones", () => {
    const p = payment({ customerId: null, metadata: { payrecon_external_id: "  order-42  " } });
    const r = record({ externalId: "order-42", customerId: null });
    expect(index([p], [r]).findInternalFor(p).value).toBe(r);

    const blank = payment({ customerId: null, metadata: { payrecon_external_id: "   " } });
    expect(index([blank], [r]).findInternalFor(blank)).toEqual({
      value: null,
      confidence: "none",
      ambiguous: false,
    });
  });

  it("honours the documented metadata key precedence", () => {
    const p = payment({
      customerId: null,
      metadata: { order_id: "order-b", payrecon_external_id: "order-a" },
    });
    const a = record({ id: "rec_a", externalId: "order-a", customerId: null });
    const b = record({ id: "rec_b", externalId: "order-b", customerId: null });

    expect(index([p], [a, b]).findInternalFor(p).value).toBe(a);
  });

  it("falls through to a lower-precedence metadata key when the first is absent", () => {
    const p = payment({ customerId: null, metadata: { order_id: "order-b" } });
    const b = record({ id: "rec_b", externalId: "order-b", customerId: null });
    expect(index([p], [b]).findInternalFor(p)).toEqual({
      value: b,
      confidence: "strong",
      ambiguous: false,
    });
  });

  it("matches when the internal record names a CHARGE's payment intent id", () => {
    const charge = payment({
      id: "ch_1",
      kind: "charge",
      paymentIntentId: "pi_parent",
      customerId: null,
    });
    const r = record({ providerTransactionId: "pi_parent", customerId: null });
    const idx = index([charge], [r]);

    expect(idx.findInternalFor(charge)).toEqual({
      value: r,
      confidence: "strong",
      ambiguous: false,
    });
    expect(idx.findProviderFor(r)).toEqual({
      value: charge,
      confidence: "strong",
      ambiguous: false,
    });
  });

  it("reports ambiguity when two charges share one payment intent id", () => {
    const a = payment({ id: "ch_a", kind: "charge", paymentIntentId: "pi_parent" });
    const b = payment({ id: "ch_b", kind: "charge", paymentIntentId: "pi_parent" });
    const r = record({ providerTransactionId: "pi_parent" });

    expect(index([a, b], [r]).findProviderFor(r)).toEqual({
      value: null,
      confidence: "strong",
      ambiguous: true,
    });
  });

  it("reports ambiguity when two internal records name the same transaction", () => {
    const p = payment({ id: "pi_abc" });
    const a = record({ id: "rec_a", externalId: "order-a", providerTransactionId: "pi_abc" });
    const b = record({ id: "rec_b", externalId: "order-b", providerTransactionId: "pi_abc" });

    expect(index([p], [a, b]).findInternalFor(p)).toEqual({
      value: null,
      confidence: "strong",
      ambiguous: true,
    });
  });

  it("does not double-count one record reachable by both id and payment intent id", () => {
    // The record names the charge id; the charge also carries a payment intent
    // id. The record must still resolve to exactly one strong match.
    const charge = payment({ id: "ch_1", kind: "charge", paymentIntentId: "pi_parent" });
    const r = record({ providerTransactionId: "ch_1" });
    const both = record({ id: "rec_dup", externalId: "order-dup", providerTransactionId: "ch_1" });

    expect(index([charge], [r]).findInternalFor(charge)).toEqual({
      value: r,
      confidence: "strong",
      ambiguous: false,
    });
    expect(index([charge], [r, both]).findInternalFor(charge).ambiguous).toBe(true);
  });

  it("beats a heuristic candidate with an explicit link", () => {
    const named = payment({ id: "pi_named", metadata: { payrecon_external_id: "order-1" } });
    const r = record({ externalId: "order-1" });
    expect(index([named], [r]).findInternalFor(named).confidence).toBe("strong");
  });
});

describe("heuristic matches", () => {
  it("matches only when mutually unique on customer, amount, currency and window", () => {
    const p = payment({ id: "pi_h" });
    const r = record({ id: "rec_h" });
    const idx = index([p], [r]);

    expect(idx.findInternalFor(p)).toEqual({ value: r, confidence: "heuristic", ambiguous: false });
    expect(idx.findProviderFor(r)).toEqual({ value: p, confidence: "heuristic", ambiguous: false });
  });

  it("does not match across a differing amount, currency or customer", () => {
    const p = payment();
    for (const r of [
      record({ amountMinor: 9_999n }),
      record({ currency: "EUR" }),
      record({ customerId: "cus_other" }),
    ]) {
      const idx = index([p], [r]);
      expect(idx.findInternalFor(p)).toEqual({
        value: null,
        confidence: "none",
        ambiguous: false,
      });
      expect(idx.findProviderFor(r)).toEqual({
        value: null,
        confidence: "none",
        ambiguous: false,
      });
    }
  });

  it("does not match outside the configured window", () => {
    const p = payment({ createdAt: hoursBefore(1) });
    const r = record({ occurredAt: hoursBefore(80) }); // window is 72h
    const idx = index([p], [r]);

    expect(idx.findInternalFor(p)).toEqual({ value: null, confidence: "none", ambiguous: false });
    expect(idx.findProviderFor(r)).toEqual({ value: null, confidence: "none", ambiguous: false });
  });

  it("respects a narrowed window from config", () => {
    const narrow: ReconciliationConfig = {
      ...DEFAULT_RECONCILIATION_CONFIG,
      heuristicMatchWindowHours: 1,
    };
    const p = payment({ createdAt: hoursBefore(1) });
    const r = record({ occurredAt: hoursBefore(5) });

    expect(index([p], [r]).findInternalFor(p).value).toBe(r);
    expect(index([p], [r], narrow).findInternalFor(p).value).toBeNull();
  });

  it("reports AMBIGUOUS when two internal records share customer, amount and currency", () => {
    const p = payment({ id: "pi_amb" });
    const a = record({ id: "rec_a", externalId: "order-a" });
    const b = record({ id: "rec_b", externalId: "order-b" });

    const outcome = index([p], [a, b]).findInternalFor(p);
    expect(outcome.value).toBeNull();
    expect(outcome.ambiguous).toBe(true);
    expect(outcome.confidence).toBe("heuristic");
  });

  it("reports AMBIGUOUS when two provider payments share customer, amount and currency", () => {
    const a = payment({ id: "pi_a" });
    const b = payment({ id: "pi_b" });
    const r = record();
    const idx = index([a, b], [r]);

    const fromRecord = idx.findProviderFor(r);
    expect(fromRecord.value).toBeNull();
    expect(fromRecord.ambiguous).toBe(true);
    expect(fromRecord.confidence).toBe("heuristic");

    // The same insufficiency is reported from the provider side, via the
    // mutual-uniqueness check.
    const fromPayment = idx.findInternalFor(a);
    expect(fromPayment.value).toBeNull();
    expect(fromPayment.ambiguous).toBe(true);
    expect(fromPayment.confidence).toBe("heuristic");
  });

  it("never guesses heuristically when the customer id is null", () => {
    const p = payment({ customerId: null });
    const r = record({ customerId: null });
    const idx = index([p], [r]);

    expect(idx.findInternalFor(p)).toEqual({ value: null, confidence: "none", ambiguous: false });
    expect(idx.findProviderFor(r)).toEqual({ value: null, confidence: "none", ambiguous: false });
  });

  it("requires a customer id on BOTH sides", () => {
    expect(
      index([payment({ customerId: null })], [record()]).findInternalFor(
        payment({ customerId: null }),
      ),
    ).toEqual({ value: null, confidence: "none", ambiguous: false });

    const p = payment();
    expect(index([p], [record({ customerId: null })]).findInternalFor(p)).toEqual({
      value: null,
      confidence: "none",
      ambiguous: false,
    });
  });

  it("excludes an internal record already bound to a different provider transaction", () => {
    const p = payment({ id: "pi_1" });
    const r = record({ providerTransactionId: "pi_elsewhere" });

    expect(index([p], [r]).findInternalFor(p)).toEqual({
      value: null,
      confidence: "none",
      ambiguous: false,
    });
  });
});

describe("a record naming a transaction the provider does not have", () => {
  it("is a signal, not an ambiguity", () => {
    const r = record({ providerTransactionId: "pi_does_not_exist" });
    const outcome = index([payment({ id: "pi_other" })], [r]).findProviderFor(r);

    expect(outcome.value).toBeNull();
    expect(outcome.confidence).toBe("none");
    expect(outcome.ambiguous).toBe(false);
  });

  it("is not rescued by an otherwise plausible heuristic candidate", () => {
    // A payment that would have matched heuristically must NOT be substituted
    // for the transaction the record explicitly named.
    const plausible = payment({ id: "pi_other" });
    const r = record({ providerTransactionId: "pi_does_not_exist" });

    expect(index([plausible], [r]).findProviderFor(r)).toEqual({
      value: null,
      confidence: "none",
      ambiguous: false,
    });
  });
});

describe("empty inputs", () => {
  it("returns a clean miss", () => {
    const p = payment();
    const r = record();
    expect(index([], []).findInternalFor(p)).toEqual({
      value: null,
      confidence: "none",
      ambiguous: false,
    });
    expect(index([], []).findProviderFor(r)).toEqual({
      value: null,
      confidence: "none",
      ambiguous: false,
    });
  });
});
