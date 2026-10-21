/**
 * Typed job runner over the Task-5 adapter registry (ledgered Task-6 build).
 *
 * Guarantees / rulings implemented here:
 * - Job state persists ONLY through the Task-4 evidence store (`addJob` /
 *   `updateJobState` + typed `job` events). There is deliberately NO parallel
 *   JSON store or in-memory registry; the serialized `runJob` promise IS the
 *   job lifecycle for callers. (The plan's `src/jobs/store.ts` artifact-file
 *   design was superseded by the 2026-10-21 ledger ruling.)
 * - Adapter validation errors surface VERBATIM so the model can self-correct:
 *   unknown adapter names list the registry, typebox path/keyword failures are
 *   reported with their exact instance path, and `buildArgs` guard messages
 *   (flag-prefix, missing required param) and the store's canonical secret
 *   refusal propagate untouched.
 * - Spawn is argv-only via Bun.spawn — never a shell string — with stdin
 *   closed and both output pipes captured under byte caps.
 * - Timeout: 120 s default, overridable via `opts.timeoutMs`, hard ceiling
 *   600 s (higher values clamp silently to the ceiling).
 * - Outcome mapping for killed runs: a timeout kill means the run never
 *   reached a clean completion. If the captured partial output still parses
 *   into evidence rows, those rows are kept and the job state is
 *   `interrupted`; with no usable output the state is `outcome-unknown`.
 *   Both paths additionally append an annotated `job` event so the audit
 *   trail records why the terminal state is not `succeeded`/`failed`. The
 *   same branch also covers exits without a code and POSIX signal-convention
 *   exits (Bun maps signal-terminated children to 128+n, verified by probe).
 *   The outcome annotation (and the success summary) is written GUARANTEED
 *   after the guarded row persistence: a mid-flush evidence refusal leaves a
 *   `summary` event carrying {persist, refusedCount, reason} counters and
 *   the verbatim refusal goes to the caller via the JobResult — the ledger
 *   always explains why evidence is incomplete.
 * - Event discipline: every `appendEvent("job", ...)` payload carries
 *   references and counters only (ids, bytes, exit codes, row counts) — NO
 *   raw output text. Captured stderr is returned to the caller clipped and
 *   never persisted.
 * - Secret checks: the FULL argv (including entries beyond the recorded
 *   250-entry head, which the store never secret-checks) refuses with the
 *   canonical message before exec; the tool repeats the check on its details
 *   return path and gates stderr/spawnError exposures the same way.
 * - Concurrency: `runJob` serializes through one in-process promise chain
 *   (matching the tool's `executionMode: "sequential"`); parallel execution
 *   is deliberately not offered.
 * - Known limitation (documented, not silent): Bun's spawn API exposes no
 *   process-group hook, so no `setpgid`/`kill(-pgid)`. Argv-only spawning
 *   means there is no shell wrapper tree; on timeout the flagged direct
 *   child receives SIGKILL.
 */

