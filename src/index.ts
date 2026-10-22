import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { STATE_ENTRY, brief, recoverState, updateState, type CyberState } from "./state.ts";
import { registerGithubTool } from "./tools/github.ts";
import { registerEvidenceTool } from "./tools/evidence.ts";
import { registerCyberJobsTool } from "./tools/jobs.ts";
import { registerAdapterTools } from "./tools/adapter-tools.ts";
import { registerMailgenTool } from "./tools/mailgen.ts";
import { registerBypassFetchTool } from "./tools/bypass-fetch.ts";
import { registerCyberToolsTool } from "./tools/cyber-tools.ts";
import { registerBrowserAutoTool } from "./tools/browser-auto.ts";
import { registerKnowledgeTool } from "./tools/knowledge.ts";
import { contextLine } from "./evidence/db.ts";
import { isPersistedSession, writeExitCard } from "./exit-card.ts";

const CYBER_THEME = "cyber-offense";
const resource = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const instructions = Object.fromEntries(["base", "offense"].map((name) => [name, readFileSync(resource(`prompts/${name}.md`), "utf8")]));

/** Absolute path to the prompt tree. Injected into the runtime prompt so the agent can reach the full spec and packages by absolute path. */
const PROMPTS_DIR = resource("prompts");
/**
 * Specialist role playbooks. The wired role definition under
 * config/cyber/agents/ points here by name instead of a path relative to the
 * working directory, so a specialist can load its full playbook from any cwd.
 */
