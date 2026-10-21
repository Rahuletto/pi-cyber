import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import { loadManifest, toolStates, type ToolState } from "./tools/manifest.ts";

export interface ToolPresence { name: string; available: boolean; path: string | null; validated: false }
/** Harness runtime binaries, not part of the manifest catalog. */
const runtimeCatalog = ["bun", "node", "pi", "rg", "git", "ast-grep", "sg"];
/** PATH metadata only. Never runs an executable, probes a target, installs, or writes configuration. */
export async function inventory(path = process.env.PATH ?? "", names: readonly string[] = runtimeCatalog): Promise<ToolPresence[]> {
  const directories = path.split(delimiter).filter(Boolean);
  return Promise.all(names.map(async (name) => {
    for (const directory of directories) {
      const candidate = resolve(directory, name);
      try {
        await access(candidate, constants.X_OK);
        if (!(await stat(candidate)).isFile()) continue;
        return { name, available: true, path: candidate, validated: false as const };
      } catch { /* Missing or inaccessible on this PATH segment. */ }
    }
    return { name, available: false, path: null, validated: false as const };
  }));
}

export interface ToolRow { name: string; category: string; disposition: string; state: ToolState }
export interface DoctorReport {
  platform: string;
  architecture: string;
  note: string;
  runtime: ToolPresence[];
  tools: ToolRow[];
}
export const DOCTOR_NOTE =
  "PATH presence and operator state file only; versions, identity, compatibility and target behavior are unvalidated. " +
  "An executable named httpx may be unrelated. The doctor never executes tools.";

export async function report(options: {
  manifestPath?: string | URL;
  statePath?: string;
  envPath?: string;
  runtimeNames?: readonly string[];
} = {}): Promise<DoctorReport> {
  const pathEnv = options.envPath ?? process.env.PATH ?? "";
  const manifest = await loadManifest(options.manifestPath);
  const [runtime, states] = await Promise.all([
    inventory(pathEnv, options.runtimeNames),
    toolStates(manifest, options.statePath, pathEnv),
  ]);
  const tools: ToolRow[] = manifest.tools.map((tool) => ({
    name: tool.name, category: tool.category, disposition: tool.disposition, state: states[tool.name] as ToolState,
  }));
  return { platform: process.platform, architecture: process.arch, note: DOCTOR_NOTE, runtime, tools };
}

if (import.meta.main) {
  console.log(JSON.stringify(await report(), null, 2));
}
