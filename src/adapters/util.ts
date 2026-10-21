/**
 * Shared parse helpers for the adapter registry.
 *
 * Global constraint: model input is data. These helpers only ever see tool
 * output (stdout/stderr) — parsing must tolerate malformed upstream lines by
 * skipping them, never by throwing (a half-finished artifact is still
 * evidence, per the PD-kit "no silent gaps" stance the parse returns fewer
 * rows plus the raw artifact keeps everything).
 */

/** Normalized.raw cap (≤4000 chars) from the Task 5 interface. */
export const RAW_CAP = 4000;

/** Cap a raw finding payload at 4000 chars, preserving the prefix. */
export function clipRaw(text: string): string {
  return text.length <= RAW_CAP ? text : text.slice(0, RAW_CAP);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse JSONL/NDJSON upstream output. Every line is tried independently;
 * malformed lines (truncation, progress bars, blank) are skipped.
 */
export function jsonLines(stdout: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // tolerate malformed lines: skip them
    }
  }
  return records;
}

/**
 * Parse a single-document JSON upstream output (ffuf result document, semgrep
 * SARIF, vulnx query result). Returns `null` when nothing parseable is there —
 * callers then return an empty finding list, the raw artifact stays intact.
 */
export function jsonDocument(stdout: string): Record<string, unknown> | null {
  const text = stdout.replace(/^\uFEFF/, ""); // strip a lone BOM before parsing
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Narrow model-supplied target-ish params: validated by Typebox upstream
 * (Task 6), but buildArgs stays defensive — non-strings drop, never explode.
 */
export function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** Same narrowing for validated integer lists (ports, status codes). */
export function intList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => Number.isInteger(item));
}
