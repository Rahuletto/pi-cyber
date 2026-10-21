import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Offense specification invariants.
 *
 * The runtime overlay is capped at 25 lines by tests/prompts.test.ts, so the
 * operator behaviour lives in files the agent loads on demand. These tests
 * make sure that tree stays intact: the specification exists, every package
 * is reachable, every model in the catalogue routes to an overlay that
 * exists, and the rendered prompt never leaks a placeholder.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROMPTS = join(ROOT, "prompts");

const PACKAGES = ["behavior", "contract", "doctrine", "doors", "exfil", "backdoor", "secrets", "evidence", "status"];
const OVERLAYS = ["general", "grok", "claude", "gpt", "reasoning", "deepseek", "llama", "qwen", "gemma", "mistral", "phi4", "gemini", "glm", "kimi", "toolcall", "kernel"];
const WIRED_ROLES = ["recon", "web-api", "vulnerability-research", "validation", "offensive-operator", "source-remediation"];

/** Must stay in step with OVERLAY_RULES in src/index.ts. */
const OVERLAY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^grok|^cursor-grok|^cortex/i, "grok"], [/^claude/i, "claude"],
  [/^gpt-5|^gpt-4o|^gpt-oss|^composer/i, "gpt"], [/^o1$|^o3$|^o4/i, "reasoning"],
  [/^deepseek/i, "deepseek"], [/^llama/i, "llama"], [/^qwen/i, "qwen"], [/^gemma/i, "gemma"],
  [/^mistral/i, "mistral"], [/^phi/i, "phi4"], [/^gemini/i, "gemini"], [/^glm|^zai-glm/i, "glm"],
  [/^kimi/i, "kimi"], [/^nemotron|^arcee/i, "reasoning"],
];

describe("offense specification tree", () => {
  test("the complete specification and every package exist and carry real content", () => {
    const full = readFileSync(join(PROMPTS, "offense-full.md"), "utf8");
    expect(full.length).toBeGreaterThan(20000);
    expect(full).toContain("# 30. ACTIVATION");
    for (const name of PACKAGES) {
      const path = join(PROMPTS, "packages", `${name}.md`);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(400);
    }
  });

  test("every overlay exists, including the general fallback and the tool-calling block", () => {
    for (const name of OVERLAYS) {
      const path = join(PROMPTS, "overlays", `${name}.md`);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8").trim().length).toBeGreaterThan(150);
    }
  });

  // The catalogue is operator-owned and git-ignored (provider endpoints and key
  // sources never live in the repository). A checkout without one cannot assert
  // overlay routing, so the invariant is skipped rather than failed.
  const CATALOGUE = join(ROOT, "config/models.json");

  test.skipIf(!existsSync(CATALOGUE))("every model in the catalogue routes to an overlay that exists", () => {
    const models = JSON.parse(readFileSync(CATALOGUE, "utf8"));
    const ids: string[] = [];
    for (const provider of Object.values(models.providers as Record<string, { models: { id: string }[] }>)) {
      for (const model of provider.models) ids.push(model.id);
    }
    expect(ids.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const id of ids) {
      const family = OVERLAY_RULES.find(([pattern]) => pattern.test(id))?.[1] ?? "general";
      seen.add(family);
      expect(existsSync(join(PROMPTS, "overlays", `${family}.md`))).toBe(true);
    }
    // A catalogue that collapsed onto one family would mean the rules rotted.
    expect(seen.size).toBeGreaterThan(5);
  });

  test("the runtime overlay renders with no leftover placeholder", () => {
    const template = readFileSync(join(PROMPTS, "offense.md"), "utf8");
    const rendered = template
      .replaceAll("{{PROMPTS_DIR}}", PROMPTS)
      .replace("{{MODEL_OVERLAY}}", readFileSync(join(PROMPTS, "overlays", "grok.md"), "utf8"));
    expect(rendered).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(rendered).toContain("cyber_spec");
  });

  test("the runtime overlay names every package so each is reachable from the prompt", () => {
    const overlay = readFileSync(join(PROMPTS, "offense.md"), "utf8");
    for (const name of PACKAGES) expect(overlay).toContain(name);
  });

  test("the deep roster covers the whole mixture of experts and every wired role points into it", () => {
    const roster = readdirSync(join(ROOT, "agents")).filter((file) => file.endsWith(".md"));
    expect(roster.length).toBeGreaterThanOrEqual(12);
    for (const role of WIRED_ROLES) {
      const body = readFileSync(join(ROOT, "config/cyber/agents", `${role}.md`), "utf8");
      // The playbook is reached through the tool, so the pointer stays valid
      // from any working directory.
      const playbook = /Full\s+playbook:\s*call cyber_spec with target `role:([a-z-]+)`/.exec(body);
      expect(playbook).not.toBeNull();
      expect(playbook![1]).toBe(role);
      // Every wired specialist can reach the specification it depends on.
      expect(body).toContain("cyber_spec");
    }
  });
});
