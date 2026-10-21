/**
 * Secret heuristics for the evidence store.
 *
 * This is a strict superset of the `knownSecrets` pattern in `src/state.ts`:
 * it additionally recognizes classic GitHub tokens (ghp_/gho_), the OpenSSH
 * PEM marker, Slack tokens (xoxb-/xoxp-) and Anthropic keys (sk-ant-). Every
 * text-bearing entry point of the evidence store runs through
 * `containsSecretLike` before anything is written.
 */

const KNOWN_SECRETS = /(?:sk-(?:proj-)?[a-zA-Z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[a-zA-Z0-9._~+/-]{12,}|\b(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+|https?:\/\/[^\s/:]+:[^\s@]+@)/i;

const EXTRA_SECRETS = /(?:ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|-----BEGIN OPENSSH PRIVATE KEY-----|xox[bp]-|sk-ant-)/i;

export const SECRET_REFUSAL_MESSAGE = "possible raw secret: store a redacted artifact reference instead.";

/** True when the text looks like a raw credential that must never be persisted. */
export function containsSecretLike(text: string): boolean {
  return KNOWN_SECRETS.test(text) || EXTRA_SECRETS.test(text);
}

/** Refuse with the store's canonical message when the text looks secret-like. */
export function assertNoSecretLike(text: string): void {
  if (containsSecretLike(text)) throw new Error(SECRET_REFUSAL_MESSAGE);
}

/**
 * Validate a string field for persistence: must be a string, within the given
 * length budget, and free of secret-like content. Returns the exact string
 * (no trimming — evidence text is stored verbatim).
 */
export function checkedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  if (value.length > maxLength) throw new Error(`${field} exceeds the ${maxLength} character limit.`);
  assertNoSecretLike(value);
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
