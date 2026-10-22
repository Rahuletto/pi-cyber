import { randomBytes } from "node:crypto";
import { openEvidence, resolveEvidencePath } from "../evidence/db.ts";
import type { JobState } from "../evidence/db.ts";
import { findArtifactBySource, readArtifact, storeArtifact, type ArtifactRead, type ArtifactRef } from "../artifacts/store.ts";
import { runJob, type JobProgress, type JobResult, type RunJobInput, type RunJobOpts } from "./runner.ts";

export interface ManagedJobSnapshot {
  jobId: string;
  adapter: string;
  state: JobState;
  phase: "queued" | "running" | "capturing" | "persisting" | "completed";
  stdoutBytes: number;
  stderrBytes: number;
  cancelRequested: boolean;
  resultArtifact?: ArtifactRef;
  error?: string;
}

export interface ManagedJobResult extends JobResult {
  resultArtifact?: ArtifactRef;
}

export interface ManagedJob {
  readonly jobId: string;
  get(): ManagedJobSnapshot;
  cancel(): boolean;
  readonly completion: Promise<ManagedJobResult>;
}

interface RuntimeRecord {
  snapshot: ManagedJobSnapshot;
  controller: AbortController;
  evidencePath: string;
  env: NodeJS.ProcessEnv;
  store: ReturnType<typeof openEvidence>;
  settled: boolean;
  resolve: (result: ManagedJobResult) => void;
  reject: (error: Error) => void;
  completion: Promise<ManagedJobResult>;
}

const runtimeJobs = new Map<string, RuntimeRecord>();
const MAX_RUNTIME_JOBS = 100;

function makeRoom(): void {
  for (const [key, record] of runtimeJobs) {
    if (runtimeJobs.size < MAX_RUNTIME_JOBS) return;
    if (record.settled) runtimeJobs.delete(key);
  }
  if (runtimeJobs.size >= MAX_RUNTIME_JOBS) throw new Error(`runtime job capacity reached (${MAX_RUNTIME_JOBS} active or queued jobs).`);
}

function scopeKey(env: NodeJS.ProcessEnv): string {
  return resolveEvidencePath(env);
}

