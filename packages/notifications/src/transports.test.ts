import { describe, expect, it } from "vitest";
import {
  ConsoleEmailTransport,
  HttpSlackTransport,
  MemoryEmailTransport,
  MemorySlackTransport,
  TransportError,
  classifyHttpStatus,
  classifySmtpResponseCode,
  createEmailTransport,
  isTransientFailure,
  sanitizeErrorMessage,
  type FetchLike,
} from "./transports";

const WEBHOOK = "https://hooks.slack.com/services/T0A1B2C3D/B9Z8Y7X6W/AbCdEfGhIjKlMnOpQrStUvWx";

function stubFetch(
  response: { ok: boolean; status: number; body?: string },
  calls: Array<{ url: string; init: unknown }> = [],
): FetchLike {
  return (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve(response.body ?? ""),
    });
  };
}

describe("failure classification", () => {
  it("treats rate limiting and server errors as transient", () => {
    expect(classifyHttpStatus(429)).toBe("transient");
    expect(classifyHttpStatus(500)).toBe("transient");
    expect(classifyHttpStatus(503)).toBe("transient");
  });

  it("treats other 4xx responses as permanent", () => {
    expect(classifyHttpStatus(400)).toBe("permanent");
    expect(classifyHttpStatus(403)).toBe("permanent");
    expect(classifyHttpStatus(404)).toBe("permanent");
  });

  it("inverts the convention for SMTP, where 4xx is the temporary class", () => {
    expect(classifySmtpResponseCode(421)).toBe("transient");
    expect(classifySmtpResponseCode(450)).toBe("transient");
    expect(classifySmtpResponseCode(550)).toBe("permanent");
    expect(classifySmtpResponseCode(552)).toBe("permanent");
  });

  it("defaults an unclassified error to transient, bounded by the attempt budget", () => {
    expect(isTransientFailure(new Error("socket hang up"))).toBe(true);
    expect(isTransientFailure(new TransportError("bad request", "permanent", 400))).toBe(false);
    expect(isTransientFailure(new TransportError("overloaded", "transient", 503))).toBe(true);
  });
});

describe("error sanitisation", () => {
  it("scrubs a webhook out of a TransportError at construction", () => {
    const error = new TransportError(`POST ${WEBHOOK} failed`, "transient");
    expect(error.message).not.toContain(WEBHOOK);
    expect(error.message).toContain("[redacted]");
  });

  it("scrubs, flattens and bounds a stored error message", () => {
    const message = sanitizeErrorMessage(new Error(`line one\r\nsecret ${WEBHOOK} tail`));
    expect(message).not.toContain(WEBHOOK);
    expect(message).not.toContain("\n");
    expect(message).toContain("[redacted]");
    expect(message.length).toBeLessThanOrEqual(500);
  });

  it("bounds a runaway message", () => {
    expect(sanitizeErrorMessage(new Error("x".repeat(5_000))).length).toBeLessThanOrEqual(500);
  });

  it("handles values that are not Errors", () => {
    expect(sanitizeErrorMessage("plain string")).toBe("plain string");
    expect(sanitizeErrorMessage(undefined)).toBe("unknown transport failure");
  });
});

