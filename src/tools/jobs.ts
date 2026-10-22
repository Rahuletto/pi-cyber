import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { adapters } from "../adapters/index.ts";
import { openEvidence, type JobRow } from "../evidence/db.ts";
import { containsSecretLike } from "../evidence/secrets.ts";
import { assertArgvSecretFree, runJob, type JobResult, type RunJobOpts } from "../jobs/runner.ts";
import { cancelManagedJob, getManagedJob, readManagedJobResult, startManagedJob } from "../jobs/controller.ts";

/**
 * `cyber_jobs` — the model-facing surface of the typed job runner.
 *
 * Actions: run (blocking) and start (nonblocking); status reports state and
 * progress, cancel kills queued/running children, and result reads a bounded
 * cursor from the normalized result artifact. Existing list/status behavior
 * remains available. Runtime handles do not survive process restart; durable
 * job state remains in the evidence store.
 *
 * Concurrency: the runner serializes jobs through a single in-process chain;
 * this tool additionally declares executionMode "sequential". Parallel
 * execution is deliberately not offered.
 */

const MAX_OUTPUT_CHARS = 16 * 1024;
const MAX_ROWS = 50;
const DEFAULT_RECENT = 10;
const TRUNCATED = "[truncated]";
const ARGV_DISPLAY_CHARS = 400;
const WITHHELD = "<withheld: matched a secret-like pattern; redact before dispatch>";

/** Secret-check a target-derived free-text return path (stderr, spawn errors). */
function renderChecked(label: string, text: string): string {
  return containsSecretLike(text) ? `${label}: ${WITHHELD}` : `${label}: ${text}`;
}

/** Same check applied to the structured details spread. */
function sanitizeDetails(result: JobResult): { action: string } & JobResult {
  const stderr = typeof result.stderr === "string" && containsSecretLike(result.stderr) ? WITHHELD : result.stderr;
  const spawnError = typeof result.spawnError === "string" && containsSecretLike(result.spawnError) ? WITHHELD : result.spawnError;
  return { action: "run", ...result, stderr, spawnError };
}

/** Clip a result to the 16 KiB output budget, never splitting a surrogate pair. */
export function clipOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let cut = text.slice(0, MAX_OUTPUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("run"),
    Type.Literal("start"),
    Type.Literal("cancel"),
    Type.Literal("status"),
    Type.Literal("result"),
    Type.Literal("list"),
  ], { description: "Job interaction to perform: run, start, cancel, status, result, list." }),
  tool: Type.Optional(Type.String({ maxLength: 64, description: "Adapter registry name (run), e.g. subfinder or nuclei." })),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Model params forwarded to the adapter schema (run). Validated before exec — errors name the offending field verbatim." })),
  jobId: Type.Optional(Type.String({ maxLength: 200, description: "Job id for cancel, status, or result. Omit for recent status." })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: DEFAULT_RECENT, description: "Recent jobs to return (status without jobId); default 10, hard cap 50." })),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 600000, description: "Kill timeout for the run (≤ 600 s); default 120 s." })),
  offset: Type.Optional(Type.Number({ minimum: 0, description: "Byte cursor for a bounded result artifact read." })),
  readLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 262144, description: "Result bytes to read (max 256 KiB)." })),
  encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")], { description: "Result window encoding; base64 preserves binary bytes." })),
}, { additionalProperties: false });

type JobParams = Static<typeof parameters>;

function asDetails(value: object): AgentToolResult["details"] {
  return value as unknown as AgentToolResult["details"];
}

/** Shortened param summary derived from the adapter schema itself. */
export function paramSummary(schema: unknown): string {
  const objectSchema = (schema ?? {}) as SchemaNode;
  const required = new Set(objectSchema.required ?? []);
  return Object.entries(objectSchema.properties ?? {}).map(([name, node]) => {
    const label = paramKind(node);
    const caps: string[] = [];
    if (node?.maxItems !== undefined) caps.push(`n<=${node.maxItems}`);
    if (node?.maxLength !== undefined) caps.push(`len<=${node.maxLength}`);
    const capLabel = caps.length ? `[${caps.join(",")}]` : "";
    return `${name}:${label}${capLabel}${required.has(name) ? "*" : ""}`;
  }).join(" ");
}

