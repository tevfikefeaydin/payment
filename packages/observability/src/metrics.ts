/**
 * In-process counters.
 *
 * The smallest useful metrics surface: monotonic counters with a bounded label
 * set, snapshotted periodically into a structured log line. No metrics backend
 * is assumed — the summary line is greppable JSON, and if a scrape endpoint is
 * ever chosen, these counters are the thing it would expose.
 */

export interface MetricsRegistry {
  /** Add `by` (default 1) to a counter. Labels distinguish series. */
  increment(name: string, labels?: Record<string, string>, by?: number): void;
  /** Copy of every counter, keyed `name{k=v,...}` with sorted label keys. */
  snapshot(): Record<string, number>;
}

/** Bound the series count so a label built from unbounded input cannot leak memory. */
const MAX_SERIES = 1_000;

function seriesKey(name: string, labels?: Record<string, string>): string {
  if (!labels) return name;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
  return parts.length === 0 ? name : `${name}{${parts.join(",")}}`;
}

export function createMetrics(): MetricsRegistry {
  const counters = new Map<string, number>();

  return {
    increment(name, labels, by = 1): void {
      if (!Number.isFinite(by) || by <= 0) return;
      const key = seriesKey(name, labels);
      const existing = counters.get(key);
      if (existing === undefined && counters.size >= MAX_SERIES) return;
      counters.set(key, (existing ?? 0) + by);
    },

    snapshot(): Record<string, number> {
      return Object.fromEntries(counters);
    },
  };
}