import type { TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import { adapters, byName } from "../adapters/index.ts";
import type { AdapterDef } from "../adapters/types.ts";
import { openEvidence, type EvidenceStore, type JobState } from "../evidence/db.ts";
import { containsSecretLike, SECRET_REFUSAL_MESSAGE } from "../evidence/secrets.ts";

/** Per-run timeout: default 120 s; any override clamps at 600 s. */
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

/**
 * Capture caps (bytes). These bound transient stderr/stdout buffers, NOT the
 * durability budget: persistable evidence text is the parsed Normalized rows
 * (≤ 4000 chars each) and — on failures — a clipped stderr excerpt.
 */
export const STDOUT_CAP_BYTES = 512 * 1024;
export const STDERR_CAP_BYTES = 96 * 1024;

/** True result utilities. */
export const MAX_ARGV_RECORDED = 250; // evidence addJob argv cap is 256 entries
export const FAIL_STDERR_CHARS = 4000; // clipped stderr excerpt surfaced on failure

export interface RunJobInput {
  /** Adapter registry name, e.g. "subfinder" or "nuclei". */
  tool: string;
  /** Model-supplied params, validated against the adapter's typebox schema. */
  params?: unknown;
}

export interface RunJobOpts {
  /** Injected evidence DB; defaults to `openEvidence()` (caller-owns flag below). */
  evidenceDb?: EvidenceStore;
  /** Kill timeout in ms; default 120 s, ceiling 600 s. */
  timeoutMs?: number;
  /** Capture caps in bytes (see constant docs above). */
  stdoutCapBytes?: number;
  stderrCapBytes?: number;
  /** Operator-only opts forwarded to buildArgs (wordlists, template dirs). */
  buildOpts?: { wordlistPath?: string; templatesDir?: string };
}

export interface JobResult {
  jobId: string;
  adapter: string;
  argv: string[];
  state: JobState;
  exitCode: number | null;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  parsedRows: number;
  byKind: Record<string, number>;
  evidenceIds: number[];
  /**
   * Evidence persistence status: "complete" by default; "partial"/"error"
   * when a Normalized row could not be persisted (e.g. secret refusal).
   * The job keeps its terminal state either way — the annotation fields
   * below tell the caller WHY evidence is incomplete.
   */
  evidencePersistence: "complete" | "partial" | "error";
  refusedCount?: number;
  persistReason?: "secret-refusal" | "persist-error";
  persistError?: string;
  /** Clipped stderr excerpt; failure paths only, never persisted. */
  stderr?: string;
  /** Populated when the child could not be spawned at all (e.g. bin absent). */
  spawnError?: string;
}

/** Typed unknown-tool error: carries the full available adapter list. */
export class UnknownAdapterError extends Error {
  readonly requested: string;
  readonly available: readonly string[];
  constructor(requested: string, available: readonly string[]) {
    super(`unknown job tool "${requested}". Available adapters: ${available.join(", ")}.`);
    this.name = "UnknownAdapterError";
    this.requested = requested;
    this.available = available;
  }
}

interface CapturedStream {
  text: string;
  bytes: number;
  truncated: boolean;
}

function resolveTimeout(ms: number | undefined): number {
  if (ms === undefined || typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(ms, MAX_TIMEOUT_MS);
}

function resolveCap(value: number | undefined, fallback: number): number {
  if (value === undefined || typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), fallback);
}

/**
 * Deterministic single-line schema validation error naming the offending
 * instance path, keyword and message — surfaced verbatim to the model.
 */
export function schemaValidationError(adapter: AdapterDef, params: unknown): string {
  const errors = [...Errors(adapter.schema as TSchema, params)];
  const chosen = errors.find((error) => error.keyword !== "boolean") ?? errors[0];
  if (!chosen) return `params for ${adapter.name} rejected by schema at (root): no error details available.`;
  const instancePath = typeof chosen.instancePath === "string" && chosen.instancePath ? chosen.instancePath : "(root)";
  const unknown = ((chosen.params ?? {}) as { additionalProperties?: string[] }).additionalProperties ?? [];
  const where = unknown.length > 0
    ? `${instancePath === "(root)" ? "unknown" : `${instancePath} unknown`} key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`
    : instancePath;
  return `params for ${adapter.name} rejected by schema at ${where} (${chosen.keyword}): ${chosen.message}`;
}

function assertSchemaParams(adapter: AdapterDef, params: unknown): void {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`params for ${adapter.name} must be a JSON object (received ${params === null ? "null" : Array.isArray(params) ? "array" : typeof params}).`);
  }
  const schema = adapter.schema as TSchema;
  if (!Check(schema, params)) throw new Error(schemaValidationError(adapter, params));
}

/**
 * Evidence store argv cap is 256 checked entries; long scans (nuclei 256
 * targets = 512+ argv elements) record a bounded head plus a synthetic
 * marker instead of failing the launch. Entries beyond the cap are simply
 * not stored (and therefore not secret-checked) — nothing is hidden, the
 * full argv stays alive in the returned JobResult.
 */
function recordedArgv(argv: string[]): string[] {
  if (argv.length <= 256) return argv;
  const head = argv.slice(0, MAX_ARGV_RECORDED);
  return [...head, `<${argv.length - MAX_ARGV_RECORDED} more argv entries not recorded>`];
}

