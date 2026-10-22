import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  compactDiag,
  registerBrowserAutoTool,
  validateParams,
} from "../src/tools/browser-auto.ts";

/**
 * Modelless fakes ONLY — no live browser in unit tests. The node binary is a
 * fake shell script pointed at via CYBER_NODE_BIN: it appends the ONE JSON
 * argv element the tool hands it (argv slot 2) to a dump file and prints a
 * canned output line via `cat` (real bytes — never printf, tabs would get
 * escaped). That proves the spec the driver receives plus the
 * ok/fail/harvest rendering. Engine resolution (cloakDir/profileDir) is
 * stubbed via env; the driver itself is exercised in live smokes, not here.
 */

let work = "";
const toolToRegister: ToolDefinition<any, any, any>[] = [];
registerBrowserAutoTool({ registerTool: (tool) => { toolToRegister.push(tool as ToolDefinition<any, any, any>); } } as Pick<ExtensionAPI, "registerTool">);
const browserTool = toolToRegister[0];

function freshWork(): void {
  work = join(tmpdir(), `cyber-browserauto-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(work, { recursive: true });
}

/** A fake "node": dumps argv[2] (the driver spec JSON), then cats canned stdout. */
let cannedStdoutFile = "";
function fakeNode(stdout: string, exit = 0): void {
  cannedStdoutFile = join(work, "canned-out.txt");
  // Real bytes only: writeFileSync keeps tabs/JSON verbatim.
  writeFileSync(cannedStdoutFile, stdout);
  const bin = join(work, "node-fake");
  writeFileSync(bin, [
    "#!/bin/sh",
    `DUMP="${join(work, "driver-argv.txt")}"`,
    'printf \'%s\\n\' "$2" >> "$DUMP"',
    `cat ${JSON.stringify(cannedStdoutFile)}`,
    `exit ${exit}`,
  ].join("\n"));
  chmodSync(bin, 0o755);
  process.env.CYBER_NODE_BIN = bin;
}

/** A fake "node" that crashes to stderr (the catastrophic setup path). */
function fakeCrashingNode(): void {
  cannedStdoutFile = join(work, "unused.txt");
  const bin = join(work, "node-crash");
  writeFileSync(bin, [
    "#!/bin/sh",
    "echo 'cloakbrowser not installed under ~/.pi/scanners/cloakbrowser' >&2",
    "exit 3",
  ].join("\n"));
  chmodSync(bin, 0o755);
  process.env.CYBER_NODE_BIN = bin;
}

function driverSpec(): Record<string, any> {
  return JSON.parse(readFileSync(join(work, "driver-argv.txt"), "utf8").trim());
}

const ctx = { sessionManager: { getBranch: () => [] }, tools: [] } as unknown as ExtensionToolContext;

/** Operator cloak root stub: resolveCloakDir only stats package.json files. */
function stubCloakRoot(): string {
  const root = join(work, "cloakroot");
  mkdirSync(join(root, "node_modules", "cloakbrowser"), { recursive: true });
  writeFileSync(join(root, "node_modules", "cloakbrowser", "package.json"), "{}");
  process.env.CYBER_CLOAKBROWSER_DIR = root;
  return root;
}

/** Redirect the persistent-profile base into the test work dir. */
function stubProfileBase(): string {
  const base = join(work, "profiles");
  process.env.CYBER_BROWSER_PROFILE_DIR = base;
  return base;
}

function stubEvidence(): void {
  process.env.CYBER_EVIDENCE_DIR = join(work, "evidence");
  process.env.CYBER_ENGAGEMENT_ID = "default";
}

function textOf(result: any): string {
  return result.content[0].type === "text" ? String(result.content[0].text) : "";
}

function envKeys(): string[] {
  return [
    "CYBER_NODE_BIN", "CYBER_NODE_BIN_EXIT",
    "CYBER_EVIDENCE_DIR", "CYBER_ENGAGEMENT_ID",
    "CYBER_CLOAKBROWSER_DIR", "CYBER_BROWSER_PROFILE_DIR", "CYBER_BROWSER_SHOT_DIR",
  ];
}

const savedEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of envKeys()) {
    savedEnv.set(key, undefined);
    delete process.env[key];
  }
});

afterAll(() => {
  savedEnv.clear();
  if (cannedStdoutFile && existsSync(cannedStdoutFile)) rmSync(cannedStdoutFile, { force: true });
});

const CANNED_OK = JSON.stringify({
  ok: true,
  url: "https://example.com/",
  title: "Example Domain",
  text: "Example Domain body text",
  inputCount: 1,
  inputs: [{ name: "q", id: "search", type: "search", placeholder: "Search…" }],
  steps: [{ index: 0, op: "eval", ok: true, result: "doc title" }],
  xhrScripts: [{ method: "GET", url: "https://example.com/app.js", status: 200, resourceType: "script", size: 4321 }],
  networkTotal: 3,
  console: [{ type: "log", text: "boot" }],
  cookies: [{ name: "probe", domain: ".example.com", value: "yes", httpOnly: false, secure: true }],
}) + "\n";

describe("browser (single-tool) validation", () => {
  test("unknown action is rejected naming the field", () => {
    expect(() => validateParams({ action: "hover" } as any)).toThrow(/action must be one of/);
  });

  test("navigate without url is rejected", () => {
    expect(() => validateParams({ action: "navigate" } as any)).toThrow(/url required/);
    expect(() => validateParams({ action: "navigate", url: "/relative" } as any)).toThrow(/invalid absolute http\(s\) URL/);
  });

  test("an eval step value over 8000 chars is rejected naming steps[i].value", () => {
    const params = {
      action: "navigate",
      url: "https://example.com",
      steps: [{ op: "eval", value: "x".repeat(9001) }],
    } as any;
    expect(() => validateParams(params)).toThrow(/steps\[0\]\.value exceeds the 8000-character step budget/);
  });

  test("more than 15 steps is rejected; eval action needs code; code over 16000 rejected", () => {
    const steps = Array.from({ length: 16 }, () => ({ op: "waitSel", sel: "#x" }));
    expect(() => validateParams({ action: "navigate", url: "https://example.com", steps } as any)).toThrow(/steps accepts at most 15 entries/);
    expect(() => validateParams({ action: "eval" } as any)).toThrow(/code required/);
    expect(() => validateParams({ action: "eval", code: "y".repeat(16001) } as any)).toThrow(/code exceeds the 16000-character/);
  });

  test("sel-ops without sel and shutdown without close are rejected", () => {
    expect(() => validateParams({ action: "navigate", url: "https://e.test", steps: [{ op: "click" }] } as any))
      .toThrow(/steps\[0\]\.sel required/);
    expect(() => validateParams({ action: "snapshot", shutdown: true } as any)).toThrow(/shutdown applies only with action "close"/);
  });

  test("harvest actions need a url and take no steps (turnstile/clearance/fingerprint)", () => {
    expect(() => validateParams({ action: "turnstile" } as any)).toThrow(/url required for the turnstile action/);
    expect(() => validateParams({ action: "clearance" } as any)).toThrow(/url required for the clearance action/);
 // turnstile ACCEPTS steps: a widget that mounts only after the page is acted
 // on never loads unless they run before the poll.
 expect(() => validateParams({ action: "turnstile", url: "https://e.test", steps: [{ op: "click", sel: "#x" }] } as any)).not.toThrow();
 expect(() => validateParams({ action: "clearance", url: "https://e.test", steps: [{ op: "click", sel: "#x" }] } as any))
 .toThrow(/steps do not apply to clearance/);
    expect(() => validateParams({ action: "fingerprint", steps: [] } as any))
      .toThrow(/steps do not apply to fingerprint/);
    // fingerprint without a url is fine (defaults to the tls probe endpoint)
    expect(() => validateParams({ action: "fingerprint" } as any)).not.toThrow();
    // harvest urls are validated too
    expect(() => validateParams({ action: "turnstile", url: "javascript:alert(1)" } as any))
      .toThrow(/invalid absolute http\(s\) URL/);
  });

  test("invalid named profile is rejected as a typed error", () => {
    expect(() => validateParams({ action: "navigate", url: "https://example.com", profile: "Bad Name!" } as any))
      .toThrow(/invalid profile: invalid profile name/);
    expect(() => validateParams({ action: "navigate", url: "https://example.com", profile: "ok.name" } as any)).not.toThrow();
  });

  test("download export requires an explicit index and network artifact needs a capture ref", () => {
    expect(() => validateParams({action:"download"} as any)).toThrow(/downloadIndex required/);
    expect(() => validateParams({action:"download", downloadIndex:20} as any)).toThrow(/downloadIndex must/);
    expect(() => validateParams({action:"networkArtifact"} as any)).toThrow(/captureId required/);
    expect(() => validateParams({action:"networkArtifact", captureId:"n1", maxBytes:600000} as any)).toThrow(/opaque ID/);
    expect(() => validateParams({action:"networkArtifact", captureId:`n${"a".repeat(32)}`, maxBytes:600000} as any)).toThrow(/maxBytes must/);
  });

  test("includeScreenshot/fullPage apply to navigate+snapshot+harvest, not eval/close/fingerprint", () => {
    expect(() => validateParams({ action: "eval", code: "return 1", includeScreenshot: true } as any))
      .toThrow(/includeScreenshot\/fullPage apply only to the navigate, turnstile and clearance actions \(not eval\)/);
    expect(() => validateParams({ action: "close", fullPage: true } as any))
      .toThrow(/includeScreenshot\/fullPage apply only to the navigate, turnstile and clearance actions \(not close\)/);
    expect(() => validateParams({ action: "fingerprint", includeScreenshot: true } as any))
      .toThrow(/includeScreenshot\/fullPage apply only to the navigate, turnstile and clearance actions \(not fingerprint\)/);
    expect(() => validateParams({ action: "snapshot", includeScreenshot: true, fullPage: true } as any)).not.toThrow();
    expect(() => validateParams({ action: "turnstile", url: "https://e.test", includeScreenshot: true } as any)).not.toThrow();
  });
});

describe("browser (single-tool) execute — session actions", () => {
  test("navigate ok: the spec carries cloakDir+profileDir+steps and the snapshot renders with sections", async () => {
    freshWork();
    const cloakRoot = stubCloakRoot();
    const profileBase = stubProfileBase();
    fakeNode(CANNED_OK);
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("t1", {
      action: "navigate",
      url: "https://example.com/",
      steps: [{ op: "eval", value: "return document.title" }],
      includeCookies: true,
    }, undefined, undefined, ctx);
    // the argv slot went to the driver intact
    const spec = driverSpec();
    expect(String(spec.cloakDir).startsWith(cloakRoot)).toBe(true);
    expect(spec.profileDir).toBe(join(profileBase, "default"));
    expect(spec.showUi).toBe(false);
    expect(spec.action).toBe("navigate");
    expect(spec.url).toBe("https://example.com/");
    expect(spec.steps).toEqual([{ op: "eval", value: "return document.title" }]);
    expect(spec.includeNetwork).toBe(true); // navigate defaults network+console on
    expect(spec.includeConsole).toBe(true);
    expect(spec.includeCookies).toBe(true);
    const text = textOf(result);
    expect(text).toContain("browser navigate ok");
    expect(text).toContain("page: https://example.com/ — Example Domain");
    expect(text).toContain("Example Domain body text");
    expect(text).toContain("---NETWORK---");
    expect(text).toContain("GET 200 script 4321b https://example.com/app.js");
    expect(text).toContain("---CONSOLE---");
    expect(text).toContain("[log] boot");
    expect(text).toContain("cookies: probe=yes");
    expect(text).toContain("step eval#0 → doc title");
 });


 test("tab pinning: the index reaches the driver spec and the tab list marks the acted-on tab", async () => {
 freshWork();
 stubCloakRoot();
 stubProfileBase();
 const canned = JSON.stringify({
 ok: true,
 url: "https://target.example/challenge",
 title: "Just a moment",
 text: "challenge passed",
 tab: 1,
 tabs: [
 { index: 0, url: "https://target.example/signup" },
 { index: 1, url: "https://target.example/challenge" },
 ],
 }) + "\n";
 fakeNode(canned);
 stubEvidence();
 const execute = browserTool!.execute as any;
 const result = await execute("t-tab", { action: "snapshot", tab: 1 }, undefined, undefined, ctx);
 expect(driverSpec().tab).toBe(1);
 const text = textOf(result);
 expect(text).toContain("tabs: 0=https://target.example/signup | 1*=https://target.example/challenge");
 });

  test("ok:false with diag renders the error + compact diag as an isError result", async () => {
    freshWork();
    stubCloakRoot();
    stubProfileBase();
    const canned = JSON.stringify({
      ok: false,
      error: "navigation failed: net::ERR_NAME_NOT_RESOLVED",
      diag: {
        url: "https://fail.test/",
        title: "",
        inputCount: 2,
        steps: [{ index: 0, op: "click", ok: false, error: "sel required" }],
      },
    }) + "\n";
    fakeNode(canned);
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("t2", { action: "navigate", url: "https://fail.test/" }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("browser navigate failed: navigation failed: net::ERR_NAME_NOT_RESOLVED");
    expect(text).toContain("[diag] url=https://fail.test/ inputs=2 steps=click-error");
    expect(result.details.diag.url).toBe("https://fail.test/");
  });

  test("driver crash to stderr surfaces as 'browser driver failed:'", async () => {
    freshWork();
    stubCloakRoot();
    stubProfileBase();
    fakeCrashingNode();
    stubEvidence();
    const execute = browserTool!.execute as any;
    await expect(execute("t3", { action: "snapshot" }, undefined, undefined, ctx))
      .rejects.toThrow(/browser driver failed:.*cloakbrowser/);
  });

  test("snapshot spec carries include flags verbatim (default: none)", async () => {
    freshWork();
    stubCloakRoot();
    stubProfileBase();
    fakeNode(CANNED_OK);
    stubEvidence();
    const execute = browserTool!.execute as any;
    await execute("t4", { action: "snapshot", includeNetwork: true }, undefined, undefined, ctx);
    const spec = driverSpec();
    expect(spec.action).toBe("snapshot");
    expect(spec.includeNetwork).toBe(true);
    expect(spec.includeConsole).toBe(false); // snapshot defaults console off
    expect(spec.url).toBeUndefined();
  });

  test("showUi:true + a NAMED profile land in the spec verbatim", async () => {
    freshWork();
    stubCloakRoot();
    const profileBase = stubProfileBase();
    fakeNode(CANNED_OK);
    stubEvidence();
    const execute = browserTool!.execute as any;
    await execute("t5", { action: "navigate", url: "https://example.com/", showUi: true, profile: "ops-guy" }, undefined, undefined, ctx);
    const spec = driverSpec();
    expect(spec.showUi).toBe(true);
    expect(spec.profileDir).toBe(join(profileBase, "ops-guy"));
  });

  test("includeScreenshot(+fullPage): spec.screenshot + screenshotDir pass through, dir pre-created, path rendered", async () => {
    freshWork();
    stubCloakRoot();
    stubProfileBase();
    const shotDir = join(work, "shots");
    process.env.CYBER_BROWSER_SHOT_DIR = shotDir;
    const canned = JSON.stringify({
      ok: true,
      url: "https://example.com/",
      title: "Example Domain",
      text: "Example Domain body text",
      inputCount: 0,
      screenshotPath: join(shotDir, "browser-shot-1-abc.png"),
      screenshotBytes: 21_072,
    }) + "\n";
    fakeNode(canned);
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("t6", { action: "navigate", url: "https://example.com/", includeScreenshot: true, fullPage: true }, undefined, undefined, ctx);
    const spec = driverSpec();
    expect(spec.screenshot).toBe(true);
    expect(spec.screenshotDir).toBe(shotDir);
    expect(spec.fullPage).toBe(true);
    expect(existsSync(shotDir)).toBe(true); // the tool mkdir -p'd the shot dir
    const text = textOf(result);
    expect(text).toContain(`screenshot: ${join(shotDir, "browser-shot-1-abc.png")} (21072 bytes)`);
    expect(result.details.screenshotPath).toBe(join(shotDir, "browser-shot-1-abc.png"));
  });

  test("close+shutdown keeps the persistent profile (typed note, no engine file machinery)", async () => {
    freshWork();
    stubCloakRoot();
    const profileBase = stubProfileBase();
    fakeNode(JSON.stringify({ ok: true, closed: true, url: "https://example.com/" }) + "\n");
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("t7", { action: "close", shutdown: true, profile: "ops-guy" }, undefined, undefined, ctx);
    const text = textOf(result);
    expect(text).toContain("browser close ok");
    expect(text).toContain(`cloak profile kept at ${join(profileBase, "ops-guy")}`);
    expect(result.details.shutdown).toContain("cookies persist for the next call");
  });
});


describe("browser harvest actions", () => {
  test("bounded download bytes become an opaque artifact reference", async () => {
    freshWork();
    stubCloakRoot();
    stubProfileBase();
    fakeNode(JSON.stringify({ok:true, download:{filename:"fixture.json", contentType:"application/json", bytes:7, dataBase64:Buffer.from('{"ok":1}').toString("base64")}}) + "\n");
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("download", {action:"download", downloadIndex:0}, undefined, undefined, ctx);
    expect(result.details.artifacts).toHaveLength(1);
    expect(result.details.artifacts[0]).toMatchObject({kind:"browser-download", contentType:"application/json", bytes:8});
    expect(textOf(result)).toContain("fixture.json");
    expect(textOf(result)).not.toContain(Buffer.from('{"ok":1}').toString("base64"));
  });

  test("turnstile spec shape: url + profileDir, no steps; token renders in its own line, never in the summary meta", async () => {
    freshWork();
    stubCloakRoot();
    const profileBase = stubProfileBase();
    const token = "0.tokA".concat("x".repeat(144));
    const canned = JSON.stringify({
      ok: true,
      url: "https://target.test/signup",
      finalUrl: "https://target.test/token",
      tab: 1,
      tabId: "t4",
      tabs: [{ index: 1, id: "t4", url: "https://target.test/token" }],
      screenshotPath: "/tmp/token.png",
      screenshotBytes: 1234,
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/145.0.0.0",
      token,
      source: "getResponse",
      siteKey: "0x4AAAAAAA",
    }) + "\n";
    fakeNode(canned);
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("h1", { action: "turnstile", url: "https://target.test/signup" }, undefined, undefined, ctx);
    const spec = driverSpec();
    expect(spec.action).toBe("turnstile");
    expect(spec.url).toBe("https://target.test/signup");
    expect(spec.profileDir).toBe(join(profileBase, "default"));
    expect(String(spec.cloakDir).length).toBeGreaterThan(0);
    expect(spec.steps).toBeUndefined(); // single-purpose harvest
    const text = textOf(result);
    expect(text).toContain(`browser turnstile resolved (${token.length} chars)`);
    expect(text).toContain("source: getResponse");
    expect(text).toContain("siteKey: 0x4AAAAAAA");
    expect(text).toContain("single-use, ~300s");
    expect(text).toContain(token); // the token appears in its designated line
    expect(result.details.tokenLength).toBe(token.length);
    expect(result.details.source).toBe("getResponse");
    expect(text).toContain("page: https://target.test/token");
    expect(text).toContain("screenshot: /tmp/token.png (1234 bytes)");
    expect(result.details.url).toBe("https://target.test/token");
    expect(result.details.tabId).toBe("t4");
    expect(result.details.screenshotPath).toBe("/tmp/token.png");
  });

  test("turnstile ok:false diag renders as isError with sawChallenge + frame info", async () => {
    freshWork();
    stubCloakRoot();
    stubProfileBase();
    const canned = JSON.stringify({
      ok: false,
      error: "no turnstile token resolved within 60000ms at https://target.test/gate",
      diag: {
        url: "https://target.test/gate",
        title: "Just a moment...",
        siteKey: "0x4AAAAAAA",
        inputCount: 2,
        pollMs: 60_000,
        turnstileGlobalLoaded: true,
        frameUrls: ["https://challenges.cloudflare.com/turnstile/v0/…"],
      },
    }) + "\n";
    fakeNode(canned);
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("h2", { action: "turnstile", url: "https://target.test/gate", timeoutSec: 60 }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("browser turnstile failed: no turnstile token resolved");
    expect(text).toContain("[diag] url=https://target.test/gate title=Just a moment... inputs=2 turnstileGlobalLoaded=yes");
    expect(result.details.diag.turnstileGlobalLoaded).toBe(true);
  });

  test("clearance render: cfClearance: present + the full jar in details.cookies for the bypass_fetch handoff", async () => {
    freshWork();
    stubCloakRoot();
    stubProfileBase();
    const canned = JSON.stringify({
      ok: true,
      url: "https://target.test/protected",
      finalUrl: "https://target.test/protected",
      title: "Welcome",
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/145.0.0.0",
      sawChallenge: true,
      cookies: [
        { name: "cf_clearance", value: "yJnX…long", domain: ".target.test", path: "/", expiresSec: 1_800 },
        { name: "__cf_bm", value: "abc123", domain: ".target.test", path: "/", expiresSec: 1_100 },
      ],
    }) + "\n";
    fakeNode(canned);
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("h3", { action: "clearance", url: "https://target.test/protected" }, undefined, undefined, ctx);
    const spec = driverSpec();
    expect(spec.action).toBe("clearance");
    expect(spec.steps).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("browser clearance harvest resolved");
    expect(text).toMatch(/cfClearance: present \(\d+ chars\)/);
    expect(text).toContain("matching UA header via bypass_fetch");
    expect(text).toContain("cf_clearance=");
    expect(result.details.cfClearance).toBe(true);
    expect(result.details.sawChallenge).toBe(true);
    expect(Array.isArray(result.details.cookies)).toBe(true);
    expect(result.details.cookies[0].name).toBe("cf_clearance");
    expect(result.details.cookies.length).toBe(2);
  });

  test("clearance ok:false diag: honest sawChallenge state + observed cookie names, isError", async () => {
    freshWork();
    stubCloakRoot();
    stubProfileBase();
    const canned = JSON.stringify({
      ok: false,
      error: "no cf_clearance after 60000ms at https://target.test/fortress",
      diag: {
        ok: false,
        url: "https://target.test/fortress",
        title: "Just a moment...",
        sawChallenge: true,
        cookieNames: ["__cf_bm", "cf_chl_prog"],
        ua: "Mozilla/5.0 Chrome",
      },
    }) + "\n";
    fakeNode(canned);
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("h4", { action: "clearance", url: "https://target.test/fortress" }, undefined, undefined, ctx);
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain("browser clearance failed: no cf_clearance after");
    expect(text).toContain("sawChallenge: yes");
    expect(text).toContain("cookieNames: __cf_bm, cf_chl_prog");
  });

  test("fingerprint: default tls probe url when none given; ja3/ja4/http2 render into the head", async () => {
    freshWork();
    stubCloakRoot();
    stubProfileBase();
    const canned = JSON.stringify({
      ok: true,
      url: "https://tls.peet.ws/api/all",
      ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/145.0.0.0",
      ja3: "c1860c18c9092da2a6a0d198e6c71126",
      ja4: "t13d1516h2_8daaf6152771_d8a2da3f94cd",
      http2: "1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p",
    }) + "\n";
    fakeNode(canned);
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("h5", { action: "fingerprint" }, undefined, undefined, ctx);
    const spec = driverSpec();
    expect(spec.action).toBe("fingerprint");
    expect(spec.url).toBe("https://tls.peet.ws/api/all"); // engine-checked default
    expect(spec.steps).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain("browser fingerprint probe");
    expect(text).toContain("ja3: c1860c18c9092da2a6a0d198e6c71126");
    expect(text).toContain("ja4: t13d1516h2_8daaf6152771_d8a2da3f94cd");
    expect(text).toContain("http2 (akamai): 1:65536;2:0");
    expect(result.details.ja4).toBe("t13d1516h2_8daaf6152771_d8a2da3f94cd");
    expect(result.details.ua).toContain("Chrome/145");
  });

  test("fingerprint falls back to the raw text body when the page is not json", async () => {
    freshWork();
    stubCloakRoot();
    stubProfileBase();
    const canned = JSON.stringify({
      ok: true,
      url: "https://example.test/fp",
      ua: "UA",
      ja3: null,
      ja4: null,
      http2: null,
      text: "no fingerprint json here",
    }) + "\n";
    fakeNode(canned);
    stubEvidence();
    const execute = browserTool!.execute as any;
    const result = await execute("h6", { action: "fingerprint", url: "https://example.test/fp" }, undefined, undefined, ctx);
    const spec = driverSpec();
    expect(spec.url).toBe("https://example.test/fp"); // a given url rides verbatim
    const text = textOf(result);
    expect(text).toContain("ja3: n/a");
    expect(text).toContain("no fingerprint json here");
  });
});

describe("browser compactDiag", () => {
  test("folds steps ok/error counts and carries url/inputs", () => {
    const compact = compactDiag({
      url: "https://example.com/long/path/that/goes/on",
      title: "T",
      inputCount: 4,
      steps: [
        { index: 0, op: "eval", ok: true },
        { index: 1, op: "eval", ok: false },
        { index: 2, op: "fill", ok: false },
      ],
      console: [1, 2, 3],
    });
    expect(compact).toContain("url=https://example.com/long/path");
    expect(compact).toContain("inputs=4");
    expect(compact).toContain("steps=ok,eval-error,fill-error");
    expect(compact).toContain("console=3");
  });

  test("reports the turnstile state honestly (turnstileGlobalLoaded)", () => {
    expect(compactDiag({ turnstileGlobalLoaded: true })).toContain("turnstileGlobalLoaded=yes");
    expect(compactDiag({ turnstileGlobalLoaded: false })).toContain("turnstileGlobalLoaded=no");
  });

  test("non-object diag renders empty", () => {
    expect(compactDiag(null)).toBe("");
    expect(compactDiag([1])).toBe("");
  });
});

describe("browser expanded controls", () => {
  test("accepts tab controls, frame interaction, and network inspection", () => {
    for (const action of ["tabs", "newTab", "switchTab", "frames", "network", "reload", "back", "forward"]) {
      expect(() => validateParams({ action, ...(action === "switchTab" ? {tabId: "t1"} : {}) } as any)).not.toThrow();
    }
    expect(() => validateParams({ action: "act", frame: 1, steps: [
      {op: "check", sel: "#agree"}, {op: "select", sel: "#plan", value: "basic"},
      {op: "waitSel", sel: "#done", state: "visible"}, {op: "waitURL", value: "**/done"},
    ] } as any)).not.toThrow();
    expect(() => validateParams({action: "act", steps: [{op: "click"}]} as any)).toThrow(/sel required/);
    expect(() => validateParams({action: "snapshot", tab: 0, tabId: "t1"} as any)).toThrow(/one tab selector/);
    expect(() => validateParams({action: "snapshot", frame: -1} as any)).toThrow(/frame/);
  });

  test("forwards stable tab, frame, step controls, and network filter to the driver", async () => {
    freshWork(); stubCloakRoot(); stubProfileBase(); stubEvidence(); fakeNode(CANNED_OK);
    await (browserTool!.execute as any)("controls", { action: "act", tabId: "t2", frame: 1,
      steps: [{op: "hover", sel: "#menu"}], stopOnError: true,
      includeNetwork: true, networkFilter: "/api/",
    }, undefined, undefined, ctx);
    expect(driverSpec()).toMatchObject({action: "act", tabId: "t2", frame: 1,
      steps: [{op: "hover", sel: "#menu"}], stopOnError: true,
      includeNetwork: true, networkFilter: "/api/"});
  });
});
