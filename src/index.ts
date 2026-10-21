import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STATE_ENTRY, brief, recoverState, switchMode, updateState, type CyberMode, type CyberState } from "./state.ts";
import { registerGithubTool } from "./tools/github.ts";
import { registerEvidenceTool } from "./tools/evidence.ts";
import { registerCyberJobsTool } from "./tools/jobs.ts";
import { registerAdapterTools } from "./tools/adapter-tools.ts";
import { registerKnowledgeTool } from "./tools/knowledge.ts";
import { contextLine } from "./evidence/db.ts";

const CYBER_THEME = "cyber-defense"; // Single blue accent in both modes; nothing rethemes on mode change.
const resource = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const instructions = Object.fromEntries(["base", "offense", "defense"].map((name) => [name, readFileSync(resource(`prompts/${name}.md`), "utf8")]));
const strings = Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 24 });
const patchSchema = Type.Object({
  scope: Type.Optional(strings), objective: Type.Optional(Type.String({ maxLength: 2000 })),
  coverage: Type.Optional(strings), evidenceRefs: Type.Optional(strings), nextSteps: Type.Optional(strings),
}, { additionalProperties: false });

export default function cyber(pi: ExtensionAPI): void {
  registerGithubTool(pi);
  registerEvidenceTool(pi);
  registerCyberJobsTool(pi);
  registerAdapterTools(pi);
  registerKnowledgeTool(pi);
  const runningTools = new Set<string>();
  let agentRunning = false;
  let visualReady = false;
  const current = (ctx: ExtensionContext) => recoverState(ctx.sessionManager.getBranch());
  const save = (state: CyberState) => pi.appendEntry(STATE_ENTRY, state);
  /** The SDK error notice prefixes the printed message with "Error: "; pass the bare message so it never doubles. */
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  function notice(ctx: ExtensionContext, content: string, type: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(content, type);
    else pi.sendMessage({ customType: "cyber.notice", content, display: true, details: { type } });
  }
  /** OFFENSE renders red and DEFENSE blue (belt-color convention) whenever a theme is reachable; plain text otherwise (print mode, fixture UIs). */
  function badge(ctx: ExtensionContext, mode: CyberMode): string {
    if (ctx.mode !== "tui") return mode.toUpperCase();
    try { return ctx.ui.theme.fg(mode === "offense" ? "error" : "accent", mode.toUpperCase()); }
    catch { return mode.toUpperCase(); }
  }
  function decorate(ctx: ExtensionContext, mode: CyberMode) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("cyber", `${badge(ctx, mode)}${visualReady ? "" : " · theme unavailable"}`);
    ctx.ui.setTitle(`Pi Cyber · ${mode.toUpperCase()}`);
  }
  function applyTheme(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const theme = ctx.ui.getTheme(CYBER_THEME);
    if (!theme) throw new Error(`Theme ${CYBER_THEME} is unavailable. Load this package's theme resources and rerun /cyber status to restore it.`);
    const result = ctx.ui.setTheme(theme);
    if (!result.success) throw new Error(result.error || `Could not apply ${CYBER_THEME}.`);
    visualReady = true;
  }
  function restore(ctx: ExtensionContext) {
    visualReady = false;
    try { applyTheme(ctx); decorate(ctx, current(ctx).mode); }
    catch (error) { notice(ctx, errorText(error), "error"); }
  }
  // Shared guard + persistence path for /cyber mode, /offense and /defense.
  async function setMode(ctx: ExtensionContext, state: CyberState, mode: CyberMode) {
    if (agentRunning || !ctx.isIdle() || runningTools.size || ctx.hasPendingMessages()) throw new Error("Mode switch refused while agent/tool work or queued messages are active. Stop or drain work first, then retry.");
    const next = switchMode(state, mode);
    save(next);
    decorate(ctx, next.mode);
    notice(ctx, `Cyber ${badge(ctx, next.mode)} · checkpoint ${next.revision}. Engagement scope and objective retained.`);
  }
  const registerModeCommand = (mode: CyberMode) => pi.registerCommand(mode, {
    description: `Cyber engagement ${mode.toUpperCase()} mode (same switch as /cyber mode ${mode}).`,
    handler: async (args, ctx) => {
      try {
        if (args.trim()) throw new Error(`Usage: /${mode} (no arguments).`);
        await setMode(ctx, current(ctx), mode);
      } catch (error) { notice(ctx, errorText(error), "error"); }
    },
  });
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
    try { applyTheme(ctx); decorate(ctx, state.mode); }
    catch (error) { visualReady = false; notice(ctx, errorText(error), "error"); }
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions.base}\n\n${instructions[state.mode]}` };
  });
  // Runs for every provider call, including a continuation after mid-turn compaction.
  // This message is ephemeral: it does not grow the session transcript.
  // One guarded, lazily-computed evidence hint line is appended after the state brief;
  // it never throws and never exposes stored contents.
  pi.on("context", (event, ctx) => {
    let evidenceSuffix = "";
    try { const line = contextLine(); if (line) evidenceSuffix = `\n${line}`; } catch { evidenceSuffix = ""; }
    return { messages: [
      ...event.messages.filter((message) => !(message.role === "custom" && message.customType === "cyber.context")),
      { role: "custom" as const, customType: "cyber.context", content: `${brief(current(ctx))}${evidenceSuffix}`, display: false, timestamp: Date.now() },
    ] };
  });
  pi.on("tool_call", (_event, ctx) => {
    try { current(ctx); } catch (error) { return { block: true, reason: errorText(error) }; }
    if (ctx.mode === "tui" && !visualReady) return { block: true, reason: "Cyber theme restoration failed. Resolve the visible error and retry /cyber mode before executing tools." };
  });
  pi.registerCommand("cyber", {
    description: "Cyber engagement: status, checkpoint, mode offense|defense (mode also via /offense and /defense)",
    handler: async (args, ctx) => {
      try {
        const words = args.trim().split(/\s+/).filter(Boolean);
        const command = words[0] || "status";
        const state = current(ctx);
        if (command === "status" && words.length <= 1) { notice(ctx, brief(state)); return; }
        if (command === "checkpoint" && words.length === 1) {
          const next = updateState(state, {}); save(next);
          notice(ctx, `Cyber ${badge(ctx, next.mode)} checkpoint ${next.revision} appended to this session. Only recorded state is checkpointed; undisclosed tool results are not inferred.`); return;
        }
        if (command === "mode" && words.length === 2 && (words[1] === "offense" || words[1] === "defense")) {
          await setMode(ctx, state, words[1] as CyberMode); return;
        }
        throw new Error("Usage: /cyber [status|checkpoint|mode offense|defense] · /offense · /defense");
      } catch (error) { notice(ctx, errorText(error), "error"); }
    },
  });
  registerModeCommand("offense");
  registerModeCommand("defense");
  pi.registerTool({
    name: "cyber_state", label: "Cyber state",
    description: "Read or replace selected durable engagement fields. Scope/objective are shared; coverage, evidenceRefs and nextSteps belong to the active mode. Record established user scope only. No raw secrets. Lists replace their previous values; use get first. Mode changes require the user's /offense or /defense command (also /cyber mode offense|defense).",
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
