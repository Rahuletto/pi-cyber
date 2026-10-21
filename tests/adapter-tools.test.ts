/**
 * Task 7b — one Pi tool per adapter over the job runner.
 *
 * Covers (per the task contract):
 * - all 11 adapters register a Pi tool named EXACTLY like the adapter;
 * - the tool's parameter schema IS the adapter's own schema (identity, no
 *   duplicate — additionalProperties:false preserved);
 * - every tool declares executionMode "sequential";
 * - unknown-bin fast-fail with the typed message for every adapter stub-free
 *   bin (cataloged + stale validated state.json variants);
 * - stub-bin happy paths through the DEFAULT store for subfinder and nuclei
 *   (rendering shows state, per-kind row counts, Normalized rows, refs);
 * - schema/guard error messages surface verbatim through the tool.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { adapters } from "../src/adapters/index.ts";
import { registerAdapterTools } from "../src/tools/adapter-tools.ts";

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
  const dir = mkdtempSync(resolve(tmpdir(), "adapter-tools-test-"));
  directories.push(dir);
  return dir;
}

interface ToolEntry {
  name: string;
  description: string;
  parameters?: { additionalProperties?: boolean };
  executionMode?: string;
  execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionToolContext) => Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>;
}

const TOOLS = new Map<string, ToolEntry>();
{
  const registered: unknown[] = [];
  registerAdapterTools({ registerTool: (tool) => registered.push(tool) });
  expect(registered).toHaveLength(adapters.length);
  for (const tool of registered as unknown as ToolEntry[]) TOOLS.set(tool.name, tool);
}

const ctx = {} as ExtensionToolContext;
const call = (name: string, params: Record<string, unknown>) =>
  TOOLS.get(name)!.execute("fixture", params, undefined, undefined, ctx);

describe("registration: one tool per adapter", () => {
  test("every adapter registers a tool named exactly like the adapter", () => {
    for (const adapter of adapters) {
      const tool = TOOLS.get(adapter.name);
      expect(tool).toBeTruthy();
      expect(tool!.name).toBe(adapter.name);
      expect(tool!.executionMode).toBe("sequential");
    }
    expect([...TOOLS.keys()].sort()).toEqual([...adapters.map((a) => a.name)].sort());
  });

  test("tool parameter schemas are the adapters' own schemas (identity, additionalProperties:false)", () => {
    for (const adapter of adapters) {
      const tool = TOOLS.get(adapter.name)!;
      expect(Object.is(tool.parameters, adapter.schema)).toBe(true); // reused directly, never duplicated
      expect(tool.parameters?.additionalProperties).toBe(false);
    }
  });

  test("each tool has a single-line description naming its adapter", () => {
    for (const adapter of adapters) {
      const description = TOOLS.get(adapter.name)!.description;
      expect(description).toContain(adapter.name === "interactsh" ? "interactsh-client" : adapter.name); // wording includes the tool's own name
      expect(description.includes("\n")).toBe(false);
      expect(description).toContain("validated state required");
    }
  });
});

describe("readiness guard: fast typed failures instead of spawn errors", () => {
  test("a bin that is neither on PATH nor installed fails fast with the cataloged message", async () => {
    const dir = tempDir();
    const previousStateFile = process.env.CYBER_TOOLS_STATE_FILE;
    const previousBinDir = process.env.CYBER_TOOLS_BIN_DIR;
    process.env.CYBER_TOOLS_STATE_FILE = join(dir, "state.json"); // missing file → everything cataloged
    process.env.CYBER_TOOLS_BIN_DIR = join(dir, "bin");
    try {
      for (const adapter of adapters) {
        if (adapter.bin === "subfinder" || adapter.bin === "nuclei") continue; // stubs sit on this test's PATH
        await expect(call(adapter.name, {}))
          .rejects.toThrow(`bin not available: ${adapter.bin} — run tools/install.sh (state: cataloged)`);
      }
    } finally {
      if (previousStateFile === undefined) delete process.env.CYBER_TOOLS_STATE_FILE;
      else process.env.CYBER_TOOLS_STATE_FILE = previousStateFile;
      if (previousBinDir === undefined) delete process.env.CYBER_TOOLS_BIN_DIR;
      else process.env.CYBER_TOOLS_BIN_DIR = previousBinDir;
    }
  });

  test("a stale validated state file does not rescue an absent binary — state reported verbatim", async () => {
    const dir = tempDir();
    const previousStateFile = process.env.CYBER_TOOLS_STATE_FILE;
    const previousBinDir = process.env.CYBER_TOOLS_BIN_DIR;
    process.env.CYBER_TOOLS_STATE_FILE = join(dir, "state.json");
    process.env.CYBER_TOOLS_BIN_DIR = join(dir, "bin");
    writeFileSync(process.env.CYBER_TOOLS_STATE_FILE, JSON.stringify({ semgrep: { state: "validated" } }));
    try {
      await expect(call("semgrep", { paths: ["src"], ruleSet: "auto" }))
        .rejects.toThrow("bin not available: semgrep — run tools/install.sh (state: validated)");
    } finally {
      if (previousStateFile === undefined) delete process.env.CYBER_TOOLS_STATE_FILE;
      else process.env.CYBER_TOOLS_STATE_FILE = previousStateFile;
      if (previousBinDir === undefined) delete process.env.CYBER_TOOLS_BIN_DIR;
      else process.env.CYBER_TOOLS_BIN_DIR = previousBinDir;
    }
  });
});

describe("stub-bin happy paths through the typed tools", () => {
  test("subfinder tool runs end-to-end: succeeded, per-kind counts, Normalized row and refs rendered", async () => {
    const dir = tempDir();
    const previous = process.env.CYBER_EVIDENCE_DIR;
    process.env.CYBER_EVIDENCE_DIR = join(dir, "evidence");
    try {
      const result = await call("subfinder", { domain: "fixture.local" });
      expect(result.details).toMatchObject({ adapterToolRun: true, adapter: "subfinder", state: "succeeded", exitCode: 0, parsedRows: 1, rowsShown: 1 });
      const text = result.content[0].text ?? "";
      expect(text).toContain("state=succeeded");
      expect(text).toContain("rows: 1 (subfinder:1)");
      expect(text).toContain("evidence refs: [");
      expect(text).toContain("#"); // row id header
      expect(text).toContain("api.example.com"); // the Normalized key renders, clipped per plan
      expect(existsSync(join(dir, "evidence", "default", "cyber.sqlite"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.CYBER_EVIDENCE_DIR;
      else process.env.CYBER_EVIDENCE_DIR = previous;
    }
  });

  test("nuclei tool runs end-to-end: succeeded with the fixture finding rendered", async () => {
    const dir = tempDir();
    const previous = process.env.CYBER_EVIDENCE_DIR;
    process.env.CYBER_EVIDENCE_DIR = join(dir, "evidence");
    try {
      const result = await call("nuclei", { targets: ["fixture.local"] });
      expect(result.details).toMatchObject({ adapter: "nuclei", state: "succeeded", parsedRows: 1, rowsShown: 1 });
      const text = result.content[0].text ?? "";
      expect(text).toContain("job nuclei-");
      expect(text).toContain("state=succeeded");
      expect(text).toContain("api.example.com");
      expect(text).toContain("CVE-2024-1234");
      expect(text).toContain("evidence refs: [");
    } finally {
      if (previous === undefined) delete process.env.CYBER_EVIDENCE_DIR;
      else process.env.CYBER_EVIDENCE_DIR = previous;
    }
  });

  test("ffuf receives only the operator-configured wordlist path", async () => {
    const dir = tempDir();
    const binary = join(dir, "ffuf");
    const previous = {
      path: process.env.PATH,
      binDir: process.env.CYBER_TOOLS_BIN_DIR,
      wordlist: process.env.CYBER_FFUF_WORDLIST,
      evidence: process.env.CYBER_EVIDENCE_DIR,
    };
    writeFileSync(binary, '#!/bin/sh\nprintf \'{"results":[]}\\n\'\n', { mode: 0o755 });
    process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
    process.env.CYBER_TOOLS_BIN_DIR = dir;
    process.env.CYBER_FFUF_WORDLIST = "/operator/wordlists/common.txt";
    process.env.CYBER_EVIDENCE_DIR = join(dir, "evidence");
    try {
      const result = await call("ffuf", { target: "http://127.0.0.1:4747/FUZZ" });
      expect(result.details).toMatchObject({ adapter: "ffuf", state: "succeeded", parsedRows: 0 });
      expect(result.details.argv).toContain("/operator/wordlists/common.txt");
      expect(result.details.argv).toContain("-w");
    } finally {
      if (previous.path === undefined) delete process.env.PATH;
      else process.env.PATH = previous.path;
      if (previous.binDir === undefined) delete process.env.CYBER_TOOLS_BIN_DIR;
      else process.env.CYBER_TOOLS_BIN_DIR = previous.binDir;
      if (previous.wordlist === undefined) delete process.env.CYBER_FFUF_WORDLIST;
      else process.env.CYBER_FFUF_WORDLIST = previous.wordlist;
      if (previous.evidence === undefined) delete process.env.CYBER_EVIDENCE_DIR;
      else process.env.CYBER_EVIDENCE_DIR = previous.evidence;
    }
  });

  test("adapter schema and guard errors surface verbatim through the typed tools", async () => {
    await expect(call("subfinder", { domain: "" }))
      .rejects.toThrow("params for subfinder rejected by schema at /domain (minLength): must not have fewer than 1 characters");
    await expect(call("subfinder", { domain: "example.com", flag: "-l" }))
      .rejects.toThrow(/rejected by schema at unknown key flag \(additionalProperties\)/);
    await expect(call("nuclei", { targets: [] }))
      .rejects.toThrow('nuclei: missing required param "targets"');
    await expect(call("subfinder", { domain: "-l/etc-passwd" }))
      .rejects.toThrow('field-param "domain" must not start with "-"');
  });

  test("rows beyond the plan cap are summarized, not dumped in full", async () => {
    const dir = tempDir();
    const previous = process.env.CYBER_EVIDENCE_DIR;
    process.env.CYBER_EVIDENCE_DIR = join(dir, "evidence");
    try {
      const result = await call("nuclei", { targets: ["fixture.local"], extra: ["--flood"] });
      expect(result.details.state).toBe("succeeded");
      expect(result.details.rowsShown).toBe(50); // plan cap
      const text = result.content[0].text ?? "";
      expect(text).toContain("only 50 of"); // loud marker instead of a full dump
      expect(text).toContain("more evidence ids not listed"); // refs clip like the runner
    } finally {
      if (previous === undefined) delete process.env.CYBER_EVIDENCE_DIR;
      else process.env.CYBER_EVIDENCE_DIR = previous;
    }
  });
});
