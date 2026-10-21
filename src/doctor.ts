import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, resolve } from "node:path";
export interface ToolPresence { name: string; available: boolean; path: string | null; validated: false }
const catalog = ["bun", "node", "pi", "rg", "git", "ast-grep", "sg", "nmap", "vulnx", "ffuf", "subfinder", "dnsx", "httpx", "uncover", "katana", "nuclei", "interactsh-client", "semgrep", "trivy", "gitleaks", "osv-scanner", "obscura", "rea", "ghidra", "java", "tshark", "yara"];
/** PATH metadata only. Never runs an executable, probes a target, installs, or writes configuration. */
export async function inventory(path = process.env.PATH ?? "", names: readonly string[] = catalog): Promise<ToolPresence[]> {
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
if (import.meta.main) {
  console.log(JSON.stringify({
    platform: process.platform, architecture: process.arch,
    note: "PATH presence only; versions, identity, compatibility, credentials, Pi integration and target behavior are unvalidated. An executable named httpx/sg may be unrelated. No tools were executed.",
    tools: await inventory(),
  }, null, 2));
}
