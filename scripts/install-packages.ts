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
let settings: { [key: string]: unknown; packages?: unknown[] } = {};
try {
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    settings = parsed as { [key: string]: unknown; packages?: unknown[] };
  }
} catch (error) {
  if (!(error instanceof Error) || !("code" in error && error.code === "ENOENT")) throw error;
}
const packageSource = (item: unknown): string | undefined => {
  if (typeof item === "string") return item;
  if (typeof item === "object" && item !== null && "source" in item && typeof item.source === "string") return item.source;
  return undefined;
};
const installed = new Set((settings.packages ?? []).map(packageSource).filter((source): source is string => source !== undefined));

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

const installedSettings: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
if (typeof installedSettings !== "object" || installedSettings === null || Array.isArray(installedSettings)) {
  throw new Error(`Pi wrote invalid settings at ${settingsPath}`);
}
settings = installedSettings as { [key: string]: unknown; packages?: unknown[] };

// Keep bigpowers limited to six selected skills; do not load its extension,
// prompts, themes, or the remaining broad skill catalog.
const bigpowers = "npm:bigpowers@2.88.9";
settings.packages = (settings.packages ?? []).map((item) => packageSource(item) === bigpowers
  ? {
      source: bigpowers,
      autoload: false,
      extensions: [],
      prompts: [],
      themes: [],
      skills: [
        "+.pi/skills/survey-context/SKILL.md",
        "+.pi/skills/research-first/SKILL.md",
        "+.pi/skills/plan-work/SKILL.md",
        "+.pi/skills/develop-tdd/SKILL.md",
        "+.pi/skills/verify-work/SKILL.md",
        "+.pi/skills/audit-code/SKILL.md",
      ],
    }
  : item);
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });

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
