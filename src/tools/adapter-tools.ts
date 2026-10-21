import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { defaultWordlistPath, toolsBinDir } from "./paths.ts";
import { access, constants, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { adapters } from "../adapters/index.ts";
import type { AdapterDef } from "../adapters/types.ts";
import { RAW_CAP } from "../adapters/util.ts";
import { openEvidence } from "../evidence/db.ts";
import { containsSecretLike } from "../evidence/secrets.ts";
import { assertArgvSecretFree, runJob, type JobResult } from "../jobs/runner.ts";
import { DEFAULT_STATE_FILE, loadManifest, type ToolState } from "./manifest.ts";

/**
 * `one Pi tool per adapter` (Task 7b) — the model's PRIMARY surface for the
 * pinned scanner kit. Each of the 11 registry adapters registers a Pi tool
 * whose NAME is the adapter name (nuclei, subfinder, httpx, …) and whose
 * PARAMETER SCHEMA is the adapter's own typebox schema (reused directly, not
 * duplicated — additionalProperties:false is preserved by identity), so the
 * model fills typed params instead of emitting bash or a generic passthrough.
 *
 * Discipline shared with cyber_jobs:
 * - execute calls the Task-6 job runner (`runJob(adapter.name, params)`); all
 *   schema/guard/secret/refusal errors surface VERBATIM to the model.
 * - executionMode "sequential": the runner serializes through one promise
 *   chain anyway — parallel execution is deliberately not offered.
 * - Readiness guard: BEFORE the runner, each tool checks the bin state
 *   (state.json + manifest catalog + runtime PATH / ~/.pi/scanners/bin disk
 *   check) and fails FAST with the typed
 *   `bin not available: <bin> — run tools/install.sh (state: <state>)`
 *   message instead of a confusing spawn error.
 * - Rendering clipped to plan caps: job state line, row count per kind, the
 *   Normalized rows (key + raw up to the store's per-row 4000-char clip),
 *   then evidence refs — evidence is NOT auto-dumped in full; full history
 *   lives in the store behind cyber_evidence.
 */

const MAX_OUTPUT_CHARS = 16 * 1024;
const MAX_ROWS = 50; // plan cap on rows re-entering the model context
const TRUNCATED = "[truncated]";
const WITHHELD = "<withheld: matched a secret-like pattern; redact before dispatch>";

/** Additional bin dir the installer owns (checked alongside the runtime PATH). */
const DEFAULT_TOOLS_BIN_DIR = resolve(homedir(), ".pi", "scanners", "bin");

/** Test/operator knob documented below: <missing/empty dir> makes every non-PATH bin unavailable. */
function stateFile(): string {
  return process.env.CYBER_TOOLS_STATE_FILE?.trim() || DEFAULT_STATE_FILE;
}

export interface BinReadiness {
  ready: boolean;
  /** Doctor-style state vocabulary: cataloged | installed | available | validated. */
  state: ToolState;
  /** True when the bin is present in the tools/manifest.json catalog. */
  cataloged: boolean;
  /** GitHub release tag from manifest.resolved.json, when a pin is recorded. */
  resolvedTag?: string;
  /**
   * The state the operator's state file records for this bin
   * ("installed" | "validated"), or undefined when the file says nothing.
   * `state` above is the doctor-computed label; this is the recorded pin.
   */
  recorded?: "installed" | "validated";
}

async function executableOnDisk(name: string, extraDir: string, pathEnv: string): Promise<boolean> {
  const dirs = [extraDir, ...pathEnv.split(delimiter).filter(Boolean)];
  for (const directory of dirs) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return true;
    } catch { /* not this segment */ }
  }
  return false;
}

/**
 * Bin readiness for one adapter bin, weighted like the doctor:
 * PATH/…/.pi/scanners/bin disk presence is the runtime truth (ready);
 * the state file contributes installed/validated labels, the manifest
 * contributes the catalog flag and the resolved release tag. Manifest and
 * resolved reads are best-effort: a corrupt file must never block a run whose
 * binary actually exists on disk.
 */
