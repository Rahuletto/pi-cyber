import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { registerBypassFetchTool, resolveFetchEngine, buildCurlArgs, requestHost } from "../src/tools/bypass-fetch.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Modelless: the fetch engine is a fake executable pointed at via
 * CYBER_CURL_IMPERSONATE. It appends each argv element (one slot,
 * ---ARG----marked) to a dump file and prints a canned body followed by the
 * real write-out tail. That proves the argv shape the engine sees, the
 * scope-gate behavior, and the body/tail split.
 */

let work = "";
const toolToRegister: ToolDefinition<any, any, any>[] = [];
registerBypassFetchTool({ registerTool: (tool) => { toolToRegister.push(tool as ToolDefinition<any, any, any>); } } as Pick<ExtensionAPI, "registerTool">);
const bypassFetch = toolToRegister[0];

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function fakeEngine(stdout: string, exit = 0): void {
  mkdirSync(work, { recursive: true });
  // Real bytes only: write the canned stdout to a file (writeFileSync keeps
  // tabs/CRs verbatim) and let the script cat it — printf via JSON.stringify
  // would escape \t into literal backslash-t text.
  writeFileSync(join(work, "canned-out.txt"), stdout);
  const bin = join(work, "curl-fake");
  writeFileSync(bin, [
    "#!/bin/sh",
    `DUMP="${join(work, "argv.txt")}"`,
    'rm -f "$DUMP"',
    'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$DUMP"; printf \'%s\\n\' "---ARG---" >> "$DUMP"; done',
    `cat ${JSON.stringify(join(work, "canned-out.txt"))}`,
    `exit ${exit}`,
  ].join("\n"));
  chmodSync(bin, 0o755);
  process.env.CYBER_CURL_IMPERSONATE = bin;
  process.env.CYBER_EVIDENCE_DIR = join(work, "evidence");
}

function argvSlots(): string[] {
  return readFileSync(join(work, "argv.txt"), "utf8").split("\n---ARG---\n").slice(0, -1);
}

function freshWork(): void {
  work = join(tmpdir(), `cyber-bypassfetch-${Math.random().toString(36).slice(2, 10)}`);
}

/** scope recorded on the (stub) cyber_state branch: fixture session entries are minimal, so we exercise through hostInScope via the execute path with an injected session. */
const ctx = { sessionManager: { getBranch: () => [] }, tools: [] } as unknown as ExtensionToolContext;

const SAMPLE_TAIL = "\t200\t0.512\t4449\tapplication/json\thttps://target.test/api/me\n";

describe("bypass_fetch pure helpers", () => {
  test("requestHost extracts and lowercases the host", () => {
    expect(requestHost("https://API.Target.test/x")).toBe("api.target.test");
    expect(requestHost("http://target.test:8443/")).toBe("target.test");
    expect(requestHost("notaurl")).toBeNull();
  });

  test("buildCurlArgs keeps one value per argv slot and flags UA overrides", () => {
    const { argv, warnings } = buildCurlArgs(
      { method: "POST", url: "https://t.test/api", headers: { "X-Turnstile-Token": "tok", "Content-Type": "application/json", "User-Agent": "spoof" }, body: '{"a":1}', profile: "chrome152", session: "signup" },
      "impersonate"
    );
    expect(argv).toContain("chrome152");
    expect(argv).toContain("--header");
    expect(argv).toContain("X-Turnstile-Token: tok");
    expect(argv).toContain("Content-Type: application/json");
    expect(argv).toContain("--data-raw");
    expect(argv).toContain('{"a":1}');
    expect(argv.filter((entry) => entry === "--header").length).toBe(3);
    expect(warnings.length).toBe(1);
  });

  test("buildCurlArgs rejects an invalid header name outright", () => {
    expect(() => buildCurlArgs({ method: "GET", url: "https://t.test/", headers: { "Bad\nName": "x" } }, "impersonate")).toThrow(/invalid header name/);
  });
});

describe("bypass_fetch engine resolution", () => {
  test("an illegible CYBER_CURL_IMPERSONATE override fails loudly instead of silently degrading", () => {
    freshWork();
    process.env.CYBER_CURL_IMPERSONATE = join(work, "missing");
    expect(() => resolveFetchEngine()).toThrow(/not executable/);
    delete process.env.CYBER_CURL_INSTALLED_EMPTY;
  });
});

describe("bypass_fetch execute", () => {
  test("model's headers and body each stay a single argv slot; response tail parses into metadata", async () => {
    freshWork();
    fakeEngine('{"ok":true,"user":"probe"}' + SAMPLE_TAIL);
    const execute = bypassFetch!.execute;
    const result = await execute("t1", {
      method: "POST",
      url: "https://target.test/api/auth/register",
      headers: { "Content-Type": "application/json", "X-Turnstile-Token": "TST-abc" },
      body: '{"email":"probe@subhosttest.org","password":"x"}',
      profile: "chrome152",
      session: "signup",
      followRedirects: false,
    }, undefined, undefined, ctx);
    const slots = argvSlots();
    expect(slots).toContain("--impersonate");
    expect(slots).toContain("chrome152");
    expect(slots).toContain("--data-raw");
    expect(slots).toContain('{"email":"probe@subhosttest.org","password":"x"}');
    expect(slots.filter((entry) => entry === "--header").length).toBe(2);
    // session named → cookie jar flags present; POST implies explicit method
    expect(slots).toContain("--cookie");
    expect(slots).toContain("--cookie-jar");
    expect(slots).toContain("--request");
    expect(slots).toContain("POST");
    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("status: 200");
    expect(text).toContain("application/json");
    expect(text).toContain('"user":"probe"');
  });

  test("GET rejects a body and unknown profile rather than guessing", async () => {
    freshWork();
    fakeEngine(SAMPLE_TAIL);
    const execute = bypassFetch!.execute;
    await expect(execute("t2", { method: "GET", url: "https://target.test/", body: "x" }, undefined, undefined, ctx))
      .rejects.toThrow(/GET takes no body/);
    await expect(execute("t3", { method: "GET", url: "https://target.test/", profile: "shell456" }, undefined, undefined, ctx))
      .rejects.toThrow(/unknown impersonation profile/);
    await expect(execute("t4", { method: "GET", url: "/relative/path" }, undefined, undefined, ctx))
      .rejects.toThrow(/invalid absolute http\(s\) URL/);
  });

  test("engine failure propagates the first stderr line, not a stack", async () => {
    freshWork();
    const bin = join(work, "curl-fake");
    mkdirSync(work, { recursive: true });
    writeFileSync(bin, [
      "#!/bin/sh",
      "echo 'curl: (6) Could not resolve host: target.test' >&2",
      "exit 6",
    ].join("\n"));
    chmodSync(bin, 0o755);
    process.env.CYBER_CURL_IMPERSONATE = bin;
    process.env.CYBER_EVIDENCE_DIR = join(work, "evidence");
    const execute = bypassFetch!.execute;
    await expect(execute("t5", { method: "GET", url: "https://target.test/" }, undefined, undefined, ctx))
      .rejects.toThrow(/Could not resolve host/);
  });
});

const savedEnvKeys = ["CYBER_CURL_IMPERSONATE", "CYBER_EVIDENCE_DIR", "CYBER_COOKIE_DIR"] as const;

afterAll(() => {
  for (const key of savedEnvKeys) delete process.env[key];
});
