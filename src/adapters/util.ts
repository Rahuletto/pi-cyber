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

/**
 * F1 flag-smuggling guard: a model-supplied value that starts with `-` is not
 * a target/path/query/id, it is an argv flag injection (e.g. `-l /etc/passwd`
 * or semgrep `--config`). Closed-set enums (severities, record types, engines,
 * rule sets, methods) are literal-validated, so only free-string slots pass
 * through here. Operator-approved `extra` is deliberately NOT guarded — it is
 * flags by definition and never model-authored.
 */
export function rejectFlagLike(value: string, paramName: string): string {
  if (value.startsWith("-")) {
    throw new TypeError(`field-param "${paramName}" must not start with "-"`);
  }
  return value;
}

/** Model-supplied free-string list: non-strings drop, `-`-prefixed values rejected. */
export function modelList(value: unknown, paramName: string): string[] {
  return stringList(value).map((item) => rejectFlagLike(item, paramName));
}

/** Model-supplied free string: undefined when absent, `-`-prefixed rejected. */
export function modelString(value: unknown, paramName: string): string | undefined {
  const items = stringList([value]);
  if (items.length === 0) return undefined;
  return rejectFlagLike(items[0], paramName);
}

/**
 * Degenerate-argv guard: a required target param absent from the validated
 * model input must stop buildArgs — never emit junk argv like bare `["-json"]`
 * or `String(undefined)`.
 */
export function requireModelList(value: unknown, paramName: string, adapter: string): string[] {
  const items = modelList(value, paramName);
  if (items.length === 0) throw new Error(`${adapter}: missing required param "${paramName}"`);
  return items;
}

export function requireModelString(value: unknown, paramName: string, adapter: string): string {
  const item = modelString(value, paramName);
  if (item === undefined) throw new Error(`${adapter}: missing required param "${paramName}"`);
  return item;
}

/**
 * Operator-approved `extra` slots: appended verbatim as separate argv
 * elements (flags by design). Schema caps them at 4; the same cap is enforced
 * locally so the invariant holds even without a validation pass.
 */
export function operatorExtra(value: unknown): string[] {
  return stringList(value).slice(0, 4);
}
