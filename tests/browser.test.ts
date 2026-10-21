/**
 * `cyber_browser` — the Obscura browser lease lane.
 *
 * Modelless: no browser is launched, nothing is downloaded, no network is
 * touched and no provider is contacted. A lease is a row in the engagement's
 * evidence file, so the tests drive the REAL store through a temp evidence
 * directory and assert on what actually landed in SQLite.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { openEvidence } from "../src/evidence/db.ts";
import {
  BROWSER_BIN,
  BROWSER_MODES,
  BROWSER_PURPOSES,
  BrowserLeaseError,
  EXPORT_BEFORE_CLOSE_REMINDER,
  registerBrowserTool,
} from "../src/tools/browser.ts";

interface ToolFixture {
  name: string;
  description: string;
  parameters: unknown;
  executionMode?: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text?: string }>; details?: Record<string, unknown> }>;
}

const ENV_KEYS = ["CYBER_EVIDENCE_DIR", "CYBER_ENGAGEMENT_ID", "CYBER_TOOLS_STATE_FILE", "CYBER_TOOLS_BIN_DIR"] as const;
const directories: string[] = [];
let saved: Record<string, string | undefined> = {};

function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "browser-test-"));
  directories.push(dir);
  return dir;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<string, string | undefined>;
  const dir = tempDir();
  process.env.CYBER_EVIDENCE_DIR = dir;
  process.env.CYBER_ENGAGEMENT_ID = "lease-test";
  process.env.CYBER_TOOLS_STATE_FILE = join(dir, "state.json"); // missing file → every bin stays cataloged
  process.env.CYBER_TOOLS_BIN_DIR = join(dir, "bin");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

let definition!: ToolFixture;
beforeAll(() => {
  let captured!: ToolFixture;
  const fakePi = { registerTool: (tool: ToolFixture) => { captured = tool; } };
  registerBrowserTool(fakePi as unknown as Pick<ExtensionAPI, "registerTool">);
  definition = captured;
});

/** Tool context with a stable Pi session id, so the lease owner is predictable. */
function ctx(sessionId = "session-fixture"): ExtensionToolContext {
  return { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionToolContext;
}

const call = (params: unknown, context = ctx()) => definition.execute("fixture", params, undefined, undefined, context);

/** Run a call with an empty PATH so the readiness probe cannot see an ambient binary. */
async function callWithoutPath(params: unknown, context = ctx()): ReturnType<typeof call> {
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    return await call(params, context);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

/** Read the raw event log of the engagement store. */
function events(): Array<{ kind: string; payload_json: string }> {
  const path = join(process.env.CYBER_EVIDENCE_DIR!, process.env.CYBER_ENGAGEMENT_ID!, "cyber.sqlite");
  const db = new Database(path);
  try {
    return db.prepare("SELECT kind, payload_json FROM events ORDER BY id ASC").all() as Array<{ kind: string; payload_json: string }>;
  } finally {
    db.close();
  }
}

function leases(activeOnly = false) {
  const store = openEvidence();
  try {
    return store.listSessions({ activeOnly });
  } finally {
    store.close();
  }
}

describe("cyber_browser: schema", () => {
  test("strict schema, closed purpose enum, sequential execution", () => {
    expect(definition.name).toBe("cyber_browser");
    expect(definition.executionMode).toBe("sequential");
    const schema = definition.parameters as { additionalProperties?: boolean; properties?: Record<string, { anyOf?: Array<{ const?: string }> }> };
    expect(schema.additionalProperties).toBe(false);
    const purposes = schema.properties?.purpose?.anyOf?.map((entry) => entry.const) ?? [];
    expect(purposes).toEqual([...BROWSER_PURPOSES]);
    expect(BROWSER_MODES).toEqual(["read", "act"]);
    // The schema itself refuses an unknown purpose, an unknown action and extras.
    expect(Value.Check(schema, { action: "acquire", mode: "read", purpose: "recon" })).toBe(true);
    expect(Value.Check(schema, { action: "acquire", mode: "read", purpose: "not-a-purpose" })).toBe(false);
    expect(Value.Check(schema, { action: "acquire", mode: "drive", purpose: "recon" })).toBe(false);
    expect(Value.Check(schema, { action: "nope" })).toBe(false);
    expect(Value.Check(schema, { action: "status", extra: 1 })).toBe(false);
  });

  test("the lease lane never spawns a process or downloads a browser", () => {
    const source = readFileSync(new URL("../src/tools/browser.ts", import.meta.url), "utf8");
    // Comments describe the boundary; only the CODE may not call a process.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bexecFile\b|\bexecSync\b|\bspawn\b|Bun\.spawn|child_process/);
  });
});

describe("cyber_browser: lease lifecycle", () => {
  test("acquire → status → release moves the lease through the evidence store", async () => {
    const acquired = await call({ action: "acquire", mode: "read", purpose: "recon" });
    expect(acquired.content[0].text).toContain("lease acquired");
    const sessionId = acquired.details!.sessionId as string;
    expect(sessionId).toMatch(/^bs-/);
    expect(acquired.details!.owner).toBe("pi-session:session-fixture");
    expect(acquired.details!.mode).toBe("read");
    expect(acquired.details!.purpose).toBe("recon");
    expect(String(acquired.details!.acquiredAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const status = await call({ action: "status" });
    expect(status.content[0].text).toContain(sessionId);
    expect(status.content[0].text).toContain("pi-session:session-fixture");
    expect(status.content[0].text).toContain("purpose recon");
    expect(status.details!.active).toBe(1);

    const released = await call({ action: "release", sessionId });
    expect(released.content[0].text).toContain("lease released");
    expect(released.content[0].text).toContain("export_evidence_bundle");
    expect(released.content[0].text).toContain("close_binary");
    expect(released.content[0].text).toContain(EXPORT_BEFORE_CLOSE_REMINDER);
    expect(released.details!.released).toBe(true);

    const after = await call({ action: "status" });
    expect(after.content[0].text).toBe("no active lease");
    expect(after.details!.active).toBe(0);
  });

  test("the lease round-trips through the store and the release marks it released", async () => {
    const acquired = await call({ action: "acquire", mode: "read", purpose: "validation" });
    const sessionId = acquired.details!.sessionId as string;

    const [live] = leases(true);
    expect(live.sessionId).toBe(sessionId);
    expect(live.owner).toBe("pi-session:session-fixture");
    expect(live.mode).toBe("read");
    expect(live.purpose).toBe("validation");
    expect(live.releasedAt).toBeNull();

    await call({ action: "release", sessionId });

    const [row] = leases();
    expect(row.sessionId).toBe(sessionId);
    expect(row.releasedAt).not.toBeNull();
    expect(leases(true)).toHaveLength(0);
  });

  test("the release appends the typed session event; the acquisition writes none", async () => {
    const acquired = await call({ action: "acquire", mode: "read", purpose: "capture" });
    const sessionId = acquired.details!.sessionId as string;
    expect(events()).toEqual([]); // acquiring is not an event — only the sanctioned release is

    await call({ action: "release", sessionId });
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("session");
    expect(JSON.parse(rows[0].payload_json)).toMatchObject({
      sessionId,
      owner: "pi-session:session-fixture",
      action: "released",
    });
  });

  test("releasing an unknown session is a typed no-op, not an error", async () => {
    const released = await call({ action: "release", sessionId: "bs-unknown-session" });
    expect(released.details!.released).toBe(false);
    expect(released.content[0].text).toContain("no active lease");
    expect(released.content[0].text).toContain("export_evidence_bundle");
    expect(events()).toEqual([]); // a no-op release writes no event
  });
});

describe("cyber_browser: single-owner enforcement", () => {
  test("a second acquire while a lease is active is a typed conflict naming the owner and purpose", async () => {
    const first = await call({ action: "acquire", mode: "read", purpose: "capture" }, ctx("owner-a"));
    const sessionId = first.details!.sessionId as string;

    let raised: unknown;
    try {
      await call({ action: "acquire", mode: "read", purpose: "recon" }, ctx("owner-b"));
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(BrowserLeaseError);
    expect((raised as BrowserLeaseError).code).toBe("lease-conflict");
    const message = (raised as Error).message;
    expect(message).toContain("lease conflict");
    expect(message).toContain("owner-a"); // the CURRENT owner is named
    expect(message).toContain("capture"); // and the current purpose
    expect(message).toContain(sessionId);
    expect(message).not.toContain("owner-b"); // the rejected claimant is not the owner

    // The refused acquire changed nothing: still exactly one live lease.
    expect(leases(true)).toHaveLength(1);
    expect(leases(true)[0].owner).toBe("pi-session:owner-a");
  });

  test("the lease is free again once the holder releases it", async () => {
    const first = await call({ action: "acquire", mode: "read", purpose: "recon" }, ctx("owner-a"));
    await call({ action: "release", sessionId: first.details!.sessionId as string });
    const second = await call({ action: "acquire", mode: "read", purpose: "reproduction" }, ctx("owner-b"));
    expect(second.content[0].text).toContain("lease acquired");
    expect(second.details!.owner).toBe("pi-session:owner-b");
    expect(leases(true)).toHaveLength(1);
  });
});

describe("cyber_browser: validation", () => {
  test("an invalid purpose is a validation error and never reaches the store", async () => {
    let raised: unknown;
    try {
      await call({ action: "acquire", mode: "read", purpose: "not-a-purpose" });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(BrowserLeaseError);
    expect((raised as BrowserLeaseError).code).toBe("validation-error");
    expect((raised as Error).message).toContain("purpose must be one of");
    expect(leases()).toHaveLength(0);
  });

  test("an invalid or missing mode and a missing purpose are validation errors", async () => {
    await expect(call({ action: "acquire", mode: "drive", purpose: "recon" })).rejects.toThrow(/mode must be one of/);
    await expect(call({ action: "acquire", purpose: "recon" })).rejects.toThrow(/mode must be one of/);
    await expect(call({ action: "acquire", mode: "read" })).rejects.toThrow(/purpose must be one of/);
    await expect(call({ action: "release" })).rejects.toThrow(/sessionId required/);
    expect(leases()).toHaveLength(0);
  });
});

describe("cyber_browser: lane discipline", () => {
  test("a passive read lease is taken with no browser installed at all", async () => {
    const acquired = await callWithoutPath({ action: "acquire", mode: "read", purpose: "recon" });
    expect(acquired.content[0].text).toContain("lease acquired");
    expect(acquired.content[0].text).toContain("nothing was downloaded, launched or attached");
    expect(leases(true)).toHaveLength(1);
  });

  test("an interactive lease fails fast with the typed readiness message while the bin is only cataloged", async () => {
    let raised: unknown;
    try {
      await callWithoutPath({ action: "acquire", mode: "act", purpose: "capture" });
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(BrowserLeaseError);
    expect((raised as BrowserLeaseError).code).toBe("bin-not-available");
    expect((raised as Error).message).toBe(`bin not available: ${BROWSER_BIN} — run tools/install.sh (state: cataloged)`);
    expect(leases()).toHaveLength(0); // no lease is booked for an unusable browser
  });

  test("an interactive lease is refused when the recorded install has no binary on disk", async () => {
    writeFileSync(process.env.CYBER_TOOLS_STATE_FILE!, JSON.stringify({ [BROWSER_BIN]: { state: "installed" } }));
    await expect(callWithoutPath({ action: "acquire", mode: "act", purpose: "capture" }))
      .rejects.toThrow(`bin not available: ${BROWSER_BIN} — run tools/install.sh (state: installed)`);
    expect(leases()).toHaveLength(0);
  });

  test("an interactive lease is taken once the operator recorded the bin and it is on disk", async () => {
    const binDir = join(tempDir(), "bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, BROWSER_BIN);
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
    writeFileSync(process.env.CYBER_TOOLS_STATE_FILE!, JSON.stringify({ [BROWSER_BIN]: { state: "installed" } }));
    process.env.CYBER_TOOLS_BIN_DIR = binDir;

    const acquired = await callWithoutPath({ action: "acquire", mode: "act", purpose: "reproduction" });
    expect(acquired.content[0].text).toContain("lease acquired");
    expect(acquired.details!.mode).toBe("act");
    expect(leases(true)).toHaveLength(1);
  });
});
