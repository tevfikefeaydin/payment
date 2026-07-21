import { createHash } from "node:crypto";
import type { ReconciliationRuleId } from "./types";

/**
 * Stable exception fingerprints.
 *
 * A fingerprint identifies "the same underlying problem" across reconciliation
 * runs. It is used as a uniqueness key (organization + fingerprint) so that:
 *
 *   - a repeated run does not create a duplicate open exception, and
 *   - a resolved exception can be REOPENED when the same problem is detected
 *     again, preserving its history.
 *
 * DELIBERATE OMISSION: the rule VERSION is not part of the fingerprint. If it
 * were, publishing a new rule version would orphan every existing exception and
 * create a duplicate for each one. The rule version is recorded on the
 * exception and on the run instead. See docs/adr/0006-exception-fingerprints.md.
 *
 * Components are joined with a separator that cannot occur in an identifier, and
 * each component is length-prefixed, so that ("ab","c") and ("a","bc") can never
 * collide.
 */
export function buildFingerprint(
  organizationId: string,
  ruleId: ReconciliationRuleId,
  components: ReadonlyArray<string | null | undefined>,
): string {
  const parts = [organizationId, ruleId, ...components.map((c) => c ?? "")];
  const canonical = parts.map((part) => `${part.length}:${part}`).join("");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
