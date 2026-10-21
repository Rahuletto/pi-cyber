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
 *   trail records why the terminal state is not `succeeded`/`failed`.
 * - Event discipline: every `appendEvent("job", ...)` payload carries
 *   references and counters only (ids, bytes, exit codes, row counts) — NO
 *   raw output text. Captured stderr is returned to the caller clipped and
 *   never persisted.
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
        parsedRows: 0, byKind: {}, evidenceIds: [], spawnError,
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
    if (timedOut) {
      const parsed = safeParse(adapter, capsOut.text, capsErr.text);
      const state = parsed.rows.length > 0 ? "interrupted" : "outcome-unknown";
      store.updateJobState(jobId, state);
      const evidenceIds = persistRows(store, jobId, adapter, parsed.rows);
      // Annotated event: killed mid-run, never reached a clean completion.
      store.appendEvent("job", {
        jobId,
        event: "outcome-unknown",
        reason: "killed at timeout",
        state,
        partialEvidenceRows: evidenceIds.length,
        stdoutTruncated: capsOut.truncated,
        stderrTruncated: capsErr.truncated,
      });
      return {
        ...base, state, exitCode: typeof exitCode === "number" ? exitCode : null,
        parsedRows: evidenceIds.length, byKind: countByKind(parsed.rows), evidenceIds,
        stderr: clipStderr(capsErr.text),
      };
    }

    const code = typeof exitCode === "number" ? exitCode : null;
    if (code !== 0) {
      // Non-zero exit (or an abrupt signal exit without a code): failed, no parse.
      const abrupt = code === null;
      store.updateJobState(jobId, "failed");
      store.appendEvent("job", {
        jobId, event: "failed", exitCode: code,
        note: abrupt ? "abrupt-exit-without-code" : undefined,
        stdoutBytes: capsOut.bytes, stderrBytes: capsErr.bytes,
        stdoutTruncated: capsOut.truncated, stderrTruncated: capsErr.truncated,
      });
      return {
        ...base, state: "failed", exitCode: code,
        parsedRows: 0, byKind: {}, evidenceIds: [],
        stderr: clipStderr(capsErr.text),
      };
    }

    // Non-zero-free success: parse first, persist each Normalized row.
    const parsed = safeParse(adapter, capsOut.text, capsErr.text);
    store.updateJobState(jobId, "succeeded");
    const evidenceIds = persistRows(store, jobId, adapter, parsed.rows);
    const byKind = countByKind(parsed.rows);
    store.appendEvent("job", {
      jobId,
      event: "summary",
      rows: evidenceIds.length,
      byKind,
      evidenceIds,
      stdoutTruncated: capsOut.truncated,
      stderrTruncated: capsErr.truncated,
      parseError: parsed.error,
    });
    return {
      ...base, state: "succeeded", exitCode: code,
      parsedRows: evidenceIds.length, byKind, evidenceIds,
    };
  } finally {
    if (ownsStore) store.close();
  }
}

/**
 * Persist each Normalized finding as an evidence row
 * ({kind: artifactKind, refs: [jobId, key], text: raw, sensitivity: "internal"}).
 * On the canonical secret refusal mid-way, what has been persisted stays and
 * the refusal error propagates verbatim (the job keeps its already-updated
 * terminal state; the caller sees exactly why the run was cut short).
 */
function persistRows(store: EvidenceStore, jobId: string, adapter: AdapterDef, rows: ReturnType<AdapterDef["parse"]>): number[] {
  const ids: number[] = [];
  for (const row of rows) {
    const { id } = store.addEvidence({
      kind: adapter.artifactKind,
      refs: [jobId, row.key],
      text: row.raw,
      sensitivity: "internal",
    });
    ids.push(id);
  }
  return ids;
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
