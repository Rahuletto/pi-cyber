/**
 * Package installer for the cyber profile (Tasks 10 + 11).
 *
 * The harness runs under bun, so the four reviewed Pi packages are installed
 * into this repository with `bun add` and pinned in package.json. This script
 * is the operator-facing half: it verifies the pins, reports the resolved
 * on-disk paths Pi will load, and refreshes the selectively copied bigpowers
 * skills in the profile.
 *
 * It never installs anything itself, never reaches the network, and is never
 * invoked by the test suite. Run it explicitly:
 *
 *   bun scripts/install-packages.ts            # verify + refresh profile skills
 *   bun scripts/install-packages.ts --check    # verify only, no writes
 */
import { existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = join(ROOT, "config", "cyber");

/** Package identity and pin come from research/PACKAGES-*.md; keep them exact. */
export const EXPECTED_PACKAGES = [
  { name: "pi-subagents", version: "0.79.2", role: "worker engine" },
  { name: "pi-web-access", version: "0.43.0", role: "search and extraction" },
  { name: "pi-btw", version: "0.8.0", role: "optional side conversation" },
  { name: "bigpowers", version: "2.88.9", role: "selective remediation skills" },
] as const;

/** Plan Task 11: only these bigpowers skills enter the profile. */
export const SELECTED_SKILLS = ["survey-context", "research-first", "plan-work", "develop-tdd", "verify-work", "audit-code"] as const;

export interface PackageCheck {
  name: string;
  declared: string | null;
  installed: string | null;
  expected: string;
  path: string | null;
  ok: boolean;
  problem: string | null;
}

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const pinOf = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  return value.replace(/^[\^~>=<\s]+/, "");
};

/** Compare the declared pin and the installed copy against the reviewed version. */
export function checkPackages(root = ROOT): PackageCheck[] {
  const manifest = readJson(join(root, "package.json"));
  const declared = { ...(manifest?.dependencies as Record<string, string> | undefined) };
  return EXPECTED_PACKAGES.map((expected) => {
    const declaredVersion = pinOf(declared[expected.name]) ?? null;
    const packageRoot = join(root, "node_modules", expected.name);
    const installed = readJson(join(packageRoot, "package.json"));
    const installedVersion = typeof installed?.version === "string" ? installed.version : null;
    const problems: string[] = [];
    if (!declaredVersion) problems.push("not declared in package.json dependencies");
    else if (declaredVersion !== expected.version) problems.push(`package.json pins ${declaredVersion}, expected ${expected.version}`);
    if (!installedVersion) problems.push("not installed in node_modules");
    else if (installedVersion !== expected.version) problems.push(`installed ${installedVersion}, expected ${expected.version}`);
    return {
      name: expected.name,
      declared: declaredVersion,
      installed: installedVersion,
      expected: expected.version,
      path: installedVersion ? packageRoot : null,
      ok: problems.length === 0,
      problem: problems.length ? problems.join("; ") : null,
    };
  });
}

/** Refresh the copied bigpowers skills; report every file that could not be copied. */
export function syncSelectedSkills(root = ROOT): { copied: string[]; failed: string[] } {
  const copied: string[] = [];
  const failed: string[] = [];
  const sourceRoot = join(root, "node_modules", "bigpowers", ".pi", "skills");
  for (const skill of SELECTED_SKILLS) {
    const source = join(sourceRoot, skill, "SKILL.md");
    const target = join(root, "config", "cyber", "skills", skill, "SKILL.md");
    if (!existsSync(source)) {
      failed.push(`${skill}: missing source ${source}`);
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      copied.push(skill);
    } catch (error) {
      failed.push(`${skill}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { copied, failed };
}

/** Profile files Pi reads for this harness. */
export function profilePaths(root = ROOT): { path: string; exists: boolean; kind: string }[] {
  const candidates: [string, string][] = [
    [join(root, "config", "cyber", "settings.json"), "profile settings (packages, skills)"],
    [join(root, "config", "cyber", "web-search.json"), "pi-web-access configuration"],
    [join(root, "config", "cyber", "extensions", "subagent", "config.json"), "pi-subagents spawn caps"],
    [join(root, "config", "cyber", "agents"), "specialist role definitions"],
    [join(root, "config", "cyber", "skills"), "selected bigpowers skills"],
  ];
  return candidates.map(([path, kind]) => ({ path, exists: existsSync(path), kind }));
}

function main(): number {
  const checkOnly = process.argv.includes("--check");
  const checks = checkPackages();
  let failed = false;
  console.log("pi-cyber package check (pins from research/PACKAGES-*.md)");
  for (const check of checks) {
    if (check.ok) {
      console.log(`  ok       ${check.name}@${check.expected} -> ${check.path}`);
      continue;
    }
    failed = true;
    console.error(`  FAILED   ${check.name}@${check.expected}: ${check.problem}`);
    console.error(`           fix: bun add ${check.name}@${check.expected}`);
  }

  let sync = { copied: [] as string[], failed: [] as string[] };
  if (!checkOnly) {
    sync = syncSelectedSkills();
    for (const skill of sync.copied) console.log(`  skill    ${skill} (copied from bigpowers)`);
    for (const problem of sync.failed) {
      failed = true;
      console.error(`  FAILED   skill ${problem}`);
    }
  }

  console.log("profile paths Pi loads for this harness");
  for (const entry of profilePaths()) {
    console.log(`  ${entry.exists ? "ok      " : "MISSING "} ${entry.kind}: ${entry.path}`);
    if (!entry.exists) failed = true;
  }

  if (failed) {
    console.error("package wiring incomplete: resolve the failures above before running the harness.");
    return 1;
  }
  console.log("package wiring complete. Start Pi with: bun run pi (from the repository root).");
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
