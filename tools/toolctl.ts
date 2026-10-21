/**
 * toolctl — thin Bun CLI between the bash scripts (install.sh / validate.sh) and the typed
 * modules (src/tools/manifest.ts, src/tools/installer.ts). All JSON structures are built and
 * parsed here; bash only ever sees flat TSV lines or receives argv-expressible values.
 *
 * Subcommands:
 *   list [disposition...]                        → TSV rows: name, repo, artifact, versionFlag, sha256
 *   resolve <name> <repo>                        → TSV: tag, assetName, assetUrl
 *   resolved-get <name> [--file PATH]            → frozen sha256 (empty string if unfrozen)
 *   freeze <name> <repo> <tag> <assetUrl> <sha256> <resolvedAt> [--file PATH]
 *   installed [--file PATH]                      → names whose state file says "installed", one per line
 *   state-set <name> <state> [--file PATH] [--version V] [--sha256 S] [--validatedAt ISO]
 */
import { loadManifest, DISPOSITIONS } from "../src/tools/manifest.ts";
import { freezeResolved, loadResolved, resolveLatest, RESOLVED_FILE, ASSET_PATTERN } from "../src/tools/installer.ts";
import { homedir } from "node:os";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const DEFAULT_STATE_FILE = resolve(homedir(), ".pi", "tools", "state.json");

const MANIFEST_FILE = new URL("./manifest.json", import.meta.url);

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function takeFlag(args: string[], flag: string): string [] {
  const index = args.indexOf(flag);
  if (index < 0) return args;
  const value = args[index + 1];
  if (value === undefined) die(`toolctl: ${flag} requires a value`);
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

async function readState(path: string): Promise<Record<string, Record<string, string>>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw new TypeError(`toolctl: unreadable state file ${path}`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError(`toolctl: state file ${path} top level must be an object`);
  }
  const out: Record<string, Record<string, string>> = {};
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(`toolctl: state entry "${name}" must be an object`);
    }
    out[name] = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
    );
  }
  return out;
}

async function writeState(path: string, state: Record<string, Record<string, string>>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "list": {
      const filters = args;
      for (const f of filters) {
        if (!(DISPOSITIONS as readonly string[]).includes(f)) die(`toolctl: unknown disposition filter "${f}"`);
      }
      const manifest = await loadManifest(MANIFEST_FILE);
      const lines: string[] = [];
      for (const tool of manifest.tools) {
        if (filters.length > 0 && !filters.includes(tool.disposition)) continue;
        lines.push([tool.name, tool.repo ?? "", tool.artifact ?? "", tool.versionFlag ?? "", tool.sha256 ?? ""].join("\t"));
      }
      if (lines.length > 0) console.log(lines.join("\n"));
      break;
    }
    case "resolve": {
      const [name, repo] = args;
      if (!name || !repo) die("toolctl: resolve requires <name> <repo>");
      try {
        const resolution = await resolveLatest(repo);
        console.log([name, resolution.tag, resolution.assetName, resolution.assetUrl].join("\t"));
      } catch (error) {
        die(`toolctl: resolve ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    case "resolved-get": {
      const positional = takeFlag(args, "--file");
      const [name] = positional;
      if (!name) die("toolctl: resolved-get requires <name>");
      const path = flagValue(args, "--file") ?? RESOLVED_FILE;
      const map = await loadResolved(path);
      const record = map[name];
      if (record) console.log(record.sha256);
      break;
    }
    case "freeze": {
      const positional = takeFlag(args, "--file");
      const [name, repo, tag, assetUrl, sha256, resolvedAt] = positional;
      if (!name || !repo || !tag || !assetUrl || !sha256 || !resolvedAt) {
        die("toolctl: freeze requires <name> <repo> <tag> <assetUrl> <sha256> <resolvedAt>");
      }
      try {
        const record = { name, repo, tag, assetUrl, sha256, resolvedAt };
        await freezeResolved(flagValue(args, "--file") ?? RESOLVED_FILE, record);
      } catch (error) {
        die(`toolctl: freeze ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    case "installed": {
      const path = flagValue(args, "--file") ?? DEFAULT_STATE_FILE;
      try {
        const state = await readState(path);
        for (const [name, entry] of Object.entries(state)) {
          if (entry.state === "installed") console.log(name);
        }
      } catch (error) {
        die(`toolctl: installed ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    case "state-set": {
      const positional = takeFlag(args, "--file");
      const [name, stateValue] = positional;
      if (!name || !stateValue) die("toolctl: state-set requires <name> <state>");
      if (stateValue !== "installed" && stateValue !== "validated") {
        die(`toolctl: state must be "installed" or "validated", got "${stateValue}"`);
      }
      const path = flagValue(args, "--file") ?? DEFAULT_STATE_FILE;
      try {
        const state = await readState(path);
        const entry: Record<string, string> = { ...(state[name] ?? {}), state: stateValue };
        const version = flagValue(args, "--version");
        if (version !== undefined) entry.version = version;
        const sha256 = flagValue(args, "--sha256");
        if (sha256 !== undefined) entry.sha256 = sha256.toLowerCase();
        const validatedAt = flagValue(args, "--validatedAt");
        if (validatedAt !== undefined) entry.validatedAt = validatedAt;
        state[name] = entry;
        await writeState(path, state);
      } catch (error) {
        die(`toolctl: state-set ${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      break;
    }
    case "pattern": {
      console.log(ASSET_PATTERN);
      break;
    }
    default:
      die(`toolctl: unknown command "${command ?? ""}" (expected list|resolve|resolved-get|freeze|installed|state-set)`);
  }
}

await main();
