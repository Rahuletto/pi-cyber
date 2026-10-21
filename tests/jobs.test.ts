/**
 * Task-6 job runner tests — fully modelless: no network, no real scanners.
 * Stub "bin" scripts (bun, marked +x) for subfinder and nuclei are placed on
 * PATH ahead of the real system PATH; they emit the stored Task-5 fixtures.
 *
 * Covers (per the Task-6 contract):
 * - happy path: job row created → transitions → succeeded, Normalized rows in
 *   evidence, typed `job` events appended (references only, no raw output);
 * - unknown tool typed error listing available adapter names;
 * - typebox validation failure message verbatim;
 * - buildArgs guard error verbatim (flag-prefix guard);
 * - missing required param message from buildArgs;
 * - secret-tainted argv refusal (canonical message, nothing persisted);
 * - timeout kill → interrupted/outcome-unknown with annotated events;
 * - non-zero exit → failed with clipped stderr, never persisted raw;
 * - output caps (512 KiB stdout capture) and loud truncation flags;
 * - bounded argv recording for long scans;
 * - strict serialization of runs (the documented "no parallel exec" stance);
 * - `cyber_jobs` tool end-to-end through the store's default path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, UnknownAdapterError, runJob } from "../src/jobs/runner.ts";
import { openEvidence } from "../src/evidence/db.ts";
import { SECRET_REFUSAL_MESSAGE } from "../src/evidence/secrets.ts";
import { registerCyberJobsTool, renderAdapters } from "../src/tools/jobs.ts";

const STUB_BIN = join(import.meta.dir, "fixtures", "jobs", "bin");
const directories: string[] = [];
const originalPath = process.env.PATH;

beforeAll(() => {
  process.env.PATH = `${STUB_BIN}:${process.env.PATH ?? ""}`;
});
afterAll(() => {
  process.env.PATH = originalPath;
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "jobs-test-"));
  directories.push(dir);
  return dir;
}

interface EventRecord { kind: string; payload_json: string }
function readEvents(path: string): EventRecord[] {
  const db = new Database(path, { readonly: true });
  try {
    return db.query("SELECT kind, payload_json FROM events ORDER BY id").all() as EventRecord[];
  } finally { db.close(); }
}

function jobEvents(path: string): EventRecord[] {
  return readEvents(path).filter((event) => event.kind === "job");
}

describe("job runner essentials", () => {
  test("timeout bounds are the documented 120 s default and 600 s ceiling", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(MAX_TIMEOUT_MS).toBe(600_000);
  });

  test("unknown tool fails immediately with a typed error naming the registry", async () => {
    const store = openEvidence(":memory:");
    try {
      await expect(runJob({ tool: "evil-tool", params: {} }, { evidenceDb: store }))
        .rejects.toThrowError(UnknownAdapterError);
      await expect(runJob({ tool: "evil-tool", params: {} }, { evidenceDb: store }))
        .rejects.toThrow("unknown job tool \"evil-tool\". Available adapters: subfinder, httpx, dnsx, katana, ffuf, naabu, nuclei, uncover, vulnx, interactsh, semgrep.");
      expect(store.listJobs()).toEqual([]); // nothing stored for bogus runs
    } finally { store.close(); }
  });

  test("typebox validation failure surfaces the offending path verbatim and persists nothing", async () => {
    const store = openEvidence(":memory:");
    try {
      await expect(runJob({ tool: "subfinder", params: { domain: "" } }, { evidenceDb: store }))
        .rejects.toThrow("params for subfinder rejected by schema at /domain (minLength): must not have fewer than 1 characters");
      expect(store.listJobs()).toEqual([]);
      expect(store.recordCount()).toBe(0);
    } finally { store.close(); }
  });

  test("typebox rejects unknown keys with an additionalProperties error naming them", async () => {
    const store = openEvidence(":memory:");
    try {
      await expect(runJob({ tool: "subfinder", params: { domain: "example.com", flag: "-l" } }, { evidenceDb: store }))
        .rejects.toThrow(/rejected by schema at unknown key flag \(additionalProperties\)/);
    } finally { store.close(); }
  });

  test("buildArgs flag-prefix guard error surfaces verbatim", async () => {
    const store = openEvidence(":memory:");
    try {
      await expect(runJob({ tool: "subfinder", params: { domain: "-l/etc-passwd" } }, { evidenceDb: store }))
        .rejects.toThrow('field-param "domain" must not start with "-"');
      expect(store.listJobs()).toEqual([]);
      expect(store.recordCount()).toBe(0); // guards fire before any DB write
    } finally { store.close(); }
  });

  test("missing required param surfaces the buildArgs message verbatim", async () => {
    const store = openEvidence(":memory:");
    try {
      // targets: [] passes typebox (no minItems) and trips requireModelList.
      await expect(runJob({ tool: "nuclei", params: { targets: [] } }, { evidenceDb: store }))
        .rejects.toThrow('nuclei: missing required param "targets"');
      expect(store.listJobs()).toEqual([]);
    } finally { store.close(); }
  });

  test("secret-tainted argv refuses with the canonical message before spawn", async () => {
    const store = openEvidence(":memory:");
    try {
      await expect(runJob({ tool: "subfinder", params: { domain: "api_key=leakysecretvalue" } }, { evidenceDb: store }))
        .rejects.toThrow(SECRET_REFUSAL_MESSAGE);
      // Nothing persisted and the stub never received that value.
      expect(store.listJobs()).toEqual([]);
      expect(store.recordCount()).toBe(0);
    } finally { store.close(); }
  });
});

describe("job runner happy path (file-backed events)", () => {
  test("subfinder run: transitions → succeeded, evidence rows, typed job events without raw output", async () => {
    const store = openEvidence(join(tempDir(), "happy", "cyber.sqlite"));
    try {
      const result = await runJob({ tool: "subfinder", params: { domain: "fixture.local" } }, { evidenceDb: store });
      expect(result.state).toBe("succeeded");
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.parsedRows).toBe(1);
      expect(result.byKind).toEqual({ subfinder: 1 });

      const jobs = store.listJobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe(result.jobId);
      expect(jobs[0].adapter).toBe("subfinder");
      expect(jobs[0].state).toBe("succeeded");
      expect(jobs[0].argv).toEqual(["subfinder", "-json", "-d", "fixture.local"]);
      expect(jobs[0].startedAt).toBeTruthy();
      expect(jobs[0].endedAt).toBeTruthy();

      const rows = store.listEvidence({ kind: "jsonl" });
      expect(rows).toHaveLength(1);
      expect(rows[0].refs).toEqual([result.jobId, "api.example.com"]);
      expect(rows[0].text).toContain("api.example.com"); // raw fixture line kept as evidence text
      expect(rows[0].sensitivity).toBe("internal");

      const events = jobEvents(store.path);
      expect(events.every((event) => event.kind === "job")).toBe(true);
      expect(events.map((event) => JSON.parse(event.payload_json).event)).toEqual(["queued", undefined, "summary"]);
      expect(JSON.parse(events[1].payload_json).state).toBe("succeeded");
      // No raw output in events: the result host never leaks into the audit trail.
      expect(events.every((event) => !event.payload_json.includes("api.example.com"))).toBe(true);
      const summary = JSON.parse(events[events.length - 1].payload_json);
      expect(summary.rows).toBe(1);
      expect(summary.byKind).toEqual({ subfinder: 1 });
      expect(summary.evidenceIds).toEqual([rows[0].id]);
    } finally { store.close(); }
  });
});

describe("outcome mapping for non-zero exits and kills", () => {
  test("non-zero exit → failed with clipped stderr in the result but not in the audit trail", async () => {
    const store = openEvidence(join(tempDir(), "failed", "cyber.sqlite"));
    try {
      const result = await runJob(
        { tool: "nuclei", params: { targets: ["fixture.local"], extra: ["--exit-fail"] } },
        { evidenceDb: store },
      );
      expect(result.state).toBe("failed");
      expect(result.exitCode).toBe(1);
      expect(result.parsedRows).toBe(0);
      expect(result.stderr).toContain("boom");
      expect(store.listEvidence()).toEqual([]);
      // Failed event carries counters only — never the raw stderr text.
      expect(jobEvents(store.path).every((event) => !event.payload_json.includes("boom"))).toBe(true);
    } finally { store.close(); }
  });

  test("timeout kill with parsable partial output → interrupted + outcome-unknown annotated event", async () => {
    const store = openEvidence(join(tempDir(), "interrupted", "cyber.sqlite"));
    try {
      const result = await runJob(
        {
          tool: "nuclei",
          params: { targets: ["fixture.local"], extra: ["--linger"] },
        },
        { evidenceDb: store, timeoutMs: 600 },
      );
      expect(result.timedOut).toBe(true);
      expect(result.state).toBe("interrupted");
      expect(result.parsedRows).toBeGreaterThanOrEqual(1);
      expect(result.evidenceIds.length).toBe(result.parsedRows);
      const annotated = jobEvents(store.path)
        .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>)
        .find((payload) => payload.event === "outcome-unknown");
      expect(annotated).toMatchObject({ reason: "killed at timeout", state: "interrupted", partialEvidenceRows: result.parsedRows });
      expect(store.listJobs()[0].state).toBe("interrupted");
    } finally { store.close(); }
  });

  test("timeout kill with no usable output → outcome-unknown, no rows persisted", async () => {
    const store = openEvidence(":memory:");
    try {
      const result = await runJob(
        {
          tool: "nuclei",
          params: { targets: ["fixture.local"], extra: ["--silent-linger"] },
        },
        { evidenceDb: store, timeoutMs: 600 },
      );
      expect(result.timedOut).toBe(true);
      expect(result.state).toBe("outcome-unknown");
      expect(result.parsedRows).toBe(0);
      expect(store.listEvidence()).toEqual([]);
      expect(store.listJobs()[0].state).toBe("outcome-unknown");
    } finally { store.close(); }
  });
});

describe("capture caps and argv recording", () => {
  test("oversize stdout caps at the byte budget with loud truncation flags; rows still parse", async () => {
    const store = openEvidence(":memory:");
    try {
      const result = await runJob(
        { tool: "nuclei", params: { targets: ["fixture.local"], extra: ["--flood"] } },
        { evidenceDb: store },
      );
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdoutBytes).toBeGreaterThan(0);
      expect(result.stdoutBytes).toBeLessThanOrEqual(512 * 1024);
      expect(result.stderrTruncated).toBe(false);
      expect(result.state).toBe("succeeded");
      expect(result.parsedRows).toBeGreaterThan(1000);
      expect(result.evidenceIds.length).toBe(result.parsedRows);
      // listEvidence is count-capped at 50; total durability check via recordCount()
      // (evidence rows + 3 job events + 1 job row).
      expect(store.recordCount()).toBe(result.parsedRows + 4);
      expect(store.listEvidence({ kind: "jsonl" })).toHaveLength(50);
      // Evidence text stays inside the store's caps (≤ 4000 chars per raw row).
      for (const row of store.listEvidence({ kind: "jsonl", limit: 50 })) {
        expect(row.text.length).toBeLessThanOrEqual(4000);
      }
    } finally { store.close(); }
  });

  test("long scans record a bounded argv head plus a marker instead of failing", async () => {
    const store = openEvidence(":memory:");
    try {
      const targets = Array.from({ length: 256 }, (_, index) => `fixture-${index}.local`);
      const result = await runJob({ tool: "nuclei", params: { targets } }, { evidenceDb: store });
      expect(result.state).toBe("succeeded");
      expect(result.argv.length).toBe(514); // bin + 256 × ("-u", target) + "-json"
      const row = store.listJobs()[0];
      expect(row.argv.length).toBe(251); // 250 head entries + 1 marker
      expect(row.argv.at(-1)).toContain("not recorded");
    } finally { store.close(); }
  });
});

describe("serialization (no parallel execution)", () => {
  test("a queued run starts only after the previous run ends", async () => {
    const store = openEvidence(join(tempDir(), "serial", "cyber.sqlite"));
    try {
      const slow = runJob(
        { tool: "nuclei", params: { targets: ["fixture.local"], extra: ["--linger"] } },
        { evidenceDb: store, timeoutMs: 600 },
      );
      const quick = runJob({ tool: "subfinder", params: { domain: "fixture-serial.local" } }, { evidenceDb: store });
      const [slowResult, quickResult] = await Promise.all([slow, quick]);
      expect(slowResult.state).toBe("interrupted");
      expect(quickResult.state).toBe("succeeded");
      const slowRow = store.listJobs().find((row) => row.jobId === slowResult.jobId)!;
      const quickRow = store.listJobs().find((row) => row.jobId === quickResult.jobId)!;
      const slowEnd = new Date(slowRow.endedAt ?? "").getTime();
      const quickStart = new Date(quickRow.startedAt ?? "").getTime();
      expect(quickStart).toBeGreaterThanOrEqual(slowEnd - 5); // no overlap beyond clock granularity
    } finally { store.close(); }
  });
});

describe("cyber_jobs tool", () => {
  type ToolDef = {
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionToolContext,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>;
  };
  function loadTool(): ToolDef {
    const registered: unknown[] = [];
    registerCyberJobsTool({ registerTool: (tool) => registered.push(tool) });
    if (registered.length !== 1) throw new Error("cyber_jobs tool did not register");
    return registered[0] as ToolDef;
  }
  const ctx = {} as ExtensionToolContext;
  const call = (tool: ToolDef, params: Record<string, unknown>) =>
    tool.execute("fixture", params, undefined, undefined, ctx);

  test("tool registers through the pi surface and the list action summarizes every adapter schema", async () => {
    const tool = loadTool();
    const result = await call(tool, { action: "list" });
    const text = result.content[0].text ?? "";
    expect(text).toContain("subfinder (bin subfinder · jsonl · non-mutating): domain:string[len<=253]*");
    expect(text).toContain("sources:string[][n<=12]");
    expect(text).toContain("severity:enum[][n<=5]");
    expect(text).toContain("nuclei (bin nuclei · jsonl · non-mutating): targets:string[][n<=256]*");
    expect(text).toContain("semgrep (bin semgrep · sarif");
    expect(result.details).toEqual({ action: "list", adapters: expect.any(Array) });
  });

  test("run action end-to-end: default store path honored, evidence refs returned, no raw dumps", async () => {
    const dir = tempDir();
    const previous = process.env.CYBER_EVIDENCE_DIR;
    process.env.CYBER_EVIDENCE_DIR = join(dir, "evidence");
    try {
      const tool = loadTool();
      const result = await call(tool, { action: "run", tool: "subfinder", params: { domain: "fixture-e2e.local" } });
      expect(result.details).toMatchObject({ action: "run", state: "succeeded", exitCode: 0 });
      const text = result.content[0].text ?? "";
      expect(text).toContain("state=succeeded");
      expect(text).toContain("evidence refs:");
      // Raw output never re-enters the model context; only references.
      expect(text.includes("api.example.com")).toBe(false);
      // Default openEvidence() honored the environment: DB file lives at <dir>/default/cyber.sqlite.
      const storePath = join(dir, "evidence", "default", "cyber.sqlite");
      expect(existsSync(storePath)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CYBER_EVIDENCE_DIR;
      else process.env.CYBER_EVIDENCE_DIR = previous;
    }
  });

  test("status action: unknown id throws typed error; recent rows render states", async () => {
    const dir = tempDir();
    const previous = process.env.CYBER_EVIDENCE_DIR;
    process.env.CYBER_EVIDENCE_DIR = join(dir, "evidence");
    try {
      const tool = loadTool();
      const runResult = await call(tool, { action: "run", tool: "subfinder", params: { domain: "fixture-status.local" } });
      const jobId = runResult.details.jobId as string;
      expect(jobId).toBeTruthy();

      const byId = await call(tool, { action: "status", jobId });
      const idText = byId.content[0].text ?? "";
      expect(idText).toContain(`${jobId} · subfinder · state=succeeded`);

      const recent = await call(tool, { action: "status" });
      const recentText = recent.content[0].text ?? "";
      expect(recentText).toContain("state=succeeded");
      expect(recentText).toContain(jobId);

      await expect(call(tool, { action: "status", jobId: "subfinder-never-was" }))
        .rejects.toThrow('unknown job id "subfinder-never-was"');

      const empty = openEvidence(join(dir, "fresh", "cyber.sqlite"));
      try { expect(empty.listJobs()).toEqual([]); } finally { empty.close(); }
    } finally {
      if (previous === undefined) delete process.env.CYBER_EVIDENCE_DIR;
      else process.env.CYBER_EVIDENCE_DIR = previous;
    }
  });

  test("run action guard: missing tool and missing params produce actionable errors", async () => {
    const tool = loadTool();
    await expect(call(tool, { action: "run", params: {} }))
      .rejects.toThrow("tool required for the run action (see the list action for names).");
    await expect(call(tool, { action: "run", tool: "subfinder" }))
      .rejects.toThrow('params required for the run action (tool subfinder).');
  });
});