describe("HttpSlackTransport", () => {
  it("POSTs the rendered payload as JSON to the webhook", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    const transport = new HttpSlackTransport(stubFetch({ ok: true, status: 200 }, calls));

    await transport.send({
      webhookUrl: WEBHOOK,
      text: "fallback",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "body" } }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(WEBHOOK);
    const init = calls[0]?.init as {
      method: string;
      body: string;
      headers: Record<string, string>;
    };
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({
      text: "fallback",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "body" } }],
    });
  });

  it("raises a transient error for 429 and 5xx", async () => {
    for (const status of [429, 500, 503]) {
      const transport = new HttpSlackTransport(stubFetch({ ok: false, status, body: "busy" }));
      await expect(
        transport.send({ webhookUrl: WEBHOOK, text: "t", blocks: [] }),
      ).rejects.toMatchObject({ kind: "transient", statusCode: status });
    }
  });

  it("raises a permanent error for other 4xx responses", async () => {
    const transport = new HttpSlackTransport(
      stubFetch({ ok: false, status: 404, body: "no_service" }),
    );
    await expect(
      transport.send({ webhookUrl: WEBHOOK, text: "t", blocks: [] }),
    ).rejects.toMatchObject({ kind: "permanent", statusCode: 404 });
  });

  it("treats a network failure as transient", async () => {
    const transport = new HttpSlackTransport(() => Promise.reject(new Error("ECONNRESET")));
    await expect(
      transport.send({ webhookUrl: WEBHOOK, text: "t", blocks: [] }),
    ).rejects.toMatchObject({ kind: "transient" });
  });

  it("never puts the webhook into the error, even when the body echoes it", async () => {
    const transport = new HttpSlackTransport(
      stubFetch({ ok: false, status: 400, body: `bad request for ${WEBHOOK}` }),
    );
    try {
      await transport.send({ webhookUrl: WEBHOOK, text: "t", blocks: [] });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TransportError);
      expect((error as TransportError).message).not.toContain(WEBHOOK);
      expect((error as TransportError).message).toContain("[redacted]");
    }
  });
});

describe("ConsoleEmailTransport", () => {
  it("writes the rendered message without contacting anything", async () => {
    const lines: string[] = [];
    const transport = new ConsoleEmailTransport((line) => lines.push(line));

    await transport.send({
      to: "alerts@example.com",
      subject: "PayRecon: 1 payment exception",
      text: "body text",
      html: "<p>body</p>",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("alerts@example.com");
    expect(lines[0]).toContain("body text");
    expect(lines[0]).toContain("no SMTP_HOST configured");
  });

  it("redacts anything credential-shaped that reached the body", async () => {
    const lines: string[] = [];
    const transport = new ConsoleEmailTransport((line) => lines.push(line));

    await transport.send({
      to: "alerts@example.com",
      subject: "s",
      text: `hook ${WEBHOOK} end`,
      html: "",
    });

    expect(lines[0]).not.toContain(WEBHOOK);
    expect(lines[0]).toContain("[redacted]");
  });
});

describe("createEmailTransport", () => {
  it("selects the console transport when no SMTP host is configured", () => {
    expect(createEmailTransport({ from: "a@b.test" })).toBeInstanceOf(ConsoleEmailTransport);
    expect(createEmailTransport({ host: "", from: "a@b.test" })).toBeInstanceOf(
      ConsoleEmailTransport,
    );
  });

  it("selects the SMTP transport when a host is configured", () => {
    const transport = createEmailTransport({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      from: "a@b.test",
    });
    // Constructing it must not connect; nodemailer is loaded lazily on send.
    expect(transport).not.toBeInstanceOf(ConsoleEmailTransport);
  });
});

describe("memory transports", () => {
  it("record real messages and can be scripted to fail", async () => {
    const email = new MemoryEmailTransport();
    await email.send({ to: "a@b.test", subject: "s", text: "t", html: "<p>h</p>" });
    expect(email.sent).toEqual([{ to: "a@b.test", subject: "s", text: "t", html: "<p>h</p>" }]);

    email.failNextWith(new TransportError("nope", "transient"));
    await expect(email.send({ to: "a@b.test", subject: "s", text: "t", html: "" })).rejects.toThrow(
      "nope",
    );
    // The scripted failure applies once.
    await email.send({ to: "a@b.test", subject: "s2", text: "t", html: "" });
    expect(email.sent).toHaveLength(2);

    const slack = new MemorySlackTransport();
    slack.failAlwaysWith(new TransportError("down", "transient"));
    await expect(slack.send({ webhookUrl: WEBHOOK, text: "t", blocks: [] })).rejects.toThrow(
      "down",
    );
    await expect(slack.send({ webhookUrl: WEBHOOK, text: "t", blocks: [] })).rejects.toThrow(
      "down",
    );
    expect(slack.sent).toHaveLength(0);

    slack.failAlwaysWith(null);
    await slack.send({ webhookUrl: WEBHOOK, text: "t", blocks: [] });
    expect(slack.sent).toHaveLength(1);
  });
});
