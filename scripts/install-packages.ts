import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profile = resolve(process.env.PI_CODING_AGENT_DIR ?? `${root}/config/cyber`);
const pi = resolve(root, "node_modules/.bin/pi");
const packages = [
  "npm:pi-subagents@0.79.2",
  "npm:pi-web-access@0.43.0",
  "npm:pi-btw@0.8.0",
  "npm:bigpowers@2.88.9",
];

mkdirSync(profile, { recursive: true });
const settingsPath = resolve(profile, "settings.json");
let settings: { packages?: unknown[] } = {};
try {
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    settings = parsed as { packages?: unknown[] };
  }
} catch (error) {
  if (!(error instanceof Error) || !("code" in error && error.code === "ENOENT")) throw error;
}
const installed = new Set((settings.packages ?? []).filter((item): item is string => typeof item === "string"));

for (const source of packages) {
  if (installed.has(source)) {
    console.log(`already recorded: ${source}`);
    continue;
  }
  const result = spawnSync(pi, ["install", source, "--no-approve"], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: profile },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  installed.add(source);
}

const webConfigPath = resolve(profile, "web-search.json");
let webConfig: { [key: string]: unknown } = {};
try {
  const parsed: unknown = JSON.parse(readFileSync(webConfigPath, "utf8"));
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    webConfig = parsed as { [key: string]: unknown };
  }
} catch (error) {
  if (!(error instanceof Error) || !("code" in error && error.code === "ENOENT")) throw error;
}
webConfig.searchProvider ??= "exa";
webConfig.workflow ??= "none";
writeFileSync(webConfigPath, `${JSON.stringify(webConfig, null, 2)}\n`, { mode: 0o600 });
console.log(`profile: ${profile}`);
console.log(`search provider: ${String(webConfig.searchProvider)}; workflow: ${String(webConfig.workflow)}`);
