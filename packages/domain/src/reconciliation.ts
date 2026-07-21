import { buildFingerprint } from "./fingerprint";
import { MatchIndex } from "./matching";
import { isValidCurrency, normalizeCurrency, toDecimalString } from "./money";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  type EvidenceField,
  type ExceptionCandidate,
  type ProviderPayment,
  type ReconciliationDiagnostics,
  type ReconciliationInput,
  type ReconciliationResult,
  type ReconciliationRuleId,
} from "./types";

/**
 * Deterministic reconciliation engine.
 *
 * Every rule here is a pure function of its inputs plus the injected `now`.
 * There is no randomness, no wall-clock read, no network access and no
 * language model involved in deciding whether an exception exists. Running the
 * engine twice over identical inputs produces byte-identical fingerprints, which
 * is what makes runs idempotent.
 *
 * Each rule is documented in docs/RECONCILIATION_RULES.md with its trigger,
 * non-trigger, severity, revenue-at-risk formula and fingerprint components.
 */

/**
 * Version of the rule set. Bump when a rule's TRIGGER CONDITION changes in a way
 * that alters which exceptions are produced. Recorded on every run and every
 * exception. Deliberately NOT part of the fingerprint — see fingerprint.ts.
 */
export const RULE_VERSION = 1;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Exact, locale-independent amount rendering used inside evidence rows.
 *
 * A currency that cannot be validated falls back to raw minor units rather than
 * throwing: rendering evidence must never abort a whole reconciliation run over
 * one malformed record. Such records are surfaced through
 * `diagnostics.invalidCurrencyRecords` instead.
 */
function describeAmount(amountMinor: bigint, currency: string): string {
  if (!isValidCurrency(currency)) {
    return `${amountMinor.toString(10)} (unrecognised currency ${JSON.stringify(currency)})`;
  }
  return `${toDecimalString(amountMinor, currency)} ${normalizeCurrency(currency)}`;
}