const ROLE_FILES: Record<string, string> = {
  recon: "recon.md", "web-api": "web.md", auth: "auth.md", secrets: "secrets.md",
  exfil: "exfil.md", backdoor: "backdoor.md", reverse: "reverse.md", reviewer: "reviewer.md",
  validation: "validation.md", "vulnerability-research": "vuln-research.md",
  "offensive-operator": "offensive-operator.md", "source-remediation": "remediation.md",
};

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
function specPointer(): string {
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
    registerMailgenTool(pi);
  registerBypassFetchTool(pi);
  registerBrowserAutoTool(pi);
  registerCyberToolsTool(pi);
  registerKnowledgeTool(pi);
  let visualReady = false;
  const current = (ctx: ExtensionContext) => recoverState(ctx.sessionManager.getBranch());
  const save = (state: CyberState) => pi.appendEntry(STATE_ENTRY, state);
  /** The SDK error notice prefixes the printed message with "Error: "; pass the bare message so it never doubles. */
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  function notice(ctx: ExtensionContext, content: string, type: "info" | "warning" | "error" = "info") {
    if (ctx.hasUI) ctx.ui.notify(content, type);
    else pi.sendMessage({ customType: "cyber.notice", content, display: true, details: { type } });
  }
  /** The sole engagement label uses the theme's red accent when a TUI is available. */
  function badge(ctx: ExtensionContext): string {
    if (ctx.mode !== "tui") return "OFFENSE";
    try { return ctx.ui.theme.fg("accent", "OFFENSE"); }
    catch { return "OFFENSE"; }
  }
  function decorate(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    ctx.ui.setStatus("cyber", `${badge(ctx)}${visualReady ? "" : " · theme unavailable"}`);
    ctx.ui.setTitle("Pi Cyber · OFFENSE");
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
    try { applyTheme(ctx); decorate(ctx); }
    catch (error) { notice(ctx, errorText(error), "error"); }
  }
  pi.on("resources_discover", () => ({ themePaths: [resource("themes/cyber-offense.json")] }));
  pi.on("session_start", (_event, ctx) => { restore(ctx); });
  pi.on("session_tree", (_event, ctx) => { restore(ctx); });
  // The host stops the TUI before disposing the runtime, so this banner is
  // written into the restored terminal instead of the discarded alt screen.
  pi.on("session_shutdown", (event, ctx) => {
    if (event.reason !== "quit" || ctx.mode !== "tui") return;
    const manager = ctx.sessionManager;
    const sessionId = manager.getSessionId();
    if (!sessionId || !isPersistedSession(manager.getSessionFile())) return;
    writeExitCard({ sessionId, sessionDir: manager.getSessionDir(), cwd: manager.getCwd() });
  });
  // No compaction override: Pi retains its native summarizer and overflow retry.
  pi.on("before_agent_start", (event, ctx) => {
    const state = current(ctx);
    try { applyTheme(ctx); decorate(ctx); }
    catch (error) { visualReady = false; notice(ctx, errorText(error), "error"); }
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions.base}\n\n${renderOffense(ctx.model?.id)}` };
  });
  // Runs for every provider call, including a continuation after mid-turn compaction.
  // This message is ephemeral: it does not grow the session transcript.
  // One guarded, lazily-computed evidence hint line is appended after the state brief;
  // it never throws and never exposes stored contents.
  pi.on("context", (event, ctx) => {
    let evidenceSuffix = "";
    try { const line = contextLine(); if (line) evidenceSuffix = `\n${line}`; } catch { evidenceSuffix = ""; }
    const state = current(ctx);
    const spec = specPointer();
    const suffix = `${evidenceSuffix}\n${spec}`;
    return { messages: [
      ...event.messages.filter((message) => !(message.role === "custom" && message.customType === "cyber.context")),
      { role: "custom" as const, customType: "cyber.context", content: `${brief(state)}${suffix}`, display: false, timestamp: Date.now() },
    ] };
  });
  pi.on("tool_call", (_event, ctx) => {
    try { current(ctx); } catch (error) { return { block: true, reason: errorText(error) }; }
    if (ctx.mode === "tui" && !visualReady) return { block: true, reason: "Cyber theme restoration failed. Resolve the visible error and restart the session before executing tools." };
  });
  pi.registerCommand("cyber", {
    description: "Cyber engagement: status, checkpoint",
    handler: async (args, ctx) => {
      try {
        const words = args.trim().split(/\s+/).filter(Boolean);
        const command = words[0] || "status";
        const state = current(ctx);
        if (command === "status" && words.length <= 1) { notice(ctx, brief(state)); return; }
        if (command === "checkpoint" && words.length === 1) {
          const next = updateState(state, {}); save(next);
          notice(ctx, `Cyber ${badge(ctx)} checkpoint ${next.revision} appended to this session. Only recorded state is checkpointed; undisclosed tool results are not inferred.`); return;
        }
        throw new Error("Usage: /cyber [status|checkpoint]");
      } catch (error) { notice(ctx, errorText(error), "error"); }
    },
  });
  pi.registerCommand("offensespec", {
    description: "Load the offense operator specification into the session: /offensespec [full|behavior|contract|doctrine|doors|exfil|backdoor|secrets|evidence|status]",
    handler: async (args, ctx) => {
      try {
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
    description: "Read or replace selected durable engagement fields: scope, objective, coverage, evidence references and next steps. The engagement is offense-only; record established user scope only. No raw secrets. Lists replace their previous values; use get first.",
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
      "The harness has one offense workflow.",
    promptSnippet:
      "Load the offense operator specification, or the focused package for the task at hand, before acting on that area.",
    parameters: Type.Object({
      target: Type.String({ minLength: 1, maxLength: 64, description: "'full', or a package name." }),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const requested = params.target.trim().toLowerCase();
      if (requested.startsWith("role:")) {
        const role = requested.slice("role:".length);
        const file = ROLE_FILES[role];
        if (!file) throw new Error(`Unknown role "${role}". Known roles: ${Object.keys(ROLE_FILES).join(", ")}.`);
        const body = readPrompt(join("..", "agents", file));
        if (!body) throw new Error(`Role playbook "${role}" is not installed at agents/${file}.`);
        return { content: [{ type: "text", text: body }], details: { target: requested, chars: body.length } };
      }
      if (requested === "full" || requested === "offense-full" || requested === "spec") {
        const body = readPrompt("offense-full.md");
        if (!body) throw new Error("The offense specification is not installed at prompts/offense-full.md.");
        return { content: [{ type: "text", text: body }], details: { target: "full", chars: body.length } };
      }
      const file = PACKAGE_FILES[requested];
      if (!file) throw new Error(`Unknown specification target "${params.target}". Use "full", "role:<name>", or one of: ${Object.keys(PACKAGE_FILES).join(", ")}.`);
      const body = readPrompt(join("packages", file));
      if (!body) throw new Error(`Package "${requested}" is not installed at prompts/packages/${file}.`);
      return { content: [{ type: "text", text: body }], details: { target: requested, chars: body.length } };
    },
  });
}
