import { describe, expect, it } from "vitest";
import {
  ACTIVE_EXCEPTION_STATES,
  ACTIVE_SUBSCRIPTION_STATUSES,
  DEFAULT_RECONCILIATION_CONFIG,
  EXCEPTION_SEVERITIES,
  EXCEPTION_STATES,
  INTERNAL_PAYMENT_STATUSES,
  PROVIDER_INVOICE_STATUSES,
  PROVIDER_PAYMENT_STATUSES,
  PROVIDER_REFUND_STATUSES,
  PROVIDER_SUBSCRIPTION_STATUSES,
  RECONCILIATION_RULE_IDS,
  SEVERITY_RANK,
  isActiveExceptionState,
  isInternalPaymentStatus,
  isReconciliationRuleId,
  type ExceptionSeverity,
} from "./types";

describe("status guards", () => {
  it("accepts every declared internal payment status and nothing else", () => {
    for (const status of INTERNAL_PAYMENT_STATUSES) {
      expect(isInternalPaymentStatus(status)).toBe(true);
    }
    for (const bad of ["", "PAID", "settled", "succeeded", "pending "]) {
      expect(isInternalPaymentStatus(bad)).toBe(false);
    }
  });

  it("accepts every declared rule id and nothing else", () => {
    for (const ruleId of RECONCILIATION_RULE_IDS) {
      expect(isReconciliationRuleId(ruleId)).toBe(true);
    }
    for (const bad of ["", "UNKNOWN_RULE", "payment_amount_mismatch"]) {
      expect(isReconciliationRuleId(bad)).toBe(false);
    }
  });

  it("declares exactly ten reconciliation rules, each unique", () => {
    expect(RECONCILIATION_RULE_IDS).toHaveLength(10);
    expect(new Set(RECONCILIATION_RULE_IDS).size).toBe(10);
  });
});

describe("constant lists", () => {
  it("contain no duplicates", () => {
    const lists = {
      INTERNAL_PAYMENT_STATUSES,
      PROVIDER_PAYMENT_STATUSES,
      PROVIDER_REFUND_STATUSES,
      PROVIDER_INVOICE_STATUSES,
      PROVIDER_SUBSCRIPTION_STATUSES,
      EXCEPTION_SEVERITIES,
      EXCEPTION_STATES,
      RECONCILIATION_RULE_IDS,
    };
    for (const [name, list] of Object.entries(lists)) {
      expect(new Set(list).size, `${name} has duplicates`).toBe(list.length);
    }
  });
});

describe("severity ranking", () => {
  it("orders most severe first", () => {
    const sorted = [...EXCEPTION_SEVERITIES].sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b]);
    expect(sorted).toEqual(["critical", "high", "medium", "low"]);
  });

  it("assigns a distinct rank to every severity", () => {
    const ranks = EXCEPTION_SEVERITIES.map((s: ExceptionSeverity) => SEVERITY_RANK[s]);
    expect(new Set(ranks).size).toBe(EXCEPTION_SEVERITIES.length);
  });
});

describe("exception states", () => {
  it("treats open, acknowledged and reopened as still needing attention", () => {
    expect(isActiveExceptionState("open")).toBe(true);
    expect(isActiveExceptionState("acknowledged")).toBe(true);
    expect(isActiveExceptionState("reopened")).toBe(true);
    expect(isActiveExceptionState("resolved")).toBe(false);
    expect([...ACTIVE_EXCEPTION_STATES].sort()).toEqual(["acknowledged", "open", "reopened"]);
  });
});

describe("subscription states", () => {
  it("treats only trialing and active as states that should bill", () => {
    expect([...ACTIVE_SUBSCRIPTION_STATUSES].sort()).toEqual(["active", "trialing"]);
    for (const status of PROVIDER_SUBSCRIPTION_STATUSES) {
      const expected = status === "active" || status === "trialing";
      expect(ACTIVE_SUBSCRIPTION_STATUSES.has(status)).toBe(expected);
    }
  });
});

describe("DEFAULT_RECONCILIATION_CONFIG", () => {
  it("uses the documented conservative defaults", () => {
    expect(DEFAULT_RECONCILIATION_CONFIG).toEqual({
      internalPropagationGraceMinutes: 30,
      stalePendingHours: 48,
      heuristicMatchWindowHours: 72,
      duplicateWindowMinutes: 60,
      refundPropagationGraceMinutes: 60,
    });
  });

  it("keeps every threshold positive", () => {
    for (const [key, value] of Object.entries(DEFAULT_RECONCILIATION_CONFIG)) {
      expect(value, key).toBeGreaterThan(0);
    }
  });
});