export async function binReadiness(bin: string): Promise<BinReadiness> {
  const pathEnv = process.env.PATH ?? "";
  const onDisk = await executableOnDisk(bin, toolsBinDir(), pathEnv);

  let cataloged = false;
  try {
    const manifest = await loadManifest();
    cataloged = manifest.tools.some((entry) => entry.name === bin);
  } catch { /* manifest issues never gate a runnable binary */ }

  let resolvedTag: string | undefined;
  try {
    const resolvedPath = fileURLToPath(new URL("../../tools/manifest.resolved.json", import.meta.url));
    const parsed = JSON.parse(await readFile(resolvedPath, "utf8")) as Record<string, { tag?: string }>;
    resolvedTag = typeof parsed[bin]?.tag === "string" ? parsed[bin].tag : undefined;
  } catch { /* resolved pins are informational only */ }

  let recorded: "installed" | "validated" | undefined;
  try {
    const parsed = JSON.parse(await readFile(stateFile(), "utf8")) as Record<string, { state?: string }>;
    const value = parsed[bin]?.state;
    if (value === "validated" || value === "installed") recorded = value;
  } catch { /* a missing state file is the documented all-cataloged state */ }

  if (onDisk) {
    return { ready: true, state: recorded === "validated" ? "validated" : "available", cataloged, resolvedTag, ...(recorded ? { recorded } : {}) };
  }
  const state: ToolState = recorded ?? "cataloged"; // stale labels stay truthful in the fail-fast message
  return { ready: false, state, cataloged, resolvedTag, ...(recorded ? { recorded } : {}) };
}

const DESCRIPTIONS: Record<string, string> = {
  subfinder: "Run subfinder to passively enumerate subdomains for one domain (writes evidence, validated state required).",
  httpx: "Run httpx to probe target URLs/hosts and confirm live HTTP services (writes evidence, validated state required).",
  dnsx: "Run dnsx to resolve DNS records for given domains (writes evidence, validated state required).",
  katana: "Run katana to crawl targets up to a configured depth (writes evidence, validated state required).",
  ffuf: "Run ffuf to fuzz a single URL target. Configure CYBER_FFUF_WORDLIST with an operator-owned wordlist path (writes evidence, validated state required).",
  naabu: "Run naabu to port-scan given hosts (writes evidence, validated state required).",
  nuclei: "Run nuclei to scan targets with template IDs and a severity filter (writes evidence, validated state required).",
  uncover: "Run uncover to query search engines (shodan/censys/…) for one query (writes evidence, validated state required).",
  vulnx: "Run vulnx to search/analyze CVE advisory data (writes evidence, validated state required).",
  interactsh: "Run interactsh-client polling an OOB callback server; it runs until the job timeout, so expect an interrupted state with recorded events (writes evidence, validated state required).",
  semgrep: "Run semgrep to statically scan local paths with a pinned rule set (writes evidence, validated state required).",
};

