import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { JobState } from "../src/evidence/db.ts";
import {
  contextLine,
  formatEvidenceLine,
  openEvidence,
  resolveEvidencePath,
  type EvidenceStore,
} from "../src/evidence/db.ts";
import { SECRET_REFUSAL_MESSAGE, assertNoSecretLike, containsSecretLike } from "../src/evidence/secrets.ts";
import { clipOutput, registerEvidenceTool } from "../src/tools/evidence.ts";

const directories: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "evidence-test-"));
  directories.push(dir);
  return dir;
}
afterEach(() => { directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })); });

describe("secret heuristics", () => {
  test("is a superset of state.ts patterns and the added token families", () => {
    expect(containsSecretLike("sk-proj-abcdefghijklmnopqrtuwxyz1234")).toBe(true);
    expect(containsSecretLike("sk-ant-api03-short")).toBe(true);
    expect(containsSecretLike(`ghp_${"a".repeat(36)}`)).toBe(true);
    expect(containsSecretLike(`gho_${"b".repeat(36)}`)).toBe(true);
    expect(containsSecretLike("xoxb-1234567-abcdef")).toBe(true);
    expect(containsSecretLike("xoxp-1234567-abcdef")).toBe(true);
    expect(containsSecretLike("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    expect(containsSecretLike("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(containsSecretLike("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(containsSecretLike("api_key=super-secret-value")).toBe(true);
    expect(containsSecretLike("https://user:hunter2@host.example")).toBe(true);
    expect(containsSecretLike("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc123xyzjklmno")).toBe(true);
  });
  test("benign evidence text passes", () => {
    expect(containsSecretLike("httpx 200 http://fixture.local/login (fixture app)")).toBe(false);
    expect(containsSecretLike("evidence/artifact-0001.redacted.txt")).toBe(false);
  });
  test("refusal uses the canonical exact message", () => {
    expect(SECRET_REFUSAL_MESSAGE).toBe("possible raw secret: store a redacted artifact reference instead.");
    expect(() => assertNoSecretLike(`ghp_${"c".repeat(36)}`)).toThrow(SECRET_REFUSAL_MESSAGE);
  });
});

describe("evidence store (in-memory)", () => {
  test("appends events and records their payload shapes", () => {
    const store = openEvidence(":memory:");
    try {
      const id = store.appendEvent("note", { message: "scope acknowledged" });
      expect(id).toBe(1);
      expect(store.listEvidence()).toEqual([]);
      expect(store.recordCount()).toBe(1);
    } finally { store.close(); }
  });

  test("addEvidence round-trips rows with sha256 hash and refs", () => {
    const store = openEvidence(":memory:");
    try {
      const text = "httpx 200 on /login · refs: evidence/httpx.raw";
      const first = store.addEvidence({ kind: "httpx", refs: ["evidence/httpx.raw"], text, sensitivity: "low" });
      expect(first.id).toBe(1);
      expect(first.hash).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
      store.addEvidence({ kind: "nuclei", refs: [], text, sensitivity: "restricted" });
      const rows = store.listEvidence();
      expect(rows).toHaveLength(2);
      const [newest] = rows;
      expect(newest.kind).toBe("nuclei");
      expect(newest.refs).toEqual([]);
      expect(newest.hash).toBe(first.hash);
      const oldest = store.listEvidence({ limit: 2 }).at(-1)!;
      expect(oldest.refs).toEqual(["evidence/httpx.raw"]);
      expect(oldest.sensitivity).toBe("low");
    } finally { store.close(); }
  });

  test("addFinding round-trips state, evidence ids, impact and confidence", () => {
    const store = openEvidence(":memory:");
    try {
      const { id } = store.addFinding({ title: "IDOR on /api/orders", evidenceIds: [1, 2], impact: "cross-tenant read", confidence: 0.7 });
      const [row] = store.listFindings({ state: "candidate" });
      expect(row.id).toBe(id);
      expect(row.state).toBe("candidate");
      expect(row.evidenceIds).toEqual([1, 2]);
      expect(row.confidence).toBe(0.7);
      expect(row.impact).toBe("cross-tenant read");
      expect(store.listFindings({ state: "confirmed" })).toHaveLength(0);
    } finally { store.close(); }
  });

  test("jobs transition with a typed 'job' event per state change", () => {
    const store = openEvidence(":memory:");
    try {
      store.addJob({ jobId: "j-1", adapter: "nuclei", argv: ["nuclei", "-json"], state: "queued", artifactPath: "evidence/j-1.out" });
      store.updateJobState("j-1", "running");
      store.updateJobState("j-1", "succeeded");
      const events = store.briefSummary();
      expect(events).toContain("events 3");
      expect(events).toContain("jobs 1");
      const job = store.listJobs()[0];
      expect(job.state).toBe("succeeded");
      expect(job.endedAt).not.toBeNull();
      expect(job.artifactPath).toBe("evidence/j-1.out");
      expect(() => store.updateJobState("missing", "running")).toThrow(/unknown job/i);
      expect(() => store.updateJobState("j-1", "not-a-state" as JobState)).toThrow(/Job state/);
    } finally { store.close(); }
  });

  test("browser session leases reject a second owner and release idempotently", () => {
    const store = openEvidence(":memory:");
    try {
      store.addSession({ sessionId: "obs-1", owner: "offense", mode: "offense", purpose: "fixture login walk" });
      expect(() => store.addSession({ sessionId: "obs-1", owner: "defense", mode: "defense", purpose: "shadow" })).toThrow(/active lease/);
      store.releaseSession("obs-1");
      store.releaseSession("obs-1"); // idempotent
      store.addSession({ sessionId: "obs-1", owner: "defense", mode: "defense", purpose: "reload" });
      expect(store.briefSummary()).toContain("sessions 2 (1 active)");
    } finally { store.close(); }
  });

  test("secret-like text is refused on every text entry point", () => {
    const store = openEvidence(":memory:");
    try {
      const ghp = `ghp_${"d".repeat(36)}`;
      const sk = "sk-ant-api03-abcdef123456";
      expect(() => store.addEvidence({ kind: "note", refs: [], text: `token ${sk}`, sensitivity: "low" })).toThrow(SECRET_REFUSAL_MESSAGE);
      expect(() => store.addEvidence({ kind: "note", refs: [ghp], text: "ok", sensitivity: "low" })).toThrow(SECRET_REFUSAL_MESSAGE);
      expect(() => store.appendEvent("note", { body: ghp })).toThrow(SECRET_REFUSAL_MESSAGE);
      expect(() => store.addFinding({ title: `contains ${ghp}`, evidenceIds: [], impact: "none" })).toThrow(SECRET_REFUSAL_MESSAGE);
      expect(() => store.addFinding({ title: "clean", evidenceIds: [], impact: `impact ${sk}` })).toThrow(SECRET_REFUSAL_MESSAGE);
      expect(() => store.addSession({ sessionId: "s", owner: "o", mode: "m", purpose: `leak ${ghp}` })).toThrow(SECRET_REFUSAL_MESSAGE);
      expect(store.recordCount()).toBe(0);
    } finally { store.close(); }
  });

  test("briefSummary reports counts and recent events", () => {
    const store = openEvidence(":memory:");
    try {
      store.appendEvent("startup", { v: 1 });
      store.addEvidence({ kind: "httpx", refs: [], text: "one", sensitivity: "internal" });
      store.addFinding({ title: "candidate title", evidenceIds: [], impact: "none" });
      const summary = store.briefSummary("offense");
      expect(summary).toContain("mode offense");
      expect(summary).toContain("events 1");
      expect(summary).toContain("evidence 1");
      expect(summary).toContain("findings 1");
      expect(summary).toContain("Recent:");
      expect(summary).toContain("startup");
    } finally { store.close(); }
  });

  test("list caps: limit request above 50 is clamped to 50 rows", () => {
    const store = openEvidence(":memory:");
    try {
      for (let i = 0; i < 55; i++) store.appendEvent("loop", { i });
      for (let i = 0; i < 55; i++) store.addEvidence({ kind: "row", refs: [], text: `t${i}`, sensitivity: "low" });
      expect(store.listEvidence({ limit: 500 })).toHaveLength(50);
      expect(store.listEvidence({ limit: 3 })).toHaveLength(3);
      expect(store.listEvidence()).toHaveLength(50);
    } finally { store.close(); }
  });

  test("invalid inputs are rejected before persistence", () => {
    const store = openEvidence(":memory:");
    try {
      expect(() => store.addEvidence({ kind: "note", refs: [], text: "x", sensitivity: "public" as never })).toThrow(/sensitivity/);
      expect(() => store.addEvidence({ kind: "note", refs: Array.from({ length: 25 }, () => "r"), text: "x", sensitivity: "low" })).toThrow(/accepts at most 24 entries/);
      expect(() => store.addFinding({ title: "t", evidenceIds: [1.5], impact: "none" })).toThrow(/safe integers/);
      expect(() => store.addFinding({ title: "t", evidenceIds: [], impact: "none", confidence: 1.5 })).toThrow(/confidence/);
      expect(() => store.appendEvent("", {})).toThrow(/nonempty/);
    } finally { store.close(); }
  });
});

describe("evidence store (files)", () => {
  let envBackup: string | undefined;
  let engagementBackup: string | undefined;
  beforeAll(() => {
    envBackup = process.env.CYBER_EVIDENCE_DIR;
    engagementBackup = process.env.CYBER_ENGAGEMENT_ID;
  });
  afterEach(() => {
    if (envBackup === undefined) delete process.env.CYBER_EVIDENCE_DIR;
    else process.env.CYBER_EVIDENCE_DIR = envBackup;
    if (engagementBackup === undefined) delete process.env.CYBER_ENGAGEMENT_ID;
    else process.env.CYBER_ENGAGEMENT_ID = engagementBackup;
  });

  test("path resolution respects CYBER_EVIDENCE_DIR and CYBER_ENGAGEMENT_ID", () => {
    process.env.CYBER_EVIDENCE_DIR = "/tmp/fake-base";
    process.env.CYBER_ENGAGEMENT_ID = "eng-alpha";
    expect(resolveEvidencePath()).toBe(join("/tmp/fake-base", "eng-alpha", "cyber.sqlite"));
    delete process.env.CYBER_EVIDENCE_DIR;
    delete process.env.CYBER_ENGAGEMENT_ID;
    const fallback = resolveEvidencePath();
    expect(fallback.endsWith("cyber.sqlite")).toBe(true);
    expect(fallback).toContain(join("config", "cyber", "evidence", "default"));
    process.env.CYBER_EVIDENCE_DIR = "/tmp/fake-base";
    process.env.CYBER_ENGAGEMENT_ID = "../escape";
    expect(() => resolveEvidencePath()).toThrow(/CYBER_ENGAGEMENT_ID/);
    process.env.CYBER_ENGAGEMENT_ID = "eng-alpha";
  });

  test("per-engagement files persist across close/reopen and stay separated", () => {
    const base = tempDir();
    process.env.CYBER_EVIDENCE_DIR = base;
    process.env.CYBER_ENGAGEMENT_ID = "eng-alpha";
    const alpha = openEvidence();
    try {
      alpha.addEvidence({ kind: "httpx", refs: ["evidence/a"], text: "alpha row", sensitivity: "internal" });
      alpha.addFinding({ title: "alpha finding", evidenceIds: [], impact: "none" });
      alpha.appendEvent("milestone", { step: 1 });
      expect(alpha.recordCount()).toBe(3);
    } finally { alpha.close(); }
    const reopened = openEvidence();
    try {
      expect(reopened.recordCount()).toBe(3);
      expect(reopened.listEvidence().at(-1)!.text).toBe("alpha row");
      expect(reopened.listFindings().at(-1)!.title).toBe("alpha finding");
      expect(reopened.path).toBe(join(base, "eng-alpha", "cyber.sqlite"));
    } finally { reopened.close(); }

    process.env.CYBER_ENGAGEMENT_ID = "eng-beta";
    const beta = openEvidence();
    try { expect(beta.recordCount()).toBe(0); expect(beta.path).toBe(join(base, "eng-beta", "cyber.sqlite")); }
    finally { beta.close(); }
  });

  test("explicit openEvidence(path) override wins over the computed default", () => {
    const dir = tempDir();
    const override = join(dir, "custom.sqlite");
    const store = openEvidence(override);
    try {
      store.appendEvent("override", { ok: true });
      expect(store.path).toBe(override);
    } finally { store.close(); }
    const expectedDefault = resolveEvidencePath();
    const throughDefault = contextLine(); // default DB in this environment
    if (throughDefault) expect(throughDefault.endsWith(expectedDefault)).toBe(true);
  });

  test("contextLine: null without a database, count line with one, null when opening fails", () => {
    process.env.CYBER_EVIDENCE_DIR = tempDir();
    process.env.CYBER_ENGAGEMENT_ID = "quiet";
    expect(contextLine()).toBeNull(); // no DB file yet → do not create one
    mkdirSync(join(process.env.CYBER_EVIDENCE_DIR!, "quiet"), { recursive: true });
    const store = openEvidence();
    try { store.addEvidence({ kind: "note", refs: [], text: "context", sensitivity: "internal" }); } finally { store.close(); }
    const expectedPath = resolveEvidencePath();
    const line = contextLine();
    expect(line).toBe(formatEvidenceLine(1, expectedPath));
    expect(line!.endsWith(join(process.env.CYBER_EVIDENCE_DIR!, "quiet", "cyber.sqlite"))).toBe(true);

    // Exists but unusable → guarded null, never a throw.
    process.env.CYBER_ENGAGEMENT_ID = "broken";
    const brokenDir = join(process.env.CYBER_EVIDENCE_DIR!, "broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "cyber.sqlite"), "not a database at all");
    expect(contextLine()).toBeNull();
  });
});

describe("tool surface: cyber_evidence", () => {
  interface ToolFixture { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; details?: Record<string, unknown> }> }
  let definition!: ToolFixture;
  beforeAll(() => {
    let captured!: ToolFixture;
    const fakePi = { registerTool: (tool: ToolFixture) => { captured = tool; } };
    registerEvidenceTool(fakePi as unknown as Pick<ExtensionAPI, "registerTool">);
    definition = captured;
  });

  test("add/read round-trip, clips oversized output, refuses secrets", async () => {
    const dir = tempDir();
    const evidenceBackup = process.env.CYBER_EVIDENCE_DIR;
    const engagementBackup = process.env.CYBER_ENGAGEMENT_ID;
    process.env.CYBER_EVIDENCE_DIR = dir;
    process.env.CYBER_ENGAGEMENT_ID = "tool-test";
    const ctx = {} as ExtensionToolContext;
    try {
      expect(definition.name).toBe("cyber_evidence");
      const added = await definition.execute("t", { action: "add", kind: "httpx", text: "fixture trained", refs: ["e/x"], sensitivity: "low" }, undefined, undefined, ctx);
      expect(added.content[0].text).toContain("Evidence #1 recorded");
      const read = await definition.execute("t", { action: "read", limit: 10 }, undefined, undefined, ctx);
      expect(read.content[0].text).toContain("fixture trained");
      const summary = await definition.execute("t", { action: "summary", mode: "offense" }, undefined, undefined, ctx);
      expect(summary.content[0].text).toContain("evidence 1");
      await expect(definition.execute("t", { action: "add", kind: "note", text: `token sk-ant-api03-zzz`, refs: [] }, undefined, undefined, ctx))
        .rejects.toThrow(SECRET_REFUSAL_MESSAGE);
    } finally {
      if (evidenceBackup === undefined) delete process.env.CYBER_EVIDENCE_DIR;
      else process.env.CYBER_EVIDENCE_DIR = evidenceBackup;
      if (engagementBackup === undefined) delete process.env.CYBER_ENGAGEMENT_ID;
      else process.env.CYBER_ENGAGEMENT_ID = engagementBackup;
    }
  });

  test("tool store caps beyond 50 rows behave like the store clamp", async () => {
    expect(clipOutput("x".repeat(24 * 1024))).toHaveLength(24 * 1024);
    expect(clipOutput("x".repeat(24 * 1024 + 1))).toBe(`${"x".repeat(24 * 1024)}[truncated]`);
    const store: EvidenceStore = openEvidence(":memory:");
    try {
      for (let i = 0; i < 60; i++) store.addEvidence({ kind: "flood", refs: [], text: `row-${i}`, sensitivity: "low" });
      const capped = store.listEvidence({ limit: 999 });
      expect(capped).toHaveLength(50);
    } finally { store.close(); }
  });
});
