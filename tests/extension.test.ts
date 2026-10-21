import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SessionManager, createExtensionRuntime, type ExtensionCommandContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { CyberState } from "../src/state.ts";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
const themeFor = loadThemeFromPath(resolve("themes/cyber-defense.json"), "truecolor");
async function host(tui = false) {
  const dir = await mkdtemp(resolve(tmpdir(), "cyber-test-")); directories.push(dir);
  let session = SessionManager.create(dir, dir);
  session.appendMessage({ role: "user", content: "controlled local fixture", timestamp: 1 });
  const notices: string[] = [], labels: string[] = [];
  let idle = true, failTheme = false, theme = "cyber-defense";
  const runtime = createExtensionRuntime();
  runtime.appendEntry = (type, data) => { session.appendCustomEntry(type, data); };
  runtime.sendMessage = (message) => { notices.push(String(message.content)); };
  const loaded = await loadExtensions([resolve("src/index.ts")], dir, undefined, runtime);
  expect(loaded.errors).toEqual([]);
  const extension = loaded.extensions[0];
  const ctx = {
    cwd: dir, mode: tui ? "tui" : "print", hasUI: tui,
    get sessionManager() { return session; }, isIdle: () => idle,
    hasPendingMessages: () => false,
    ui: {
      notify: (message: string) => notices.push(message),
      getTheme: (name: string) => ({ name }),
      setTheme: (next: string | { name?: string }) => {
        if (failTheme) return { success: false, error: "fixture theme failure" };
        theme = typeof next === "string" ? next : next.name!; return { success: true };
      },
      setStatus: (_key: string, value: string) => labels.push(value), setTitle: (title: string) => labels.push(title),
      ...(tui ? { get theme() { return themeFor; } } : {}),
    },
  } as unknown as ExtensionCommandContext;
  const emit = async (name: string, event: unknown = { type: name }) => {
    let result: unknown;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const command = (name: string, args: string = "") => extension.commands.get(name)!.handler(args, ctx);
  const tool = async (params: unknown) => {
    const result = await extension.tools.get("cyber_state")!.definition.execute("fixture", params, undefined, undefined, ctx as unknown as ExtensionToolContext);
    return { ...result, details: result.details as CyberState };
  };
  await emit("session_start", { type: "session_start", reason: "startup" });
  return { ctx, notices, labels, emit, command, tool, extension, get session() { return session; }, get theme() { return theme; }, setIdle: (value: boolean) => { idle = value; }, failTheme: () => { failTheme = true; }, switchSession: () => { session = SessionManager.create(dir, dir); }, reopen: () => { session = SessionManager.open(session.getSessionFile()!); } };
}

test("actual SDK loader registers commands and state tool writes durable mode-specific context", async () => {
  const h = await host();
  expect(h.extension.commands.get("offense")).toBeDefined();
  expect(h.extension.commands.get("defense")).toBeDefined();
  await h.tool({ action: "update", patch: { scope: ["local fixture only"], objective: "trace auth", coverage: ["signed-out route checked"], evidenceRefs: ["evidence/auth.redacted.txt"], nextSteps: ["prepare dossier"] } });
  await h.command("cyber", "mode defense");
  await h.tool({ action: "update", patch: { nextSteps: ["validate fixture hypothesis"] } });
  h.reopen();
  await h.emit("session_start", { type: "session_start", reason: "resume" });
  const result = await h.tool({ action: "get" });
  const state = result.details as any;
  expect(state.mode).toBe("defense");
  expect(state.scope).toEqual(["local fixture only"]);
  expect(state.modes.offense.nextSteps).toEqual(["prepare dossier"]);
  expect(state.modes.defense.nextSteps).toEqual(["validate fixture hypothesis"]);
  expect(h.extension.tools.size).toBe(4);
});

test("top-level /offense and /defense share the /cyber mode guard and switch path", async () => {
  const h = await host();
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
  h.setIdle(false); await h.command("defense"); h.setIdle(true);
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
  expect(h.notices[h.notices.length - 1]).toMatch(/active|running|idle/i);
  await h.command("defense");
  expect((await h.tool({ action: "get" })).details.mode).toBe("defense");
  expect(h.notices[h.notices.length - 1]).toMatch(/Cyber DEFENSE · checkpoint 1\b/);
  await h.command("offense");
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
  await h.command("defense", "extra arg");
  expect(h.notices[h.notices.length - 1]).toMatch(/Usage: \/defense \(no arguments\)/);
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
});

test("refuses switching during agent or nested tool work and leaves prior mode", async () => {
  const h = await host();
  h.setIdle(false); await h.command("cyber", "mode defense"); h.setIdle(true);
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
  await h.emit("tool_execution_start", { toolCallId: "parent/1", toolName: "bash" });
  await h.command("cyber", "mode defense");
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
  await h.emit("tool_execution_end", { toolCallId: "parent/1", toolName: "bash" });
  await h.command("cyber", "mode defense");
  expect((await h.tool({ action: "get" })).details.mode).toBe("defense");
  expect(h.notices.some((text) => /active|running|idle/i.test(text))).toBe(true);
});

test("single blue theme in both modes; badges are color-coded and distinct", async () => {
  const h = await host(true);
  expect(h.theme).toBe("cyber-defense");
  expect(await h.emit("tool_call", { toolName: "bash", input: {} })).toBeUndefined();
  await h.command("defense");
  expect(h.theme).toBe("cyber-defense");
  expect((await h.tool({ action: "get" })).details.mode).toBe("defense");
  expect(h.labels.some((label) => label.includes("DEFENSE"))).toBe(true);
  await h.command("offense");
  expect(h.theme).toBe("cyber-defense");
  const escape = /\[[0-9;]*m/;
  const offenseLabel = h.labels.find((label) => label.includes("OFFENSE"));
  const defenseLabel = h.labels.find((label) => label.includes("DEFENSE"));
  expect(offenseLabel).toMatch(escape);
  expect(defenseLabel).toMatch(escape);
  // Distinct badge colors, applied without changing the blue theme accent.
  expect(offenseLabel!.slice(0, offenseLabel!.indexOf("OFFENSE"))).not.toBe(defenseLabel!.slice(0, defenseLabel!.indexOf("DEFENSE")));
});

test("failed theme restoration blocks tools until resolved", async () => {
  const h = await host(true);
  await h.command("cyber", "checkpoint");
  h.failTheme();
  h.reopen();
  await h.emit("session_start", { type: "session_start", reason: "resume" });
  expect(h.notices.some((text) => text.includes("fixture theme failure"))).toBe(true);
  const blocked = await h.emit("tool_call", { toolName: "bash", input: {} });
  expect((blocked as { block?: boolean }).block).toBe(true);
});

test("rehydrates after native compaction and excludes obsolete injected context", async () => {
  const h = await host();
  await h.tool({ action: "update", patch: { objective: "recover exact objective", nextSteps: ["review evidence"] } });
  await h.command("cyber", "mode defense");
  const entry = h.session.getBranch()[0];
  expect(await h.emit("session_before_compact")).toBeUndefined();
  h.session.appendCompaction("native fixture summary", entry.id, 20000);
  h.reopen();
  await h.emit("session_start", { type: "session_start", reason: "resume" });
  const result = await h.emit("context", { type: "context", messages: [{ role: "user", content: "continue", timestamp: 3 }, { role: "custom", customType: "cyber.context", content: "obsolete", display: false, timestamp: 4 }] }) as any;
  expect(result.messages.filter((message: any) => message.customType === "cyber.context")).toHaveLength(1);
  expect(result.messages.at(-1).content).toContain("recover exact objective");
  const start = await h.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "BASE NATIVE PROMPT" }) as any;
  expect(start.systemPrompt).toContain("BASE NATIVE PROMPT");
  expect(start.systemPrompt).toContain("defensive investigation coordinator");
});

