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
const themeFor = loadThemeFromPath(resolve("themes/cyber-offense.json"), "truecolor");
async function host(tui = false) {
  const dir = await mkdtemp(resolve(tmpdir(), "cyber-test-")); directories.push(dir);
  let session = SessionManager.create(dir, dir);
  session.appendMessage({ role: "user", content: "controlled local fixture", timestamp: 1 });
  const notices: string[] = [], labels: string[] = [];
  let idle = true, failTheme = false, theme = "cyber-offense";
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

test("actual SDK loader exposes one offense state and durable cyber checkpoints", async () => {
  const h = await host();
  expect(h.extension.commands.has("offense")).toBe(false);
  expect(h.extension.commands.has("defense")).toBe(false);
  await h.tool({ action: "update", patch: { scope: ["local fixture only"], objective: "trace auth", coverage: ["signed-out route checked"], evidenceRefs: ["evidence/auth.redacted.txt"], nextSteps: ["prepare dossier"] } });
  await h.command("cyber", "checkpoint");
  h.reopen();
  await h.emit("session_start", { type: "session_start", reason: "resume" });
  const result = await h.tool({ action: "get" });
  const state = result.details;
  expect(state.mode).toBe("offense");
  expect(state.scope).toEqual(["local fixture only"]);
  expect(state.modes.offense.nextSteps).toEqual(["prepare dossier"]);
  expect(Object.keys(state.modes)).toEqual(["offense"]);
  expect(h.extension.tools.size).toBe(23);
  expect(h.extension.tools.has("cyber_artifacts")).toBe(true);
});

test("cyber command rejects removed mode switching and keeps offense active", async () => {
  const h = await host();
  await h.command("cyber", "mode defense");
  expect(h.notices.at(-1)).toMatch(/Usage: \/cyber \[status\|checkpoint\]/);
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
});

test("state tool rejects mismatched action fields without appending a checkpoint", async () => {
  const h = await host();
  const before = h.session.getBranch().length;
  for (const params of [
    { action: "get", patch: {} },
    { action: "update" },
    { action: "delete" },
    { action: "update", patch: { unknown: true } },
  ]) {
    await expect(h.tool(params)).rejects.toThrow();
    expect(h.session.getBranch()).toHaveLength(before);
  }
  expect((await h.tool({ action: "get" })).details.revision).toBe(0);
});

test("single offense theme stays active and renders a red offense badge", async () => {
  const h = await host(true);
  expect(h.theme).toBe("cyber-offense");
  expect(await h.emit("tool_call", { toolName: "bash", input: {} })).toBeUndefined();
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
  const offenseLabel = h.labels.find((label) => label.includes("OFFENSE"));
  expect(offenseLabel).toMatch(/\u001b\[[0-9;]*m/);
  expect(h.labels.some((label) => label.includes("DEFENSE"))).toBe(false);
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
  await h.command("cyber", "checkpoint");
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
  expect(start.systemPrompt).toContain("offensive-security operator");
});

test("session replacement and tree navigation restore only the active branch", async () => {
  const h = await host();
  const root = h.session.getLeafId()!;
  await h.tool({ action: "update", patch: { objective: "private old branch" } });
  await h.command("cyber", "checkpoint");
  h.session.branch(root);
  await h.emit("session_tree");
  expect((await h.tool({ action: "get" })).details.objective).toBe("");
  h.switchSession();
  await h.emit("session_start", { type: "session_start", reason: "new" });
  expect((await h.tool({ action: "get" })).details.mode).toBe("offense");
});

test("command arg errors reach the UI as a single Error-shaped notice", async () => {
  const h = await host(true);
  await h.command("cyber", "mode defense");
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

test("cyber_spec serves the full specification and every package to the agent", async () => {
  const h = await host();
  const call = async (target: string) => {
    const result = await h.extension.tools.get("cyber_spec")!.definition.execute("fixture", { target }, undefined, undefined, h.ctx as unknown as ExtensionToolContext);
    const content = result.content as { type: "text"; text: string }[];
    return String(content[0]?.text ?? "");
  };
  expect(await call("full")).toContain("# 30. ACTIVATION");
  expect(await call("doors")).toContain("find the other 98");
  expect(await call("status")).toContain("PHASE N COMPLETE");
  await expect(call("nonexistent")).rejects.toThrow(/Unknown specification target/);
  await expect(call("full")).resolves.toContain("# 30. ACTIVATION");
});

test("the context hook always re-injects the offense spec pointer", async () => {
  const h = await host();
  const briefOf = async (): Promise<string> => {
    const result = (await h.emit("context", { type: "context", messages: [] })) as { messages: { customType?: string; content: string }[] };
    return result.messages.find((message) => message.customType === "cyber.context")!.content;
  };
  const offense = await briefOf();
  expect(offense).toContain("OFFENSE SPEC:");
  expect(offense).toContain("offense-full.md");
  expect(offense).toContain("packages");
  expect(await briefOf()).toContain("OFFENSE SPEC:");
});

test("/offensespec loads the specification into the session and refuses an unknown target", async () => {
  const h = await host();
  await h.command("offensespec", "full");
  expect(h.notices.some((notice) => notice.includes("Loaded offense specification: full"))).toBe(true);
  await h.command("offensespec", "not-a-package");
  expect(h.notices[h.notices.length - 1]).toMatch(/Unknown specification target/);
});
