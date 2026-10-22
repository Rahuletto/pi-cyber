import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { report } from "../doctor.ts";
import { containsSecretLike } from "../evidence/secrets.ts";

/**
 * `cyber_tools` — introspection for this harness's own tool surface.
 *
 * Why it exists: the Pi runtime injects every tool's schema into the model
 * context, so a bare registry dump would duplicate that. The real gap is
 * readiness-language: the doctrine says "a cataloged binary is a promise, not
 * a capability", and the only way to check was `bun run doctor` through bash.
 * Both actions here are read-only introspection of the machine, never the
 * target: `list` snapshots exactly what THIS session can call (survives into
 * compaction rehydration as a written fact), `readiness` reuses the doctor's
 * manifest × on-disk state machine (cataloged | installed | available |
 * enabled | validated) plus runtime binary presence.
 */

const MAX_OUTPUT_CHARS = 16_000;
const TRUNCATED = "[truncated]";

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let cut = text.slice(0, MAX_OUTPUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

/** First sentence of a description — one line per tool, no schema walls. */
function firstSentence(description: string | undefined): string {
  if (!description) return "(no description)";
  const sentence = description.split(/(?<=\.)\s/)[0] ?? description;
  return sentence.length > 200 ? sentence.slice(0, 199) + "…" : sentence;
}

/** Registered Pi tools that carry the cyber_ prefix, sorted. */
export function registeredCyberTools(tools: readonly { name: string; description?: string }[]): { name: string; description: string }[] {
  return tools
    .filter((tool) => tool.name.startsWith("cyber_"))
    .map((tool) => ({ name: tool.name, description: firstSentence(tool.description) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("list"),
    Type.Literal("readiness"),
  ], { description: "list: registered cyber_* tools in THIS session (live registry). readiness: manifest catalog × on-disk state — the typed replacement for 'bun run doctor'." }),
}, { additionalProperties: false });

type CyberToolsParams = Static<typeof parameters>;

const cyberToolsTool: ToolDefinition<typeof parameters> = {
  name: "cyber_tools",
  label: "cyber tools",
  description:
    "Introspect this harness's own tool surface (read-only, never the target). " +
    "Actions: list (registered cyber_* tools in this session), readiness (manifest catalog with the on-disk state of every cataloged binary — cataloged/installed/available/validated — the typed replacement for 'bun run doctor').",
  promptSnippet:
    "Use cyber_tools readiness instead of shelling out to bun run doctor whenever a binary's state is in doubt.",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  async execute(
    _toolCallId: string,
    params: CyberToolsParams,
    signal: AbortSignal | undefined,
    _onUpdate,
    ctx: ExtensionToolContext
  ): Promise<AgentToolResult> {
    if (params.action === "list") {
      const tools = registeredCyberTools(ctx.tools);
      const text = [
        `this session registers ${tools.length} cyber_* tools:`,
        ...tools.map((tool) => `- ${tool.name}: ${tool.description}`),
      ].join("\n");
      return { content: [{ type: "text", text: clip(text) }], details: { action: "list", count: tools.length } };
    }
    const doc = await report();
    const rows = doc.tools.map((row) => `${row.name.padEnd(18)} ${row.disposition.padEnd(10)} ${row.state}`);
    const runtime = doc.runtime.map((entry) => `${entry.name.padEnd(18)} ${entry.available ? "available" : "MISSING"}`);
    const text = [
      `platform: ${doc.platform}/${doc.architecture}`,
      `state: ${doc.note}`,
      "",
      "MANIFEST (name / disposition / state):",
      ...rows,
      "",
      "RUNTIME (PATH presence only):",
      ...runtime,
    ].join("\n");
    const details = {
      action: "readiness",
      cataloged: doc.tools.filter((row) => row.state === "cataloged").map((row) => row.name),
      available: doc.tools.filter((row) => row.state === "available").map((row) => row.name),
      validated: doc.tools.filter((row) => row.state === "validated").map((row) => row.name),
      runtimeMissing: doc.runtime.filter((entry) => !entry.available).map((entry) => entry.name),
    };
    if (containsSecretLike(text)) {
      // An introspection of manifest names cannot carry secrets; the check is
      // the store's entry-point contract, honored here for consistency.
      throw new Error("introspection snapshot tripped the secret heuristic — refusing to render");
    }
    return { content: [{ type: "text", text: clip(text) }], details };
  },
};

export function registerCyberToolsTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(cyberToolsTool);
}
