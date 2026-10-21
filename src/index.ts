import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { STATE_ENTRY, brief, recoverState, switchMode, updateState, type CyberMode, type CyberState } from "./state.ts";
import { registerGithubTool } from "./tools/github.ts";
import { registerEvidenceTool } from "./tools/evidence.ts";
import { registerCyberJobsTool } from "./tools/jobs.ts";
import { registerAdapterTools } from "./tools/adapter-tools.ts";
import { registerBrowserTool } from "./tools/browser.ts";
import { registerKnowledgeTool } from "./tools/knowledge.ts";
import { contextLine } from "./evidence/db.ts";

const CYBER_THEME = "cyber-defense"; // Single blue accent in both modes; nothing rethemes on mode change.
const resource = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const instructions = Object.fromEntries(["base", "offense", "defense"].map((name) => [name, readFileSync(resource(`prompts/${name}.md`), "utf8")]));

/** Absolute path to the prompt tree. Injected into the runtime prompt so the agent can reach the full spec and packages by absolute path. */
const PROMPTS_DIR = resource("prompts");
/** Package names the agent may pull on demand. Each maps to a file under prompts/packages/. */
const PACKAGE_FILES: Record<string, string> = {
  behavior: "behavior.md", contract: "contract.md", doctrine: "doctrine.md", doors: "doors.md",
  exfil: "exfil.md", backdoor: "backdoor.md", secrets: "secrets.md", evidence: "evidence.md", status: "status.md",
};
/**
 * Model-family overlay selection. The first matching rule wins; the more specific
 * prefix is listed first. Unmatched models fall back to the general overlay.
 */