function newJobId(adapter: string): string {
  return `${adapter}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Drain an output pipe to the byte cap (bytes beyond the cap are counted and
 * discarded — the drain keeps running so the child never blocks on a full
 * pipe). Text stays transient; only parsed rows and clipped stderr excerpts
 * ever leave this function.
 */
async function drainPipe(stream: ReadableStream<Uint8Array>, cap: number): Promise<CapturedStream> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!truncated && bytes + value.byteLength <= cap) {
      text += decoder.decode(value, { stream: true });
      bytes += value.byteLength;
    } else if (!truncated) {
      // Only the part of this chunk that still fits is kept; the rest of the
      // stream keeps draining (discarded) so the child never blocks on a full pipe.
      const room = Math.max(0, cap - bytes);
      if (room > 0) {
        text += decoder.decode(value.subarray(0, room), { stream: true });
        bytes += room;
      }
      truncated = true;
    }
  }
  text += decoder.decode();
  return { text, bytes, truncated };
}

function safeParse(adapter: AdapterDef, stdout: string, stderr: string): { rows: ReturnType<AdapterDef["parse"]>; error?: string } {
  try {
    return { rows: adapter.parse(stdout, stderr) };
  } catch (error) {
    // parse() implementations are written to skip malformed lines, but a
    // throwing parser must never lose a succeeded job: count 0 rows and
    // annotate through the caller.
    return { rows: [], error: error instanceof Error ? error.message : String(error) };
  }
}

function countByKind(rows: { kind: string }[]): Record<string, number> {
  const byKind: Record<string, number> = {};
  for (const row of rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  return byKind;
}

function clipStderr(text: string): string {
  return text.length > FAIL_STDERR_CHARS ? `${text.slice(0, FAIL_STDERR_CHARS)}[truncated]` : text;
}

async function executeJob(input: RunJobInput, opts: RunJobOpts): Promise<JobResult> {
  const adapter = byName(input.tool);
  if (!adapter) throw new UnknownAdapterError(input.tool, adapters.map((def) => def.name));

  // 1) Typebox validation — clear error with the exact offending path; no DB touched yet.
  assertSchemaParams(adapter, input.params);

  // 2) buildArgs — its guard errors (flag-prefix, missing required param) surface verbatim.
  const buildResult = adapter.buildArgs(input.params as Record<string, unknown>, { ...(opts.buildOpts ?? {}) });
  const argv = [adapter.bin, ...buildResult];
  // Global constraint: secret-pattern check on every exec/return path that can
  // carry secrets — the FULL argv (including entries beyond the recorded 250
  // entry head) refuses with the canonical message BEFORE exec, so a tainted
  // command never runs and never reaches tool details either.
  assertArgvSecretFree(argv);
  const jobId = newJobId(adapter.name);

  // 3) Evidence DB. When injected, the caller owns it; the default store is closed here.
  const ownsStore = !opts.evidenceDb;
  const store = opts.evidenceDb ?? openEvidence();
  try {
    // Secret-tainted argv refuses here (verbatim canonical message), before any spawn.
    store.addJob({ jobId, adapter: adapter.name, argv: recordedArgv(argv), state: "running" });

    // 4) Spawn. Argv-only, stdin closed, capped pipes.
    let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      // env snapshot: Bun resolves the bin via the spawn env's PATH taken at call
      // time (process-wide PATH mutations after bun's startup still apply).
      proc = Bun.spawn([adapter.bin, ...buildResult], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
    } catch (error) {
      const spawnError = error instanceof Error ? error.message : String(error);
      store.updateJobState(jobId, "failed");
      store.appendEvent("job", { jobId, event: "failed", exitCode: null, note: "spawn-failed" });
      return {
        jobId, adapter: adapter.name, argv, state: "failed", exitCode: null,
        timedOut: false, stdoutBytes: 0, stderrBytes: 0,
        stdoutTruncated: false, stderrTruncated: false,
        parsedRows: 0, byKind: {}, evidenceIds: [], evidencePersistence: "complete", spawnError,
      };
    }

    const stdoutCap = resolveCap(opts.stdoutCapBytes, STDOUT_CAP_BYTES);
    const stderrCap = resolveCap(opts.stderrCapBytes, STDERR_CAP_BYTES);
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }, resolveTimeout(opts.timeoutMs));

    const [capsOut, capsErr, exitCode] = await Promise.all([
      drainPipe(proc.stdout as ReadableStream<Uint8Array>, stdoutCap),
      drainPipe(proc.stderr as ReadableStream<Uint8Array>, stderrCap),
      proc.exited,
    ]);
    clearTimeout(killer);

    const base = {
      jobId,
      adapter: adapter.name,
      argv,
      timedOut,
      stdoutBytes: capsOut.bytes,
      stderrBytes: capsErr.bytes,
      stdoutTruncated: capsOut.truncated,
      stderrTruncated: capsErr.truncated,
    };

    // 5) Terminal state mapping.
    const code = typeof exitCode === "number" ? exitCode : null;
    // Abrupt-completion detection: a timeout kill, a null/absent exit code
    // (OOM-kill style), or a POSIX signal-convention exit code. Note: on this
    // host Bun 1.4.3 maps a signal-terminated child to 128+n instead of null
    // (verified by probe), so 128..191 routes into the same branch — that is
    // the "never reached a clean completion" class, not a completed failure.
    const signalNo = !timedOut && code !== null && code >= 128 && code <= 191 ? code - 128 : null;
    const abrupt = timedOut || code === null || signalNo !== null;
    const abruptReason = timedOut
      ? "killed at timeout"
      : code === null
        ? "no-exit-code"
        : signalNo !== null
          ? `exit-on-signal-${signalNo}`
          : undefined;

    if (abrupt) {
      // Never reached a clean completion (timeout kill / OOM-kill style exit /
      // signal-convention exit). Parse what arrived: usable partial rows stay
      // as annotated evidence while the state is `interrupted`; otherwise
      // `outcome-unknown`. The annotated ledger record is guaranteed after
      // the guarded persist, whatever happens to the rows.
      const parsed = safeParse(adapter, capsOut.text, capsErr.text);
      const state = parsed.rows.length > 0 ? "interrupted" : "outcome-unknown";
      store.updateJobState(jobId, state);
      const persist = persistRowsGuarded(store, jobId, adapter, parsed.rows);
      annotateOutcome(store, jobId, "outcome-unknown", {
        reason: abruptReason,
        state,
        partialEvidenceRows: persist.ids.length,
        evidencePersistence: persist.evidencePersistence,
        refusedCount: persist.refusedCount,
        persistReason: persist.persistReason,
        stdoutTruncated: capsOut.truncated,
        stderrTruncated: capsErr.truncated,
      });
      return {
        ...base, state, exitCode: code,
        parsedRows: persist.ids.length, byKind: countByKind(parsed.rows), evidenceIds: persist.ids,
        evidencePersistence: persist.evidencePersistence,
        ...(persist.persistReason ? { refusedCount: persist.refusedCount, persistReason: persist.persistReason } : {}),
        ...(persist.error ? { persistError: persist.error.message } : {}),
        stderr: clipStderr(capsErr.text),
      };
    }

    if (code !== 0) {
      // A real, completed non-zero exit: failed, no parse.
      store.updateJobState(jobId, "failed");
      store.appendEvent("job", {
        jobId, event: "failed", exitCode: code,
        stdoutBytes: capsOut.bytes, stderrBytes: capsErr.bytes,
        stdoutTruncated: capsOut.truncated, stderrTruncated: capsErr.truncated,
      });
      return {
        ...base, state: "failed", exitCode: code,
        parsedRows: 0, byKind: {}, evidenceIds: [], evidencePersistence: "complete",
        stderr: clipStderr(capsErr.text),
      };
    }

    // Clean completion: parse, persist each Normalized row (guarded), annotate.
    const parsed = safeParse(adapter, capsOut.text, capsErr.text);
    store.updateJobState(jobId, "succeeded");
    const persist = persistRowsGuarded(store, jobId, adapter, parsed.rows);
    const byKind = countByKind(parsed.rows);
    // The summary event payload is counters/ids/enums ONLY (never a free-text
    // message), so the store's own payload checks cannot refuse it — the
    // verbatim persist error goes to the caller via the JobResult instead.
    try {
      store.appendEvent("job", {
        jobId,
        event: "summary",
        rows: persist.ids.length,
        parsedRows: parsed.rows.length,
        byKind,
        evidenceIds: boundedEvidenceIds(persist.ids),
        evidencePersistence: persist.evidencePersistence,
        refusedCount: persist.refusedCount,
        persistReason: persist.persistReason,
        stdoutTruncated: capsOut.truncated,
        stderrTruncated: capsErr.truncated,
        parseFailed: Boolean(parsed.error),
      });
    } catch (cause) {
      // Belt-and-braces: a refused summary must never erase the ledger record —
      // fall back to a minimal counters-only annotated event, then reraise so
      // the failure stays loud (never a silent gap after a succeeded state).
      try {
        annotateOutcome(store, jobId, "annotated", { note: "summary-event-failed", evidencePersistence: persist.evidencePersistence });
      } catch { /* the running/succeeded records remain; nothing further can be written */ }
      throw cause instanceof Error ? cause : new Error(String(cause));
    }
    return {
      ...base, state: "succeeded", exitCode: code,
      parsedRows: persist.ids.length, byKind, evidenceIds: persist.ids,
      evidencePersistence: persist.evidencePersistence,
      ...(persist.persistReason ? { refusedCount: persist.refusedCount, persistReason: persist.persistReason } : {}),
      ...(persist.error ? { persistError: persist.error.message } : {}),
    };
  } finally {
    if (ownsStore) store.close();
  }
}

/**
 * Persist each Normalized finding as an evidence row
 * ({kind: artifactKind, refs: [jobId, key], text: raw, sensitivity: "internal"}),
 * GUARDED: a refusal (e.g. a finding quoting a leaked key) or any persist
 * failure keeps what was already persisted, classifies the reason, and lets
 * the caller annotate the ledger — the job's terminal state/event is written
 * BEFORE this runs and is never left unexplained.
 */
export interface PersistOutcome {
  ids: number[];
  evidencePersistence: "complete" | "partial" | "error";
  /** Rows that exist in `rows` but did not make it into evidence. */
  refusedCount: number;
  persistReason?: "secret-refusal" | "persist-error";
  error?: Error;
}

function persistRowsGuarded(store: EvidenceStore, jobId: string, adapter: AdapterDef, rows: ReturnType<AdapterDef["parse"]>): PersistOutcome {
  const ids: number[] = [];
  let error: Error | undefined;
  for (const row of rows) {
    try {
      const { id } = store.addEvidence({
        kind: adapter.artifactKind,
        refs: [jobId, row.key],
        text: row.raw,
        sensitivity: "internal",
      });
      ids.push(id);
    } catch (cause) {
      // Stop on the first refusal (ordering matters); what is persisted stays.
      error = cause instanceof Error ? cause : new Error(String(cause));
      break;
    }
  }
  const refusedCount = rows.length - ids.length;
  const evidencePersistence = !error
    ? "complete"
    : ids.length > 0
      ? "partial"
      : "error";
  const persistReason = !error ? undefined : error.message === SECRET_REFUSAL_MESSAGE ? "secret-refusal" : "persist-error";
  return { ids, evidencePersistence, refusedCount, persistReason, error };
}

/**
 * Append the outcome annotation as a typed `job` event, counters only. If the
 * store refuses the primary annotation, a minimal fallback annotation is
 * attempted so the ledger record after a terminal state is never skippable.
 */
function annotateOutcome(store: EvidenceStore, jobId: string, event: string, payload: Record<string, unknown>): void {
  try {
    store.appendEvent("job", { jobId, event, ...payload });
  } catch {
    try { store.appendEvent("job", { jobId, event: "annotated", note: `${event}-event-failed` }); } catch { /* untouched ledger above still holds the transition */ }
  }
}

/** Budget for the evidenceIds list inside the summary event payload (the store refuses event payloads over 32 KiB). */
const EVENT_IDS_BUDGET = 28_000;

/**
 * Cap the summary event's evidenceIds list: beyond the budget the list is
 * truncated with an attached marker string instead of failing the whole
 * summary event. The ids themselves are all still readable from the evidence
 * table via their refs — the event list is a convenience, never the source of
 * truth.
 */
export function boundedEvidenceIds(ids: readonly number[]): Array<number | string> {
  if (JSON.stringify(ids).length <= EVENT_IDS_BUDGET) return [...ids];
  let count = Math.floor(EVENT_IDS_BUDGET / 6);
  while (count > 0) {
    const marker = `<${ids.length - count} more evidence ids not listed>`;
    if (JSON.stringify([...ids.slice(0, count), marker]).length <= EVENT_IDS_BUDGET) return [...ids.slice(0, count), marker];
    count = Math.floor(count / 2);
  }
  return [`<all ${ids.length} evidence ids not listed>`];
}

/**
 * Global constraint (secret check on every exec/return path that can carry
 * secrets): refuse the FULL argv — including entries beyond the recorded
 * 250-entry head, which the evidence store never secret-checks — with the
 * canonical refusal message. Used pre-exec by the runner and defensively on
 * the tool's details return path.
 */
export function assertArgvSecretFree(argv: readonly string[]): void {
  for (const entry of argv) {
    if (containsSecretLike(entry)) throw new Error(SECRET_REFUSAL_MESSAGE);
  }
}

/**
 * Serialized job execution: one in-process promise chain — a new run starts
 * only after the previous one settled. Parallel execution is deliberately
 * not offered (tool executionMode "sequential"); queue failures never.
 */
let queueTail: Promise<unknown> = Promise.resolve();

export function runJob(input: RunJobInput, opts: RunJobOpts = {}): Promise<JobResult> {
  const run = queueTail.catch(() => undefined).then(() => executeJob(input, opts));
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Look a job up in the store's most recent window (listJobs is capped at 50
 * rows by the evidence store itself — status looks back over exactly that
 * window). `undefined` means unknown job.
 */
export function lookupJob(store: EvidenceStore, jobId: string): ReturnType<EvidenceStore["listJobs"]>[number] | undefined {
  return store.listJobs({ limit: 50 }).find((row) => row.jobId === jobId);
}