test("session replacement and tree navigation restore only the active branch", async () => {
  const h = await host();
  const root = h.session.getLeafId()!;
  await h.tool({ action: "update", patch: { objective: "private old branch" } });
  await h.command("defense");
  h.session.branch(root);
  await h.emit("session_tree");
  expect((await h.tool({ action: "get" })).details.objective).toBe("");
  h.switchSession();
  await h.emit("session_start", { type: "session_start", reason: "new" });
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
});

test("command arg errors reach the UI as a single Error-shaped notice", async () => {
  const h = await host(true);
  await h.command("cyber", "mode superuser");
  expect(h.notices).toHaveLength(1);
  expect(h.notices[0]).toMatch(/^Usage: \/cyber/);
  const h2 = await host();
  await h2.command("cyber", "mode offense extra");
  expect(h2.notices[0]).not.toContain("Error: Error:");
  expect((await h2.tool({ action: "get" })).details.mode).toBe("offense");
});

test("checkpoint reports durable revision and invalid model patch leaves state intact", async () => {
  const h = await host();
  await h.command("cyber", "checkpoint");
  expect(h.session.getBranch().some((entry) => entry.type === "custom" && entry.customType === "cyber.state.v1")).toBe(true);
  const before = h.session.getBranch().length;
  await expect(h.tool({ action: "update", patch: { objective: "api_key=do-not-store-this-value" } })).rejects.toThrow(/secret/i);
  expect(h.session.getBranch()).toHaveLength(before);
});
