import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { containsSecretLike } from "../evidence/secrets.ts";
import {
  KNOWLEDGE_SOURCES,
  MAX_HITS,
  openKnowledge,
  type KnowledgeHit,
  type KnowledgeSource,
  type KnowledgeStats,
} from "../knowledge/fts.ts";

/**
 * `cyber_knowledge` — searchable access to the local corpus (skills, repo
 * research, repo docs).
 *
 * Actions:
 * - `search` — FTS5 MATCH over the index; at most 10 hits, each rendered as
 *   source / title / ref plus a short snippet with the matched term marked.
 * - `stats`  — per-source counts, the last rebuild timestamp and a stale
 *   marker when a source file on disk is newer than the index.
 * - `rebuild` — re-index one source or all of them.
 *
 * Rebuild policy: the index is NEVER rebuilt implicitly. The context hook
 * stays cheap; `stats` reports staleness and the operator (or the model)
 * decides to rebuild.
 *
 * Output is clipped at 24 KiB and the tool declares sequential execution.
 */

const MAX_OUTPUT_CHARS = 24 * 1024;
const TRUNCATED = "[truncated]";
const WITHHELD = "<withheld: matched a secret-like pattern; not shown>";

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
    Type.Literal("search"),
    Type.Literal("stats"),
    Type.Literal("rebuild"),
  ], { description: "Knowledge interaction to perform: search, stats, rebuild." }),
  query: Type.Optional(Type.String({ maxLength: 512, description: "Free-text query (search). Quoted phrases are kept; terms are ANDed." })),
  source: Type.Optional(Type.Union(
    KNOWLEDGE_SOURCES.map((source) => Type.Literal(source)),
    { description: "Restrict to one source (search) or re-index one source (rebuild). Omit for all sources." },
  )),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_HITS, default: MAX_HITS, description: `Max hits (search); default and hard cap ${MAX_HITS}.` })),
}, { additionalProperties: false });

type KnowledgeParams = Static<typeof parameters>;

/** Never echo a secret-like query back into the transcript. */
function safeQueryEcho(query: string): string {
  return containsSecretLike(query) ? WITHHELD : query;
}

function renderHit(hit: KnowledgeHit, index: number): string {
  return [
    `${index}. [${hit.source}] ${hit.title}`,
    `   ref: ${hit.ref}`,
    hit.snippet ? `   ${hit.snippet}` : null,
  ].filter(Boolean).join("\n");
}

function renderSearch(hits: KnowledgeHit[], query: string, path: string, total: number): string {
  if (!hits.length) {
    return [
      `knowledge search · 0 hits · query "${safeQueryEcho(query)}" · index ${path}`,
      total === 0
        ? "The knowledge index is empty — run the rebuild action to index the corpus."
        : "No document matched. Try a broader term or a different source.",
    ].join("\n");
  }
  return [
    `knowledge search · ${hits.length} hit${hits.length === 1 ? "" : "s"} · query "${safeQueryEcho(query)}" · index ${path}`,
    ...hits.map((hit, index) => renderHit(hit, index + 1)),
  ].join("\n");
}

function renderStats(stats: KnowledgeStats): string {
  const lines = [
    `knowledge index · ${stats.path}`,
    `counts: skill=${stats.counts.skill} · research=${stats.counts.research} · doc=${stats.counts.doc} · total=${stats.total}`,
    `last rebuilt: ${stats.lastRebuiltAt ?? "never"}`,
    "sources:",
    ...stats.sources.map((source) => [
      `  ${source.source} · ${source.count} docs · indexed ${source.lastIndexedAt ?? "never"}` +
      (source.stale ? " · STALE (newer source files exist — run rebuild)" : ""),
    ].join("")),
  ];
  if (stats.refusals.length) {
    lines.push(`refused (secret-like, not indexed): ${stats.refusals.length}`);
    for (const refusal of stats.refusals.slice(0, 24)) lines.push(`  - ${refusal.ref}`);
    if (stats.refusals.length > 24) lines.push(`  … ${stats.refusals.length - 24} more refusal paths in the knowledge DB`);
  }
  return lines.join("\n");
}

function renderRebuild(results: Array<{ source: KnowledgeSource; scanned: number; indexed: number; updated: number; pruned: number; refused: Array<{ ref: string; reason: string }> }>, path: string): string {
  const lines = [`knowledge rebuild · index ${path}`];
  for (const result of results) {
    lines.push(
      `${result.source}: scanned=${result.scanned} · indexed=${result.indexed} · updated=${result.updated} · pruned=${result.pruned} · refused=${result.refused.length}`,
    );
    for (const refusal of result.refused) lines.push(`  refused ${refusal.ref} (${refusal.reason})`);
  }
  return lines.join("\n");
}

const knowledgeTool: ToolDefinition<typeof parameters> = {
  name: "cyber_knowledge",
  label: "Cyber knowledge",
  description:
    "Search the local knowledge corpus (installed skills, repo research, repo docs) with FTS5. " +
    "Actions: search (free-text query, at most 10 hits; the matched term is marked «like-this»), " +
    "stats (per-source counts, last rebuild, stale marker), rebuild (re-index one source or all). " +
    "The index is never rebuilt implicitly — check stats and rebuild when stale.",
  promptSnippet:
    "Use cyber_knowledge to look up skill procedures and repo research before improvising; " +
    "search returns source/title/ref plus a marked snippet, stats reports staleness.",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: false, openWorldHint: false },
  async execute(
    _toolCallId: string,
    params: KnowledgeParams,
    _signal: AbortSignal | undefined,
    _onUpdate,
    _ctx: ExtensionToolContext,
  ): Promise<AgentToolResult> {
    const store = openKnowledge();
    try {
      if (params.action === "search") {
        if (params.query === undefined || !params.query.trim()) {
          throw new Error("query required for the search action.");
        }
        const hits = store.search(params.query, { limit: params.limit ?? MAX_HITS, source: params.source });
        // The index state is only needed for the "index is empty" hint; the
        // common path (hits found) does not pay for the filesystem walk.
        const total = hits.length ? hits.length : store.stats().total;
        const text = renderSearch(hits, params.query, store.path, total);
        return {
          content: [{ type: "text", text: clipOutput(text) }],
          details: { action: "search", hits: hits.length, path: store.path, source: params.source ?? null },
        };
      }
      if (params.action === "stats") {
        const stats = store.stats();
        const text = renderStats(stats);
        return {
          content: [{ type: "text", text: clipOutput(text) }],
          details: {
            action: "stats",
            path: store.path,
            counts: stats.counts,
            total: stats.total,
            lastRebuiltAt: stats.lastRebuiltAt,
            stale: stats.sources.filter((source) => source.stale).map((source) => source.source),
            refusals: stats.refusals.length,
          },
        };
      }
      const rebuild = store.rebuild(params.source);
      const text = renderRebuild(rebuild.results.map((result) => ({
        source: result.source,
        scanned: result.scanned,
        indexed: result.indexed,
        updated: result.updated,
        pruned: result.pruned,
        refused: result.refused,
      })), store.path);
      return {
        content: [{ type: "text", text: clipOutput(text) }],
        details: {
          action: "rebuild",
          path: store.path,
          indexed: rebuild.indexed,
          updated: rebuild.updated,
          refused: rebuild.refused,
        },
      };
    } finally {
      store.close();
    }
  },
};

export function registerKnowledgeTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(knowledgeTool);
}
