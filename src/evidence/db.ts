/**
 * Durable evidence store: one SQLite file per engagement (bun:sqlite, zero deps).
 *
 * Append-only discipline: events, evidence, findings and browser_sessions are
 * INSERT-only — no UPDATE or DELETE is ever exposed for them. The only
 * mutable table is `jobs`, whose rows legitimately transition through a
 * state machine, and the lease-release column of `browser_sessions`
 * (`released_at`, NULL → timestamp, sanctioned 2026-10-21). Every job
 * transition and every lease release is also recorded as a typed event
 * (`job` / `session`) so the event log stays a complete audit trail.
 *
 * Browser leases (browser_sessions) carry NO partial unique constraint: the
 * table stays a plain append-only ledger so the schema is never rewritten.
 * "One owner per live browser session" is therefore enforced one layer up,
 * by the tool that reads `listSessions({ activeOnly: true })` before it
 * acquires — see src/tools/browser.ts for why that check is sound under the
 * tool's sequential execution mode.
 *
 * Path resolution (worker env):
 * - `CYBER_EVIDENCE_DIR` — base directory, default `<repoRoot>/config/cyber/evidence`
 * - `CYBER_ENGAGEMENT_ID` — engagement subdirectory, default `"default"`
 * - file name is fixed: `cyber.sqlite`
 * An explicit `openEvidence(path)` override wins over the computed default.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkedId,
  checkedRefList,
  checkedText,
} from "./secrets.ts";

const MAX_TEXT_CHARS = 32_000;
const MAX_IMPACT_CHARS = 8_000;
const MAX_EVENT_PAYLOAD_CHARS = 32_000;
const MAX_FINDING_EVIDENCE = 50;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  refs TEXT NOT NULL,
  text TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('low','internal','restricted')),
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state TEXT NOT NULL CHECK (state IN ('candidate','needs-validation','confirmed','rejected','remediated','retest-passed')),
  title TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,
  impact TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jobId TEXT NOT NULL UNIQUE,
  adapter TEXT NOT NULL,
  argv TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled','interrupted','outcome-unknown')),
  started_at TEXT,
  ended_at TEXT,
  artifact_path TEXT
);
CREATE TABLE IF NOT EXISTS browser_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sessionId TEXT NOT NULL,
  owner TEXT NOT NULL,
  mode TEXT NOT NULL,
  purpose TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  released_at TEXT
);
`;

export type Sensitivity = "low" | "internal" | "restricted";
export type FindingState = "candidate" | "needs-validation" | "confirmed" | "rejected" | "remediated" | "retest-passed";
export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" | "outcome-unknown";

export const SENSITIVITIES: readonly Sensitivity[] = ["low", "internal", "restricted"];
export const FINDING_STATES: readonly FindingState[] = ["candidate", "needs-validation", "confirmed", "rejected", "remediated", "retest-passed"];
export const JOB_STATES: readonly JobState[] = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted", "outcome-unknown"];
/** Job states after which no further transition is meaningful. */
const JOB_TERMINAL_STATES: readonly JobState[] = ["succeeded", "failed", "cancelled", "interrupted", "outcome-unknown"];

const ENGAGEMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface EvidenceRow {
  id: number; ts: string; kind: string; refs: string[];
  text: string; sensitivity: Sensitivity; hash: string;
}
export interface FindingRow {
  id: number; state: FindingState; title: string; evidenceIds: number[];
  impact: string; confidence: number; createdAt: string;
}
export interface JobRow {
  id: number; jobId: string; adapter: string; argv: string[]; state: JobState;
  startedAt: string | null; endedAt: string | null; artifactPath: string | null;
}
/** One browser lease row. `releasedAt` is null while the lease is live. */
export interface SessionRow {
  id: number; sessionId: string; owner: string; mode: string; purpose: string;
  acquiredAt: string; releasedAt: string | null;
}

