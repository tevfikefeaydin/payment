import { describe, expect, it } from "vitest";
import { buildFingerprint } from "./fingerprint";
import { RECONCILIATION_RULE_IDS } from "./types";

const ORG_A = "org_aaaaaaaaaaaaaaaa";
const ORG_B = "org_bbbbbbbbbbbbbbbb";
const RULE = "PAYMENT_AMOUNT_MISMATCH" as const;

describe("buildFingerprint", () => {
  it("is a 64-character lowercase hex digest", () => {
    const fp = buildFingerprint(ORG_A, RULE, ["pi_1", "ext-1"]);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls for identical input", () => {
    const a = buildFingerprint(ORG_A, RULE, ["pi_1", "ext-1"]);
    const b = buildFingerprint(ORG_A, RULE, ["pi_1", "ext-1"]);
    expect(a).toBe(b);
    // And stable for a freshly built, structurally identical component array.
    const c = buildFingerprint(ORG_A, RULE, ["pi_" + "1", ["ext", "1"].join("-")]);
    expect(c).toBe(a);
  });

  it("DIFFERS when the organization differs — tenant isolation", () => {
    const a = buildFingerprint(ORG_A, RULE, ["pi_1", "ext-1"]);
    const b = buildFingerprint(ORG_B, RULE, ["pi_1", "ext-1"]);
    expect(a).not.toBe(b);
  });

  it("gives every organization a distinct fingerprint for the same problem", () => {
    const orgs = ["org_1", "org_2", "org_3", "org_4", "org_5"];
    const fingerprints = orgs.map((org) => buildFingerprint(org, RULE, ["pi_1"]));
    expect(new Set(fingerprints).size).toBe(orgs.length);
  });

  it("differs by rule id", () => {
    const fingerprints = RECONCILIATION_RULE_IDS.map((ruleId) =>
      buildFingerprint(ORG_A, ruleId, ["pi_1"]),
    );
    expect(new Set(fingerprints).size).toBe(RECONCILIATION_RULE_IDS.length);
  });

  it("differs by component values and by component order", () => {
    const a = buildFingerprint(ORG_A, RULE, ["pi_1", "ext-1"]);
    const b = buildFingerprint(ORG_A, RULE, ["pi_2", "ext-1"]);
    const reordered = buildFingerprint(ORG_A, RULE, ["ext-1", "pi_1"]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(reordered);
  });

  it("length-prefixes components so concatenations cannot collide", () => {
    const ab_c = buildFingerprint(ORG_A, RULE, ["ab", "c"]);
    const a_bc = buildFingerprint(ORG_A, RULE, ["a", "bc"]);
    const abc = buildFingerprint(ORG_A, RULE, ["abc"]);
    expect(ab_c).not.toBe(a_bc);
    expect(ab_c).not.toBe(abc);
    expect(a_bc).not.toBe(abc);
  });

  it("does not let a component containing the separator forge another layout", () => {
    // A component that itself looks like a length prefix must not be able to
    // impersonate two separate components.
    const forged = buildFingerprint(ORG_A, RULE, ["1:a1:b"]);
    const genuine = buildFingerprint(ORG_A, RULE, ["a", "b"]);
    expect(forged).not.toBe(genuine);
  });

  it("treats null and undefined components identically", () => {
    const withNull = buildFingerprint(ORG_A, RULE, ["pi_1", null]);
    const withUndefined = buildFingerprint(ORG_A, RULE, ["pi_1", undefined]);
    expect(withNull).toBe(withUndefined);

    expect(buildFingerprint(ORG_A, RULE, [null])).toBe(buildFingerprint(ORG_A, RULE, [undefined]));
    expect(buildFingerprint(ORG_A, RULE, [null, undefined])).toBe(
      buildFingerprint(ORG_A, RULE, [undefined, null]),
    );
  });

  it("treats an absent component as the empty string, not as no component", () => {
    expect(buildFingerprint(ORG_A, RULE, [null])).toBe(buildFingerprint(ORG_A, RULE, [""]));
    expect(buildFingerprint(ORG_A, RULE, [null])).not.toBe(buildFingerprint(ORG_A, RULE, []));
  });

  it("distinguishes an empty component list from a single empty component", () => {
    expect(buildFingerprint(ORG_A, RULE, [])).not.toBe(buildFingerprint(ORG_A, RULE, [""]));
  });

  it("does not fold the rule id into a component or vice versa", () => {
    // Length-prefixing also protects the fixed leading fields.
    const a = buildFingerprint("org", RULE, ["x"]);
    const b = buildFingerprint("or", RULE, ["gx"]);
    expect(a).not.toBe(b);
  });
});
