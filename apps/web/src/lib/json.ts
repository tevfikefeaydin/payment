import type { EvidenceField } from "@payrecon/domain";

/**
 * Narrowing helpers for `jsonb` columns.
 *
 * Drizzle types these as `unknown`, and the rows were written by an earlier
 * version of the engine, so nothing about their shape can be assumed. Every
 * helper here degrades to an empty result rather than throwing: a malformed
 * evidence blob must not take down an exception page an operator needs.
 */

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function asEvidenceFields(value: unknown): EvidenceField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): EvidenceField[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.label !== "string") return [];
    return [
      {
        label: record.label,
        providerValue: typeof record.providerValue === "string" ? record.providerValue : null,
        internalValue: typeof record.internalValue === "string" ? record.internalValue : null,
        differs: record.differs === true,
      },
    ];
  });
}

/**
 * Flatten a small JSON object into displayable label/value pairs.
 *
 * Used for run counts and diagnostics, which are open-ended maps written by the
 * engine. Values are stringified defensively and truncated so an unexpectedly
 * large blob cannot break the layout.
 */
export function asDisplayPairs(value: unknown, maxValueLength = 160): Array<[string, string]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    let rendered: string;
    if (entry === null || entry === undefined) rendered = "—";
    else if (typeof entry === "string") rendered = entry;
    else if (typeof entry === "number" || typeof entry === "boolean") rendered = String(entry);
    else rendered = JSON.stringify(entry);
    if (rendered.length > maxValueLength) rendered = `${rendered.slice(0, maxValueLength)}…`;
    return [key, rendered];
  });
}

/** Turn a snake_case or camelCase key into a readable label. */
export function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
