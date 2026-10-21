import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_CONCURRENT_CHILDREN, MAX_TOTAL_SPAWNS_PER_RUN } from "../src/specialists/contracts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE = join(ROOT, "config", "cyber");

/** Pinned versions come from docs/research/PACKAGES-*.md; the manifest must not float them. */
const EXPECTED = {
  "pi-subagents": "0.79.2",
  "pi-web-access": "0.43.0",
  "pi-btw": "0.8.0",
  bigpowers: "2.88.9",
} as const;

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const originalFetch = globalThis.fetch;
let networkCalls = 0;
beforeAll(() => {
  globalThis.fetch = (async () => {
    networkCalls++;
    throw new Error("network access is not allowed in package wiring tests");
  }) as unknown as typeof globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("package manifest", () => {
  test("declares every reviewed package at an exact pin", () => {
    const manifest = readJson(join(ROOT, "package.json"));
    const dependencies = (manifest.dependencies ?? {}) as Record<string, string>;
    for (const [name, version] of Object.entries(EXPECTED)) {
      expect(dependencies[name]).toBe(version);
      expect(dependencies[name]).not.toMatch(/^[\^~><]/);
    }
  });

  test("the pinned packages are installed in this repository", () => {
    for (const [name, version] of Object.entries(EXPECTED)) {
      const installed = join(ROOT, "node_modules", name, "package.json");
      expect(existsSync(installed)).toBe(true);
      expect((readJson(installed).version as string) ?? null).toBe(version);
    }
  });

  test("the harness manifest keeps its own extension and theme resources resolvable", () => {
    const manifest = readJson(join(ROOT, "package.json"));
    const pi = (manifest.pi ?? {}) as Record<string, string[]>;
    expect(pi.extensions).toContain("./src/index.ts");
    for (const resourceType of ["extensions", "themes", "skills", "prompts"] as const) {
      for (const entry of pi[resourceType] ?? []) {
        expect(existsSync(resolve(ROOT, entry))).toBe(true);
      }
    }
  });
});

describe("cyber profile wiring", () => {
  test("declares the four packages as local sources that exist on disk", () => {
    const settings = readJson(join(PROFILE, "settings.json"));
    const packages = (settings.packages ?? []) as { source: string; extensions?: string[]; skills?: string[]; prompts?: string[] }[];
    expect(packages.length).toBe(Object.keys(EXPECTED).length);
    for (const entry of packages) {
      const source = resolve(PROFILE, entry.source);
      expect(existsSync(source)).toBe(true);
      const name = entry.source.split("/").pop() as string;
      expect(Object.keys(EXPECTED)).toContain(name);
    }
  });

  test("bigpowers is installed but deliberately loads no extension, skill or prompt", () => {
    const settings = readJson(join(PROFILE, "settings.json"));
    const packages = (settings.packages ?? []) as { source: string; extensions?: string[]; skills?: string[]; prompts?: string[] }[];
    const bigpowers = packages.find((entry) => entry.source.endsWith("bigpowers"));
    expect(bigpowers).toBeDefined();
    expect(bigpowers?.extensions).toEqual([]);
    expect(bigpowers?.skills).toEqual([]);
    expect(bigpowers?.prompts).toEqual([]);
  });

  test("every profile resource path resolves to something on disk", () => {
    const settings = readJson(join(PROFILE, "settings.json"));
    for (const resourceType of ["skills", "extensions", "prompts", "themes"] as const) {
      for (const entry of (settings[resourceType] ?? []) as string[]) {
        const target = isAbsolute(entry) ? entry : resolve(PROFILE, entry);
        expect(existsSync(target)).toBe(true);
        expect(statSync(target).isDirectory() || statSync(target).isFile()).toBe(true);
      }
    }
    for (const entry of (settings.packages ?? []) as { source: string }[]) {
      expect(existsSync(resolve(PROFILE, entry.source))).toBe(true);
    }
  });

  test("the profile carries the twelve specialist roles and the six selected skills", () => {
    const roles = ["recon", "web-api", "vulnerability-research", "validation", "offensive-operator", "source-remediation", "auth", "secrets", "exfil", "backdoor", "reverse", "reviewer"];
    for (const role of roles) {
      const path = join(PROFILE, "agents", `${role}.md`);
      expect(existsSync(path)).toBe(true);
      const body = readFileSync(path, "utf8");
      expect(body.startsWith("---\n")).toBe(true);
      expect(body).toContain(`name: ${role}`);
      expect(body).toContain("contracts.ts");
      const declared = /extensions:\s*(\S+)/.exec(body)?.[1] ?? "";
      expect(existsSync(resolve(join(PROFILE, "agents"), declared))).toBe(true);
    }
    for (const skill of ["survey-context", "research-first", "plan-work", "develop-tdd", "verify-work", "audit-code"]) {
      expect(existsSync(join(PROFILE, "skills", skill, "SKILL.md"))).toBe(true);
    }
  });

  test("the pi-subagents spawn caps match the harness contract constants", () => {
    const config = readJson(join(PROFILE, "extensions", "subagent", "config.json"));
    expect(config.maxSubagentSpawnsPerRun).toBe(MAX_TOTAL_SPAWNS_PER_RUN);
    expect(config.globalConcurrencyLimit).toBe(MAX_CONCURRENT_CHILDREN);
    expect(config.maxActiveAsyncRunsPerSession).toBe(MAX_CONCURRENT_CHILDREN);
    expect(MAX_TOTAL_SPAWNS_PER_RUN).toBeLessThan(64);
  });

  test("web access pins an explicit search provider and the raw-result workflow", () => {
    const webSearch = readJson(join(PROFILE, "web-search.json"));
    expect(webSearch.provider).toBe("duckduckgo");
    expect(webSearch.provider).not.toBe("auto");
    expect(webSearch.workflow).toBe("none");
    expect((webSearch.webSearch as { allowedProviders?: string[] }).allowedProviders).toEqual(["duckduckgo"]);
    expect(webSearch.allowBrowserCookies).toBe(false);
    expect((webSearch.fetchRouting as { allowRemoteHostedProviders?: boolean }).allowRemoteHostedProviders).toBe(false);
  });
});

describe("no network at test time", () => {
  test("the wiring checks never reached the network", () => {
    expect(networkCalls).toBe(0);
  });
});