const OVERLAY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^grok|^cursor-grok|^cortex/i, "grok"], [/^claude/i, "claude"],
  [/^gpt-5|^gpt-4o|^gpt-oss|^composer/i, "gpt"], [/^o1$|^o3$|^o4/i, "reasoning"],
  [/^deepseek/i, "deepseek"], [/^llama/i, "llama"], [/^qwen/i, "qwen"], [/^gemma/i, "gemma"],
  [/^mistral/i, "mistral"], [/^phi/i, "phi4"], [/^gemini/i, "gemini"], [/^glm|^zai-glm/i, "glm"],
  [/^kimi/i, "kimi"], [/^nemotron|^arcee/i, "reasoning"],
];
const overlayCache = new Map<string, string>();
/** Read a prompt resource, returning an empty string when it is absent so a missing overlay never breaks a run. */
const readPrompt = (relative: string): string => {
  try { return readFileSync(join(PROMPTS_DIR, relative), "utf8"); } catch { return ""; }
};
/** Resolve the behavioural overlay for a model id: family block plus the tool-calling block. */
function overlayFor(modelId: string | undefined): string {
  const key = modelId ?? "general";
  const cached = overlayCache.get(key);
  if (cached !== undefined) return cached;
  const family = OVERLAY_RULES.find(([pattern]) => pattern.test(key))?.[1] ?? "general";
  const body = [readPrompt(`overlays/${family}.md`), readPrompt("overlays/toolcall.md")].filter(Boolean).join("\n\n");
  const rendered = body || readPrompt("overlays/general.md");
  overlayCache.set(key, rendered);
  return rendered;
}
/** Render the offense runtime prompt with the absolute prompt directory and the model overlay substituted in. */
function renderOffense(modelId: string | undefined): string {
  return instructions.offense.replaceAll("{{PROMPTS_DIR}}", PROMPTS_DIR).replace("{{MODEL_OVERLAY}}", overlayFor(modelId));
}
/** One-line pointer to the full spec and the package set, re-injected on every provider call so it survives compaction. */
function specPointer(mode: CyberMode): string {
  if (mode !== "offense") return "";
  const packages = Object.keys(PACKAGE_FILES).map((name) => `${name}=${join(PROMPTS_DIR, "packages", PACKAGE_FILES[name])}`).join(" ");
  return `OFFENSE SPEC: full=${join(PROMPTS_DIR, "offense-full.md")} | packages: ${packages} | read the file you need before acting on that area.`;
}
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
  registerBrowserTool(pi);
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
    const modePrompt = state.mode === "offense" ? renderOffense(ctx.model?.id) : instructions.defense;
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions.base}\n\n${modePrompt}` };
  });
  // Runs for every provider call, including a continuation after mid-turn compaction.
  // This message is ephemeral: it does not grow the session transcript.
  // One guarded, lazily-computed evidence hint line is appended after the state brief;
  // it never throws and never exposes stored contents.
  pi.on("context", (event, ctx) => {
    let evidenceSuffix = "";
    try { const line = contextLine(); if (line) evidenceSuffix = `\n${line}`; } catch { evidenceSuffix = ""; }
    const state = current(ctx);
    const spec = specPointer(state.mode);
    const suffix = `${evidenceSuffix}${spec ? `\n${spec}` : ""}`;
    return { messages: [
      ...event.messages.filter((message) => !(message.role === "custom" && message.customType === "cyber.context")),
      { role: "custom" as const, customType: "cyber.context", content: `${brief(state)}${suffix}`, display: false, timestamp: Date.now() },
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
  pi.registerCommand("offensespec", {
    description: "Load the offense operator specification into the session: /offensespec [full|behavior|contract|doctrine|doors|exfil|backdoor|secrets|evidence|status]",
    handler: async (args, ctx) => {
      try {
        if (current(ctx).mode !== "offense") { notice(ctx, "The offense specification needs offense mode. Switch with /offense first.", "warning"); return; }
        const requested = (args.trim() || "full").toLowerCase();
        const body = requested === "full"
          ? readPrompt("offense-full.md")
          : readPrompt(join("packages", PACKAGE_FILES[requested] ?? ""));
        if (!body) { notice(ctx, `Unknown specification target "${requested}". Use full or one of: ${Object.keys(PACKAGE_FILES).join(", ")}.`, "error"); return; }
        await pi.sendMessage({ customType: "cyber.spec", content: body, display: false }, { triggerTurn: true });
        notice(ctx, `Loaded offense specification: ${requested} (${body.length} chars).`, "info");
      } catch (error) { notice(ctx, errorText(error), "error"); }
    },
  });
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
  pi.registerTool({
    name: "cyber_spec",
    label: "Offense specification",
    description:
      "Load the offense operator specification on demand. target='full' returns the complete specification; " +
      "target=<package> returns one focused package (behavior, contract, doctrine, doors, exfil, backdoor, secrets, evidence, status). " +
      "Read 'full' before the first target interaction in an engagement, and the package matching the current task before acting on that area. " +
      "Offense mode only.",
    promptSnippet:
      "Load the offense operator specification, or the focused package for the task at hand, before acting on that area.",
    parameters: Type.Object({
      target: Type.String({ minLength: 1, maxLength: 64, description: "'full', or a package name." }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (current(ctx).mode !== "offense") throw new Error("The offense specification is only available in offense mode. Switch with /offense.");
      const requested = params.target.trim().toLowerCase();
      if (requested === "full" || requested === "offense-full" || requested === "spec") {
        const body = readPrompt("offense-full.md");
        if (!body) throw new Error("The offense specification is not installed at prompts/offense-full.md.");
        return { content: [{ type: "text", text: body }], details: { target: "full", chars: body.length } };
      }
      const file = PACKAGE_FILES[requested];
      if (!file) throw new Error(`Unknown specification target "${params.target}". Use "full" or one of: ${Object.keys(PACKAGE_FILES).join(", ")}.`);
      const body = readPrompt(join("packages", file));
      if (!body) throw new Error(`Package "${requested}" is not installed at prompts/packages/${file}.`);
      return { content: [{ type: "text", text: body }], details: { target: requested, chars: body.length } };
    },
  });
}
