import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { SessionManager, createExtensionRuntime, type ExtensionCommandContext, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { CyberState } from "../src/state.ts";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
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
    },
  } as unknown as ExtensionCommandContext;
  const emit = async (name: string, event: unknown = { type: name }) => {
    let result: unknown;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  const command = (args: string) => extension.commands.get("cyber")!.handler(args, ctx);
  const tool = async (params: unknown) => {
    const result = await extension.tools.get("cyber_state")!.definition.execute("fixture", params, undefined, undefined, ctx as unknown as ExtensionToolContext);
    return { ...result, details: result.details as CyberState };
  };
  await emit("session_start", { type: "session_start", reason: "startup" });
  return { ctx, notices, labels, emit, command, tool, extension, get session() { return session; }, get theme() { return theme; }, setIdle: (value: boolean) => { idle = value; }, failTheme: () => { failTheme = true; }, switchSession: () => { session = SessionManager.create(dir, dir); }, reopen: () => { session = SessionManager.open(session.getSessionFile()!); } };
}

test("actual SDK loader registers extension and state tool writes durable mode-specific context", async () => {
  const h = await host();
  await h.tool({ action: "update", patch: { scope: ["local fixture only"], objective: "trace auth", coverage: ["signed-out route checked"], evidenceRefs: ["evidence/auth.redacted.txt"], nextSteps: ["prepare dossier"] } });
  await h.command("mode offense");
  await h.tool({ action: "update", patch: { nextSteps: ["validate fixture hypothesis"] } });
  h.reopen();
  await h.emit("session_start", { type: "session_start", reason: "resume" });
  const result = await h.tool({ action: "get" });
  const state = result.details as any;
  expect(state.mode).toBe("offense");
  expect(state.scope).toEqual(["local fixture only"]);
  expect(state.modes.defense.nextSteps).toEqual(["prepare dossier"]);
  expect(state.modes.offense.nextSteps).toEqual(["validate fixture hypothesis"]);
  expect(h.extension.tools.size).toBe(2);
});

test("refuses switching during agent or nested tool work and leaves prior mode", async () => {
  const h = await host();
  h.setIdle(false); await h.command("mode offense"); h.setIdle(true);
  expect((await h.tool({ action: "get" })).details.mode).toBe("defense");
  await h.emit("tool_execution_start", { toolCallId: "parent/1", toolName: "bash" });
  await h.command("mode offense");
  expect((await h.tool({ action: "get" })).details.mode).toBe("defense");
  await h.emit("tool_execution_end", { toolCallId: "parent/1", toolName: "bash" });
  await h.command("mode offense");
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
  expect(h.notices.some((text) => /active|running|idle/i.test(text))).toBe(true);
});

test("theme failure does not persist a new mode and normal native calls remain unblocked", async () => {
  const h = await host(true);
  await h.command("mode offense");
  expect(h.theme).toBe("cyber-offense");
  expect(h.labels.some((label) => label.includes("OFFENSE"))).toBe(true);
  expect(await h.emit("tool_call", { toolName: "bash", input: {} })).toBeUndefined();
  h.failTheme(); await h.command("mode defense");
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
  expect(h.notices.some((text) => text.includes("fixture theme failure"))).toBe(true);
});

test("rehydrates after native compaction and excludes obsolete injected context", async () => {
  const h = await host();
  await h.tool({ action: "update", patch: { objective: "recover exact objective", nextSteps: ["review evidence"] } });
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
  await h.command("mode offense");
  h.session.branch(root);
  await h.emit("session_tree");
  expect((await h.tool({ action: "get" })).details.objective).toBe("");
  h.switchSession();
  await h.emit("session_start", { type: "session_start", reason: "new" });
  expect((await h.tool({ action: "get" })).details.mode).toBe("defense");
});

test("checkpoint reports durable revision and invalid model patch leaves state intact", async () => {
  const h = await host();
  await h.command("checkpoint");
  expect(h.session.getBranch().some((entry) => entry.type === "custom" && entry.customType === "cyber.state.v1")).toBe(true);
  const before = h.session.getBranch().length;
  await expect(h.tool({ action: "update", patch: { objective: "api_key=do-not-store-this-value" } })).rejects.toThrow(/secret/i);
  expect(h.session.getBranch()).toHaveLength(before);
});
