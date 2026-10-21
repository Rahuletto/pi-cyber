import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  FINDING_STATES,
  SENSITIVITIES,
  openEvidence,
  type EvidenceRow,
  type FindingRow,
  type FindingState,
  type Sensitivity,
} from "../evidence/db.ts";
import { SECRET_REFUSAL_MESSAGE } from "../evidence/secrets.ts";
import { findingsMap } from "../report/diagrams.ts";

/**
 * `cyber_evidence` — the model-facing surface of the durable evidence store.
 *
 * Actions: add (persist evidence text/refs), read (recent evidence rows),
 * findings (finding-state list), summary (bounded brief). Results are clipped
 * at 24 KiB and capped at 50 rows before re-entering the model context. The
 * store refuses raw-secrets on every write path.
 *
 * The `findings` action takes an OPTIONAL `diagram` flag (default false, so
 * the default behaviour is unchanged): when true, a mermaid lifecycle map of
 * the returned findings is appended to the text result.
 */

const MAX_OUTPUT_CHARS = 24 * 1024;
const MAX_ROW_TEXT_CHARS = 2000;
const MAX_ROWS = 50;
const TRUNCATED = "[truncated]";

/** Clip a result to the 24 KiB output budget, never splitting a surrogate pair. */
export function clipOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let cut = text.slice(0, MAX_OUTPUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("add"),
    Type.Literal("read"),
    Type.Literal("findings"),
    Type.Literal("summary"),
  ], { description: "Evidence interaction to perform." }),
  kind: Type.Optional(Type.String({ maxLength: 64, description: "Evidence kind, e.g. httpx, nuclei, note (add; filter for read)." })),
  text: Type.Optional(Type.String({ maxLength: 32000, description: "Evidence text to persist (add). Never include raw secrets; store redacted artifact references." })),
  refs: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 24, description: "Artifact/proof references associated with the evidence (add)." })),
  sensitivity: Type.Optional(Type.Union(SENSITIVITIES.map((s) => Type.Literal(s)), { description: "Sensitivity label (add). Default: internal." })),
  state: Type.Optional(Type.Union(FINDING_STATES.map((s) => Type.Literal(s)), { description: "Filter findings by state (findings)." })),
  mode: Type.Optional(Type.Union([Type.Literal("offense"), Type.Literal("defense")], { description: "Mode label to include in the summary (summary)." })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 50, description: "Max rows returned (read, findings); default 50, hard cap 50." })),
  diagram: Type.Optional(Type.Boolean({ description: "Append a mermaid lifecycle map of the returned findings (findings action). Default false — the text result is unchanged without it." })),
}, { additionalProperties: false });

type EvidenceParams = Static<typeof parameters>;

function clipRowText(text: string): string {
  return text.length > MAX_ROW_TEXT_CHARS ? `${text.slice(0, MAX_ROW_TEXT_CHARS)}${TRUNCATED}` : text;
}

function renderEvidenceRows(rows: EvidenceRow[]): string {  if (!rows.length) return "No evidence rows recorded yet.";
  return rows.map((row) => [
    `#${row.id} · ${row.ts} · kind=${row.kind} · sensitivity=${row.sensitivity} · sha256:${row.hash.slice(0, 12)}`,
    row.refs.length ? `refs: ${row.refs.join(", ")}` : null,
    clipRowText(row.text),
    "---",
  ].filter(Boolean).join("\n")).join("\n");
}

function renderFindingRows(rows: FindingRow[]): string {
  if (!rows.length) return "No findings recorded yet.";
  return rows.map((row) => [
    `#${row.id} · ${row.state} · confidence=${row.confidence} · ${row.createdAt}`,
    `title: ${clipRowText(row.title)}`,
    `impact: ${clipRowText(row.impact)}`,
    row.evidenceIds.length ? `evidence: [${row.evidenceIds.join(", ")}]` : "evidence: none",
    "---",
  ].join("\n")).join("\n");
}

const evidenceTool: ToolDefinition<typeof parameters> = {
  name: "cyber_evidence",
  label: "Cyber evidence",
  description:
    "Durable evidence store for the engagement (SQLite, one file per engagement). " +
    "Actions: add (persist evidence text with artifact references), read (recent evidence rows), " +
    "findings (finding-state list; add diagram=true for a mermaid lifecycle map), summary (brief counts and recent events). " +
    "Raw secrets are refused; store redacted artifact references instead.",
  promptSnippet:
    "Use cyber_evidence to durably persist investigation evidence and findings across compaction; " +
    "results are capped (24 KiB, 50 rows) and secret-like text is refused.",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: false, openWorldHint: false },
  async execute(
    _toolCallId: string,
    params: EvidenceParams,
    _signal: AbortSignal | undefined,
    _onUpdate,
    _ctx: ExtensionToolContext,
  ): Promise<AgentToolResult> {
    const store = openEvidence();
    try {
      if (params.action === "summary") {
        const summary = store.briefSummary(params.mode);
        return { content: [{ type: "text", text: clipOutput(summary) }], details: { action: "summary", path: store.path } };
      }
      if (params.action === "add") {
        if (params.text === undefined || !params.text.trim()) throw new Error("text required for the add action.");
        const sensitivity = (params.sensitivity ?? "internal") as Sensitivity;
        const result = store.addEvidence({
          kind: params.kind ?? "note",
          refs: params.refs ?? [],
          text: params.text,
          sensitivity,
        });
        const line = `Evidence #${result.id} recorded · kind=${params.kind ?? "note"} · sensitivity=${sensitivity} · sha256:${result.hash}`;
        return { content: [{ type: "text", text: line }], details: { action: "add", id: result.id, hash: result.hash, path: store.path } };
      }
      if (params.action === "read") {
        const rows = store.listEvidence({ kind: params.kind, limit: params.limit ?? MAX_ROWS });
        return { content: [{ type: "text", text: clipOutput(renderEvidenceRows(rows)) }], details: { action: "read", rows: rows.length, path: store.path } };
      }
      const rows = store.listFindings({ state: params.state as FindingState | undefined, limit: params.limit ?? MAX_ROWS });
      if (params.diagram) {
        // Diagrammatic reporting (Task 16): the mermaid lifecycle map is
        // appended to the text result; the default path above is untouched.
        const graph = findingsMap(rows);
        return {
          content: [{ type: "text", text: clipOutput(`${renderFindingRows(rows)}\n\n${graph}`) }],
          details: { action: "findings", rows: rows.length, path: store.path, diagram: true },
        };
      }
      return { content: [{ type: "text", text: clipOutput(renderFindingRows(rows)) }], details: { action: "findings", rows: rows.length, path: store.path } };
    } catch (error) {
      // Surface the canonical refusal without a raw stack dump.
      const message = error instanceof Error ? error.message : String(error);
      if (message === SECRET_REFUSAL_MESSAGE) throw new Error(SECRET_REFUSAL_MESSAGE);
      throw error;
    } finally {
      store.close();
    }
  },
};

export function registerEvidenceTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(evidenceTool);
}