export interface EvidenceStore {
  readonly path: string;
  appendEvent(kind: string, payload: unknown): number;
  addEvidence(input: { kind: string; refs: string[]; text: string; sensitivity: Sensitivity }): { id: number; hash: string };
  addFinding(init: { state?: FindingState; title: string; evidenceIds: number[]; impact: string; confidence?: number }): { id: number };
  addJob(row: { jobId: string; adapter: string; argv: string[]; state: JobState; startedAt?: string | number; artifactPath?: string }): number;
  updateJobState(jobId: string, state: JobState): void;
  addSession(row: { sessionId: string; owner: string; mode: string; purpose: string }): void;
  releaseSession(sessionId: string): void;
  /** Read-only lease query. `activeOnly` returns only leases that are still held. */
  listSessions(opts?: { activeOnly?: boolean; limit?: number }): SessionRow[];
  listEvidence(opts?: { kind?: string; limit?: number }): EvidenceRow[];
  listFindings(opts?: { state?: FindingState; limit?: number }): FindingRow[];
  listJobs(opts?: { limit?: number }): JobRow[];
  briefSummary(mode?: string): string;
  recordCount(): number;
  close(): void;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * startedAt accepts undefined (derived from state), an ISO-8601 string, or a
 * numeric epoch (ms). Anything else is rejected with a clear error.
 */
function normalizeStartedAt(value: string | number | null | undefined, state: JobState): string | null {
  if (value === undefined || value === null) return state === "running" ? now() : null;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("Job startedAt must be undefined, an ISO-8601 string, or a numeric epoch.");
  }
  if (typeof value === "string" && !value.trim()) {
    throw new Error("Job startedAt must be undefined, an ISO-8601 string, or a numeric epoch.");
  }
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) {
    throw new Error("Job startedAt must be undefined, an ISO-8601 string, or a numeric epoch.");
  }
  return new Date(time).toISOString();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/** Repo root, derived from this module's location (…/src/evidence/db.ts). */
export function repoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

export interface EvidenceEnv {
  CYBER_EVIDENCE_DIR?: string;
  CYBER_ENGAGEMENT_ID?: string;
  [key: string]: string | undefined;
}

/** Default evidence DB path for the current (or given) environment. */
export function resolveEvidencePath(env: EvidenceEnv = process.env): string {
  const base = env.CYBER_EVIDENCE_DIR?.trim() || join(repoRoot(), "config", "cyber", "evidence");
  const engagement = env.CYBER_ENGAGEMENT_ID?.trim() || "default";
  if (!ENGAGEMENT_PATTERN.test(engagement)) {
    throw new Error(`CYBER_ENGAGEMENT_ID must match ${ENGAGEMENT_PATTERN.source} (rejected ${JSON.stringify(engagement.slice(0, 64))}).`);
  }
  return join(base, engagement, "cyber.sqlite");
}

