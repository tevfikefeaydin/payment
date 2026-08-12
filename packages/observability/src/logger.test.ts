import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

/** Collect emitted lines synchronously so assertions see them immediately. */
function capture(): { lines: () => Record<string, unknown>[]; write: (line: string) => void } {
  const raw: string[] = [];
  return {
    write(line: string) {
      raw.push(line);
    },
    lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createLogger", () => {
  it("emits JSON lines carrying the component", () => {
    const sink = capture();
    const log = createLogger({ component: "worker", level: "info", destination: sink });

    log.info({ action: "started", concurrency: 5 }, "worker started");

    const [line] = sink.lines();
    expect(line?.component).toBe("worker");
    expect(line?.action).toBe("started");
    expect(line?.concurrency).toBe(5);
    expect(line?.msg).toBe("worker started");
  });

  it("redacts sensitive keys and credential-shaped values in fields", () => {
    const sink = capture();
    const log = createLogger({ component: "queue", level: "info", destination: sink });

    log.error(
      {
        apiKey: "prk_live_abcdef123456",
        note: "failed with rk_live_abcdefgh12345678 during sync",
      },
      "job failed",
    );

    const [line] = sink.lines();
    expect(line?.apiKey).toBe("[redacted]");
    expect(JSON.stringify(line)).not.toContain("rk_live_abcdefgh12345678");
    expect(line?.note).toContain("failed with");
  });

  it("redacts credential-shaped substrings in the message itself", () => {
    const sink = capture();
    const log = createLogger({ component: "worker", level: "info", destination: sink });

    log.warn("auth failed for rk_live_abcdefgh12345678");

    const [line] = sink.lines();
    expect(String(line?.msg)).not.toContain("rk_live_abcdefgh12345678");
    expect(String(line?.msg)).toContain("auth failed");
  });

  it("respects the level threshold", () => {
    const sink = capture();
    const log = createLogger({ component: "worker", level: "warn", destination: sink });

    log.info("below threshold");
    log.warn("at threshold");

    expect(sink.lines()).toHaveLength(1);
    expect(sink.lines()[0]?.msg).toBe("at threshold");
  });
});
