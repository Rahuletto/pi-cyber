import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STATE_ENTRY, brief, recoverState, switchMode, updateState, type CyberMode, type CyberState } from "./state.ts";
import { registerGithubTool } from "./tools/github.ts";

const resource = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const instructions = Object.fromEntries(["base", "offense", "defense"].map((name) => [name, readFileSync(resource(`prompts/${name}.md`), "utf8")]));
const strings = Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 24 });
const patchSchema = Type.Object({
  scope: Type.Optional(strings), objective: Type.Optional(Type.String({ maxLength: 2000 })),
  coverage: Type.Optional(strings), evidenceRefs: Type.Optional(strings), nextSteps: Type.Optional(strings),
}, { additionalProperties: false });

export default function cyber(pi: ExtensionAPI): void {
  registerGithubTool(pi);
  const runningTools = new Set<string>();
  let agentRunning = false;
  let visualReady = false;
  const current = (ctx: ExtensionContext) => recoverState(ctx.sessionManager.getBranch());
  const save = (state: CyberState) => pi.appendEntry(STATE_ENTRY, state);
  function notice(ctx: ExtensionContext, content: string, type: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(content, type);
    else pi.sendMessage({ customType: "cyber.notice", content, display: true, details: { type } });
  }
  function decorate(ctx: ExtensionContext, mode: CyberMode) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("cyber", `${mode.toUpperCase()}${visualReady ? "" : " · theme unavailable"}`);
    ctx.ui.setTitle(`Pi Cyber · ${mode.toUpperCase()}`);
  }
  function applyTheme(ctx: ExtensionContext, mode: CyberMode) {
    if (ctx.mode !== "tui") return;
    const name = `cyber-${mode}`;
    const theme = ctx.ui.getTheme(name);
    if (!theme) throw new Error(`Theme ${name} is unavailable. Load this package's theme resources and retry /cyber mode ${mode}.`);
    const result = ctx.ui.setTheme(theme);
    if (!result.success) throw new Error(result.error || `Could not apply ${name}.`);
    visualReady = true;
  }
  function restore(ctx: ExtensionContext) {
    visualReady = false;
    try { const state = current(ctx); applyTheme(ctx, state.mode); decorate(ctx, state.mode); }
    catch (error) { notice(ctx, String(error), "error"); }
  }
  pi.on("resources_discover", () => ({ themePaths: [resource("themes/cyber-offense.json"), resource("themes/cyber-defense.json")] }));
  pi.on("session_start", (_event, ctx) => { runningTools.clear(); agentRunning = false; restore(ctx); });
  pi.on("session_tree", (_event, ctx) => { restore(ctx); });
  pi.on("agent_start", () => { agentRunning = true; });
  pi.on("agent_end", () => { agentRunning = false; runningTools.clear(); });
  pi.on("tool_execution_start", (event) => { runningTools.add(event.toolCallId); });
  pi.on("tool_execution_end", (event) => { runningTools.delete(event.toolCallId); });
  // No compaction override: Pi retains its native summarizer and overflow retry.
  pi.on("before_agent_start", (event, ctx) => {
    const state = current(ctx);
    try { applyTheme(ctx, state.mode); decorate(ctx, state.mode); }
    catch (error) { visualReady = false; notice(ctx, String(error), "error"); }
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions.base}\n\n${instructions[state.mode]}` };
  });
  // Runs for every provider call, including a continuation after mid-turn compaction.
  // This message is ephemeral: it does not grow the session transcript.
  pi.on("context", (event, ctx) => ({ messages: [
    ...event.messages.filter((message) => !(message.role === "custom" && message.customType === "cyber.context")),
    { role: "custom" as const, customType: "cyber.context", content: brief(current(ctx)), display: false, timestamp: Date.now() },
  ] }));
  pi.on("tool_call", (_event, ctx) => {
    try { current(ctx); } catch (error) { return { block: true, reason: String(error) }; }
    if (ctx.mode === "tui" && !visualReady) return { block: true, reason: "Cyber theme restoration failed. Resolve the visible error and retry /cyber mode before executing tools." };
  });
  pi.registerCommand("cyber", {
    description: "Cyber engagement: mode offense|defense, status, checkpoint",
    handler: async (args, ctx) => {
      try {
        const words = args.trim().split(/\s+/).filter(Boolean);
        const command = words[0] || "status";
        const state = current(ctx);
        if (command === "status" && words.length <= 1) { notice(ctx, brief(state)); return; }
        if (command === "checkpoint" && words.length === 1) {
          const next = updateState(state, {}); save(next);
          notice(ctx, `Cyber ${next.mode.toUpperCase()} checkpoint ${next.revision} appended to this session. Only recorded state is checkpointed; undisclosed tool results are not inferred.`); return;
        }
        if (command !== "mode" || words.length !== 2 || !["offense", "defense"].includes(words[1])) throw new Error("Usage: /cyber mode offense|defense · /cyber status · /cyber checkpoint");
        if (agentRunning || !ctx.isIdle() || runningTools.size || ctx.hasPendingMessages()) throw new Error("Mode switch refused while agent/tool work or queued messages are active. Stop or drain work first, then retry.");
        const next = switchMode(state, words[1] as CyberMode);
        applyTheme(ctx, next.mode);
        try { save(next); } catch (error) {
          try { applyTheme(ctx, state.mode); } catch { visualReady = false; }
          throw error;
        }
        decorate(ctx, next.mode);
        notice(ctx, `Cyber ${next.mode.toUpperCase()} · checkpoint ${next.revision}. Engagement scope and objective retained.`);
      } catch (error) { notice(ctx, String(error), "error"); }
    },
  });
  pi.registerTool({
    name: "cyber_state", label: "Cyber state",
    description: "Read or replace selected durable engagement fields. Scope/objective are shared; coverage, evidenceRefs and nextSteps belong to the active mode. Record established user scope only. No raw secrets. Lists replace their previous values; use get first. Mode changes require the user's /cyber mode command.",
    promptSnippet: "Maintain concise engagement scope, objective, coverage, sanitized evidence references and next steps across compaction.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("get") }, { additionalProperties: false }),
      Type.Object({ action: Type.Literal("update"), patch: patchSchema }, { additionalProperties: false }),
    ]),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const state = current(ctx);
      const next = params.action === "update" ? updateState(state, params.patch) : state;
      if (params.action === "update") save(next);
      return { content: [{ type: "text", text: brief(next) }], details: next, structuredContent: JSON.parse(JSON.stringify(next)) };
    },
  });
}