function openDatabase(file: string): Database {
  const db = new Database(file);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(SCHEMA);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function createStore(db: Database, path: string): EvidenceStore {
  // Prepared statements only — every statement is compiled once at open time.
  const insertEvent = db.prepare("INSERT INTO events (ts, kind, payload_json) VALUES (?, ?, ?) RETURNING id");
  const insertEvidence = db.prepare("INSERT INTO evidence (ts, kind, refs, text, sensitivity, hash) VALUES (?, ?, ?, ?, ?, ?) RETURNING id");
  const insertFinding = db.prepare("INSERT INTO findings (state, title, evidence_ids, impact, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id");
  const insertJob = db.prepare("INSERT INTO jobs (jobId, adapter, argv, state, started_at, ended_at, artifact_path) VALUES (?, ?, ?, ?, ?, NULL, ?) RETURNING id");
  const selectJobByJobId = db.prepare("SELECT id FROM jobs WHERE jobId = ?");
  const updateJobStateStmt = db.prepare("UPDATE jobs SET state = ?, ended_at = ? WHERE jobId = ?");
  const insertSession = db.prepare("INSERT INTO browser_sessions (sessionId, owner, mode, purpose, acquired_at, released_at) VALUES (?, ?, ?, ?, ?, NULL)");
  const selectActiveSession = db.prepare("SELECT owner FROM browser_sessions WHERE sessionId = ? AND released_at IS NULL");
  const releaseSessionStmt = db.prepare("UPDATE browser_sessions SET released_at = ? WHERE sessionId = ? AND released_at IS NULL RETURNING owner");
  const selectEvidenceAll = db.prepare("SELECT id, ts, kind, refs, text, sensitivity, hash FROM evidence ORDER BY id DESC LIMIT ?");
  const selectEvidenceByKind = db.prepare("SELECT id, ts, kind, refs, text, sensitivity, hash FROM evidence WHERE kind = ? ORDER BY id DESC LIMIT ?");
  const selectFindingsAll = db.prepare("SELECT id, state, title, evidence_ids, impact, confidence, created_at FROM findings ORDER BY id DESC LIMIT ?");
  const selectFindingsByState = db.prepare("SELECT id, state, title, evidence_ids, impact, confidence, created_at FROM findings WHERE state = ? ORDER BY id DESC LIMIT ?");
  const selectJobsAll = db.prepare("SELECT id, jobId, adapter, argv, state, started_at, ended_at, artifact_path FROM jobs ORDER BY id DESC LIMIT ?");
  const selectSessionsAll = db.prepare("SELECT id, sessionId, owner, mode, purpose, acquired_at, released_at FROM browser_sessions ORDER BY id DESC LIMIT ?");
  const selectActiveSessions = db.prepare("SELECT id, sessionId, owner, mode, purpose, acquired_at, released_at FROM browser_sessions WHERE released_at IS NULL ORDER BY id DESC LIMIT ?");
  const selectRecentEvents = db.prepare("SELECT id, ts, kind FROM events ORDER BY id DESC LIMIT 5");
  const totalRows = db.prepare("SELECT (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM evidence) + (SELECT COUNT(*) FROM findings) + (SELECT COUNT(*) FROM jobs) + (SELECT COUNT(*) FROM browser_sessions) AS n");
  const countOf = (get: () => unknown): number => {
    const row = get() as { n: unknown } | null;
    return Number(row?.n ?? 0);
  };
  const counts = {
    events: db.prepare("SELECT COUNT(*) AS n FROM events"),
    evidence: db.prepare("SELECT COUNT(*) AS n FROM evidence"),
    findings: db.prepare("SELECT COUNT(*) AS n FROM findings"),
    jobs: db.prepare("SELECT COUNT(*) AS n FROM jobs"),
    sessions: db.prepare("SELECT COUNT(*) AS n FROM browser_sessions"),
    sessionsActive: db.prepare("SELECT COUNT(*) AS n FROM browser_sessions WHERE released_at IS NULL"),
  };
  const updateJobTx = db.transaction((jobId: string, state: JobState) => {
    const existing = selectJobByJobId.get(jobId) as { id: number } | null;
    if (!existing) throw new Error(`Unknown job id: ${jobId}`);
    const terminal = JOB_TERMINAL_STATES.includes(state) ? now() : null;
    updateJobStateStmt.run(state, terminal, jobId);
    // Going through saveEvent guarantees the secret/size check on the payload.
    saveEvent("job", { jobId, state });
  });

  const saveEvent = (kind: string, payload: unknown): number => {
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined || payloadJson.length > MAX_EVENT_PAYLOAD_CHARS) {
      throw new Error(`Event payload exceeds the ${MAX_EVENT_PAYLOAD_CHARS} character limit; store a redacted artifact reference instead.`);
    }
    checkedId(kind, "Event kind", 64);
    checkedId(payloadJson, "Event payload", MAX_EVENT_PAYLOAD_CHARS);
    const inserted = insertEvent.get(now(), kind, payloadJson) as { id: unknown };
    return Number(inserted.id);
  };

  /** Lease release: sanctioned column update (NULL→timestamp) + typed `session` event. */
  const releaseSessionTx = db.transaction((id: string) => {
    const released = releaseSessionStmt.get(now(), id) as { owner: unknown } | null;
    // Idempotent semantic: a release with no active lease changes nothing and writes no event.
    if (released) saveEvent("session", { sessionId: id, owner: String(released.owner), action: "released" });
  });

  const parseRefs = (raw: string): string[] => {
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.map(String) : []; }
    catch { return []; }
  };
  const parseEvidenceIds = (raw: string): number[] => {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "number").map((v) => Number(v)) : [];
    } catch { return []; }
  };
  const limit = (value: number | undefined): number => Math.max(1, Math.min(50, Math.floor(value ?? 50)));

  return {
    path,
    appendEvent(kind, payload): number {
      return saveEvent(kind, payload);
    },
    addEvidence(input): { id: number; hash: string } {
      const kind = checkedId(input.kind, "Evidence kind", 64);
      const text = checkedText(input.text, "Evidence text", MAX_TEXT_CHARS);
      const refs = checkedRefList(input.refs, "Evidence refs");
      const sensitivity = assertEnum(input.sensitivity, SENSITIVITIES, "Evidence sensitivity");
      const hash = sha256(text);
      const inserted = insertEvidence.get(now(), kind, JSON.stringify(refs), text, sensitivity, hash) as { id: unknown };
      return { id: Number(inserted.id), hash };
    },
    addFinding(init): { id: number } {
      const state = assertEnum(init.state ?? "candidate", FINDING_STATES, "Finding state");
      const title = checkedText(init.title, "Finding title", 2000);
      const impact = checkedText(init.impact, "Finding impact", MAX_IMPACT_CHARS);
      if (!Array.isArray(init.evidenceIds) || init.evidenceIds.length > MAX_FINDING_EVIDENCE) {
        throw new Error(`Finding evidence_ids accepts at most ${MAX_FINDING_EVIDENCE} numeric rows.`);
      }
      if (init.evidenceIds.some((id) => !Number.isSafeInteger(id))) throw new Error("Finding evidence_ids must be safe integers.");
      if (init.confidence !== undefined && (typeof init.confidence !== "number" || !Number.isFinite(init.confidence) || init.confidence < 0 || init.confidence > 1)) {
        throw new Error("Finding confidence must be a finite number between 0 and 1.");
      }
      const confidence = init.confidence ?? 0.5;
      const inserted = insertFinding.get(state, title, JSON.stringify(init.evidenceIds), impact, confidence, now()) as { id: unknown };
      return { id: Number(inserted.id) };
    },
    addJob(row): number {
      const jobId = checkedId(row.jobId, "Job id", 200);
      const adapter = checkedId(row.adapter, "Job adapter", 64);
      const argv = checkedRefList(row.argv, "Job argv", 256);
      const state = assertEnum(row.state, JOB_STATES, "Job state");
      const artifactPath = row.artifactPath === undefined || row.artifactPath === null ? null : checkedId(row.artifactPath, "Job artifact path", 1000);
      const startedAt = normalizeStartedAt(row.startedAt, state);
      const inserted = insertJob.get(jobId, adapter, JSON.stringify(argv), state, startedAt, artifactPath) as { id: unknown };
      saveEvent("job", { jobId, state, event: state }); // event label matches the actual insert state, never "queued" on a running insert
      return Number(inserted.id);
    },
    updateJobState(jobId, state): void {
      assertEnum(state, JOB_STATES, "Job state");
      updateJobTx(jobId, state);
    },
    addSession(row): void {
      const sessionId = checkedId(row.sessionId, "Session id", 500);
      const owner = checkedId(row.owner, "Session owner", 500);
      const mode = checkedId(row.mode, "Session mode", 64);
      const purpose = checkedText(row.purpose, "Session purpose", 2000);
      const active = selectActiveSession.get(sessionId) as { owner: string } | null;
      if (active) throw new Error(`Browser session ${sessionId} already has an active lease held by ${active.owner}. Release it first.`);
      insertSession.run(sessionId, owner, mode, purpose, now());
    },
    releaseSession(sessionId): void {
      const id = checkedId(sessionId, "Session id", 500);
      releaseSessionTx(id);
    },
    listSessions(opts): SessionRow[] {
      const rows = (opts?.activeOnly
        ? selectActiveSessions.all(limit(opts?.limit))
        : selectSessionsAll.all(limit(opts?.limit))) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: Number(row.id), sessionId: String(row.sessionId), owner: String(row.owner),
        mode: String(row.mode), purpose: String(row.purpose),
        acquiredAt: String(row.acquired_at), releasedAt: (row.released_at as string | null) ?? null,
      }));
    },
    listEvidence(opts): EvidenceRow[] {
      const rows = (opts?.kind
        ? selectEvidenceByKind.all(checkedId(opts.kind, "Evidence kind", 64), limit(opts?.limit))
        : selectEvidenceAll.all(limit(opts?.limit))) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: Number(row.id), ts: String(row.ts), kind: String(row.kind),
        refs: parseRefs(String(row.refs)), text: String(row.text),
        sensitivity: row.sensitivity as Sensitivity, hash: String(row.hash),
      }));
    },
    listFindings(opts): FindingRow[] {
      const rows = (opts?.state
        ? selectFindingsByState.all(opts.state, limit(opts?.limit))
        : selectFindingsAll.all(limit(opts?.limit))) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: Number(row.id), state: row.state as FindingState, title: String(row.title),
        evidenceIds: parseEvidenceIds(String(row.evidence_ids)), impact: String(row.impact),
        confidence: Number(row.confidence), createdAt: String(row.created_at),
      }));
    },
    listJobs(opts): JobRow[] {
      const rows = selectJobsAll.all(limit(opts?.limit)) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: Number(row.id), jobId: String(row.jobId), adapter: String(row.adapter),
        argv: parseRefs(String(row.argv)), state: row.state as JobState,
        startedAt: (row.started_at as string | null) ?? null,
        endedAt: (row.ended_at as string | null) ?? null,
        artifactPath: (row.artifact_path as string | null) ?? null,
      }));
    },
    briefSummary(mode): string {
      const active = countOf(() => counts.sessionsActive.get());
      const line = `EVIDENCE${mode ? ` · mode ${mode}` : ""} · events ${countOf(() => counts.events.get())} · evidence ${countOf(() => counts.evidence.get())} · findings ${countOf(() => counts.findings.get())} · jobs ${countOf(() => counts.jobs.get())} · sessions ${countOf(() => counts.sessions.get())} (${active} active)`;
      const recent = (selectRecentEvents.all() as Array<Record<string, unknown>>)
        .map((row) => `#${row.id} ${row.ts} ${row.kind}`).join(" | ");
      return recent ? `${line}\nRecent: ${recent}` : line;
    },
    recordCount(): number {
      return countOf(() => totalRows.get());
    },
    close(): void {
      db.close();
    },
  };
}

export function openEvidence(path?: string): EvidenceStore {
  const file = path ?? resolveEvidencePath(process.env);
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  return createStore(openDatabase(file), file);
}

/** Fixed rendering of the context hint line — isolated for direct testing. */
export function formatEvidenceLine(rows: number, path: string): string {
  return `Evidence: ${rows} records at ${path}`;
}

/**
 * Lazily compute the guarded context line for the default evidence path.
 * Returns null on any failure or an absent database — never throws, never
 * exposes stored contents.
 */
export function contextLine(env: EvidenceEnv = process.env): string | null {
  try {
    const path = resolveEvidencePath(env);
    if (!existsSync(path)) return null;
    const store = openEvidence(path);
    try { return formatEvidenceLine(store.recordCount(), path); }
    finally { store.close(); }
  } catch {
    return null;
  }
}
