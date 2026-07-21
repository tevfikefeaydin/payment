import { describe, expect, it } from "vitest";
import { PRODUCT } from "@payrecon/config";
import {
  exceptionUrl,
  renderDigestEmail,
  renderDigestSlack,
  summarizeDigest,
  toDeliverySummary,
  type DigestException,
  type DigestInput,
} from "./rendering";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const APP_URL = "https://app.payrecon.test";

function digest(exceptions: DigestException[], overrides: Partial<DigestInput> = {}): DigestInput {
  return {
    organizationId: ORG_ID,
    organizationName: "Acme Payments",
    appUrl: APP_URL,
    exceptions,
    ...overrides,
  };
}

const usdException: DigestException = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  ruleId: "PAYMENT_AMOUNT_MISMATCH",
  severity: "critical",
  summary: "Stripe charged 20.00 more than the internal record",
  revenueAtRiskMinor: 123_456n,
  currency: "USD",
};

const jpyException: DigestException = {
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  ruleId: "INTERNAL_PAID_PROVIDER_MISSING",
  severity: "high",
  summary: "Marked paid internally with no matching Stripe payment",
  revenueAtRiskMinor: 5_000n,
  currency: "JPY",
};

describe("summarizeDigest", () => {
  it("counts by severity and reports the highest", () => {
    const summary = summarizeDigest([
      usdException,
      jpyException,
      { ...jpyException, id: "x", severity: "low" },
    ]);
    expect(summary.total).toBe(3);
    expect(summary.countsBySeverity).toEqual({ critical: 1, high: 1, medium: 0, low: 1 });
    expect(summary.highestSeverity).toBe("critical");
  });

  it("keeps revenue at risk separate per currency", () => {
    const summary = summarizeDigest([usdException, jpyException]);
    expect(summary.revenueAtRisk).toEqual([
      { currency: "JPY", amountMinor: 5_000n, formatted: "¥5,000" },
      { currency: "USD", amountMinor: 123_456n, formatted: "$1,234.56" },
    ]);
  });

  it("ignores an amount that has no currency, rather than guessing one", () => {
    const summary = summarizeDigest([
      { ...usdException, revenueAtRiskMinor: 999n, currency: null },
    ]);
    expect(summary.revenueAtRisk).toEqual([]);
  });
});

describe("revenue at risk is never combined across currencies", () => {
  const mixed = digest([usdException, jpyException]);

  it("shows USD and JPY as separate lines in the email", () => {
    const email = renderDigestEmail(mixed);
    expect(email.text).toContain("$1,234.56");
    expect(email.text).toContain("¥5,000");
    expect(email.html).toContain("$1,234.56");
    expect(email.html).toContain("¥5,000");
  });

  it("shows USD and JPY as separate lines in Slack", () => {
    const slack = renderDigestSlack(mixed);
    const payload = JSON.stringify(slack.blocks);
    expect(payload).toContain("$1,234.56");
    expect(payload).toContain("¥5,000");
  });

  it("never renders the meaningless sum of unlike currencies", () => {
    const email = renderDigestEmail(mixed);
    const slack = JSON.stringify(renderDigestSlack(mixed));
    // 123456 + 5000 = 128456, however that sum were formatted.
    for (const combined of ["128,456", "1,284.56", "128456"]) {
      expect(email.text).not.toContain(combined);
      expect(email.html).not.toContain(combined);
      expect(slack).not.toContain(combined);
    }
  });

  it("carries one entry per currency into the stored delivery summary", () => {
    const stored = toDeliverySummary(summarizeDigest([usdException, jpyException]));
    expect(stored.revenueAtRisk).toEqual([
      { currency: "JPY", amountMinor: "5000" },
      { currency: "USD", amountMinor: "123456" },
    ]);
  });
});

describe("zero-decimal currencies", () => {
  it("renders JPY without a fractional part", () => {
    const email = renderDigestEmail(digest([jpyException]));
    expect(email.text).toContain("¥5,000");
    expect(email.text).not.toContain("¥50.00");
    expect(email.text).not.toContain("5,000.00");
  });
});