function managedId(adapter: string): string {
  return `${adapter}-${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

function cancelledResult(jobId: string, adapter: string): ManagedJobResult {
  return {
    jobId, adapter, argv: [], state: "cancelled", exitCode: null,
    timedOut: false, cancelled: true, stdoutBytes: 0, stderrBytes: 0,
    stdoutTruncated: false, stderrTruncated: false, parsedRows: 0, byKind: {},
    evidenceIds: [], evidencePersistence: "complete",
  };
}

function captureArtifact(result: JobResult, env: NodeJS.ProcessEnv): ArtifactRef {
  // Result documents contain only normalized counters, state, and evidence
  // references. Raw argv, output, stderr and request values stay private.
  const document = {
    jobId: result.jobId,
    adapter: result.adapter,
    state: result.state,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled ?? false,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    parsedRows: result.parsedRows,
    byKind: result.byKind,
    evidenceIds: result.evidenceIds,
    evidencePersistence: result.evidencePersistence,
    refusedCount: result.refusedCount,
    persistReason: result.persistReason,
  };
  return storeArtifact(JSON.stringify(document), {
    kind: "job-result", contentType: "application/json", source: result.jobId,
  }, env);
}

function publishProgress(record: RuntimeRecord, progress: JobProgress): void {
  if (progress.phase === "running") record.snapshot.state = "running";
  record.snapshot.phase = progress.phase === "finished" ? "completed" : progress.phase;
  record.snapshot.stdoutBytes = progress.stdoutBytes ?? record.snapshot.stdoutBytes;
  record.snapshot.stderrBytes = progress.stderrBytes ?? record.snapshot.stderrBytes;
}

function finish(record: RuntimeRecord, result: ManagedJobResult): void {
  if (record.settled) return;
  record.settled = true;
  record.snapshot.state = result.state;
  record.snapshot.phase = "completed";
  record.snapshot.stdoutBytes = result.stdoutBytes;
  record.snapshot.stderrBytes = result.stderrBytes;
  record.snapshot.resultArtifact = result.resultArtifact;
  try { record.store.close(); } catch { record.snapshot.error ??= "evidence store close failed"; }
  record.resolve(result);
}

function finishQueuedCancellation(record: RuntimeRecord, jobId: string, adapter: string): void {
  const result = cancelledResult(jobId, adapter);
  try {
    result.resultArtifact = captureArtifact(result, record.env);
    // addJob records the terminal transition and its matching event atomically.
    // Empty argv ensures a cancelled queued tool is never materialized as an
    // executed command in the durable ledger.
    record.store.addJob({ jobId, adapter, argv: [], state: "cancelled" });
    try {
      record.store.appendEvent("job", {
        jobId,
        event: "result-artifact",
        artifactId: result.resultArtifact.id,
        bytes: result.resultArtifact.bytes,
        sha256: result.resultArtifact.sha256,
      });
    } catch {
      record.snapshot.error = "result artifact saved but its reference could not be linked in the job ledger";
    }
  } catch (cause) {
    record.snapshot.error = cause instanceof Error ? cause.message : String(cause);
  }
  finish(record, result);
}

export function startManagedJob(
  input: RunJobInput,
  options: Omit<RunJobOpts, "evidenceDb" | "jobId" | "signal" | "onProgress" | "spawnEnv"> = {},
  env: NodeJS.ProcessEnv = process.env,
): ManagedJob {
  makeRoom();
  const snapshotEnv = { ...env };
  const evidencePath = resolveEvidencePath(snapshotEnv);
  const id = managedId(input.tool);
  const store = openEvidence(evidencePath);
  let resolveCompletion!: (result: ManagedJobResult) => void;
  let rejectCompletion!: (error: Error) => void;
  const completion = new Promise<ManagedJobResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Callers may observe the job through status instead of awaiting this
  // promise. Keep rejected validation/runner errors from becoming unhandled.
  void completion.catch(() => undefined);
  const record: RuntimeRecord = {
    snapshot: {
      jobId: id,
      adapter: input.tool,
      state: "queued",
      phase: "queued",
      stdoutBytes: 0,
      stderrBytes: 0,
      cancelRequested: false,
    },
    controller: new AbortController(),
    evidencePath,
    env: snapshotEnv,
    store,
    settled: false,
    resolve: resolveCompletion,
    reject: rejectCompletion,
    completion,
  };
  runtimeJobs.set(`${evidencePath}\0${id}`, record);

  const internal = runJob(input, {
    ...options,
    evidenceDb: store,
    jobId: id,
    signal: record.controller.signal,
    spawnEnv: snapshotEnv,
    onProgress: (progress) => publishProgress(record, progress),
  });
  internal.then((result) => {
    if (record.settled) return;
    try {
      const resultArtifact = captureArtifact(result, snapshotEnv);
      try {
        record.store.appendEvent("job", {
          jobId: id,
          event: "result-artifact",
          artifactId: resultArtifact.id,
          bytes: resultArtifact.bytes,
          sha256: resultArtifact.sha256,
        });
      } catch {
        record.snapshot.error = "result artifact saved but its reference could not be linked in the job ledger";
      }
      finish(record, { ...result, resultArtifact });
    } catch (cause) {
      record.snapshot.error = cause instanceof Error ? cause.message : String(cause);
      finish(record, result);
    }
  }, (cause: unknown) => {
    if (record.settled) return;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (error.name === "AbortError") {
      finish(record, cancelledResult(id, input.tool));
      return;
    }
    record.snapshot.error = error.message;
    record.snapshot.phase = "completed";
    record.snapshot.state = "failed";
    record.settled = true;
    store.close();
    record.reject(error);
  });

  return {
    jobId: id,
    get: () => ({ ...record.snapshot, ...(record.snapshot.resultArtifact ? { resultArtifact: { ...record.snapshot.resultArtifact } } : {}) }),
    cancel: () => {
      if (record.settled || record.snapshot.cancelRequested) return false;
      record.snapshot.cancelRequested = true;
      if (record.snapshot.phase === "queued") {
        record.controller.abort();
        finishQueuedCancellation(record, id, input.tool);
      } else {
        record.controller.abort();
      }
      return true;
    },
    completion,
  };
}

function findInScope(jobId: string, env: NodeJS.ProcessEnv): RuntimeRecord {
  const key = `${scopeKey(env)}\0${jobId}`;
  const record = runtimeJobs.get(key);
  if (!record) throw new Error("unknown or out-of-scope runtime job id.");
  return record;
}

export function getManagedJob(jobId: string, env: NodeJS.ProcessEnv = process.env): ManagedJobSnapshot {
  const runtime = runtimeJobs.get(`${scopeKey(env)}\0${jobId}`);
  if (runtime) return { ...runtime.snapshot };
  const resultArtifact = findArtifactBySource(jobId, env);
  if (!resultArtifact) throw new Error("unknown or out-of-scope runtime job id.");
  const document = JSON.parse(readArtifact(resultArtifact.id, { limit: 64 * 1024 }, env).data) as Record<string, unknown>;
  if (document.jobId !== jobId || typeof document.adapter !== "string" ||
      !["succeeded", "failed", "cancelled", "interrupted", "outcome-unknown"].includes(String(document.state))) {
    throw new Error("persisted job result is invalid.");
  }
  return {
    jobId,
    adapter: document.adapter,
    state: document.state as JobState,
    phase: "completed",
    stdoutBytes: Number.isSafeInteger(document.stdoutBytes) ? Number(document.stdoutBytes) : 0,
    stderrBytes: Number.isSafeInteger(document.stderrBytes) ? Number(document.stderrBytes) : 0,
    cancelRequested: document.cancelled === true,
    resultArtifact,
  };
}

export function cancelManagedJob(jobId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const record = findInScope(jobId, env);
  if (record.settled || record.snapshot.cancelRequested) return false;
  record.snapshot.cancelRequested = true;
  if (record.snapshot.phase === "queued") {
    record.controller.abort();
    finishQueuedCancellation(record, jobId, record.snapshot.adapter);
  }
  else record.controller.abort();
  return true;
}

export function readManagedJobResult(
  jobId: string,
  options: { offset?: number; limit?: number; encoding?: "utf8" | "base64" } = {},
  env: NodeJS.ProcessEnv = process.env,
): ArtifactRead {
  const record = runtimeJobs.get(`${scopeKey(env)}\0${jobId}`);
  const ref = record?.snapshot.resultArtifact ?? findArtifactBySource(jobId, env);
  if (!ref) throw new Error(record ? "job result is not available yet." : "unknown or out-of-scope runtime job id.");
  return readArtifact(ref.id, options, record?.env ?? env);
}
