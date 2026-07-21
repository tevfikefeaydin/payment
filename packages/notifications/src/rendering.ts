import { PRODUCT } from "@payrecon/config";
import {
  EXCEPTION_SEVERITIES,
  MoneyBag,
  SEVERITY_RANK,
  formatMoney,
  redactSecretsInText,
  serializeAmountMinor,
  type ExceptionSeverity,
} from "@payrecon/domain";
import { escapeHtml, escapeSlackText, toSingleLine, truncate } from "./escaping";

/**
 * Message rendering.
 *
 * Two invariants govern this module.
 *
 *  1. Revenue at risk is reported PER CURRENCY and is never summed across
 *     currencies. There is deliberately no combined total anywhere in a
 *     rendered message, because adding USD to JPY produces a number that means
 *     nothing. `MoneyBag` is used precisely because it offers no `.total()`.
 *
 *  2. Every value that did not originate in this codebase — exception
 *     summaries, rule ids, organization names, destination names — is passed
 *     through `redactSecretsInText`, flattened to a single line, truncated, and
 *     only then escaped for the specific target format.
 *
 * Messages carry the minimum needed to act: what broke, how bad, how much, and
 * a link back to the authorized page. No raw provider payloads, no customer
 * personal data, no credentials.
 */

// ---------------------------------------------------------------------------
// Slack wire format
// ---------------------------------------------------------------------------

export type SlackBlock =
  | { type: "header"; text: { type: "plain_text"; text: string; emoji: boolean } }
  | { type: "section"; text: { type: "mrkdwn"; text: string } }
  | { type: "context"; elements: Array<{ type: "mrkdwn"; text: string }> }
  | { type: "divider" };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface DigestException {
  id: string;
  ruleId: string;
  severity: ExceptionSeverity;
  summary: string;
  revenueAtRiskMinor: bigint | null;
  currency: string | null;
}

