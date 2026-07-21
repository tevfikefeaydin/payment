import { beforeEach, describe, expect, it } from "vitest";
import type { Keyring } from "@payrecon/auth/crypto";
import { createMemoryNotificationStore, type MemoryNotificationStore } from "./memory-store";
import { createEmailDestination, createSlackDestination, markVerified } from "./destinations";
import {
  DEFAULT_RETRY_POLICY,
  buildDedupeKey,
  computeBackoffMs,
  digestWindowStart,
  effectiveDigest,
  enqueueForException,
  policyMatches,
  sendPendingDeliveries,
  sendTestMessage,
} from "./delivery";
import {
  MemoryEmailTransport,
  MemorySlackTransport,
  TransportError,
  type NotificationTransports,
} from "./transports";
import type { DeliveryRow, PolicyRow } from "./store";

const ORG = "11111111-1111-4111-8111-111111111111";
const APP_URL = "https://app.payrecon.test";
const WEBHOOK = "https://hooks.slack.com/services/T0A1B2C3D/B9Z8Y7X6W/AbCdEfGhIjKlMnOpQrStUvWx";

const keyring: Keyring = { active: { id: "test-key-1", key: Buffer.alloc(32, 0x11) } };

const T10_05 = new Date("2026-07-21T10:05:00.000Z");
const T10_50 = new Date("2026-07-21T10:50:00.000Z");
const T11_05 = new Date("2026-07-21T11:05:00.000Z");

let db: MemoryNotificationStore;
let email: MemoryEmailTransport;
let slack: MemorySlackTransport;
let transports: NotificationTransports;

beforeEach(() => {
  db = createMemoryNotificationStore();
  db.seedOrganization(ORG, "Acme Payments");
  email = new MemoryEmailTransport();
  slack = new MemorySlackTransport();
  transports = { email, slack };
});

function policy(overrides: Partial<PolicyRow> & { destinationId: string }): PolicyRow {
  return db.seedPolicy({
    organizationId: ORG,
    minSeverity: "low",
    minRevenueAtRiskMinor: null,
    currency: null,
    digest: "immediate",
    criticalBypassesDigest: false,
    enabled: true,
    ...overrides,
  });
}

async function activeEmailDestination(name = "Finance alerts"): Promise<string> {
  const created = await createEmailDestination(db, {
    organizationId: ORG,
    name,
    email: "alerts@example.com",
  });
  await markVerified(db, { organizationId: ORG, destinationId: created.id });
  return created.id;
}

async function activeSlackDestination(name = "#payments"): Promise<string> {
  const created = await createSlackDestination(db, {
    organizationId: ORG,
    name,
    webhookUrl: WEBHOOK,
    keyring,
  });
  await markVerified(db, { organizationId: ORG, destinationId: created.id });
  return created.id;
}

function seedException(
  id: string,
  overrides: Partial<{
    severity: "critical" | "high" | "medium" | "low";
    revenueAtRiskMinor: bigint | null;
    currency: string | null;
    summary: string;
    ruleId: string;
  }> = {},
): string {
  const row = db.seedException({
    id,
    organizationId: ORG,
    ruleId: overrides.ruleId ?? "PAYMENT_AMOUNT_MISMATCH",
    severity: overrides.severity ?? "high",
    summary: overrides.summary ?? "Stripe charged more than the internal record",
    revenueAtRiskMinor:
      overrides.revenueAtRiskMinor === undefined ? 123_456n : overrides.revenueAtRiskMinor,
    currency: overrides.currency === undefined ? "USD" : overrides.currency,
  });
  return row.id;
}

function onlyDelivery(): DeliveryRow {
  const rows = db.listDeliveries(ORG);
  const [row] = rows;
  if (!row || rows.length !== 1) {
    throw new Error(`expected exactly one delivery, found ${rows.length}`);
  }
  return row;
}

// ---------------------------------------------------------------------------

