/**
 * Scanner binary locations.
 *
 * The adapters declare their binary as a bare name ("dnsx", "ffuf") and the
 * job runner used to spawn that name directly, which only worked when the
 * installer-owned directory happened to be on PATH. Resolving the absolute
 * path here removes that dependency: the harness finds its own tools from any
 * working directory, with no launcher and no environment setup.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The installer-owned scanner directory. */
export const DEFAULT_TOOLS_BIN_DIR = resolve(homedir(), ".pi", "scanners", "bin");

/** Resolve the scanner binary directory. The env override wins over the default. */
export function toolsBinDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CYBER_TOOLS_BIN_DIR?.trim() || DEFAULT_TOOLS_BIN_DIR;
}

/**
 * Absolute path of a scanner binary, or the bare name when it is not installed
 * in the tools directory — a system-wide install on PATH still resolves.
 */
export function resolveToolBin(bin: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidate = join(toolsBinDir(env), bin);
  return existsSync(candidate) ? candidate : bin;
}

/**
 * The pinned SecLists common wordlist the ffuf adapter fuzzes with. Resolved
 * from the tools directory so the harness needs no environment setup; the
 * operator override still wins.
 */
export function defaultWordlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CYBER_FFUF_WORDLIST?.trim() || join(toolsBinDir(env), "..", "wordlists", "seclists-common.txt");
}