interface SchemaNode {
  properties?: Record<string, SchemaNode | undefined>;
  required?: string[];
  type?: string;
  maxItems?: number;
  maxLength?: number;
  items?: SchemaNode;
  anyOf?: unknown[];
}

function paramKind(node: SchemaNode | undefined): string {
  if (!node) return "complex";
  if (node.type === "array") return `${paramKind(node.items)}[]`;
  return node.anyOf?.length ? "enum" : node.type ?? "complex";
}

/** One clipped line per adapter for the list action. */
export function renderAdapters(list = adapters): string {
  return list.map((adapter) =>
    `${adapter.name} (bin ${adapter.bin} · ${adapter.artifactKind} · ${adapter.mutating ? "mutating" : "non-mutating"}): ${paramSummary(adapter.schema)}`,
  ).join("\n");
}

function clipArgv(argv: string[]): string {
  const line = argv.join(" ");
  return line.length > ARGV_DISPLAY_CHARS ? `${line.slice(0, ARGV_DISPLAY_CHARS)}${TRUNCATED}` : line;
}

function renderJobRow(row: JobRow): string {
  return [
    `${row.jobId} · ${row.adapter} · state=${row.state}`,
    `started=${row.startedAt ?? "-"} · ended=${row.endedAt ?? "-"} · argv(${row.argv.length} entries)`,
  ].join(" · ");
}

function renderJobResult(result: JobResult): string {
  const lines = [
    `job ${result.jobId} · ${result.adapter} · state=${result.state} · exit=${result.exitCode}${result.timedOut ? " · killed at timeout" : ""}`,
    `argv: ${clipArgv(result.argv)}`,
    `parsed rows: ${result.parsedRows}${Object.keys(result.byKind).length ? ` (${Object.entries(result.byKind).map(([kind, count]) => `${kind}:${count}`).join(", ")})` : ""}`,
    `evidence refs: [${result.evidenceIds.join(", ")}]`,
  ];
  // Why evidence may be partial: the job keeps its terminal state, but the
  // caller always learns the refusal from the returned annotation.
  if (result.evidencePersistence !== "complete") {
    lines.push(
      `evidence persistence: ${result.evidencePersistence} · refused rows: ${result.refusedCount ?? 0} · reason: ${result.persistReason ?? "persist-error"}`,
    );
    if (result.persistError) lines.push(`persist error (verbatim): ${result.persistError}`);
  }
  if (result.spawnError) lines.push(renderChecked("spawn error", result.spawnError));
  if (result.stderr) lines.push(renderChecked("stderr (clipped, not persisted)", result.stderr));
  if (result.stdoutTruncated) lines.push("stdout capture truncated at the byte cap; parsed rows above are complete for captured data.");
  if (result.stderrTruncated) lines.push("stderr capture truncated at the byte cap.");
  return lines.join("\n");
}

function unknownJob(jobId: string): never {
  throw new Error(`unknown job id "${jobId}" (status looks back over the ${MAX_ROWS}-row recent window; run the job first or check 'status' recent).`);
}