export interface DigestInput {
  organizationId: string;
  organizationName: string;
  /** Base application URL; the deep links are built relative to it. */
  appUrl: string;
  exceptions: readonly DigestException[];
  /** Human label for the batching window, e.g. "hourly digest". */
  windowLabel?: string | undefined;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface RenderedSlack {
  text: string;
  blocks: SlackBlock[];
}

// Bounds keep one hostile or runaway value from dominating a message, and keep
// Slack payloads inside its 50-block / 3000-character-per-block limits.
const MAX_SUMMARY_CHARS = 240;
const MAX_NAME_CHARS = 80;
const MAX_RULE_CHARS = 64;
const MAX_SUBJECT_CHARS = 160;
const MAX_LISTED_EXCEPTIONS_EMAIL = 25;
const MAX_LISTED_EXCEPTIONS_SLACK = 10;

/**
 * Normalise an untrusted value before it is escaped for a target format.
 * Order matters: redact, flatten, then truncate — truncating first could cut a
 * credential in half and defeat the redactor's patterns.
 */
function safeValue(value: string, max: number): string {
  return truncate(redactSecretsInText(toSingleLine(value)), max);
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function baseUrl(appUrl: string): string {
  return appUrl.replace(/\/+$/, "");
}

/** Deep link to the authorized exception detail page. */
export function exceptionUrl(appUrl: string, organizationId: string, exceptionId: string): string {
  return `${baseUrl(appUrl)}/orgs/${encodeURIComponent(organizationId)}/exceptions/${encodeURIComponent(exceptionId)}`;
}

/** Deep link to the organization's exception inbox. */
export function inboxUrl(appUrl: string, organizationId: string): string {
  return `${baseUrl(appUrl)}/orgs/${encodeURIComponent(organizationId)}/exceptions`;
}

/** Deep link to the notification settings page, used by verification messages. */
export function notificationSettingsUrl(appUrl: string, organizationId: string): string {
  return `${baseUrl(appUrl)}/orgs/${encodeURIComponent(organizationId)}/settings/notifications`;
}

// ---------------------------------------------------------------------------
// Summarising
// ---------------------------------------------------------------------------

export interface CurrencyRisk {
  currency: string;
  amountMinor: bigint;
  /** Locale-formatted for display, e.g. "$1,234.56" or "¥5,000". */
  formatted: string;
}

export interface DigestSummary {
  total: number;
  countsBySeverity: Record<ExceptionSeverity, number>;
  /** One entry per currency, sorted by code. Never combined. */
  revenueAtRisk: CurrencyRisk[];
  highestSeverity: ExceptionSeverity | null;
}

export function summarizeDigest(exceptions: readonly DigestException[]): DigestSummary {
  const countsBySeverity: Record<ExceptionSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };

  const bag = new MoneyBag();
  let highestSeverity: ExceptionSeverity | null = null;

  for (const exception of exceptions) {
    countsBySeverity[exception.severity] += 1;
    if (
      highestSeverity === null ||
      SEVERITY_RANK[exception.severity] < SEVERITY_RANK[highestSeverity]
    ) {
      highestSeverity = exception.severity;
    }
    // An amount without a currency is not money and is deliberately dropped
    // rather than guessed at.
    if (exception.revenueAtRiskMinor !== null && exception.currency) {
      bag.addAmount(exception.revenueAtRiskMinor, exception.currency);
    }
  }

  return {
    total: exceptions.length,
    countsBySeverity,
    revenueAtRisk: bag.entries().map((entry) => ({
      currency: entry.currency,
      amountMinor: entry.amountMinor,
      formatted: formatMoney(entry.amountMinor, entry.currency),
    })),
    highestSeverity,
  };
}

/**
 * JSON-safe, non-sensitive projection stored on the delivery row for the
 * delivery log UI. Amounts are strings so a bigint never becomes an unsafe
 * JavaScript number.
 */
export function toDeliverySummary(summary: DigestSummary): Record<string, unknown> {
  return {
    total: summary.total,
    countsBySeverity: summary.countsBySeverity,
    revenueAtRisk: summary.revenueAtRisk.map((risk) => ({
      currency: risk.currency,
      amountMinor: serializeAmountMinor(risk.amountMinor),
    })),
  };
}

function severityBreakdown(summary: DigestSummary): string {
  const parts = EXCEPTION_SEVERITIES.filter(
    (severity) => summary.countsBySeverity[severity] > 0,
  ).map((severity) => `${summary.countsBySeverity[severity]} ${severity}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function headline(summary: DigestSummary, windowLabel: string | undefined): string {
  const noun = summary.total === 1 ? "exception" : "exceptions";
  const suffix = windowLabel ? ` (${windowLabel})` : "";
  return `${summary.total} payment ${noun}${suffix}`;
}

function amountLabel(exception: DigestException): string | null {
  if (exception.revenueAtRiskMinor === null || !exception.currency) return null;
  return formatMoney(exception.revenueAtRiskMinor, exception.currency);
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export function renderDigestEmail(input: DigestInput): RenderedEmail {
  const summary = summarizeDigest(input.exceptions);
  const orgName = safeValue(input.organizationName, MAX_NAME_CHARS);

  const subject = truncate(
    toSingleLine(`${PRODUCT.name}: ${headline(summary, input.windowLabel)} — ${orgName}`),
    MAX_SUBJECT_CHARS,
  );

  const listed = input.exceptions.slice(0, MAX_LISTED_EXCEPTIONS_EMAIL);
  const omitted = input.exceptions.length - listed.length;

  // ---- plain text -----------------------------------------------------
  // Not escaped: text/plain is never interpreted as markup, so `<script>` is
  // inert here. It IS redacted and flattened, which is what actually matters.
  const textLines: string[] = [
    `${PRODUCT.name} — ${headline(summary, input.windowLabel)}`,
    `Organization: ${orgName}`,
    "",
    `Severity: ${severityBreakdown(summary)}`,
  ];

  if (summary.revenueAtRisk.length > 0) {
    textLines.push("", "Revenue at risk (reported per currency, never combined):");
    for (const risk of summary.revenueAtRisk) {
      textLines.push(`  ${risk.currency}  ${risk.formatted}`);
    }
  }

  textLines.push("", "Exceptions:");
  listed.forEach((exception, index) => {
    const amount = amountLabel(exception);
    textLines.push(
      `${index + 1}. [${exception.severity.toUpperCase()}] ${safeValue(exception.ruleId, MAX_RULE_CHARS)}` +
        (amount ? ` — ${amount}` : ""),
      `   ${safeValue(exception.summary, MAX_SUMMARY_CHARS)}`,
      `   ${exceptionUrl(input.appUrl, input.organizationId, exception.id)}`,
    );
  });
  if (omitted > 0) textLines.push(`   …and ${omitted} more.`);

  textLines.push(
    "",
    `Open the inbox: ${inboxUrl(input.appUrl, input.organizationId)}`,
    "",
    `You are receiving this because a ${PRODUCT.name} notification policy matched these exceptions.`,
    `Manage destinations: ${notificationSettingsUrl(input.appUrl, input.organizationId)}`,
  );

  // ---- html -----------------------------------------------------------
  const htmlRows = listed
    .map((exception) => {
      const amount = amountLabel(exception);
      const url = exceptionUrl(input.appUrl, input.organizationId, exception.id);
      return [
        "<tr>",
        `<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top">`,
        `<strong>${escapeHtml(exception.severity.toUpperCase())}</strong>`,
        "</td>",
        `<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top">`,
        `<code>${escapeHtml(safeValue(exception.ruleId, MAX_RULE_CHARS))}</code><br>`,
        `<span>${escapeHtml(safeValue(exception.summary, MAX_SUMMARY_CHARS))}</span><br>`,
        `<a href="${escapeHtml(url)}">View exception</a>`,
        "</td>",
        `<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;text-align:right;white-space:nowrap">`,
        amount ? escapeHtml(amount) : "&mdash;",
        "</td>",
        "</tr>",
      ].join("");
    })
    .join("");

  const riskHtml =
    summary.revenueAtRisk.length > 0
      ? [
          `<p style="margin:16px 0 4px"><strong>Revenue at risk</strong> (reported per currency, never combined)</p>`,
          '<ul style="margin:0 0 16px;padding-left:20px">',
          summary.revenueAtRisk
            .map(
              (risk) =>
                `<li>${escapeHtml(risk.currency)}: <strong>${escapeHtml(risk.formatted)}</strong></li>`,
            )
            .join(""),
          "</ul>",
        ].join("")
      : "";

  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827;max-width:640px">`,
    `<h1 style="font-size:18px;margin:0 0 4px">${escapeHtml(PRODUCT.name)} — ${escapeHtml(headline(summary, input.windowLabel))}</h1>`,
    `<p style="margin:0 0 12px;color:#4b5563">Organization: ${escapeHtml(orgName)}</p>`,
    `<p style="margin:0"><strong>Severity:</strong> ${escapeHtml(severityBreakdown(summary))}</p>`,
    riskHtml,
    `<table style="border-collapse:collapse;width:100%">${htmlRows}</table>`,
    omitted > 0 ? `<p style="margin:12px 0;color:#4b5563">…and ${omitted} more.</p>` : "",
    `<p style="margin:16px 0"><a href="${escapeHtml(inboxUrl(input.appUrl, input.organizationId))}">Open the exception inbox</a></p>`,
    `<p style="margin:24px 0 0;font-size:12px;color:#6b7280">You are receiving this because a ${escapeHtml(PRODUCT.name)} notification policy matched these exceptions. <a href="${escapeHtml(notificationSettingsUrl(input.appUrl, input.organizationId))}">Manage destinations</a>.</p>`,
    "</div>",
  ].join("");

  return { subject, text: textLines.join("\n"), html };
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

