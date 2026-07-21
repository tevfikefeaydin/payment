import { describe, expect, it } from "vitest";
import { buildFingerprint } from "./fingerprint";
import { RULE_VERSION, runReconciliation } from "./reconciliation";
import {
  DEFAULT_RECONCILIATION_CONFIG,
  type ExceptionCandidate,
  type InternalPaymentRecord,
  type ProviderInvoice,
  type ProviderPayment,
  type ProviderRefund,
  type ProviderSubscription,
  type ReconciliationInput,
  type ReconciliationResult,
  type ReconciliationRuleId,
} from "./types";

// ---------------------------------------------------------------------------
// Fixed clock and fixtures
// ---------------------------------------------------------------------------

/** Every test evaluates against this instant. Nothing reads the wall clock. */
const NOW = new Date("2026-03-01T12:00:00Z");
const ORG = "org_recon";
const CONNECTION = "conn_1";

const minutesBefore = (minutes: number): Date => new Date(NOW.getTime() - minutes * 60_000);
const hoursBefore = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);

function providerPayment(overrides: Partial<ProviderPayment> = {}): ProviderPayment {
  return {
    id: "pi_1",
    organizationId: ORG,
    connectionId: CONNECTION,
    kind: "payment_intent",
    status: "succeeded",
    amountMinor: 10_000n,
    currency: "USD",
    amountRefundedMinor: 0n,
    createdAt: hoursBefore(3),
    customerId: "cus_1",
    invoiceId: null,
    paymentIntentId: null,
    disputed: false,
    metadata: {},
    ...overrides,
  };
}

function internalRecord(overrides: Partial<InternalPaymentRecord> = {}): InternalPaymentRecord {
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
    occurredAt: hoursBefore(3),
    recordUpdatedAt: null,
    metadata: {},
    ...overrides,
  };
}

function providerRefund(overrides: Partial<ProviderRefund> = {}): ProviderRefund {
  return {
    id: "re_1",
    organizationId: ORG,
    connectionId: CONNECTION,
    paymentId: "pi_1",
    amountMinor: 4_000n,
    currency: "USD",
    status: "succeeded",
    createdAt: hoursBefore(3),
    ...overrides,
  };
}

function providerInvoice(overrides: Partial<ProviderInvoice> = {}): ProviderInvoice {
  return {
    id: "in_1",
    organizationId: ORG,
    connectionId: CONNECTION,
    status: "paid",
    amountDueMinor: 5_000n,
    amountPaidMinor: 5_000n,
    currency: "USD",
    customerId: "cus_1",
    subscriptionId: "sub_1",
    createdAt: hoursBefore(5),
    paidAt: hoursBefore(1),
    attemptCount: 0,
    ...overrides,
  };
}

function providerSubscription(overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return {
    id: "sub_1",
    organizationId: ORG,
    connectionId: CONNECTION,
    status: "active",
    customerId: "cus_1",
    currency: "USD",
    createdAt: hoursBefore(1000),
    canceledAt: null,
    currentPeriodStart: hoursBefore(200),
    currentPeriodEnd: hoursBefore(-500),
    ...overrides,
  };
}

function run(overrides: Partial<ReconciliationInput> = {}): ReconciliationResult {
  return runReconciliation({
    organizationId: ORG,
    now: NOW,
    providerPayments: [],
    providerRefunds: [],
    providerInvoices: [],
    providerSubscriptions: [],
    internalRecords: [],
    config: DEFAULT_RECONCILIATION_CONFIG,
    ...overrides,
  });
}

const forRule = (result: ReconciliationResult, ruleId: ReconciliationRuleId) =>
  result.candidates.filter((candidate) => candidate.ruleId === ruleId);

function onlyFor(result: ReconciliationResult, ruleId: ReconciliationRuleId): ExceptionCandidate {
  const found = forRule(result, ruleId);
  expect(found, `expected exactly one ${ruleId}`).toHaveLength(1);
  const first = found[0];
  if (!first) throw new Error(`no candidate for ${ruleId}`);
  return first;
}

const evidenceValue = (candidate: ExceptionCandidate, label: string) =>
  candidate.evidence.find((row) => row.label === label);

// ---------------------------------------------------------------------------
// Rule 1 — PAYMENT_SUCCEEDED_INTERNAL_MISSING
// ---------------------------------------------------------------------------