/** Clip a result to the 16 KiB output budget, never splitting a surrogate pair. */
export function clipOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let cut = text.slice(0, MAX_OUTPUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

/** Secret-check a target-derived free-text return path (stderr, spawn errors). */
function renderChecked(label: string, text: string): string {
  return containsSecretLike(text) ? `${label}: ${WITHHELD}` : `${label}: ${text}`;
}

function clipRow(raw: string): string {
  return raw.length > RAW_CAP ? `${raw.slice(0, RAW_CAP)}${TRUNCATED}` : raw;
}

function clipIds(ids: readonly number[]): Array<number | string> {
  if (ids.length <= MAX_ROWS) return [...ids];
  return [...ids.slice(0, MAX_ROWS), `<${ids.length - MAX_ROWS} more evidence ids not listed>`];
}

/**
 * Plan-capped rendering: state · per-kind row counts · Normalized rows
 * (up to MAX_ROWS, each raw clipped at the store's per-row cap) · evidence
 * refs. Only clipped rows are shown — never a full auto dump; the store stays
 * the source of truth behind cyber_evidence.
 */
export function renderJob(result: JobResult, evidenceRows: Array<{ id: number; refs: string[]; text: string }>): string {
  const kinds = Object.entries(result.byKind).map(([kind, count]) => `${kind}:${count}`).join(", ");
  const lines = [
    `job ${result.jobId} · ${result.adapter} · state=${result.state} · exit=${result.exitCode}${result.timedOut ? " · killed at timeout" : ""}`,
    `rows: ${result.parsedRows}${kinds ? ` (${kinds})` : ""}`,
    `evidence refs: [${clipIds(result.evidenceIds).join(", ")}]`,
  ];
  const rows = evidenceRows.filter((row) => result.evidenceIds.includes(row.id)).slice(0, MAX_ROWS);
  if (rows.length < result.evidenceIds.length) {
    lines.push(""); // spacer before the row block
    lines.push(`<only ${rows.length} of ${result.evidenceIds.length} evidence rows shown — read cyber_evidence for the rest>`);
  }
  for (const row of rows) {
    const key = row.refs.length > 1 ? row.refs.at(-1) : row.refs[0];
    lines.push(`#${row.id} · ${key ?? "?"}`);
    lines.push(clipRow(row.text));
  }
  if (result.evidencePersistence !== "complete") {
    lines.push(`evidence persistence: ${result.evidencePersistence} · refused rows: ${result.refusedCount ?? 0} · reason: ${result.persistReason ?? "persist-error"}`);
    if (result.persistError) lines.push(`persist error (verbatim): ${result.persistError}`);
  }
  if (result.spawnError) lines.push(renderChecked("spawn error", result.spawnError));
  if (result.stderr) lines.push(renderChecked("stderr (clipped, not persisted)", result.stderr));
  return lines.join("\n");
}

/** Secret-check the details return path (stderr/spawnError only). */
function sanitizeDetails(result: JobResult, rowsShown: number): { adapterToolRun: true; rowsShown: number } & JobResult {
  const stderr = typeof result.stderr === "string" && containsSecretLike(result.stderr) ? WITHHELD : result.stderr;
  const spawnError = typeof result.spawnError === "string" && containsSecretLike(result.spawnError) ? WITHHELD : result.spawnError;
  return { adapterToolRun: true, rowsShown, ...result, stderr, spawnError };
}

function buildTool(adapter: AdapterDef): ToolDefinition {
  // Schema reuse (Task 7b ruling): the adapter's own typebox schema IS the
  // tool parameter schema — never a duplicate. additionalProperties:false is
  // preserved by identity, and the runner re-validates before exec.
  const parameters = adapter.schema as ToolDefinition["parameters"];
  const description = DESCRIPTIONS[adapter.name] ?? `Run ${adapter.name} through its typed adapter (writes evidence, validated state required).`;
  const tool: ToolDefinition = {
    name: adapter.name, // EXACTLY the adapter name — no prefix
    label: `Cyber ${adapter.name}`,
    description,
    parameters,
    executionMode: "sequential",
    annotations: { readOnlyHint: false, openWorldHint: false },
    async execute(
      _toolCallId: string,
      params,
      _signal: AbortSignal | undefined,
      _onUpdate,
      _ctx: ExtensionToolContext,
    ): Promise<AgentToolResult> {
      // Readiness guard: fail FAST on an uninstalled/unvalidated bin instead
      // of a confusing spawn error later.
      const readiness = await binReadiness(adapter.bin);
      if (!readiness.ready) {
        throw new Error(`bin not available: ${adapter.bin} — run tools/install.sh (state: ${readiness.state})`);
      }
      const buildOpts = adapter.name === "ffuf" && process.env.CYBER_FFUF_WORDLIST?.trim()
        ? { wordlistPath: process.env.CYBER_FFUF_WORDLIST.trim() }
        : undefined;
      const result = await runJob(
        { tool: adapter.name, params: params as Record<string, unknown> },
        buildOpts ? { buildOpts } : {},
      );
      // Global constraint: secret check on the return path that carries the
      // FULL argv (the store records/checks only a 250-entry head).
      assertArgvSecretFree(result.argv);
      let rows: Array<{ id: number; refs: string[]; text: string }> = [];
      if (result.evidenceIds.length > 0) {
        const store = openEvidence();
        try {
          rows = store.listEvidence({ limit: MAX_ROWS });
        } finally { store.close(); }
      }
      const rowsShown = rows.filter((row) => result.evidenceIds.includes(row.id)).length;
      return {
        content: [{ type: "text", text: clipOutput(renderJob(result, rows)) }],
        details: sanitizeDetails(result, rowsShown) as unknown as AgentToolResult["details"],
      };
    },
  };
  return tool;
}

/** Register one Pi tool per adapter, named exactly like the adapter. */
export function registerAdapterTools(pi: Pick<ExtensionAPI, "registerTool">): void {
  for (const adapter of adapters) pi.registerTool(buildTool(adapter));
}