describe("digest windows", () => {
  it("floors to UTC hour and day boundaries", () => {
    expect(digestWindowStart(T10_50, "hourly").toISOString()).toBe("2026-07-21T10:00:00.000Z");
    expect(digestWindowStart(T10_50, "daily").toISOString()).toBe("2026-07-21T00:00:00.000Z");
    expect(digestWindowStart(T10_50, "immediate")).toEqual(T10_50);
  });

  it("lets a critical exception bypass the digest when the policy allows it", () => {
    const base: PolicyRow = {
      id: "p",
      organizationId: ORG,
      destinationId: "d",
      minSeverity: "low",
      minRevenueAtRiskMinor: null,
      currency: null,
      digest: "hourly",
      criticalBypassesDigest: true,
      enabled: true,
    };

    expect(effectiveDigest(base, "critical")).toBe("immediate");
    expect(effectiveDigest(base, "high")).toBe("hourly");
    expect(effectiveDigest({ ...base, criticalBypassesDigest: false }, "critical")).toBe("hourly");
  });

  it("builds a deterministic key from organization, policy, digest and subject", () => {
    const key = buildDedupeKey({
      organizationId: ORG,
      policyId: "policy-1",
      digest: "hourly",
      exceptionId: "exception-1",
      now: T10_50,
    });

    expect(key).toBe(`v1|org:${ORG}|policy:policy-1|digest:hourly|window:2026-07-21T10:00:00.000Z`);

    // Same inputs, same key, regardless of when it is computed within the window.
    expect(
      buildDedupeKey({
        organizationId: ORG,
        policyId: "policy-1",
        digest: "hourly",
        exceptionId: "exception-2",
        now: T10_05,
      }),
    ).toBe(key);
  });

  it("keys immediate deliveries by the exception, not the clock", () => {
    const a = buildDedupeKey({
      organizationId: ORG,
      policyId: "policy-1",
      digest: "immediate",
      exceptionId: "exception-1",
      now: T10_05,
    });
    const b = buildDedupeKey({
      organizationId: ORG,
      policyId: "policy-1",
      digest: "immediate",
      exceptionId: "exception-1",
      now: T11_05,
    });
    expect(a).toBe(b);
    expect(a).toContain("exception:exception-1");
  });
});

// ---------------------------------------------------------------------------