function describeDate(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function field(
  label: string,
  providerValue: string | null,
  internalValue: string | null,
): EvidenceField {
  return {
    label,
    providerValue,
    internalValue,
    differs: providerValue !== null && internalValue !== null && providerValue !== internalValue,
  };
}

interface RuleContext {
  input: ReconciliationInput;
  index: MatchIndex;
  diagnostics: ReconciliationDiagnostics;
  emit: (candidate: ExceptionCandidate) => void;
}

function candidate(
  ctx: RuleContext,
  ruleId: ReconciliationRuleId,
  parts: {
    fingerprintComponents: ReadonlyArray<string | null | undefined>;
    severity: ExceptionCandidate["severity"];
    summary: string;
    revenueAtRiskMinor: bigint | null;
    currency: string | null;
    providerObjectId?: string | null;
    internalRecordId?: string | null;
    internalExternalId?: string | null;
    evidence: EvidenceField[];
    probableCauses: string[];
    recommendedActions: string[];
    occurredAt: Date | null;
  },
): ExceptionCandidate {
  return {
    ruleId,
    ruleVersion: RULE_VERSION,
    fingerprint: buildFingerprint(ctx.input.organizationId, ruleId, parts.fingerprintComponents),
    severity: parts.severity,
    summary: parts.summary,
    revenueAtRiskMinor: parts.revenueAtRiskMinor,
    currency: parts.currency,
    providerObjectId: parts.providerObjectId ?? null,
    internalRecordId: parts.internalRecordId ?? null,
    internalExternalId: parts.internalExternalId ?? null,
    evidence: parts.evidence,
    probableCauses: parts.probableCauses,
    recommendedActions: parts.recommendedActions,
    occurredAt: parts.occurredAt,
  };
}

/** Net amount still exposed on a provider payment: captured minus refunded. */
function netAtRisk(payment: ProviderPayment): bigint {
  const net = payment.amountMinor - payment.amountRefundedMinor;
  return net > 0n ? net : 0n;
}

// ---------------------------------------------------------------------------
// Rule 1 — PAYMENT_SUCCEEDED_INTERNAL_MISSING
// ---------------------------------------------------------------------------

/**
 * Stripe captured money but the customer's system has no record of it at all.
 * This is the highest-impact failure: revenue collected, nothing provisioned.
 *
 * Non-trigger: payments younger than the propagation grace window, because the
 * customer's webhook handler may legitimately still be catching up.
 */
export function rulePaymentSucceededInternalMissing(ctx: RuleContext): void {
  const graceMs = ctx.input.config.internalPropagationGraceMinutes * MINUTE_MS;

  for (const payment of ctx.input.providerPayments) {
    if (payment.status !== "succeeded") continue;

    if (ctx.input.now.getTime() - payment.createdAt.getTime() < graceMs) {
      ctx.diagnostics.withinPropagationGrace += 1;
      continue;
    }

    const match = ctx.index.findInternalFor(payment);
    if (match.ambiguous) {
      ctx.diagnostics.ambiguousProviderMatches += 1;
      continue;
    }
    if (match.value) continue;

    const risk = netAtRisk(payment);
    ctx.emit(
      candidate(ctx, "PAYMENT_SUCCEEDED_INTERNAL_MISSING", {
        fingerprintComponents: [payment.id],
        severity: "critical",
        summary:
          `Stripe captured ${describeAmount(payment.amountMinor, payment.currency)} ` +
          `but no matching record exists in your system.`,
        revenueAtRiskMinor: risk,
        currency: payment.currency,
        providerObjectId: payment.id,
        evidence: [
          field("Provider payment", payment.id, null),
          field("Status", payment.status, "not found"),
          field("Amount", describeAmount(payment.amountMinor, payment.currency), null),
          field("Currency", payment.currency, null),
          field("Customer", payment.customerId, null),
          field("Invoice", payment.invoiceId, null),
          field("Created", describeDate(payment.createdAt), null),
        ],
        probableCauses: [
          "The webhook that records successful payments failed or was never delivered.",
          "The payment was created outside your normal checkout flow (Stripe Dashboard, API, or a recovery link).",
          "The internal write failed after the charge succeeded and was not retried.",
        ],
        recommendedActions: [
          "Locate the payment in Stripe and confirm what the customer purchased.",
          "Replay or re-run your own webhook handler for this payment, then re-run reconciliation.",
          "Check your webhook endpoint's error rate around the payment time.",
        ],
        occurredAt: payment.createdAt,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Rule 2 — PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID
// ---------------------------------------------------------------------------

/**
 * The internal record exists and is linked to the payment, but does not reflect
 * a successful payment. The customer has almost certainly been charged without
 * receiving what they paid for.
 */
export function rulePaymentSucceededInternalNotPaid(ctx: RuleContext): void {
  const graceMs = ctx.input.config.internalPropagationGraceMinutes * MINUTE_MS;

  for (const payment of ctx.input.providerPayments) {
    if (payment.status !== "succeeded") continue;
    if (ctx.input.now.getTime() - payment.createdAt.getTime() < graceMs) continue;

    const match = ctx.index.findInternalFor(payment);
    const record = match.value;
    if (!record) continue;

    // "refunded" and "partially_refunded" both imply the payment was recognised
    // as successful at some point, so they are not a not-paid condition here.
    if (
      record.status === "paid" ||
      record.status === "refunded" ||
      record.status === "partially_refunded"
    ) {
      continue;
    }

    const severity = record.status === "failed" ? "critical" : "high";
    ctx.emit(
      candidate(ctx, "PAYMENT_SUCCEEDED_INTERNAL_NOT_PAID", {
        fingerprintComponents: [payment.id, record.externalId],
        severity,
        summary:
          `Stripe reports this payment as succeeded, but your system still shows it as ` +
          `"${record.status}".`,
        revenueAtRiskMinor: netAtRisk(payment),
        currency: payment.currency,
        providerObjectId: payment.id,
        internalRecordId: record.id,
        internalExternalId: record.externalId,
        evidence: [
          field("Provider payment", payment.id, record.providerTransactionId),
          field("Internal record", null, record.externalId),
          field("Status", payment.status, record.status),
          field(
            "Amount",
            describeAmount(payment.amountMinor, payment.currency),
            describeAmount(record.amountMinor, record.currency),
          ),
          field("Occurred", describeDate(payment.createdAt), describeDate(record.occurredAt)),
          field("Last updated internally", null, describeDate(record.recordUpdatedAt)),
        ],
        probableCauses: [
          record.status === "failed"
            ? "Your system recorded a failure for a payment Stripe ultimately captured — often a timeout on the first attempt followed by a successful retry."
            : "The success webhook was lost, delayed, or errored before the record was updated.",
          "A race condition left the record in its pre-confirmation state.",
        ],
        recommendedActions: [
          "Confirm in Stripe that the payment is captured and not disputed.",
          "Update the internal record to paid and provision whatever the customer purchased.",
          "Review handler logs for this payment id to find why the state was never advanced.",
        ],
        occurredAt: payment.createdAt,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Rule 3 — INTERNAL_PAID_PROVIDER_MISSING
// ---------------------------------------------------------------------------

/**
 * The internal system believes a payment succeeded but the provider has no such
 * payment. Usually means value was delivered without ever being charged.
 *
 * Non-trigger: records with neither a provider transaction id nor a customer id,
 * because there is no safe basis on which to assert the payment is missing.
 * Those are counted in diagnostics instead.
 */
export function ruleInternalPaidProviderMissing(ctx: RuleContext): void {
  const graceMs = ctx.input.config.internalPropagationGraceMinutes * MINUTE_MS;

  for (const record of ctx.input.internalRecords) {
    if (record.status !== "paid") continue;
    if (ctx.input.now.getTime() - record.occurredAt.getTime() < graceMs) continue;

    const match = ctx.index.findProviderFor(record);
    if (match.ambiguous) {
      ctx.diagnostics.ambiguousInternalMatches += 1;
      continue;
    }
    if (match.value) continue;

    // Without any identifying link we cannot claim the provider is missing it.
    if (!record.providerTransactionId && !record.customerId) {
      ctx.diagnostics.ambiguousInternalMatches += 1;
      continue;
    }

    ctx.emit(
      candidate(ctx, "INTERNAL_PAID_PROVIDER_MISSING", {
        fingerprintComponents: [record.externalId],
        severity: "high",
        summary:
          `Your system records ${describeAmount(record.amountMinor, record.currency)} as paid, ` +
          `but Stripe has no matching payment.`,
        revenueAtRiskMinor: record.amountMinor,
        currency: record.currency,
        internalRecordId: record.id,
        internalExternalId: record.externalId,
        providerObjectId: record.providerTransactionId,
        evidence: [
          field(
            "Provider payment",
            record.providerTransactionId ? "not found" : null,
            record.providerTransactionId,
          ),
          field("Internal record", null, record.externalId),
          field("Status", "not found", record.status),
          field("Amount", null, describeAmount(record.amountMinor, record.currency)),
          field("Customer", null, record.customerId),
          field("Occurred", null, describeDate(record.occurredAt)),
        ],
        probableCauses: [
          "The payment was marked paid optimistically before the provider confirmed it.",
          "A manual or test record was created in the internal system.",
          "The payment was taken through a different provider or account than the one connected here.",
          "The connected Stripe account is in a different mode (test vs live) than the internal data.",
        ],
        recommendedActions: [
          "Search Stripe for the customer to confirm no payment exists.",
          "If no payment was taken, decide whether to invoice the customer or reverse the entitlement.",
          "If the payment lives in another Stripe account, connect that account as an additional source.",
        ],
        occurredAt: record.occurredAt,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Rule 4 — PAYMENT_AMOUNT_MISMATCH
// ---------------------------------------------------------------------------

/**
 * A matched pair disagrees on amount within the SAME currency. Comparing across
 * currencies is meaningless without an FX rate, so differing currencies are
 * handled exclusively by rule 5.
 */
export function rulePaymentAmountMismatch(ctx: RuleContext): void {
  for (const payment of ctx.input.providerPayments) {
    if (payment.status !== "succeeded") continue;

    const match = ctx.index.findInternalFor(payment);
    const record = match.value;
    if (!record) continue;
    // A record whose currency cannot be validated is not comparable at all.
    // Rule 5 owns that case and counts it in diagnostics; normalising it here
    // would throw and abort the entire run.
    if (!isValidCurrency(record.currency)) continue;
    if (normalizeCurrency(payment.currency) !== normalizeCurrency(record.currency)) continue;
    if (payment.amountMinor === record.amountMinor) continue;

    const difference =
      payment.amountMinor > record.amountMinor
        ? payment.amountMinor - record.amountMinor
        : record.amountMinor - payment.amountMinor;

    const overcharged = payment.amountMinor > record.amountMinor;
    ctx.emit(
      candidate(ctx, "PAYMENT_AMOUNT_MISMATCH", {
        fingerprintComponents: [payment.id, record.externalId],
        severity: "high",
        summary:
          `Stripe charged ${describeAmount(payment.amountMinor, payment.currency)} but your ` +
          `system recorded ${describeAmount(record.amountMinor, record.currency)} ` +
          `(difference ${describeAmount(difference, payment.currency)}).`,
        revenueAtRiskMinor: difference,
        currency: payment.currency,
        providerObjectId: payment.id,
        internalRecordId: record.id,
        internalExternalId: record.externalId,
        evidence: [
          field("Provider payment", payment.id, record.providerTransactionId),
          field(
            "Amount",
            describeAmount(payment.amountMinor, payment.currency),
            describeAmount(record.amountMinor, record.currency),
          ),
          field("Currency", payment.currency, record.currency),
          field(
            "Difference",
            `${overcharged ? "provider higher by" : "internal higher by"} ${describeAmount(difference, payment.currency)}`,
            null,
          ),
          field("Occurred", describeDate(payment.createdAt), describeDate(record.occurredAt)),
        ],
        probableCauses: [
          "A discount, coupon, tax or shipping amount was applied on one side only.",
          "The internal record stores the pre-tax or pre-discount amount.",
          "A currency minor-unit conversion error (for example treating JPY as two-decimal).",
          "The order was modified after the payment was captured.",
        ],
        recommendedActions: [
          "Compare the Stripe line items with the internal order breakdown.",
          "Confirm which figure is authoritative and correct the other side.",
          overcharged
            ? "If the customer was overcharged, decide whether a refund is owed."
            : "If the customer was undercharged, decide whether to collect the difference.",
        ],
        occurredAt: payment.createdAt,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Rule 5 — PAYMENT_CURRENCY_MISMATCH
// ---------------------------------------------------------------------------

/**
 * A matched pair disagrees on currency. Revenue at risk is reported in the
 * PROVIDER's currency — the money actually moved — and never converted.
 */
export function rulePaymentCurrencyMismatch(ctx: RuleContext): void {
  for (const payment of ctx.input.providerPayments) {
    if (payment.status !== "succeeded") continue;

    const match = ctx.index.findInternalFor(payment);
    const record = match.value;
    if (!record) continue;

    if (!isValidCurrency(record.currency)) {
      ctx.diagnostics.invalidCurrencyRecords += 1;
      continue;
    }
    if (normalizeCurrency(payment.currency) === normalizeCurrency(record.currency)) continue;

    ctx.emit(
      candidate(ctx, "PAYMENT_CURRENCY_MISMATCH", {
        fingerprintComponents: [payment.id, record.externalId],
        severity: "critical",
        summary:
          `Stripe settled this payment in ${normalizeCurrency(payment.currency)} but your system ` +
          `recorded it in ${normalizeCurrency(record.currency)}. Amounts cannot be compared ` +
          `without an explicit exchange rate.`,
        // No FX conversion exists in the MVP, so the exposure is stated in the
        // currency that actually moved and is never summed with the other side.
        revenueAtRiskMinor: netAtRisk(payment),
        currency: payment.currency,
        providerObjectId: payment.id,
        internalRecordId: record.id,
        internalExternalId: record.externalId,
        evidence: [
          field("Provider payment", payment.id, record.providerTransactionId),
          field(
            "Currency",
            normalizeCurrency(payment.currency),
            normalizeCurrency(record.currency),
          ),
          field(
            "Amount",
            describeAmount(payment.amountMinor, payment.currency),
            describeAmount(record.amountMinor, record.currency),
          ),
          field("Occurred", describeDate(payment.createdAt), describeDate(record.occurredAt)),
        ],
        probableCauses: [
          "The internal system assumes a single default currency and ignores the provider's.",
          "A multi-currency checkout writes the presentment currency instead of the settlement currency.",
          "The currency column was populated from a hard-coded constant.",
        ],
        recommendedActions: [
          "Confirm the settlement currency in Stripe for this payment.",
          "Store the provider's currency verbatim on the internal record.",
          "Audit other records for the same customer for the same defect.",
        ],
        occurredAt: payment.createdAt,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Rule 6 — DUPLICATE_SUCCEEDED_PAYMENT
// ---------------------------------------------------------------------------

/**
 * The same customer was charged the same amount more than once inside a short
 * window. Revenue at risk counts only the EXCESS charges (every payment after
 * the earliest), net of anything already refunded, so a duplicate that was
 * refunded contributes nothing and is not double-counted.
 *
 * Requires a customer id: without one, "same amount twice" is not evidence of a
 * duplicate.
 */
export function ruleDuplicateSucceededPayment(ctx: RuleContext): void {
  const windowMs = ctx.input.config.duplicateWindowMinutes * MINUTE_MS;

  const groups = new Map<string, ProviderPayment[]>();
  for (const payment of ctx.input.providerPayments) {
    if (payment.status !== "succeeded") continue;
    if (!payment.customerId) continue;
    const key = `${payment.customerId} ${payment.amountMinor.toString(10)} ${normalizeCurrency(payment.currency)}`;
    const existing = groups.get(key);
    if (existing) existing.push(payment);
    else groups.set(key, [payment]);
  }

  for (const payments of groups.values()) {
    if (payments.length < 2) continue;

    const sorted = [...payments].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
    );

    // Walk the sorted list building clusters where each payment is within the
    // window of the cluster's FIRST payment.
    let cluster: ProviderPayment[] = [];
    const flush = (): void => {
      if (cluster.length >= 2) emitDuplicateCluster(ctx, cluster);
      cluster = [];
    };

    for (const payment of sorted) {
      const first = cluster[0];
      if (!first) {
        cluster = [payment];
        continue;
      }
      if (payment.createdAt.getTime() - first.createdAt.getTime() <= windowMs) {
        cluster.push(payment);
      } else {
        flush();
        cluster = [payment];
      }
    }
    flush();
  }
}

function emitDuplicateCluster(ctx: RuleContext, cluster: ProviderPayment[]): void {
  const first = cluster[0];
  if (!first) return;
  const extras = cluster.slice(1);

  // Only the excess charges are at risk, and only the portion not yet refunded.
  let risk = 0n;
  for (const payment of extras) risk += netAtRisk(payment);

  const allRefunded = risk === 0n;

  ctx.emit(
    candidate(ctx, "DUPLICATE_SUCCEEDED_PAYMENT", {
      // Anchored on the earliest payment so that a third duplicate arriving
      // later updates this exception rather than creating a second one.
      fingerprintComponents: [
        first.customerId,
        first.amountMinor.toString(10),
        normalizeCurrency(first.currency),
        first.id,
      ],
      severity: allRefunded ? "low" : "critical",
      summary: allRefunded
        ? `Customer was charged ${describeAmount(first.amountMinor, first.currency)} ` +
          `${cluster.length} times; the duplicate charges have already been refunded.`
        : `Customer was charged ${describeAmount(first.amountMinor, first.currency)} ` +
          `${cluster.length} times within a short window.`,
      revenueAtRiskMinor: risk,
      currency: first.currency,
      providerObjectId: first.id,
      evidence: [
        field("Customer", first.customerId, null),
        field("Charge count", String(cluster.length), null),
        field("Amount each", describeAmount(first.amountMinor, first.currency), null),
        field("Payments", cluster.map((p) => p.id).join(", "), null),
        field("First charged", describeDate(first.createdAt), null),
        field("Last charged", describeDate(cluster[cluster.length - 1]?.createdAt ?? null), null),
        field("Excess not refunded", describeAmount(risk, first.currency), null),
      ],
      probableCauses: [
        "The customer double-submitted a checkout form with no idempotency key.",
        "A client-side retry re-sent the payment request after a slow response.",
        "A webhook retry re-triggered charge creation instead of being treated as idempotent.",
      ],
      recommendedActions: allRefunded
        ? [
            "Confirm the refunds are complete and the customer was made whole.",
            "Add an idempotency key to the charge-creation path to prevent recurrence.",
          ]
        : [
            "Verify with the customer whether multiple purchases were intended.",
            "Refund the excess charges in Stripe if they were unintended.",
            "Add an idempotency key to the charge-creation path to prevent recurrence.",
          ],
      occurredAt: first.createdAt,
    }),
  );
}

// ---------------------------------------------------------------------------
// Rule 7 — REFUND_STATUS_MISMATCH
// ---------------------------------------------------------------------------

/**
 * Refund state disagrees between provider and internal system, in either
 * direction. Both directions share a rule id because they describe the same
 * class of problem, but they carry distinct summaries, causes and fingerprints.
 */
export function ruleRefundStatusMismatch(ctx: RuleContext): void {
  const graceMs = ctx.input.config.refundPropagationGraceMinutes * MINUTE_MS;

  // Latest succeeded refund time per payment, used for the grace check.
  const latestRefundAt = new Map<string, Date>();
  for (const refund of ctx.input.providerRefunds) {
    if (refund.status !== "succeeded" || !refund.paymentId) continue;
    const current = latestRefundAt.get(refund.paymentId);
    if (!current || refund.createdAt > current)
      latestRefundAt.set(refund.paymentId, refund.createdAt);
  }

  for (const payment of ctx.input.providerPayments) {
    if (payment.status !== "succeeded") continue;

    const match = ctx.index.findInternalFor(payment);
    const record = match.value;
    if (!record) continue;

    const providerRefunded = payment.amountRefundedMinor > 0n;
    const fullyRefunded = providerRefunded && payment.amountRefundedMinor >= payment.amountMinor;
    const internalRefunded = record.status === "refunded" || record.status === "partially_refunded";

    // --- Direction A: provider refunded, internal system unaware.
    if (providerRefunded && !internalRefunded) {
      const refundedAt = latestRefundAt.get(payment.id);
      if (refundedAt && ctx.input.now.getTime() - refundedAt.getTime() < graceMs) continue;

      ctx.emit(
        candidate(ctx, "REFUND_STATUS_MISMATCH", {
          fingerprintComponents: [payment.id, record.externalId, "provider_refunded"],
          severity: "high",
          summary:
            `Stripe refunded ${describeAmount(payment.amountRefundedMinor, payment.currency)} ` +
            `but your system still shows this payment as "${record.status}".`,
          revenueAtRiskMinor: payment.amountRefundedMinor,
          currency: payment.currency,
          providerObjectId: payment.id,
          internalRecordId: record.id,
          internalExternalId: record.externalId,
          evidence: [
            field("Provider payment", payment.id, record.providerTransactionId),
            field(
              "Refunded amount",
              describeAmount(payment.amountRefundedMinor, payment.currency),
              "0",
            ),
            field("Refund type", fullyRefunded ? "full" : "partial", null),
            field("Status", fullyRefunded ? "refunded" : "partially_refunded", record.status),
            field("Refunded at", describeDate(refundedAt ?? null), null),
          ],
          probableCauses: [
            "The refund was issued from the Stripe Dashboard and no webhook updated the internal record.",
            "The `charge.refunded` webhook is not subscribed to or is failing.",
            "The internal system has no representation for partial refunds.",
          ],
          recommendedActions: [
            "Update the internal record to reflect the refund and revoke any entitlement it granted.",
            "Subscribe to and verify handling of refund webhooks.",
          ],
          occurredAt: refundedAt ?? payment.createdAt,
        }),
      );
      continue;
    }

    // --- Direction B: internal system believes a refund happened, provider disagrees.
    if (internalRefunded && !providerRefunded) {
      ctx.emit(
        candidate(ctx, "REFUND_STATUS_MISMATCH", {
          fingerprintComponents: [payment.id, record.externalId, "internal_refunded"],
          severity: "high",
          summary:
            `Your system shows this payment as "${record.status}", but Stripe reports no refund. ` +
            `The customer may have been credited without money being returned.`,
          revenueAtRiskMinor: record.amountMinor,
          currency: record.currency,
          providerObjectId: payment.id,
          internalRecordId: record.id,
          internalExternalId: record.externalId,
          evidence: [
            field("Provider payment", payment.id, record.providerTransactionId),
            field("Refunded amount", describeAmount(0n, payment.currency), "recorded as refunded"),
            field("Status", payment.status, record.status),
            field(
              "Amount",
              describeAmount(payment.amountMinor, payment.currency),
              describeAmount(record.amountMinor, record.currency),
            ),
          ],
          probableCauses: [
            "A refund was recorded internally but the provider call failed or was never made.",
            "The refund was issued against a different payment or provider account.",
            "A support tool marks records refunded without calling the provider.",
          ],
          recommendedActions: [
            "Confirm in Stripe whether a refund exists for this payment.",
            "If the customer is owed money, issue the refund in Stripe directly.",
            "Ensure the internal refund path fails loudly when the provider call does not succeed.",
          ],
          occurredAt: payment.createdAt,
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Rule 8 — PAID_INVOICE_INACTIVE_SUBSCRIPTION
// ---------------------------------------------------------------------------

/**
 * An invoice was paid, but the subscription it belongs to is not in a state
 * that should be billing. The customer is paying for something that is likely
 * not being delivered.
 */
export function rulePaidInvoiceInactiveSubscription(ctx: RuleContext): void {
  const subscriptions = indexById(ctx.input.providerSubscriptions);

  for (const invoice of ctx.input.providerInvoices) {
    if (invoice.status !== "paid") continue;
    if (!invoice.subscriptionId) continue;

    const subscription = subscriptions.get(invoice.subscriptionId);
    if (!subscription) continue;
    if (ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) continue;

    // A final invoice paid before cancellation is normal. Only flag when the
    // invoice was paid at or after the cancellation moment.
    if (
      subscription.canceledAt &&
      invoice.paidAt &&
      invoice.paidAt.getTime() < subscription.canceledAt.getTime()
    ) {
      continue;
    }

    ctx.emit(
      candidate(ctx, "PAID_INVOICE_INACTIVE_SUBSCRIPTION", {
        fingerprintComponents: [invoice.id],
        severity: "high",
        summary:
          `Invoice was paid (${describeAmount(invoice.amountPaidMinor, invoice.currency)}) but its ` +
          `subscription is "${subscription.status}".`,
        revenueAtRiskMinor: invoice.amountPaidMinor,
        currency: invoice.currency,
        providerObjectId: invoice.id,
        evidence: [
          field("Invoice", invoice.id, null),
          field("Invoice status", invoice.status, null),
          field("Amount paid", describeAmount(invoice.amountPaidMinor, invoice.currency), null),
          field("Subscription", subscription.id, null),
          field("Subscription status", subscription.status, null),
          field("Canceled at", describeDate(subscription.canceledAt), null),
          field("Invoice paid at", describeDate(invoice.paidAt), null),
        ],
        probableCauses: [
          "The subscription was cancelled but a scheduled invoice still collected payment.",
          "Cancellation was processed internally without cancelling in Stripe.",
          "A dunning retry succeeded after the subscription had already been marked unpaid.",
        ],
        recommendedActions: [
          "Confirm whether the customer should still have access.",
          "If the charge was not owed, refund it in Stripe.",
          "Align the cancellation flow so internal and Stripe state change together.",
        ],
        occurredAt: invoice.paidAt ?? invoice.createdAt,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Rule 9 — FAILED_INVOICE_ACTIVE_SUBSCRIPTION
// ---------------------------------------------------------------------------

/**
 * An invoice has failed to collect, yet the subscription is still active or
 * trialing. Service is being delivered without payment.
 */
export function ruleFailedInvoiceActiveSubscription(ctx: RuleContext): void {
  const subscriptions = indexById(ctx.input.providerSubscriptions);

  for (const invoice of ctx.input.providerInvoices) {
    const failed =
      invoice.status === "uncollectible" || (invoice.status === "open" && invoice.attemptCount > 0);
    if (!failed) continue;
    if (!invoice.subscriptionId) continue;

    const subscription = subscriptions.get(invoice.subscriptionId);
    if (!subscription) continue;
    if (!ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) continue;

    const outstanding = invoice.amountDueMinor - invoice.amountPaidMinor;
    if (outstanding <= 0n) continue;

    ctx.emit(
      candidate(ctx, "FAILED_INVOICE_ACTIVE_SUBSCRIPTION", {
        fingerprintComponents: [invoice.id],
        severity: "high",
        summary:
          `Invoice has not been collected (${describeAmount(outstanding, invoice.currency)} outstanding ` +
          `after ${invoice.attemptCount} attempt${invoice.attemptCount === 1 ? "" : "s"}) but the ` +
          `subscription is still "${subscription.status}".`,
        revenueAtRiskMinor: outstanding,
        currency: invoice.currency,
        providerObjectId: invoice.id,
        evidence: [
          field("Invoice", invoice.id, null),
          field("Invoice status", invoice.status, null),
          field("Amount due", describeAmount(invoice.amountDueMinor, invoice.currency), null),
          field("Amount paid", describeAmount(invoice.amountPaidMinor, invoice.currency), null),
          field("Outstanding", describeAmount(outstanding, invoice.currency), null),
          field("Attempts", String(invoice.attemptCount), null),
          field("Subscription", subscription.id, null),
          field("Subscription status", subscription.status, null),
        ],
        probableCauses: [
          "Dunning is exhausted but the subscription was never downgraded or paused.",
          "Your application grants access on subscription status alone and ignores invoice state.",
          "The customer's payment method expired and no recovery flow ran.",
        ],
        recommendedActions: [
          "Decide whether access should be suspended until the invoice is paid.",
          "Prompt the customer to update their payment method.",
          "Gate entitlement on invoice payment, not only on subscription status.",
        ],
        occurredAt: invoice.createdAt,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Rule 10 — STALE_INTERNAL_PENDING_PAYMENT
// ---------------------------------------------------------------------------

/**
 * An internal payment has been pending far longer than any real payment takes.
 * Either it silently failed, or it succeeded and the update was lost.
 *
 * Non-trigger: pending records whose provider payment is already known to have
 * succeeded — rule 2 reports those with better evidence, and reporting both
 * would double-count the same money.
 */
export function ruleStaleInternalPendingPayment(ctx: RuleContext): void {
  const thresholdMs = ctx.input.config.stalePendingHours * HOUR_MS;

  for (const record of ctx.input.internalRecords) {
    if (record.status !== "pending") continue;

    const age = ctx.input.now.getTime() - record.occurredAt.getTime();
    if (age < thresholdMs) continue;

    const match = ctx.index.findProviderFor(record);
    if (match.value?.status === "succeeded") continue; // covered by rule 2

    // Integer division on bigint. `age` is a duration in milliseconds, not a
    // monetary value, but the money-safety lint rule that bans Math.floor in
    // this package is deliberately absolute — an exception here would blunt it.
    // Bigint division is exact and expresses the intent (whole hours) directly.
    const hours = Number(BigInt(age) / BigInt(HOUR_MS));
    const providerStatus = match.value?.status ?? null;

    ctx.emit(
      candidate(ctx, "STALE_INTERNAL_PENDING_PAYMENT", {
        fingerprintComponents: [record.externalId],
        severity: "medium",
        summary:
          `Payment has been pending for ${hours} hours ` +
          `(${describeAmount(record.amountMinor, record.currency)}).`,
        revenueAtRiskMinor: record.amountMinor,
        currency: record.currency,
        internalRecordId: record.id,
        internalExternalId: record.externalId,
        providerObjectId: match.value?.id ?? null,
        evidence: [
          field("Internal record", null, record.externalId),
          field("Status", providerStatus ?? "not found", record.status),
          field("Amount", null, describeAmount(record.amountMinor, record.currency)),
          field("Pending since", null, describeDate(record.occurredAt)),
          field("Age", null, `${hours} hours`),
          field("Provider payment", match.value?.id ?? "not found", record.providerTransactionId),
        ],
        probableCauses: [
          providerStatus
            ? `The provider payment is "${providerStatus}" and the internal record was never advanced to a terminal state.`
            : "The payment was never completed and no failure was recorded.",
          "The customer abandoned checkout and the record was left pending.",
          "A terminal-state webhook (success or failure) was never processed.",
        ],
        recommendedActions: [
          "Check the provider for a terminal outcome and update the record accordingly.",
          "Expire abandoned pending payments automatically after a defined period.",
          "Alert on records that stay pending beyond your expected settlement time.",
        ],
        occurredAt: record.occurredAt,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Rules run in a fixed order so output ordering is deterministic. */
const RULES: ReadonlyArray<(ctx: RuleContext) => void> = [
  rulePaymentSucceededInternalMissing,
  rulePaymentSucceededInternalNotPaid,
  ruleInternalPaidProviderMissing,
  rulePaymentAmountMismatch,
  rulePaymentCurrencyMismatch,
  ruleDuplicateSucceededPayment,
  ruleRefundStatusMismatch,
  rulePaidInvoiceInactiveSubscription,
  ruleFailedInvoiceActiveSubscription,
  ruleStaleInternalPendingPayment,
];

/**
 * Execute every rule against one organization's data.
 *
 * Pure and deterministic: identical input yields identical output, including
 * candidate ordering and fingerprints.
 */
export function runReconciliation(input: ReconciliationInput): ReconciliationResult {
  const index = new MatchIndex(input.providerPayments, input.internalRecords, input.config);
  const diagnostics: ReconciliationDiagnostics = {
    ambiguousProviderMatches: 0,
    ambiguousInternalMatches: 0,
    withinPropagationGrace: 0,
    invalidCurrencyRecords: 0,
  };

  const candidates: ExceptionCandidate[] = [];
  const seen = new Set<string>();

  const ctx: RuleContext = {
    input,
    index,
    diagnostics,
    emit: (value) => {
      // Defensive: a fingerprint collision inside a single run would otherwise
      // violate the (organization, fingerprint) uniqueness constraint on insert.
      if (seen.has(value.fingerprint)) return;
      seen.add(value.fingerprint);
      candidates.push(value);
    },
  };

  for (const rule of RULES) rule(ctx);

  const countsByRule: Record<string, number> = {};
  for (const value of candidates) {
    countsByRule[value.ruleId] = (countsByRule[value.ruleId] ?? 0) + 1;
  }

  // Stable ordering: severity, then rule, then fingerprint.
  candidates.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.ruleId.localeCompare(b.ruleId) ||
      a.fingerprint.localeCompare(b.fingerprint),
  );

  return { ruleVersion: RULE_VERSION, candidates, diagnostics, countsByRule };
}

function severityRank(severity: ExceptionCandidate["severity"]): number {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
  }
}

function indexById<T extends { id: string }>(values: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of values) map.set(value.id, value);
  return map;
}