describe("deep links", () => {
  it("builds a link containing the organization and exception ids", () => {
    expect(exceptionUrl(APP_URL, ORG_ID, "exc-9")).toBe(
      `${APP_URL}/orgs/${ORG_ID}/exceptions/exc-9`,
    );
  });

  it("tolerates a trailing slash on APP_URL", () => {
    expect(exceptionUrl(`${APP_URL}/`, ORG_ID, "exc-9")).toBe(
      `${APP_URL}/orgs/${ORG_ID}/exceptions/exc-9`,
    );
  });

  it("includes the per-exception deep link in the email and in Slack", () => {
    const url = exceptionUrl(APP_URL, ORG_ID, usdException.id);
    const input = digest([usdException]);

    const email = renderDigestEmail(input);
    expect(email.text).toContain(url);
    expect(email.html).toContain(`href="${url}"`);
    expect(url).toContain(ORG_ID);
    expect(url).toContain(usdException.id);

    const slack = JSON.stringify(renderDigestSlack(input).blocks);
    expect(slack).toContain(`<${url}|View exception>`);
  });
});

describe("untrusted values are escaped for the target format", () => {
  const hostile: DigestException = {
    id: "aaaaaaaa-0000-4000-8000-000000000003",
    ruleId: "PAYMENT_AMOUNT_MISMATCH",
    severity: "high",
    summary: `<script>alert("xss")</script> Tom & Jerry <https://evil.test|click>`,
    revenueAtRiskMinor: 1_000n,
    currency: "USD",
  };

  const input = digest([hostile], { organizationName: `Evil <b>&</b> Co` });

  it("neutralises the summary in the HTML email", () => {
    const email = renderDigestEmail(input);
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("</script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("Tom &amp; Jerry");
  });

  it("neutralises the organization name in the HTML email", () => {
    const email = renderDigestEmail(input);
    expect(email.html).toContain("Evil &lt;b&gt;&amp;&lt;/b&gt; Co");
    expect(email.html).not.toContain("<b>&</b>");
  });

  it("neutralises the summary in the Slack message", () => {
    const slack = renderDigestSlack(input);
    const payload = JSON.stringify(slack.blocks);
    expect(payload).not.toContain("<script>");
    expect(payload).toContain("&lt;script&gt;");
    expect(payload).toContain("Tom &amp; Jerry");
    // The injected Slack link markup must not survive as live markup.
    expect(payload).not.toContain("<https://evil.test|click>");
    expect(payload).toContain("&lt;https://evil.test|click&gt;");
  });

  it("neutralises the organization name in the Slack fallback text", () => {
    const slack = renderDigestSlack(input);
    expect(slack.text).toContain("Evil &lt;b&gt;&amp;&lt;/b&gt; Co");
    expect(slack.text).not.toContain("<b>");
  });

  it("keeps CR/LF out of the email subject, which would inject headers", () => {
    const email = renderDigestEmail(
      digest([hostile], { organizationName: "Acme\r\nBcc: attacker@evil.test" }),
    );
    expect(email.subject).not.toContain("\r");
    expect(email.subject).not.toContain("\n");
  });
});

describe("digest content", () => {
  it("names the product from central configuration", () => {
    const email = renderDigestEmail(digest([usdException]));
    expect(email.subject).toContain(PRODUCT.name);
    expect(email.text).toContain(PRODUCT.name);
  });

  it("lists the rule, severity and exact amount per exception", () => {
    const email = renderDigestEmail(digest([usdException, jpyException]));
    expect(email.text).toContain("[CRITICAL] PAYMENT_AMOUNT_MISMATCH");
    expect(email.text).toContain("$1,234.56");
    expect(email.text).toContain("[HIGH] INTERNAL_PAID_PROVIDER_MISSING");
    expect(email.text).toContain("¥5,000");
    expect(email.text).toContain("1 critical, 1 high");
  });

  it("labels the batching window when one applies", () => {
    const email = renderDigestEmail(digest([usdException], { windowLabel: "hourly digest" }));
    expect(email.subject).toContain("hourly digest");
  });
});
