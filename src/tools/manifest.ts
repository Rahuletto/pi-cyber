import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";

export const TOOL_CATEGORIES = ["recon", "discovery", "web", "defense", "reverse", "browser", "misc"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export const DISPOSITIONS = ["core", "on-demand", "reference", "platform-limited", "deferred"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** The five distinct tool states (spec §4). `enabled` is set by mode wiring, never by the doctor. */
export const TOOL_STATES = ["cataloged", "installed", "available", "enabled", "validated"] as const;
export type ToolState = (typeof TOOL_STATES)[number];

export interface ToolEntry {
  name: string;
  category: ToolCategory;
  repo?: string;
  /** "pin-at-install" for every entry until the first verified download freezes a concrete version. */
  version: string;
  disposition: Disposition;
  note?: string;
  /** GitHub release asset filename to install (installer hint); absent = installer picks via its darwin/arm64 matcher. */
  artifact?: string;
  /** Pinned SHA-256; null = no digest recorded yet, record on the first verified download (never mutated manifest.json — frozen in manifest.resolved.json). */
  sha256?: string | null;
  /** Probe flag for validate.sh (e.g. "-version"); absent = validate.sh applies its per-tool default map. */
  versionFlag?: string;
}

export interface Manifest {
  tools: ToolEntry[];
}

/** Optional operator/installer state file: `Record<name, { state: "installed" | "validated", ... }>`. */
export const DEFAULT_STATE_FILE = resolve(homedir(), ".pi", "scanners", "state.json");

const DEFAULT_MANIFEST_FILE = new URL("../../tools/manifest.json", import.meta.url);

const KNOWN_ENTRY_KEYS = new Set(["name", "category", "repo", "version", "disposition", "note", "artifact", "sha256", "versionFlag"]);
const SHA256_RE = /^[0-9a-f]{64}$/i;

function failWhere(message: string, detail: string): never {
  throw new TypeError(`manifest: ${message} (${detail})`);
}

function expectString(entry: string, field: string, value: unknown, required: boolean): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.length === 0) failWhere(`field "${field}" must be a non-empty string`, entry);
}

function isToolEntry(row: unknown): ToolEntry {
  if (typeof row !== "object" || row === null || Array.isArray(row)) failWhere("each tool entry must be an object", String(row));
  const entry = row as Record<string, unknown>;
  expectString("entry", "name", entry.name, true);
  const name = entry.name as string;
  for (const key of Object.keys(entry)) {
    if (!KNOWN_ENTRY_KEYS.has(key)) {
      failWhere(`unknown key "${key}"; expected one of ${[...KNOWN_ENTRY_KEYS].sort().join("|")}`, name);
    }
  }
  expectString(name, "version", entry.version, true);
  expectString(name, "repo", entry.repo, false);
  expectString(name, "note", entry.note, false);
  expectString(name, "artifact", entry.artifact, false);
  expectString(name, "versionFlag", entry.versionFlag, false);
  if (entry.sha256 !== undefined && entry.sha256 !== null) {
    if (typeof entry.sha256 !== "string" || !SHA256_RE.test(entry.sha256)) {
      failWhere('field "sha256" must be a 64-hex digest or null', name);
    }
  }
  if (typeof entry.category !== "string" || !(TOOL_CATEGORIES as readonly string[]).includes(entry.category)) {
    failWhere(`unknown category "${String(entry.category)}"; expected one of ${TOOL_CATEGORIES.join("|")}`, name);
  }
  if (typeof entry.disposition !== "string" || !(DISPOSITIONS as readonly string[]).includes(entry.disposition)) {
    failWhere(`unknown disposition "${String(entry.disposition)}"; expected one of ${DISPOSITIONS.join("|")}`, name);
  }
  const parsed: ToolEntry = {
    name,
    category: entry.category as ToolCategory,
    version: entry.version as string,
    disposition: entry.disposition as Disposition,
  };
  if (typeof entry.repo === "string") parsed.repo = entry.repo;
  if (typeof entry.note === "string") parsed.note = entry.note;
  if (typeof entry.artifact === "string") parsed.artifact = entry.artifact;
  if (entry.sha256 === null) parsed.sha256 = null;
  else if (typeof entry.sha256 === "string") parsed.sha256 = entry.sha256;
  if (typeof entry.versionFlag === "string") parsed.versionFlag = entry.versionFlag;
  return parsed;
}

/** Bun JSON.parse loader with hand-rolled schema validation. Throws on unknown keys, unknown category or disposition, duplicates, malformed shape. */
export async function loadManifest(path: string | URL = DEFAULT_MANIFEST_FILE): Promise<Manifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new TypeError(`manifest: unreadable file ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) failWhere("top level must be an object", "");
  const tools = (raw as Record<string, unknown>).tools;
  if (!Array.isArray(tools)) failWhere(`field "tools" must be an array`, "");
  const seen = new Set<string>();
  const parsed: ToolEntry[] = [];
  for (const row of tools) {
    const entry = isToolEntry(row);
    if (seen.has(entry.name)) failWhere("duplicate tool name", entry.name);
    seen.add(entry.name);
    parsed.push(entry);
  }
  return { tools: parsed };
}

interface StateFileEntry {
  state: "installed" | "validated";
}

function readStateFileEntry(name: string, value: unknown): StateFileEntry | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) failWhere("state entry must be an object", name);
  const state = (value as Record<string, unknown>).state;
  if (state === "validated" || state === "installed") return { state };
  failWhere(`state must be "installed" or "validated"`, name);
}

async function onPath(name: string, pathEnv: string): Promise<boolean> {
  for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, name);
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      return true;
    } catch { /* Not on this PATH segment. */ }
  }
  return false;
}

/**
 * Doctor state machine: cataloged → installed (stateFile says so) → available (on PATH) → validated (stateFile pass mark).
 * Read-only: never executes tools. A missing state file means every entry stays `cataloged`.
 */
export async function toolStates(
  manifest: Manifest,
  stateFile: string = DEFAULT_STATE_FILE,
  pathEnv: string = process.env.PATH ?? "",
): Promise<Record<string, ToolState>> {
  const states: Record<string, StateFileEntry> = {};
  let file: string | null = null;
  try {
    file = await readFile(stateFile, "utf8");
  } catch { /* A missing state file is the documented all-cataloged state. */ }
  let parsed: unknown = {};
  if (file !== null) {
    try {
      parsed = JSON.parse(file);
    } catch {
      throw new TypeError(`manifest: unreadable state file ${stateFile}`);
    }
  }
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) failWhere("state file top level must be an object", stateFile);
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = readStateFileEntry(name, value);
    if (entry) states[name] = entry;
  }

  const result: Record<string, ToolState> = {};
  await Promise.all(manifest.tools.map(async (tool) => {
    const recorded = states[tool.name]?.state;
    let state: ToolState = "cataloged";
    if (recorded === "installed") state = "installed";
    if (await onPath(tool.name, pathEnv)) state = "available";
    if (recorded === "validated") state = "validated";
    result[tool.name] = state;
  }));
  return result;
}
