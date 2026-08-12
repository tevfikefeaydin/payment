import { describe, expect, it } from "vitest";
import { createMetrics } from "./metrics";

describe("createMetrics", () => {
  it("counts per name and label set, with sorted label keys", () => {
    const metrics = createMetrics();

    metrics.increment("jobs_processed_total", { queue: "reconciliation.run" });
    metrics.increment("jobs_processed_total", { queue: "reconciliation.run" });
    metrics.increment("jobs_processed_total", { queue: "stripe.sync" });
    metrics.increment("jobs_failed_total", { b: "2", a: "1" });

    expect(metrics.snapshot()).toEqual({
      "jobs_processed_total{queue=reconciliation.run}": 2,
      "jobs_processed_total{queue=stripe.sync}": 1,
      "jobs_failed_total{a=1,b=2}": 1,
    });
  });

  it("supports increments by more than one and ignores non-positive amounts", () => {
    const metrics = createMetrics();

    metrics.increment("rows", undefined, 5);
    metrics.increment("rows", undefined, 0);
    metrics.increment("rows", undefined, -3);
    metrics.increment("rows", undefined, Number.NaN);

    expect(metrics.snapshot()).toEqual({ rows: 5 });
  });

  it("returns an independent snapshot", () => {
    const metrics = createMetrics();
    metrics.increment("rows");

    const first = metrics.snapshot();
    metrics.increment("rows");

    expect(first).toEqual({ rows: 1 });
    expect(metrics.snapshot()).toEqual({ rows: 2 });
  });

  it("caps the number of series so unbounded labels cannot leak memory", () => {
    const metrics = createMetrics();
    for (let index = 0; index < 1_100; index += 1) {
      metrics.increment("burst", { id: String(index) });
    }

    expect(Object.keys(metrics.snapshot()).length).toBe(1_000);
    // Existing series still count even once the cap is reached.
    metrics.increment("burst", { id: "0" });
    expect(metrics.snapshot()["burst{id=0}"]).toBe(2);
  });
});