const jobsTool: ToolDefinition<typeof parameters> = {
  name: "cyber_jobs",
  label: "Cyber jobs",
  description:
    "Run pinned security tools through typed adapters with durable job tracking. " +
    "Actions: run (blocking), start (nonblocking), cancel (kill queued/running), " +
    "status (state/progress), result (bounded result cursor), and list (adapter param summaries). " +
    "Adapter params are schema-validated before exec; validation and guard errors are returned verbatim. " +
    "Jobs run serialized. Normalized results are private artifacts; raw output is never returned.",
  promptSnippet:
    "Use cyber_jobs to launch subfinder/nuclei and the other registry adapters. Use start for nonblocking work, " +
    "status for progress, cancel to kill the child, and result for bounded normalized-result reads. " +
    "Runtime handles are process-local; durable job states and result artifacts are stored per engagement.",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: false, openWorldHint: false },
  async execute(
    _toolCallId: string,
    params: JobParams,
    _signal: AbortSignal | undefined,
    _onUpdate,
    _ctx: ExtensionToolContext,
  ): Promise<AgentToolResult> {
    if (params.action === "list") {
      const text = clipOutput(renderAdapters());
      return { content: [{ type: "text", text }], details: { action: "list", adapters: adapters.map((adapter) => adapter.name) } };
    }

    if (params.action === "run" || params.action === "start") {
      if (params.tool === undefined) throw new Error("tool required for the run action (see the list action for names).");
      if (params.params === undefined) throw new Error(`params required for the run action (tool ${params.tool}).`);
      const opts: RunJobOpts = {};
      if (params.timeoutMs !== undefined) opts.timeoutMs = params.timeoutMs;
      if (params.action === "start") {
        const job = startManagedJob({ tool: params.tool, params: params.params }, opts);
        const snapshot = job.get();
        return {
          content: [{ type: "text", text: `job ${job.jobId} · ${params.tool} · state=queued · accepted for serialized execution` }],
          details: asDetails({ action: "start", ...snapshot }),
        };
      }
      const result = await runJob({ tool: params.tool, params: params.params }, opts);
      // Global constraint: secret check on every return path that can carry
      // secrets — the details spread below carries the FULL argv (the store
      // only records and checks a 250-entry head), so it is refused here with
      // the canonical message instead of leaking through details.
      assertArgvSecretFree(result.argv);
      return {
        content: [{ type: "text", text: clipOutput(renderJobResult(result)) }],
        details: sanitizeDetails(result) as unknown as AgentToolResult["details"],
      };
    }

    if (params.action === "cancel") {
      if (!params.jobId) throw new Error("jobId required for the cancel action.");
      const accepted = cancelManagedJob(params.jobId);
      const snapshot = getManagedJob(params.jobId);
      return {
        content: [{ type: "text", text: `job ${params.jobId} · cancellation ${accepted ? "requested" : "already terminal"} · state=${snapshot.state}` }],
        details: asDetails({ action: "cancel", accepted, ...snapshot }),
      };
    }

    if (params.action === "result") {
      if (!params.jobId) throw new Error("jobId required for the result action.");
      const result = readManagedJobResult(params.jobId, {
        ...(params.offset !== undefined ? { offset: params.offset } : {}),
        ...(params.readLimit !== undefined ? { limit: params.readLimit } : {}),
        ...(params.encoding !== undefined ? { encoding: params.encoding } : {}),
      });
      return {
        content: [{ type: "text", text: result.data }],
        details: asDetails({ action: "result", artifact: result.artifact, offset: result.offset, nextOffset: result.nextOffset }),
      };
    }

    const store = openEvidence();
    try {
      if (params.jobId !== undefined) {
        try {
          const runtime = getManagedJob(params.jobId);
          return { content: [{ type: "text", text: `job ${runtime.jobId} · ${runtime.adapter} · state=${runtime.state} · phase=${runtime.phase} · stdout=${runtime.stdoutBytes} bytes · stderr=${runtime.stderrBytes} bytes${runtime.resultArtifact ? ` · result=${runtime.resultArtifact.id}` : ""}` }], details: asDetails({ action: "status", ...runtime }) };
        } catch { /* fall back to the durable job ledger for completed/older runs */ }
        const row = store.listJobs({ limit: MAX_ROWS }).find((job) => job.jobId === params.jobId);
        if (!row) unknownJob(params.jobId);
        return { content: [{ type: "text", text: renderJobRow(row) }], details: { action: "status", ...row } };
      }
      const rows = store.listJobs({ limit: Math.min(params.limit ?? DEFAULT_RECENT, MAX_ROWS) });
      const text = rows.length
        ? rows.map(renderJobRow).join("\n")
        : "No jobs recorded yet for this engagement.";
      return { content: [{ type: "text", text: clipOutput(text) }], details: { action: "status", rows: rows.length, path: store.path } };
    } finally {
      store.close();
    }
  },
};

export function registerCyberJobsTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(jobsTool);
}
