import { describe, expect, it } from "vitest";
import type { Job } from "pg-boss";
import { createMetrics } from "@payrecon/observability";
import { jobBatchRunner } from "./handlers";

function jobs(...ids: string[]): Job<unknown>[] {
  return ids.map((id) => ({ id, name: "q", data: { id } }) as Job<unknown>);
}

describe("jobBatchRunner", () => {
  it("counts each successful job under its queue", async () => {
    const metrics = createMetrics();
    const run = jobBatchRunner("reconciliation.run", async () => {}, metrics);

    await run(jobs("a", "b"));

    expect(metrics.snapshot()).toEqual({
      "jobs_processed_total{queue=reconciliation.run}": 2,
    });
  });

  it("counts a failure, rethrows so pg-boss retries, and stops the batch", async () => {
    const metrics = createMetrics();
    const seen: string[] = [];
    const run = jobBatchRunner(
      "stripe.sync",
      async (raw) => {
        const { id } = raw as { id: string };
        seen.push(id);
        if (id === "b") throw new Error("boom with rk_live_abcdefgh12345678");
      },
      metrics,
    );

    await expect(run(jobs("a", "b", "c"))).rejects.toThrow("boom");

    // "c" was never attempted: the rethrow hands the batch back to pg-boss.
    expect(seen).toEqual(["a", "b"]);
    expect(metrics.snapshot()).toEqual({
      "jobs_processed_total{queue=stripe.sync}": 1,
      "jobs_failed_total{queue=stripe.sync}": 1,
    });
  });

  it("works without a metrics registry", async () => {
    const run = jobBatchRunner("session.cleanup", async () => {});
    await expect(run(jobs("a"))).resolves.toBeUndefined();
  });
});