describe("dedupe", () => {
  it("creates exactly one delivery when the same exception is enqueued twice", async () => {
    const destinationId = await activeEmailDestination();
    policy({ destinationId, digest: "immediate" });
    const exceptionId = seedException("aaaaaaaa-0000-4000-8000-000000000001");

    const first = await enqueueForException(db, {
      organizationId: ORG,
      exceptionId,
      severity: "high",
      revenueAtRiskMinor: 123_456n,
      currency: "USD",
      now: T10_05,
    });
    const second = await enqueueForException(db, {
      organizationId: ORG,
      exceptionId,
      severity: "high",
      revenueAtRiskMinor: 123_456n,
      currency: "USD",
      // A later re-detection of the same exception, even in another window.
      now: T11_05,
    });

    expect(first.deliveries[0]?.created).toBe(true);
    expect(second.deliveries[0]?.created).toBe(false);
    expect(second.deliveries[0]?.linked).toBe(false);

    expect(db.listDeliveries(ORG)).toHaveLength(1);
    expect(db.countDeliveryItems(onlyDelivery().id)).toBe(1);
    expect(onlyDelivery().exceptionCount).toBe(1);
  });

  it("collapses two exceptions in the same hourly window onto one delivery", async () => {
    const destinationId = await activeEmailDestination();
    policy({ destinationId, digest: "hourly" });

    const first = seedException("aaaaaaaa-0000-4000-8000-000000000001");
    const second = seedException("aaaaaaaa-0000-4000-8000-000000000002");

    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: first,
      severity: "high",
      revenueAtRiskMinor: 100n,
      currency: "USD",
      now: T10_05,
    });
    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: second,
      severity: "high",
      revenueAtRiskMinor: 200n,
      currency: "USD",
      now: T10_50,
    });

    expect(db.listDeliveries(ORG)).toHaveLength(1);
    const delivery = onlyDelivery();
    expect(db.countDeliveryItems(delivery.id)).toBe(2);
    expect(delivery.exceptionCount).toBe(2);
    // Due when the window closes, not when the first exception arrived.
    expect(delivery.scheduledFor.toISOString()).toBe("2026-07-21T11:00:00.000Z");
  });

  it("opens a new delivery for the next hourly window", async () => {
    const destinationId = await activeEmailDestination();
    policy({ destinationId, digest: "hourly" });

    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: seedException("aaaaaaaa-0000-4000-8000-000000000001"),
      severity: "high",
      revenueAtRiskMinor: 100n,
      currency: "USD",
      now: T10_50,
    });
    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: seedException("aaaaaaaa-0000-4000-8000-000000000003"),
      severity: "high",
      revenueAtRiskMinor: 300n,
      currency: "USD",
      now: T11_05,
    });

    const deliveries = db.listDeliveries(ORG);
    expect(deliveries).toHaveLength(2);
    expect(deliveries.map((row) => row.dedupeKey)).toEqual([
      expect.stringContaining("window:2026-07-21T10:00:00.000Z"),
      expect.stringContaining("window:2026-07-21T11:00:00.000Z"),
    ]);
    for (const delivery of deliveries) {
      expect(db.countDeliveryItems(delivery.id)).toBe(1);
    }
  });

  it("keeps separate deliveries per policy", async () => {
    const emailDestination = await activeEmailDestination("Finance alerts");
    const slackDestination = await activeSlackDestination("#payments");
    policy({ destinationId: emailDestination, digest: "immediate" });
    policy({ destinationId: slackDestination, digest: "immediate" });

    const exceptionId = seedException("aaaaaaaa-0000-4000-8000-000000000001");
    const result = await enqueueForException(db, {
      organizationId: ORG,
      exceptionId,
      severity: "high",
      revenueAtRiskMinor: 100n,
      currency: "USD",
      now: T10_05,
    });

    expect(result.matchedPolicies).toBe(2);
    expect(db.listDeliveries(ORG)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("threshold filtering", () => {
  const base: PolicyRow = {
    id: "p",
    organizationId: ORG,
    destinationId: "d",
    minSeverity: "high",
    minRevenueAtRiskMinor: null,
    currency: null,
    digest: "immediate",
    criticalBypassesDigest: false,
    enabled: true,
  };

  it("excludes an exception below the minimum severity", () => {
    expect(policyMatches(base, { severity: "low", revenueAtRiskMinor: null, currency: null })).toBe(
      false,
    );
    expect(
      policyMatches(base, { severity: "medium", revenueAtRiskMinor: null, currency: null }),
    ).toBe(false);
    expect(
      policyMatches(base, { severity: "high", revenueAtRiskMinor: null, currency: null }),
    ).toBe(true);
    expect(
      policyMatches(base, { severity: "critical", revenueAtRiskMinor: null, currency: null }),
    ).toBe(true);
  });

  it("excludes an amount below the revenue threshold", () => {
    const withThreshold = { ...base, minSeverity: "low" as const, minRevenueAtRiskMinor: 100_000n };
    expect(
      policyMatches(withThreshold, {
        severity: "high",
        revenueAtRiskMinor: 99_999n,
        currency: "USD",
      }),
    ).toBe(false);
    expect(
      policyMatches(withThreshold, {
        severity: "high",
        revenueAtRiskMinor: 100_000n,
        currency: "USD",
      }),
    ).toBe(true);
    // No monetary exposure cannot clear a monetary threshold.
    expect(
      policyMatches(withThreshold, { severity: "high", revenueAtRiskMinor: null, currency: null }),
    ).toBe(false);
  });

  it("excludes other currencies when the policy pins one", () => {
    const usdOnly = { ...base, minSeverity: "low" as const, currency: "USD" };
    expect(
      policyMatches(usdOnly, { severity: "high", revenueAtRiskMinor: 100n, currency: "EUR" }),
    ).toBe(false);
    expect(
      policyMatches(usdOnly, { severity: "high", revenueAtRiskMinor: 100n, currency: "usd" }),
    ).toBe(true);
    expect(
      policyMatches(usdOnly, { severity: "high", revenueAtRiskMinor: 100n, currency: null }),
    ).toBe(false);
  });

  it("never matches a disabled policy", () => {
    expect(
      policyMatches(
        { ...base, enabled: false, minSeverity: "low" },
        { severity: "critical", revenueAtRiskMinor: 1n, currency: "USD" },
      ),
    ).toBe(false);
  });

  it("enqueues nothing when no policy threshold is met", async () => {
    const destinationId = await activeEmailDestination();
    policy({ destinationId, minSeverity: "high" });

    const result = await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: seedException("aaaaaaaa-0000-4000-8000-000000000001", { severity: "low" }),
      severity: "low",
      revenueAtRiskMinor: 100n,
      currency: "USD",
      now: T10_05,
    });

    expect(result.matchedPolicies).toBe(0);
    expect(db.listDeliveries(ORG)).toHaveLength(0);
  });

  it("ignores policies belonging to another organization", async () => {
    const destinationId = await activeEmailDestination();
    db.seedPolicy({
      organizationId: "99999999-9999-4999-8999-999999999999",
      destinationId,
      minSeverity: "low",
      minRevenueAtRiskMinor: null,
      currency: null,
      digest: "immediate",
      criticalBypassesDigest: false,
      enabled: true,
    });

    const result = await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: seedException("aaaaaaaa-0000-4000-8000-000000000001"),
      severity: "critical",
      revenueAtRiskMinor: 1_000_000n,
      currency: "USD",
      now: T10_05,
    });

    expect(result.matchedPolicies).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("sending", () => {
  it("renders and delivers a real email, then marks the delivery sent", async () => {
    const destinationId = await activeEmailDestination();
    policy({ destinationId, digest: "immediate" });
    const exceptionId = seedException("aaaaaaaa-0000-4000-8000-000000000001", {
      severity: "critical",
      revenueAtRiskMinor: 123_456n,
      currency: "USD",
    });

    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId,
      severity: "critical",
      revenueAtRiskMinor: 123_456n,
      currency: "USD",
      now: T10_05,
    });

    const result = await sendPendingDeliveries(db, {
      now: T10_05,
      appUrl: APP_URL,
      transports,
      keyring,
    });

    expect(result).toMatchObject({ claimed: 1, sent: 1, retried: 0, failed: 0 });

    const [message] = email.sent;
    expect(message?.to).toBe("alerts@example.com");
    expect(message?.text).toContain("PAYMENT_AMOUNT_MISMATCH");
    expect(message?.text).toContain("$1,234.56");
    expect(message?.text).toContain(`${APP_URL}/orgs/${ORG}/exceptions/${exceptionId}`);
    expect(message?.html).toContain("Acme Payments");

    const delivery = onlyDelivery();
    expect(delivery.status).toBe("sent");
    expect(delivery.sentAt).toEqual(T10_05);
    expect(delivery.attempts).toBe(1);
    expect(delivery.summary).toMatchObject({
      total: 1,
      revenueAtRisk: [{ currency: "USD", amountMinor: "123456" }],
    });
  });

  it("does not send twice when the queue is drained again", async () => {
    const destinationId = await activeEmailDestination();
    policy({ destinationId, digest: "immediate" });
    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: seedException("aaaaaaaa-0000-4000-8000-000000000001"),
      severity: "high",
      revenueAtRiskMinor: 100n,
      currency: "USD",
      now: T10_05,
    });

    await sendPendingDeliveries(db, { now: T10_05, appUrl: APP_URL, transports, keyring });
    await sendPendingDeliveries(db, { now: T11_05, appUrl: APP_URL, transports, keyring });

    expect(email.sent).toHaveLength(1);
  });

  it("skips a disabled or unverified destination instead of sending", async () => {
    const created = await createEmailDestination(db, {
      organizationId: ORG,
      name: "Unverified",
      email: "alerts@example.com",
    });
    policy({ destinationId: created.id, digest: "immediate" });
    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: seedException("aaaaaaaa-0000-4000-8000-000000000001"),
      severity: "high",
      revenueAtRiskMinor: 100n,
      currency: "USD",
      now: T10_05,
    });

    const result = await sendPendingDeliveries(db, {
      now: T10_05,
      appUrl: APP_URL,
      transports,
      keyring,
    });

    expect(result.skipped).toBe(1);
    expect(email.sent).toHaveLength(0);
    expect(onlyDelivery().status).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------

describe("retries", () => {
  async function queueOne(): Promise<void> {
    const destinationId = await activeEmailDestination();
    policy({ destinationId, digest: "immediate" });
    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: seedException("aaaaaaaa-0000-4000-8000-000000000001"),
      severity: "high",
      revenueAtRiskMinor: 100n,
      currency: "USD",
      now: T10_05,
    });
  }

  it("computes bounded exponential backoff with jitter", () => {
    // random() === 0 removes all jitter, giving the raw exponential value.
    expect(computeBackoffMs(1, DEFAULT_RETRY_POLICY, () => 0)).toBe(30_000);
    expect(computeBackoffMs(2, DEFAULT_RETRY_POLICY, () => 0)).toBe(60_000);
    expect(computeBackoffMs(3, DEFAULT_RETRY_POLICY, () => 0)).toBe(120_000);

    // Jitter only ever shortens the delay, so the cap is a real upper bound.
    expect(computeBackoffMs(2, DEFAULT_RETRY_POLICY, () => 1)).toBe(48_000);
    expect(computeBackoffMs(99, DEFAULT_RETRY_POLICY, () => 0)).toBe(
      DEFAULT_RETRY_POLICY.maxDelayMs,
    );
    for (const attempt of [1, 2, 5, 9, 40]) {
      const delay = computeBackoffMs(attempt, DEFAULT_RETRY_POLICY, Math.random);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(DEFAULT_RETRY_POLICY.maxDelayMs);
    }
  });

  it("increments attempts and reschedules a transient failure", async () => {
    await queueOne();
    email.failAlwaysWith(new TransportError("upstream unavailable", "transient", 503));

    const result = await sendPendingDeliveries(db, {
      now: T10_05,
      appUrl: APP_URL,
      transports,
      keyring,
      maxAttempts: 3,
      random: () => 0,
    });

    expect(result).toMatchObject({ sent: 0, retried: 1, failed: 0 });
    const delivery = onlyDelivery();
    expect(delivery.status).toBe("pending");
    expect(delivery.attempts).toBe(1);
    expect(delivery.scheduledFor.getTime()).toBe(T10_05.getTime() + 30_000);
    expect(delivery.lastError).toContain("upstream unavailable");

    // The destination is not condemned while retries remain.
    const [destination] = db.listDestinations(ORG);
    expect(destination?.status).toBe("active");
  });

  it("fails the delivery and marks the destination failing after maxAttempts", async () => {
    await queueOne();
    email.failAlwaysWith(new TransportError("upstream unavailable", "transient", 503));

    let now = T10_05;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await sendPendingDeliveries(db, {
        now,
        appUrl: APP_URL,
        transports,
        keyring,
        maxAttempts: 3,
        random: () => 0,
      });
      now = onlyDelivery().scheduledFor;
    }

    const delivery = onlyDelivery();
    expect(delivery.status).toBe("failed");
    expect(delivery.attempts).toBe(3);

    const [destination] = db.listDestinations(ORG);
    expect(destination?.status).toBe("failing");
    expect(destination?.lastError).toContain("upstream unavailable");

    expect(db.listAuditEvents().map((event) => event.action)).toContain(
      "notification.delivery_failed",
    );
  });

  it("does not retry a permanent failure", async () => {
    await queueOne();
    email.failAlwaysWith(new TransportError("invalid recipient", "permanent", 400));

    const result = await sendPendingDeliveries(db, {
      now: T10_05,
      appUrl: APP_URL,
      transports,
      keyring,
      maxAttempts: 5,
      random: () => 0,
    });

    expect(result).toMatchObject({ retried: 0, failed: 1 });
    const delivery = onlyDelivery();
    expect(delivery.status).toBe("failed");
    // One attempt only, despite four retries remaining in the budget.
    expect(delivery.attempts).toBe(1);

    const audit = db
      .listAuditEvents()
      .find((event) => event.action === "notification.delivery_failed");
    expect(audit?.metadata).toMatchObject({ permanent: true, attempts: 1 });
  });

  it("recovers when a transient failure clears before the budget runs out", async () => {
    await queueOne();
    email.failNextWith(new TransportError("connection reset", "transient"));

    await sendPendingDeliveries(db, {
      now: T10_05,
      appUrl: APP_URL,
      transports,
      keyring,
      maxAttempts: 3,
      random: () => 0,
    });
    expect(onlyDelivery().status).toBe("pending");

    await sendPendingDeliveries(db, {
      now: onlyDelivery().scheduledFor,
      appUrl: APP_URL,
      transports,
      keyring,
      maxAttempts: 3,
      random: () => 0,
    });

    expect(onlyDelivery().status).toBe("sent");
    expect(email.sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("test messages and verification", () => {
  it("activates a destination only after the verification message is delivered", async () => {
    const created = await createEmailDestination(db, {
      organizationId: ORG,
      name: "Finance alerts",
      email: "alerts@example.com",
    });
    expect(created.status).toBe("pending_verification");

    const result = await sendTestMessage(db, {
      organizationId: ORG,
      destinationId: created.id,
      transports,
      keyring,
      appUrl: APP_URL,
      now: T10_05,
    });

    expect(result.ok).toBe(true);
    expect(result.destination?.status).toBe("active");
    expect(result.destination?.verifiedAt).toEqual(T10_05);
    expect(email.sent[0]?.subject).toContain("Finance alerts");
    expect(db.listAuditEvents().map((event) => event.action)).toContain("notification.test_sent");
  });

  it("leaves a destination unverified when the verification message fails", async () => {
    const created = await createSlackDestination(db, {
      organizationId: ORG,
      name: "#payments",
      webhookUrl: WEBHOOK,
      keyring,
    });
    slack.failAlwaysWith(new TransportError("Slack responded 404", "permanent", 404));

    const result = await sendTestMessage(db, {
      organizationId: ORG,
      destinationId: created.id,
      transports,
      keyring,
      appUrl: APP_URL,
      now: T10_05,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Slack responded 404");
    expect(result.destination?.status).toBe("failing");
    expect(result.destination?.verifiedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("no secret leakage", () => {
  it("keeps the webhook out of the rendered Slack message", async () => {
    const destinationId = await activeSlackDestination();
    policy({ destinationId, digest: "immediate" });
    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: seedException("aaaaaaaa-0000-4000-8000-000000000001"),
      severity: "high",
      revenueAtRiskMinor: 100n,
      currency: "USD",
      now: T10_05,
    });

    await sendPendingDeliveries(db, { now: T10_05, appUrl: APP_URL, transports, keyring });

    const [message] = slack.sent;
    expect(message).toBeDefined();
    // The transport legitimately receives the URL; the CONTENT must not carry it.
    expect(message?.webhookUrl).toBe(WEBHOOK);
    expect(message?.text).not.toContain("hooks.slack.com");
    expect(JSON.stringify(message?.blocks)).not.toContain("hooks.slack.com");
    expect(JSON.stringify(message?.blocks)).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
  });

  it("sanitises a webhook echoed back inside a provider error", async () => {
    const destinationId = await activeSlackDestination();
    policy({ destinationId, digest: "immediate" });
    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: seedException("aaaaaaaa-0000-4000-8000-000000000001"),
      severity: "high",
      revenueAtRiskMinor: 100n,
      currency: "USD",
      now: T10_05,
    });

    // A raw Error, not a TransportError: nothing has pre-scrubbed this message.
    slack.failAlwaysWith(new Error(`POST ${WEBHOOK} failed with 500`));

    await sendPendingDeliveries(db, {
      now: T10_05,
      appUrl: APP_URL,
      transports,
      keyring,
      maxAttempts: 1,
    });

    const delivery = onlyDelivery();
    expect(delivery.status).toBe("failed");
    expect(delivery.lastError).not.toContain(WEBHOOK);
    expect(delivery.lastError).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
    expect(delivery.lastError).toContain("[redacted]");

    const [destination] = db.listDestinations(ORG);
    expect(destination?.lastError).not.toContain(WEBHOOK);

    const audit = JSON.stringify(db.listAuditEvents());
    expect(audit).not.toContain(WEBHOOK);
    expect(audit).not.toContain("hooks.slack.com");
    expect(audit).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
  });

  it("keeps the webhook out of every stored delivery and destination field", async () => {
    const destinationId = await activeSlackDestination();
    policy({ destinationId, digest: "immediate" });
    await enqueueForException(db, {
      organizationId: ORG,
      exceptionId: seedException("aaaaaaaa-0000-4000-8000-000000000001"),
      severity: "high",
      revenueAtRiskMinor: 100n,
      currency: "USD",
      now: T10_05,
    });
    await sendPendingDeliveries(db, { now: T10_05, appUrl: APP_URL, transports, keyring });

    const persisted = JSON.stringify({
      deliveries: db.listDeliveries(ORG),
      destinations: db.listDestinations(ORG).map((row) => ({
        ...row,
        // Ciphertext is binary; excluded so the assertion is about plaintext.
        secretCiphertext: null,
        secretNonce: null,
        secretAuthTag: null,
      })),
      audit: db.listAuditEvents(),
    });

    expect(persisted).not.toContain(WEBHOOK);
    expect(persisted).not.toContain("AbCdEfGhIjKlMnOpQrStUvWx");
  });
});