describe("rule 1: PAYMENT_SUCCEEDED_INTERNAL_MISSING", () => {
  it("TRIGGERS when Stripe captured money and nothing internal matches", () => {
    const payment = providerPayment({ id: "pi_missing", createdAt: hoursBefore(2) });
    const result = run({ providerPayments: [payment] });

    const candidate = onlyFor(result, "PAYMENT_SUCCEEDED_INTERNAL_MISSING");
    expect(result.candidates).toHaveLength(1);
    expect(candidate.severity).toBe("critical");
    expect(candidate.revenueAtRiskMinor).toBe(10_000n);
    expect(candidate.currency).toBe("USD");
    expect(candidate.providerObjectId).toBe("pi_missing");
    expect(candidate.internalRecordId).toBeNull();
    expect(candidate.internalExternalId).toBeNull();
    expect(candidate.occurredAt).toEqual(payment.createdAt);
    expect(candidate.ruleVersion).toBe(RULE_VERSION);
    expect(candidate.summary).toContain("100.00 USD");
    expect(candidate.probableCauses.length).toBeGreaterThan(0);
    expect(candidate.recommendedActions.length).toBeGreaterThan(0);
    expect(candidate.fingerprint).toBe(
      buildFingerprint(ORG, "PAYMENT_SUCCEEDED_INTERNAL_MISSING", ["pi_missing"]),
    );
    expect(evidenceValue(candidate, "Status")?.providerValue).toBe("succeeded");
    expect(evidenceValue(candidate, "Status")?.internalValue).toBe("not found");
  });

  it("nets an existing refund off the revenue at risk", () => {
    const result = run({
      providerPayments: [
        providerPayment({ id: "pi_part", createdAt: hoursBefore(2), amountRefundedMinor: 4_000n }),
      ],
    });
    expect(onlyFor(result, "PAYMENT_SUCCEEDED_INTERNAL_MISSING").revenueAtRiskMinor).toBe(6_000n);
  });

  it("never reports negative risk when more was refunded than captured", () => {
    const result = run({
      providerPayments: [
        providerPayment({ id: "pi_over", createdAt: hoursBefore(2), amountRefundedMinor: 15_000n }),
      ],
    });
    expect(onlyFor(result, "PAYMENT_SUCCEEDED_INTERNAL_MISSING").revenueAtRiskMinor).toBe(0n);
  });

  it("does NOT trigger inside the 30-minute propagation grace window", () => {
    const result = run({
      providerPayments: [providerPayment({ id: "pi_fresh", createdAt: minutesBefore(10) })],
    });

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.withinPropagationGrace).toBe(1);
  });

  it("triggers as soon as the grace window has elapsed", () => {
    const inside = run({
      providerPayments: [providerPayment({ id: "pi_edge", createdAt: minutesBefore(29) })],
    });
    const outside = run({
      providerPayments: [providerPayment({ id: "pi_edge", createdAt: minutesBefore(31) })],
    });

    expect(inside.candidates).toEqual([]);
    expect(forRule(outside, "PAYMENT_SUCCEEDED_INTERNAL_MISSING")).toHaveLength(1);
  });

  it("does NOT trigger when a matching internal record exists", () => {
    const result = run({
      providerPayments: [providerPayment({ id: "pi_ok", createdAt: hoursBefore(2) })],
      internalRecords: [internalRecord({ providerTransactionId: "pi_ok" })],
    });
    expect(forRule(result, "PAYMENT_SUCCEEDED_INTERNAL_MISSING")).toEqual([]);
  });

  it("does NOT trigger for a payment that did not succeed", () => {
    for (const status of ["failed", "canceled", "processing", "requires_action"] as const) {
      const result = run({
        providerPayments: [providerPayment({ id: "pi_x", status, createdAt: hoursBefore(2) })],
      });
      expect(result.candidates, status).toEqual([]);
    }
  });

  it("counts an ambiguous match as a diagnostic instead of emitting a guess", () => {
    const result = run({
      providerPayments: [providerPayment({ id: "pi_amb", createdAt: hoursBefore(2) })],
      internalRecords: [
        internalRecord({ id: "rec_a", externalId: "order-a" }),
        internalRecord({ id: "rec_b", externalId: "order-b" }),
      ],
    });

    expect(forRule(result, "PAYMENT_SUCCEEDED_INTERNAL_MISSING")).toEqual([]);
    expect(result.diagnostics.ambiguousProviderMatches).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID
// ---------------------------------------------------------------------------

describe("rule 2: PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID", () => {
  const scenario = (status: InternalPaymentRecord["status"]) =>
    run({
      providerPayments: [providerPayment({ id: "pi_np", createdAt: hoursBefore(2) })],
      internalRecords: [
        internalRecord({
          externalId: "order-np",
          providerTransactionId: "pi_np",
          status,
          occurredAt: hoursBefore(2),
        }),
      ],
    });

  it("TRIGGERS when the linked internal record is still pending", () => {
    const result = scenario("pending");
    const candidate = onlyFor(result, "PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID");

    expect(result.candidates).toHaveLength(1);
    expect(candidate.severity).toBe("high");
    expect(candidate.revenueAtRiskMinor).toBe(10_000n);
    expect(candidate.currency).toBe("USD");
    expect(candidate.providerObjectId).toBe("pi_np");
    expect(candidate.internalExternalId).toBe("order-np");
    expect(candidate.summary).toContain('"pending"');
    expect(candidate.fingerprint).toBe(
      buildFingerprint(ORG, "PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID", ["pi_np", "order-np"]),
    );
    expect(evidenceValue(candidate, "Status")?.differs).toBe(true);
  });

  it("escalates to critical when the internal record says the payment FAILED", () => {
    const candidate = onlyFor(scenario("failed"), "PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID");
    expect(candidate.severity).toBe("critical");
    expect(candidate.probableCauses[0]).toContain("recorded a failure");
  });

  it("does NOT trigger when the internal record is paid", () => {
    const result = scenario("paid");
    expect(forRule(result, "PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID")).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("does NOT trigger when the internal record is refunded or partially refunded", () => {
    for (const status of ["refunded", "partially_refunded"] as const) {
      const result = scenario(status);
      expect(forRule(result, "PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID"), status).toEqual([]);
    }
  });

  it("does NOT trigger inside the propagation grace window", () => {
    const result = run({
      providerPayments: [providerPayment({ id: "pi_np", createdAt: minutesBefore(10) })],
      internalRecords: [
        internalRecord({
          providerTransactionId: "pi_np",
          status: "pending",
          occurredAt: minutesBefore(10),
        }),
      ],
    });
    expect(forRule(result, "PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — INTERNAL_PAID_PROVIDER_MISSING
// ---------------------------------------------------------------------------

describe("rule 3: INTERNAL_PAID_PROVIDER_MISSING", () => {
  it("TRIGGERS when a paid record names a transaction the provider does not have", () => {
    const record = internalRecord({
      externalId: "order-ghost",
      providerTransactionId: "pi_ghost",
      occurredAt: hoursBefore(2),
    });
    const result = run({ internalRecords: [record] });
    const candidate = onlyFor(result, "INTERNAL_PAID_PROVIDER_MISSING");

    expect(result.candidates).toHaveLength(1);
    expect(candidate.severity).toBe("high");
    expect(candidate.revenueAtRiskMinor).toBe(10_000n);
    expect(candidate.currency).toBe("USD");
    expect(candidate.internalRecordId).toBe(record.id);
    expect(candidate.internalExternalId).toBe("order-ghost");
    expect(candidate.providerObjectId).toBe("pi_ghost");
    expect(candidate.occurredAt).toEqual(record.occurredAt);
    expect(candidate.fingerprint).toBe(
      buildFingerprint(ORG, "INTERNAL_PAID_PROVIDER_MISSING", ["order-ghost"]),
    );
    expect(evidenceValue(candidate, "Status")?.providerValue).toBe("not found");
  });

  it("TRIGGERS on the strength of a customer id alone", () => {
    const result = run({
      internalRecords: [
        internalRecord({
          externalId: "order-cust",
          customerId: "cus_9",
          occurredAt: hoursBefore(2),
        }),
      ],
    });
    expect(onlyFor(result, "INTERNAL_PAID_PROVIDER_MISSING").providerObjectId).toBeNull();
  });

  it("does NOT trigger for a record with neither a transaction id nor a customer id", () => {
    const result = run({
      internalRecords: [
        internalRecord({
          externalId: "order-blind",
          customerId: null,
          providerTransactionId: null,
          occurredAt: hoursBefore(2),
        }),
      ],
    });

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.ambiguousInternalMatches).toBe(1);
  });

  it("does NOT trigger when the provider payment exists", () => {
    const result = run({
      providerPayments: [providerPayment({ id: "pi_real", createdAt: hoursBefore(2) })],
      internalRecords: [
        internalRecord({ providerTransactionId: "pi_real", occurredAt: hoursBefore(2) }),
      ],
    });
    expect(result.candidates).toEqual([]);
  });

  it("does NOT trigger inside the propagation grace window", () => {
    const result = run({
      internalRecords: [
        internalRecord({ providerTransactionId: "pi_ghost", occurredAt: minutesBefore(10) }),
      ],
    });
    expect(result.candidates).toEqual([]);
  });

  it("does NOT trigger for a record that is not paid", () => {
    for (const status of ["pending", "failed", "refunded", "partially_refunded"] as const) {
      const result = run({
        internalRecords: [
          internalRecord({ status, providerTransactionId: "pi_ghost", occurredAt: hoursBefore(2) }),
        ],
      });
      expect(forRule(result, "INTERNAL_PAID_PROVIDER_MISSING"), status).toEqual([]);
    }
  });

  it("counts an ambiguous provider match as a diagnostic rather than guessing", () => {
    const result = run({
      providerPayments: [
        providerPayment({ id: "pi_one", createdAt: hoursBefore(2) }),
        providerPayment({ id: "pi_two", createdAt: hoursBefore(7) }),
      ],
      internalRecords: [internalRecord({ externalId: "order-amb", occurredAt: hoursBefore(2) })],
    });

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.ambiguousInternalMatches).toBe(1);
    expect(result.diagnostics.ambiguousProviderMatches).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — PAYMENT_AMOUNT_MISMATCH
// ---------------------------------------------------------------------------

describe("rule 4: PAYMENT_AMOUNT_MISMATCH", () => {
  const mismatch = (providerMinor: bigint, internalMinor: bigint, currency = "USD") =>
    run({
      providerPayments: [
        providerPayment({ id: "pi_amt", amountMinor: providerMinor, createdAt: hoursBefore(2) }),
      ],
      internalRecords: [
        internalRecord({
          externalId: "order-amt",
          providerTransactionId: "pi_amt",
          amountMinor: internalMinor,
          currency,
          occurredAt: hoursBefore(2),
        }),
      ],
    });

  it("TRIGGERS with revenue at risk equal to the ABSOLUTE difference (provider higher)", () => {
    const candidate = onlyFor(mismatch(10_000n, 9_500n), "PAYMENT_AMOUNT_MISMATCH");

    expect(candidate.severity).toBe("high");
    expect(candidate.revenueAtRiskMinor).toBe(500n);
    expect(candidate.currency).toBe("USD");
    expect(candidate.summary).toContain("difference 5.00 USD");
    expect(evidenceValue(candidate, "Difference")?.providerValue).toBe(
      "provider higher by 5.00 USD",
    );
    expect(candidate.fingerprint).toBe(
      buildFingerprint(ORG, "PAYMENT_AMOUNT_MISMATCH", ["pi_amt", "order-amt"]),
    );
  });

  it("TRIGGERS with the same absolute difference when the internal side is higher", () => {
    const candidate = onlyFor(mismatch(9_500n, 10_000n), "PAYMENT_AMOUNT_MISMATCH");

    expect(candidate.revenueAtRiskMinor).toBe(500n);
    expect(evidenceValue(candidate, "Difference")?.providerValue).toBe(
      "internal higher by 5.00 USD",
    );
    expect(candidate.recommendedActions.join(" ")).toContain("undercharged");
  });

  it("does NOT trigger when the amounts agree", () => {
    expect(mismatch(10_000n, 10_000n).candidates).toEqual([]);
  });

  it("does NOT trigger when the CURRENCIES differ — that is rule 5's job", () => {
    const result = mismatch(10_000n, 9_500n, "EUR");

    expect(forRule(result, "PAYMENT_AMOUNT_MISMATCH")).toEqual([]);
    expect(forRule(result, "PAYMENT_CURRENCY_MISMATCH")).toHaveLength(1);
  });

  it("stays exact for amounts beyond Number.MAX_SAFE_INTEGER", () => {
    const candidate = onlyFor(
      mismatch(9_007_199_254_740_993n, 9_007_199_254_740_992n),
      "PAYMENT_AMOUNT_MISMATCH",
    );
    expect(candidate.revenueAtRiskMinor).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — PAYMENT_CURRENCY_MISMATCH
// ---------------------------------------------------------------------------

describe("rule 5: PAYMENT_CURRENCY_MISMATCH", () => {
  const scenario = (
    providerCurrency: string,
    internalCurrency: string,
    overrides: Partial<ProviderPayment> = {},
  ) =>
    run({
      providerPayments: [
        providerPayment({
          id: "pi_cur",
          currency: providerCurrency,
          createdAt: hoursBefore(2),
          ...overrides,
        }),
      ],
      internalRecords: [
        internalRecord({
          externalId: "order-cur",
          providerTransactionId: "pi_cur",
          currency: internalCurrency,
          occurredAt: hoursBefore(2),
        }),
      ],
    });

  it("TRIGGERS and reports revenue at risk in the PROVIDER's currency", () => {
    const candidate = onlyFor(scenario("USD", "EUR"), "PAYMENT_CURRENCY_MISMATCH");

    expect(candidate.severity).toBe("critical");
    expect(candidate.currency).toBe("USD");
    expect(candidate.revenueAtRiskMinor).toBe(10_000n);
    expect(candidate.summary).toContain("settled this payment in USD");
    expect(candidate.summary).toContain("recorded it in EUR");
    expect(candidate.summary).toContain("without an explicit exchange rate");
    expect(evidenceValue(candidate, "Currency")?.providerValue).toBe("USD");
    expect(evidenceValue(candidate, "Currency")?.internalValue).toBe("EUR");
    expect(evidenceValue(candidate, "Currency")?.differs).toBe(true);
    expect(candidate.fingerprint).toBe(
      buildFingerprint(ORG, "PAYMENT_CURRENCY_MISMATCH", ["pi_cur", "order-cur"]),
    );
  });

  it("nets refunds off the provider-currency exposure and never converts", () => {
    const candidate = onlyFor(
      scenario("USD", "EUR", { amountRefundedMinor: 4_000n }),
      "PAYMENT_CURRENCY_MISMATCH",
    );
    expect(candidate.revenueAtRiskMinor).toBe(6_000n);
    expect(candidate.currency).toBe("USD");
  });

  it("does NOT trigger when the currencies agree, including in different cases", () => {
    expect(forRule(scenario("USD", "USD"), "PAYMENT_CURRENCY_MISMATCH")).toEqual([]);
    expect(forRule(scenario("USD", "usd"), "PAYMENT_CURRENCY_MISMATCH")).toEqual([]);
  });

  it("reports an unvalidatable internal currency as a diagnostic, not an exception", () => {
    const result = scenario("USD", "US$");

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.invalidCurrencyRecords).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rule 6 — DUPLICATE_SUCCEEDED_PAYMENT
// ---------------------------------------------------------------------------

describe("rule 6: DUPLICATE_SUCCEEDED_PAYMENT", () => {
  const duplicates = (payments: ProviderPayment[]) => run({ providerPayments: payments });

  it("TRIGGERS and counts ONLY the excess charge — two charges risk ONE amount", () => {
    const result = duplicates([
      providerPayment({ id: "pi_d1", createdAt: minutesBefore(20) }),
      providerPayment({ id: "pi_d2", createdAt: minutesBefore(10) }),
    ]);
    const candidate = onlyFor(result, "DUPLICATE_SUCCEEDED_PAYMENT");

    expect(result.candidates).toHaveLength(1);
    expect(candidate.severity).toBe("critical");
    // Two charges of 100.00 => 100.00 at risk, NOT 200.00.
    expect(candidate.revenueAtRiskMinor).toBe(10_000n);
    expect(candidate.currency).toBe("USD");
    expect(evidenceValue(candidate, "Charge count")?.providerValue).toBe("2");
    expect(evidenceValue(candidate, "Amount each")?.providerValue).toBe("100.00 USD");
    expect(evidenceValue(candidate, "Excess not refunded")?.providerValue).toBe("100.00 USD");
    expect(candidate.summary).toContain("2 times");
  });

  it("anchors on the EARLIEST charge so a later duplicate updates the same exception", () => {
    const candidate = onlyFor(
      duplicates([
        providerPayment({ id: "pi_d2", createdAt: minutesBefore(10) }),
        providerPayment({ id: "pi_d1", createdAt: minutesBefore(20) }),
      ]),
      "DUPLICATE_SUCCEEDED_PAYMENT",
    );

    expect(candidate.providerObjectId).toBe("pi_d1");
    expect(candidate.occurredAt).toEqual(minutesBefore(20));
    expect(candidate.fingerprint).toBe(
      buildFingerprint(ORG, "DUPLICATE_SUCCEEDED_PAYMENT", ["cus_1", "10000", "USD", "pi_d1"]),
    );
  });

  it("counts every excess charge when there are three", () => {
    const candidate = onlyFor(
      duplicates([
        providerPayment({ id: "pi_t1", createdAt: minutesBefore(25) }),
        providerPayment({ id: "pi_t2", createdAt: minutesBefore(20) }),
        providerPayment({ id: "pi_t3", createdAt: minutesBefore(15) }),
      ]),
      "DUPLICATE_SUCCEEDED_PAYMENT",
    );

    expect(candidate.revenueAtRiskMinor).toBe(20_000n);
    expect(evidenceValue(candidate, "Charge count")?.providerValue).toBe("3");
  });

  it("reports risk 0 and LOW severity when the duplicate was already refunded", () => {
    const candidate = onlyFor(
      duplicates([
        providerPayment({ id: "pi_r1", createdAt: minutesBefore(20) }),
        providerPayment({
          id: "pi_r2",
          createdAt: minutesBefore(10),
          amountRefundedMinor: 10_000n,
        }),
      ]),
      "DUPLICATE_SUCCEEDED_PAYMENT",
    );

    expect(candidate.revenueAtRiskMinor).toBe(0n);
    expect(candidate.severity).toBe("low");
    expect(candidate.summary).toContain("already been refunded");
    expect(candidate.recommendedActions.join(" ")).toContain("made whole");
  });

  it("counts only the unrefunded portion of an excess charge", () => {
    const candidate = onlyFor(
      duplicates([
        providerPayment({ id: "pi_p1", createdAt: minutesBefore(20) }),
        providerPayment({
          id: "pi_p2",
          createdAt: minutesBefore(10),
          amountRefundedMinor: 4_000n,
        }),
      ]),
      "DUPLICATE_SUCCEEDED_PAYMENT",
    );

    expect(candidate.revenueAtRiskMinor).toBe(6_000n);
    expect(candidate.severity).toBe("critical");
  });

  it("does NOT cluster charges outside the duplicate window", () => {
    const result = duplicates([
      providerPayment({ id: "pi_w1", createdAt: minutesBefore(10) }),
      providerPayment({ id: "pi_w2", createdAt: minutesBefore(80) }),
    ]);
    expect(forRule(result, "DUPLICATE_SUCCEEDED_PAYMENT")).toEqual([]);
  });

  it("clusters exactly at the window boundary", () => {
    const inside = duplicates([
      providerPayment({ id: "pi_b1", createdAt: minutesBefore(20) }),
      providerPayment({ id: "pi_b2", createdAt: minutesBefore(80) }), // exactly 60 minutes
    ]);
    expect(forRule(inside, "DUPLICATE_SUCCEEDED_PAYMENT")).toHaveLength(1);
  });

  it("NEVER triggers without a customer id", () => {
    const result = duplicates([
      providerPayment({ id: "pi_n1", customerId: null, createdAt: minutesBefore(20) }),
      providerPayment({ id: "pi_n2", customerId: null, createdAt: minutesBefore(10) }),
    ]);
    expect(forRule(result, "DUPLICATE_SUCCEEDED_PAYMENT")).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("does not group across different customers, amounts or currencies", () => {
    const variants: Array<[string, Partial<ProviderPayment>]> = [
      ["customer", { customerId: "cus_other" }],
      ["amount", { amountMinor: 9_999n }],
      ["currency", { currency: "EUR" }],
    ];
    for (const [label, variant] of variants) {
      const result = duplicates([
        providerPayment({ id: "pi_g1", createdAt: minutesBefore(20) }),
        providerPayment({ id: "pi_g2", createdAt: minutesBefore(10), ...variant }),
      ]);
      expect(forRule(result, "DUPLICATE_SUCCEEDED_PAYMENT"), label).toEqual([]);
    }
  });

  it("groups currencies case-insensitively", () => {
    const result = duplicates([
      providerPayment({ id: "pi_c1", currency: "USD", createdAt: minutesBefore(20) }),
      providerPayment({ id: "pi_c2", currency: "usd", createdAt: minutesBefore(10) }),
    ]);
    expect(forRule(result, "DUPLICATE_SUCCEEDED_PAYMENT")).toHaveLength(1);
  });

  it("ignores charges that did not succeed", () => {
    const result = duplicates([
      providerPayment({ id: "pi_s1", createdAt: minutesBefore(20) }),
      providerPayment({ id: "pi_s2", createdAt: minutesBefore(10), status: "failed" }),
    ]);
    expect(forRule(result, "DUPLICATE_SUCCEEDED_PAYMENT")).toEqual([]);
  });

  it("emits two exceptions for two separate clusters", () => {
    const result = duplicates([
      providerPayment({ id: "pi_a1", createdAt: minutesBefore(200) }),
      providerPayment({ id: "pi_a2", createdAt: minutesBefore(190) }),
      providerPayment({ id: "pi_b1", createdAt: minutesBefore(20) }),
      providerPayment({ id: "pi_b2", createdAt: minutesBefore(10) }),
    ]);
    const found = forRule(result, "DUPLICATE_SUCCEEDED_PAYMENT");

    expect(found).toHaveLength(2);
    expect(new Set(found.map((c) => c.fingerprint)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Rule 7 — REFUND_STATUS_MISMATCH
// ---------------------------------------------------------------------------

describe("rule 7: REFUND_STATUS_MISMATCH", () => {
  const providerRefundedScenario = (
    paymentOverrides: Partial<ProviderPayment> = {},
    refunds: ProviderRefund[] = [
      providerRefund({ paymentId: "pi_dir", createdAt: hoursBefore(3) }),
    ],
  ) =>
    run({
      providerPayments: [
        providerPayment({
          id: "pi_dir",
          createdAt: hoursBefore(5),
          amountRefundedMinor: 4_000n,
          ...paymentOverrides,
        }),
      ],
      internalRecords: [
        internalRecord({
          externalId: "order-dir",
          providerTransactionId: "pi_dir",
          status: "paid",
          occurredAt: hoursBefore(5),
        }),
      ],
      providerRefunds: refunds,
    });

  const internalRefundedScenario = (status: "refunded" | "partially_refunded" = "refunded") =>
    run({
      providerPayments: [
        providerPayment({ id: "pi_dir", createdAt: hoursBefore(5), amountRefundedMinor: 0n }),
      ],
      internalRecords: [
        internalRecord({
          externalId: "order-dir",
          providerTransactionId: "pi_dir",
          status,
          occurredAt: hoursBefore(5),
        }),
      ],
    });

  it("TRIGGERS in direction A: the provider refunded, the internal system is unaware", () => {
    const result = providerRefundedScenario();
    const candidate = onlyFor(result, "REFUND_STATUS_MISMATCH");

    expect(result.candidates).toHaveLength(1);
    expect(candidate.severity).toBe("high");
    expect(candidate.revenueAtRiskMinor).toBe(4_000n);
    expect(candidate.currency).toBe("USD");
    expect(candidate.summary).toContain("Stripe refunded 40.00 USD");
    expect(candidate.summary).toContain('"paid"');
    expect(evidenceValue(candidate, "Refund type")?.providerValue).toBe("partial");
    expect(candidate.occurredAt).toEqual(hoursBefore(3));
  });

  it("labels a full refund as full and exposes the whole amount", () => {
    const candidate = onlyFor(
      providerRefundedScenario({ amountRefundedMinor: 10_000n }),
      "REFUND_STATUS_MISMATCH",
    );
    expect(evidenceValue(candidate, "Refund type")?.providerValue).toBe("full");
    expect(candidate.revenueAtRiskMinor).toBe(10_000n);
  });

  it("does NOT trigger direction A inside the refund propagation grace window", () => {
    const result = providerRefundedScenario({}, [
      providerRefund({ paymentId: "pi_dir", createdAt: minutesBefore(30) }),
    ]);
    expect(result.candidates).toEqual([]);
  });

  it("ignores a refund that did not itself succeed when applying the grace window", () => {
    // A pending refund does not establish a refund time, so the mismatch is
    // reported immediately rather than being held back.
    const result = providerRefundedScenario({}, [
      providerRefund({ paymentId: "pi_dir", createdAt: minutesBefore(5), status: "pending" }),
    ]);
    expect(forRule(result, "REFUND_STATUS_MISMATCH")).toHaveLength(1);
  });

  it("TRIGGERS in direction B: the internal system believes a refund happened", () => {
    const result = internalRefundedScenario();
    const candidate = onlyFor(result, "REFUND_STATUS_MISMATCH");

    expect(result.candidates).toHaveLength(1);
    expect(candidate.severity).toBe("high");
    expect(candidate.revenueAtRiskMinor).toBe(10_000n);
    expect(candidate.currency).toBe("USD");
    expect(candidate.summary).toContain("Stripe reports no refund");
    expect(candidate.occurredAt).toEqual(hoursBefore(5));
  });

  it("triggers direction B for a partially refunded internal record too", () => {
    const candidate = onlyFor(
      internalRefundedScenario("partially_refunded"),
      "REFUND_STATUS_MISMATCH",
    );
    expect(candidate.summary).toContain('"partially_refunded"');
  });

  it("gives the two directions DIFFERENT fingerprints for the same payment and record", () => {
    const directionA = onlyFor(providerRefundedScenario(), "REFUND_STATUS_MISMATCH");
    const directionB = onlyFor(internalRefundedScenario(), "REFUND_STATUS_MISMATCH");

    expect(directionA.providerObjectId).toBe(directionB.providerObjectId);
    expect(directionA.internalExternalId).toBe(directionB.internalExternalId);
    expect(directionA.ruleId).toBe(directionB.ruleId);
    expect(directionA.fingerprint).not.toBe(directionB.fingerprint);

    expect(directionA.fingerprint).toBe(
      buildFingerprint(ORG, "REFUND_STATUS_MISMATCH", ["pi_dir", "order-dir", "provider_refunded"]),
    );
    expect(directionB.fingerprint).toBe(
      buildFingerprint(ORG, "REFUND_STATUS_MISMATCH", ["pi_dir", "order-dir", "internal_refunded"]),
    );
  });

  it("does NOT trigger when both sides agree that a refund happened", () => {
    const result = run({
      providerPayments: [
        providerPayment({ id: "pi_ok", createdAt: hoursBefore(5), amountRefundedMinor: 4_000n }),
      ],
      internalRecords: [
        internalRecord({
          providerTransactionId: "pi_ok",
          status: "partially_refunded",
          occurredAt: hoursBefore(5),
        }),
      ],
      providerRefunds: [providerRefund({ paymentId: "pi_ok", createdAt: hoursBefore(3) })],
    });
    expect(result.candidates).toEqual([]);
  });

  it("does NOT trigger when neither side reports a refund", () => {
    const result = run({
      providerPayments: [providerPayment({ id: "pi_ok", createdAt: hoursBefore(5) })],
      internalRecords: [
        internalRecord({ providerTransactionId: "pi_ok", occurredAt: hoursBefore(5) }),
      ],
    });
    expect(result.candidates).toEqual([]);
  });

  it("does NOT trigger without a matched internal record", () => {
    const result = run({
      providerPayments: [
        providerPayment({ id: "pi_lone", createdAt: hoursBefore(5), amountRefundedMinor: 4_000n }),
      ],
      providerRefunds: [providerRefund({ paymentId: "pi_lone", createdAt: hoursBefore(3) })],
    });
    expect(forRule(result, "REFUND_STATUS_MISMATCH")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 8 — PAID_INVOICE_INACTIVE_SUBSCRIPTION
// ---------------------------------------------------------------------------

describe("rule 8: PAID_INVOICE_INACTIVE_SUBSCRIPTION", () => {
  const scenario = (
    invoiceOverrides: Partial<ProviderInvoice> = {},
    subscriptionOverrides: Partial<ProviderSubscription> = {},
  ) =>
    run({
      providerInvoices: [providerInvoice(invoiceOverrides)],
      providerSubscriptions: [
        providerSubscription({
          status: "canceled",
          canceledAt: hoursBefore(2),
          ...subscriptionOverrides,
        }),
      ],
    });

  it("TRIGGERS when a paid invoice belongs to a cancelled subscription", () => {
    const result = scenario();
    const candidate = onlyFor(result, "PAID_INVOICE_INACTIVE_SUBSCRIPTION");

    expect(result.candidates).toHaveLength(1);
    expect(candidate.severity).toBe("high");
    expect(candidate.revenueAtRiskMinor).toBe(5_000n);
    expect(candidate.currency).toBe("USD");
    expect(candidate.providerObjectId).toBe("in_1");
    expect(candidate.occurredAt).toEqual(hoursBefore(1));
    expect(candidate.summary).toContain("50.00 USD");
    expect(candidate.summary).toContain('"canceled"');
    expect(candidate.fingerprint).toBe(
      buildFingerprint(ORG, "PAID_INVOICE_INACTIVE_SUBSCRIPTION", ["in_1"]),
    );
  });

  it("does NOT trigger when the invoice was paid BEFORE the cancellation", () => {
    const result = scenario({ paidAt: hoursBefore(3) }, { canceledAt: hoursBefore(2) });
    expect(result.candidates).toEqual([]);
  });

  it("TRIGGERS when the invoice was paid at or after the cancellation", () => {
    expect(
      forRule(
        scenario({ paidAt: hoursBefore(2) }, { canceledAt: hoursBefore(2) }),
        "PAID_INVOICE_INACTIVE_SUBSCRIPTION",
      ),
    ).toHaveLength(1);
  });

  it("TRIGGERS for other non-billing states that never recorded a cancellation time", () => {
    for (const status of ["unpaid", "incomplete_expired", "paused"] as const) {
      const result = scenario({}, { status, canceledAt: null });
      expect(forRule(result, "PAID_INVOICE_INACTIVE_SUBSCRIPTION"), status).toHaveLength(1);
    }
  });

  it("does NOT trigger for an active or trialing subscription", () => {
    for (const status of ["active", "trialing"] as const) {
      const result = scenario({}, { status, canceledAt: null });
      expect(result.candidates, status).toEqual([]);
    }
  });

  it("does NOT trigger for an unpaid invoice", () => {
    for (const status of ["open", "draft", "void", "uncollectible"] as const) {
      const result = scenario({ status, paidAt: null, attemptCount: 0 });
      expect(forRule(result, "PAID_INVOICE_INACTIVE_SUBSCRIPTION"), status).toEqual([]);
    }
  });

  it("does NOT trigger for an invoice with no subscription, or an unknown subscription", () => {
    expect(scenario({ subscriptionId: null }).candidates).toEqual([]);
    expect(scenario({ subscriptionId: "sub_unknown" }).candidates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule 9 — FAILED_INVOICE_ACTIVE_SUBSCRIPTION
// ---------------------------------------------------------------------------

describe("rule 9: FAILED_INVOICE_ACTIVE_SUBSCRIPTION", () => {
  const scenario = (
    invoiceOverrides: Partial<ProviderInvoice> = {},
    subscriptionOverrides: Partial<ProviderSubscription> = {},
  ) =>
    run({
      providerInvoices: [
        providerInvoice({
          status: "open",
          attemptCount: 3,
          amountDueMinor: 5_000n,
          amountPaidMinor: 1_000n,
          paidAt: null,
          ...invoiceOverrides,
        }),
      ],
      providerSubscriptions: [providerSubscription(subscriptionOverrides)],
    });

  it("TRIGGERS with revenue at risk equal to due minus paid", () => {
    const result = scenario();
    const candidate = onlyFor(result, "FAILED_INVOICE_ACTIVE_SUBSCRIPTION");

    expect(result.candidates).toHaveLength(1);
    expect(candidate.severity).toBe("high");
    expect(candidate.revenueAtRiskMinor).toBe(4_000n);
    expect(candidate.currency).toBe("USD");
    expect(candidate.providerObjectId).toBe("in_1");
    expect(candidate.occurredAt).toEqual(hoursBefore(5));
    expect(candidate.summary).toContain("40.00 USD outstanding");
    expect(candidate.summary).toContain("after 3 attempts");
    expect(evidenceValue(candidate, "Outstanding")?.providerValue).toBe("40.00 USD");
    expect(candidate.fingerprint).toBe(
      buildFingerprint(ORG, "FAILED_INVOICE_ACTIVE_SUBSCRIPTION", ["in_1"]),
    );
  });

  it("pluralises a single attempt correctly", () => {
    const candidate = onlyFor(scenario({ attemptCount: 1 }), "FAILED_INVOICE_ACTIVE_SUBSCRIPTION");
    expect(candidate.summary).toContain("after 1 attempt)");
  });

  it("TRIGGERS for an uncollectible invoice regardless of attempt count", () => {
    const result = scenario({ status: "uncollectible", attemptCount: 0 });
    expect(forRule(result, "FAILED_INVOICE_ACTIVE_SUBSCRIPTION")).toHaveLength(1);
  });

  it("TRIGGERS for a trialing subscription as well as an active one", () => {
    expect(
      forRule(scenario({}, { status: "trialing" }), "FAILED_INVOICE_ACTIVE_SUBSCRIPTION"),
    ).toHaveLength(1);
  });

  it("does NOT trigger when nothing is outstanding", () => {
    expect(scenario({ amountPaidMinor: 5_000n }).candidates).toEqual([]);
  });

  it("does NOT trigger when more was paid than was due", () => {
    expect(scenario({ amountPaidMinor: 6_000n }).candidates).toEqual([]);
  });

  it("does NOT trigger for an open invoice that has never been attempted", () => {
    expect(scenario({ attemptCount: 0 }).candidates).toEqual([]);
  });

  it("does NOT trigger when the subscription is not active", () => {
    for (const status of ["canceled", "past_due", "unpaid", "incomplete", "paused"] as const) {
      const result = scenario({}, { status });
      expect(forRule(result, "FAILED_INVOICE_ACTIVE_SUBSCRIPTION"), status).toEqual([]);
    }
  });

  it("does NOT trigger for a draft or void invoice", () => {
    for (const status of ["draft", "void"] as const) {
      expect(scenario({ status }).candidates, status).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 10 — STALE_INTERNAL_PENDING_PAYMENT
// ---------------------------------------------------------------------------

describe("rule 10: STALE_INTERNAL_PENDING_PAYMENT", () => {
  it("TRIGGERS for a pending record older than the stale threshold", () => {
    const result = run({
      internalRecords: [
        internalRecord({
          externalId: "order-stale",
          status: "pending",
          occurredAt: hoursBefore(72),
        }),
      ],
    });
    const candidate = onlyFor(result, "STALE_INTERNAL_PENDING_PAYMENT");

    expect(result.candidates).toHaveLength(1);
    expect(candidate.severity).toBe("medium");
    expect(candidate.revenueAtRiskMinor).toBe(10_000n);
    expect(candidate.currency).toBe("USD");
    expect(candidate.internalExternalId).toBe("order-stale");
    expect(candidate.providerObjectId).toBeNull();
    expect(candidate.summary).toContain("pending for 72 hours");
    expect(evidenceValue(candidate, "Provider payment")?.providerValue).toBe("not found");
    expect(candidate.fingerprint).toBe(
      buildFingerprint(ORG, "STALE_INTERNAL_PENDING_PAYMENT", ["order-stale"]),
    );
  });

  it("does NOT trigger before the threshold", () => {
    const result = run({
      internalRecords: [internalRecord({ status: "pending", occurredAt: hoursBefore(24) })],
    });
    expect(result.candidates).toEqual([]);
  });

  it("does NOT trigger when the matched provider payment SUCCEEDED — rule 2 owns that", () => {
    const result = run({
      providerPayments: [providerPayment({ id: "pi_stale", createdAt: hoursBefore(72) })],
      internalRecords: [
        internalRecord({
          externalId: "order-stale",
          status: "pending",
          providerTransactionId: "pi_stale",
          occurredAt: hoursBefore(72),
        }),
      ],
    });

    expect(forRule(result, "STALE_INTERNAL_PENDING_PAYMENT")).toEqual([]);
    // The same money is reported exactly once, by rule 2.
    expect(forRule(result, "PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID")).toHaveLength(1);
    expect(result.candidates).toHaveLength(1);
  });

  it("TRIGGERS when the matched provider payment is stuck in a non-terminal state", () => {
    const result = run({
      providerPayments: [
        providerPayment({ id: "pi_stuck", status: "requires_action", createdAt: hoursBefore(72) }),
      ],
      internalRecords: [
        internalRecord({
          externalId: "order-stuck",
          status: "pending",
          providerTransactionId: "pi_stuck",
          occurredAt: hoursBefore(72),
        }),
      ],
    });
    const candidate = onlyFor(result, "STALE_INTERNAL_PENDING_PAYMENT");

    expect(candidate.providerObjectId).toBe("pi_stuck");
    expect(evidenceValue(candidate, "Status")?.providerValue).toBe("requires_action");
    expect(candidate.probableCauses[0]).toContain("requires_action");
  });

  it("does NOT trigger for a record that is not pending", () => {
    for (const status of ["paid", "failed", "refunded", "partially_refunded"] as const) {
      const result = run({
        internalRecords: [
          internalRecord({
            status,
            customerId: null,
            providerTransactionId: null,
            occurredAt: hoursBefore(72),
          }),
        ],
      });
      expect(forRule(result, "STALE_INTERNAL_PENDING_PAYMENT"), status).toEqual([]);
    }
  });

  it("respects a config override of the stale threshold", () => {
    const records = [internalRecord({ status: "pending", occurredAt: hoursBefore(24) })];
    const result = run({
      internalRecords: records,
      config: { ...DEFAULT_RECONCILIATION_CONFIG, stalePendingHours: 12 },
    });
    expect(forRule(result, "STALE_INTERNAL_PENDING_PAYMENT")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Engine-level guarantees
// ---------------------------------------------------------------------------

/** Serialise a result so two runs can be compared byte for byte. */
const stable = (result: ReconciliationResult): string =>
  JSON.stringify(result, (_key, value: unknown) =>
    typeof value === "bigint" ? `${value.toString(10)}n` : value,
  );

/** A scenario that exercises five different rules at three severities. */
const richScenario = (): Partial<ReconciliationInput> => ({
  providerPayments: [
    providerPayment({ id: "pi_a", customerId: "cus_a", createdAt: hoursBefore(3) }),
    providerPayment({
      id: "pi_c",
      customerId: "cus_c",
      amountMinor: 7_000n,
      createdAt: hoursBefore(3),
    }),
  ],
  internalRecords: [
    internalRecord({
      id: "rec_b",
      externalId: "order-b",
      customerId: "cus_b",
      amountMinor: 5_000n,
      providerTransactionId: "pi_ghost",
      occurredAt: hoursBefore(3),
    }),
    internalRecord({
      id: "rec_c",
      externalId: "order-c",
      customerId: "cus_c",
      amountMinor: 6_500n,
      providerTransactionId: "pi_c",
      occurredAt: hoursBefore(3),
    }),
    internalRecord({
      id: "rec_d",
      externalId: "order-d",
      customerId: "cus_d",
      amountMinor: 5_000n,
      status: "pending",
      occurredAt: hoursBefore(100),
    }),
  ],
  providerInvoices: [providerInvoice({ id: "in_1", amountPaidMinor: 3_000n })],
  providerSubscriptions: [
    providerSubscription({ id: "sub_1", status: "canceled", canceledAt: hoursBefore(4) }),
  ],
});

describe("determinism", () => {
  it("produces identical fingerprints AND identical ordering across two runs", () => {
    const first = run(richScenario());
    const second = run(richScenario());

    expect(first.candidates.length).toBeGreaterThan(1);
    expect(second.candidates.map((c) => c.fingerprint)).toEqual(
      first.candidates.map((c) => c.fingerprint),
    );
    expect(second.candidates.map((c) => c.ruleId)).toEqual(first.candidates.map((c) => c.ruleId));
    expect(stable(second)).toBe(stable(first));
  });

  it("is unaffected by the order of the input arrays", () => {
    const base = richScenario();
    const reversed: Partial<ReconciliationInput> = {
      ...base,
      providerPayments: [...(base.providerPayments ?? [])].reverse(),
      internalRecords: [...(base.internalRecords ?? [])].reverse(),
    };

    expect(new Set(run(reversed).candidates.map((c) => c.fingerprint))).toEqual(
      new Set(run(base).candidates.map((c) => c.fingerprint)),
    );
    expect(run(reversed).candidates.map((c) => c.fingerprint)).toEqual(
      run(base).candidates.map((c) => c.fingerprint),
    );
  });

  it("orders candidates by severity, then rule id, then fingerprint", () => {
    const result = run(richScenario());
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as const;

    expect(result.candidates.map((c) => c.ruleId)).toEqual([
      "PAYMENT_SUCCEEDED_INTERNAL_MISSING", // critical
      "INTERNAL_PAID_PROVIDER_MISSING", // high
      "PAID_INVOICE_INACTIVE_SUBSCRIPTION", // high
      "PAYMENT_AMOUNT_MISMATCH", // high
      "STALE_INTERNAL_PENDING_PAYMENT", // medium
    ]);

    for (let i = 1; i < result.candidates.length; i += 1) {
      const previous = result.candidates[i - 1];
      const current = result.candidates[i];
      if (!previous || !current) throw new Error("missing candidate");
      expect(rank[previous.severity]).toBeLessThanOrEqual(rank[current.severity]);
    }
  });

  it("scopes fingerprints to the organization so tenants never collide", () => {
    const a = runReconciliation({
      organizationId: "org_a",
      now: NOW,
      providerPayments: [providerPayment({ id: "pi_shared", createdAt: hoursBefore(2) })],
      providerRefunds: [],
      providerInvoices: [],
      providerSubscriptions: [],
      internalRecords: [],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    const b = runReconciliation({
      organizationId: "org_b",
      now: NOW,
      providerPayments: [providerPayment({ id: "pi_shared", createdAt: hoursBefore(2) })],
      providerRefunds: [],
      providerInvoices: [],
      providerSubscriptions: [],
      internalRecords: [],
      config: DEFAULT_RECONCILIATION_CONFIG,
    });

    expect(a.candidates[0]?.fingerprint).not.toBe(b.candidates[0]?.fingerprint);
  });
});

describe("result shape", () => {
  it("reports countsByRule totalling exactly the candidate count", () => {
    const result = run(richScenario());
    const total = Object.values(result.countsByRule).reduce((sum, n) => sum + n, 0);

    expect(total).toBe(result.candidates.length);
    expect(result.countsByRule).toEqual({
      PAYMENT_SUCCEEDED_INTERNAL_MISSING: 1,
      INTERNAL_PAID_PROVIDER_MISSING: 1,
      PAYMENT_AMOUNT_MISMATCH: 1,
      PAID_INVOICE_INACTIVE_SUBSCRIPTION: 1,
      STALE_INTERNAL_PENDING_PAYMENT: 1,
    });
  });

  it("keeps countsByRule consistent when one rule fires several times", () => {
    const result = run({
      providerPayments: [
        providerPayment({ id: "pi_1", customerId: "cus_1", createdAt: hoursBefore(2) }),
        providerPayment({ id: "pi_2", customerId: "cus_2", createdAt: hoursBefore(2) }),
        providerPayment({ id: "pi_3", customerId: "cus_3", createdAt: hoursBefore(2) }),
      ],
    });

    expect(result.countsByRule).toEqual({ PAYMENT_SUCCEEDED_INTERNAL_MISSING: 3 });
    expect(Object.values(result.countsByRule).reduce((sum, n) => sum + n, 0)).toBe(
      result.candidates.length,
    );
  });

  it("returns an empty, well-formed result for empty input", () => {
    const result = run();

    expect(result.candidates).toEqual([]);
    expect(result.countsByRule).toEqual({});
    expect(result.ruleVersion).toBe(RULE_VERSION);
    expect(result.diagnostics).toEqual({
      ambiguousProviderMatches: 0,
      ambiguousInternalMatches: 0,
      withinPropagationGrace: 0,
      invalidCurrencyRecords: 0,
    });
  });

  it("stamps the rule version on the run and on every candidate", () => {
    const result = run(richScenario());
    expect(result.ruleVersion).toBe(RULE_VERSION);
    for (const candidate of result.candidates) {
      expect(candidate.ruleVersion).toBe(RULE_VERSION);
    }
  });

  it("emits unique fingerprints within a run", () => {
    const result = run(richScenario());
    expect(new Set(result.candidates.map((c) => c.fingerprint)).size).toBe(
      result.candidates.length,
    );
  });
});

describe("exact money end to end", () => {
  it("handles a zero-decimal currency without inventing minor units", () => {
    const result = run({
      providerPayments: [
        providerPayment({
          id: "pi_jpy",
          currency: "JPY",
          amountMinor: 500n,
          createdAt: hoursBefore(2),
        }),
      ],
    });
    const candidate = onlyFor(result, "PAYMENT_SUCCEEDED_INTERNAL_MISSING");

    expect(candidate.currency).toBe("JPY");
    expect(candidate.revenueAtRiskMinor).toBe(500n);
    expect(candidate.summary).toContain("500 JPY");
    expect(candidate.summary).not.toContain("5.00");
    expect(evidenceValue(candidate, "Amount")?.providerValue).toBe("500 JPY");
  });

  it("handles a three-decimal currency", () => {
    const result = run({
      providerPayments: [
        providerPayment({
          id: "pi_bhd",
          currency: "BHD",
          amountMinor: 10_500n,
          createdAt: hoursBefore(2),
        }),
      ],
    });
    expect(onlyFor(result, "PAYMENT_SUCCEEDED_INTERNAL_MISSING").summary).toContain("10.500 BHD");
  });

  it("carries a value beyond 2^53 through revenueAtRiskMinor without loss", () => {
    const huge = 9_007_199_254_740_993n;
    const result = run({
      providerPayments: [
        providerPayment({ id: "pi_huge", amountMinor: huge, createdAt: hoursBefore(2) }),
      ],
    });
    const candidate = onlyFor(result, "PAYMENT_SUCCEEDED_INTERNAL_MISSING");

    expect(candidate.revenueAtRiskMinor).toBe(huge);
    expect(candidate.revenueAtRiskMinor).not.toBe(BigInt(Number(huge)));
    expect(candidate.summary).toContain("90071992547409.93 USD");
  });

  it("keeps a huge duplicate cluster exact", () => {
    const huge = 9_007_199_254_740_993n;
    const result = run({
      providerPayments: [
        providerPayment({ id: "pi_h1", amountMinor: huge, createdAt: minutesBefore(20) }),
        providerPayment({ id: "pi_h2", amountMinor: huge, createdAt: minutesBefore(10) }),
      ],
    });
    expect(onlyFor(result, "DUPLICATE_SUCCEEDED_PAYMENT").revenueAtRiskMinor).toBe(huge);
  });
});

describe("malformed data is surfaced, not fatal", () => {
  it("does not abort the run when an internal record carries an unusable currency", () => {
    const input: Partial<ReconciliationInput> = {
      providerPayments: [
        providerPayment({
          id: "pi_bad",
          customerId: null,
          amountMinor: 20_000n,
          createdAt: hoursBefore(2),
        }),
      ],
      internalRecords: [
        internalRecord({
          externalId: "order-bad",
          customerId: null,
          providerTransactionId: "pi_bad",
          currency: "US$",
          amountMinor: 10_000n,
          occurredAt: hoursBefore(2),
        }),
      ],
    };

    expect(() => run(input)).not.toThrow();

    const result = run(input);
    expect(result.diagnostics.invalidCurrencyRecords).toBe(1);
    expect(forRule(result, "PAYMENT_AMOUNT_MISMATCH")).toEqual([]);
    expect(forRule(result, "PAYMENT_CURRENCY_MISMATCH")).toEqual([]);
  });

  it("still renders evidence for a rule that must report such a record", () => {
    const input: Partial<ReconciliationInput> = {
      internalRecords: [
        internalRecord({
          externalId: "order-bad",
          providerTransactionId: "pi_ghost",
          currency: "US$",
          amountMinor: 10_000n,
          occurredAt: hoursBefore(2),
        }),
      ],
    };

    expect(() => run(input)).not.toThrow();

    const candidate = onlyFor(run(input), "INTERNAL_PAID_PROVIDER_MISSING");
    expect(candidate.revenueAtRiskMinor).toBe(10_000n);
    // Exact minor units are still reported; no decimal point is invented for a
    // currency whose precision is unknown.
    expect(candidate.summary).toContain("10000");
    expect(candidate.summary).toContain("unrecognised currency");
  });

  it("does not abort when a STALE pending record carries an unusable currency", () => {
    const input: Partial<ReconciliationInput> = {
      internalRecords: [
        internalRecord({
          externalId: "order-stale-bad",
          status: "pending",
          currency: "US$",
          occurredAt: hoursBefore(72),
        }),
      ],
    };

    expect(() => run(input)).not.toThrow();
    expect(forRule(run(input), "STALE_INTERNAL_PENDING_PAYMENT")).toHaveLength(1);
  });
});