export function renderDigestSlack(input: DigestInput): RenderedSlack {
  const summary = summarizeDigest(input.exceptions);
  const orgName = safeValue(input.organizationName, MAX_NAME_CHARS);

  const listed = input.exceptions.slice(0, MAX_LISTED_EXCEPTIONS_SLACK);
  const omitted = input.exceptions.length - listed.length;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: truncate(`${PRODUCT.name} — ${headline(summary, input.windowLabel)}`, 150),
        emoji: false,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*Organization:* ${escapeSlackText(orgName)}`,
          `*Severity:* ${escapeSlackText(severityBreakdown(summary))}`,
        ].join("\n"),
      },
    },
  ];

  if (summary.revenueAtRisk.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          "*Revenue at risk* (reported per currency, never combined)",
          ...summary.revenueAtRisk.map(
            (risk) => `• ${escapeSlackText(risk.currency)}: *${escapeSlackText(risk.formatted)}*`,
          ),
        ].join("\n"),
      },
    });
  }

  blocks.push({ type: "divider" });

  for (const exception of listed) {
    const amount = amountLabel(exception);
    const url = exceptionUrl(input.appUrl, input.organizationId, exception.id);
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*${escapeSlackText(exception.severity.toUpperCase())}* · \`${escapeSlackText(safeValue(exception.ruleId, MAX_RULE_CHARS))}\`` +
            (amount ? ` · *${escapeSlackText(amount)}*` : ""),
          escapeSlackText(safeValue(exception.summary, MAX_SUMMARY_CHARS)),
          // The URL is constructed by this package, so only the label is untrusted.
          `<${url}|View exception>`,
        ].join("\n"),
      },
    });
  }

  if (omitted > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `…and ${omitted} more.` }],
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `<${inboxUrl(input.appUrl, input.organizationId)}|Open the ${escapeSlackText(PRODUCT.name)} exception inbox>`,
      },
    ],
  });

  return {
    text: escapeSlackText(
      `${PRODUCT.name}: ${headline(summary, input.windowLabel)} for ${orgName}`,
    ),
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Verification / test messages
// ---------------------------------------------------------------------------

export interface TestMessageInput {
  organizationId: string;
  organizationName: string;
  appUrl: string;
  destinationName: string;
}

export function renderTestEmail(input: TestMessageInput): RenderedEmail {
  const orgName = safeValue(input.organizationName, MAX_NAME_CHARS);
  const destination = safeValue(input.destinationName, MAX_NAME_CHARS);
  const settings = notificationSettingsUrl(input.appUrl, input.organizationId);

  const subject = truncate(
    toSingleLine(`${PRODUCT.name}: verifying "${destination}"`),
    MAX_SUBJECT_CHARS,
  );

  const text = [
    `${PRODUCT.name} verification message`,
    "",
    `This confirms that "${destination}" can receive notifications for ${orgName}.`,
    "No action is needed. The destination becomes active once this message is delivered.",
    "",
    `Manage destinations: ${settings}`,
  ].join("\n");

  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827;max-width:640px">`,
    `<h1 style="font-size:18px;margin:0 0 8px">${escapeHtml(PRODUCT.name)} verification message</h1>`,
    `<p style="margin:0 0 8px">This confirms that <strong>${escapeHtml(destination)}</strong> can receive notifications for ${escapeHtml(orgName)}.</p>`,
    `<p style="margin:0 0 16px;color:#4b5563">No action is needed. The destination becomes active once this message is delivered.</p>`,
    `<p style="margin:0"><a href="${escapeHtml(settings)}">Manage destinations</a></p>`,
    "</div>",
  ].join("");

  return { subject, text, html };
}

export function renderTestSlack(input: TestMessageInput): RenderedSlack {
  const orgName = safeValue(input.organizationName, MAX_NAME_CHARS);
  const destination = safeValue(input.destinationName, MAX_NAME_CHARS);

  return {
    text: escapeSlackText(
      `${PRODUCT.name} verification message for ${orgName} — destination "${destination}" is connected.`,
    ),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*${escapeSlackText(PRODUCT.name)} verification message*`,
            `Destination *${escapeSlackText(destination)}* is connected for ${escapeSlackText(orgName)}.`,
            "It becomes active once this message is delivered.",
          ].join("\n"),
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${notificationSettingsUrl(input.appUrl, input.organizationId)}|Manage destinations>`,
          },
        ],
      },
    ],
  };
}
