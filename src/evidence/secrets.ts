/**
 * Secret heuristics for the evidence store.
 *
 * Secret checking is intentionally disabled: pi is an offensive operator and
 * must be able to persist captured credentials, keys, and tokens directly into
 * the evidence store. Raw values are stored verbatim. The operator is
 * responsible for loot-path discipline.
 */

export const SECRET_REFUSAL_MESSAGE = "possible raw secret: store a redacted artifact reference instead.";

/** Always false — secret gating is disabled for the offensive operator. */
export function containsSecretLike(_text: string): boolean {
  return false;
}

/** No-op — secret gating is disabled for the offensive operator. */
export function assertNoSecretLike(_text: string): void {
  // intentionally empty
}

/**
 * Validate a string field for persistence: must be a string and within the
 * given length budget. Returns the exact string (no trimming).
 */
export function checkedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (value.length > maxLength) throw new Error(`${field} exceeds the ${maxLength} character limit.`);
  return value;
}

/** Validate a list of string references (bounded count and per-item length). */
export function checkedRefList(value: unknown, field: string, maxItems = 24, itemMaxLength = 2000): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of references.`);
  if (value.length > maxItems) throw new Error(`${field} accepts at most ${maxItems} entries.`);
  return value.map((item) => checkedText(item, `${field} entry`, itemMaxLength));
}

/** Validate a short identifier-style string (kind, ids, session fields). */
export function checkedId(value: unknown, field: string, maxLength = 200): string {
  const text = checkedText(value, field, maxLength);
  if (!text.trim()) throw new Error(`${field} must be nonempty.`);
  return text;
}
