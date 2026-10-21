import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adapters } from "../src/adapters/index.ts";

/**
 * Prompt invariants (Task 13). The overlays are injected into the system
 * prompt on every provider call, so they must stay small, free of metadata
 * leakage, and free of phantom capabilities: every tool they name must exist.
 */

const promptFile = (name: string): string => fileURLToPath(new URL(`../prompts/${name}.md`, import.meta.url));
const read = (name: string): string => readFileSync(promptFile(name), "utf8");

const base = read("base");
const offense = read("offense");
const defense = read("defense");
const all = { base, offense, defense };

/**
 * Line caps from the buildout plan Task 13. Lines enforce the dense-paragraph
 * structure (bolded section headers, no walls of bullets).
 */
const LINE_CAPS: Record<string, number> = { base: 40, offense: 25, defense: 25 };

/**
 * Character caps. The overlays are injected into the system prompt on every
 * provider call, so the size that actually costs tokens is characters, not
 * lines — a 25-line file can hold 60k characters and blow the context window
 * without tripping the line cap. This budget is the real size guard.
 */
const CHAR_CAPS: Record<string, number> = { base: 12_000, offense: 16_000, defense: 12_000 };

/** Tools the overlays are allowed to name. Anything else is a phantom. */
const REGISTERED_CYBER_TOOLS = ["cyber_state", "cyber_evidence", "cyber_jobs", "cyber_spec"];

describe("prompt overlays", () => {
  test("each overlay stays inside its line cap", () => {
    for (const [name, cap] of Object.entries(LINE_CAPS)) {
      const lines = all[name as keyof typeof all].split("\n");
      expect(lines.length).toBeLessThanOrEqual(cap);
    }
  });

  test("each overlay stays inside its character budget", () => {
    for (const [name, cap] of Object.entries(CHAR_CAPS)) {
      expect(all[name as keyof typeof all].length).toBeLessThanOrEqual(cap);
    }
  });

  test("each overlay is non-empty prose with no metadata leakage", () => {
    for (const [name, text] of Object.entries(all)) {
      expect(text.trim().length).toBeGreaterThan(400);
      expect(text.endsWith("\n")).toBe(true);
      expect(text.startsWith("---")).toBe(false); // no YAML frontmatter
      expect(text).not.toContain("<!--");
      expect(text).not.toMatch(/\b(TODO|TBD|FIXME|XXX|PLACEHOLDER|Lorem ipsum)\b/);
      expect(text).not.toMatch(/\[\s*(fill|your|placeholder)\b/i);
    }
  });

  test("base states mode discipline and the scope law", () => {
    expect(base).toContain("/offense");
    expect(base).toContain("/defense");
    expect(base).toMatch(/mode/i);
    expect(base).toMatch(/never expands scope|never widens scope|never expand scope/i);
    expect(base).toContain("cyber_state");
    expect(base).toMatch(/stop and ask|stop and resolve/i);
  });

  test("base separates cataloged from validated and warns about compaction", () => {
    expect(base).toContain("cataloged");
    expect(base).toContain("validated");
    expect(base).toMatch(/compact/i);
    expect(base).toMatch(/rehydrat/i);
  });

  test("base names the finding lifecycle in order", () => {
    const order = ["candidate", "needs-validation", "confirmed", "rejected", "remediated", "retest-passed"];
    let cursor = -1;
    for (const state of order) {
      const index = base.indexOf(state);
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  test("all three overlays carry the redaction reflex, tool-first rule, diagram rule and output caps", () => {
    for (const [name, text] of Object.entries(all)) {
      expect(text).toMatch(/never store or echo raw secrets|raw credentials|raw key material/i);
      expect(text).toContain("cyber_jobs");
      expect(text).toMatch(/never shell out/i);
      expect(text).toContain("mermaid");
      expect(text).toMatch(/cap|clipped|bounded/i);
    }
  });

  test("the coverage matrix rule belongs to the mode overlays, not the base", () => {
    expect(offense).toContain("coverage matrix");
    expect(defense).toContain("coverage matrix");
    expect(base).not.toContain("coverage matrix");
  });

  test("the mode overlays name their own lifecycle and fix classes", () => {
    expect(offense).toContain("needs-validation");
    expect(offense).toContain("retest-passed");
    expect(defense).toContain("needs-validation");
    expect(defense).toContain("retest-passed");
    expect(defense).toMatch(/proposed ≠ applied ≠ verified/);
  });

  test("no overlay names a cyber tool that is not registered", () => {
    for (const [name, text] of Object.entries(all)) {
      const mentioned = [...text.matchAll(/\bcyber_[a-z_]+\b/g)].map((match) => match[0]);
      for (const tool of mentioned) {
        expect(REGISTERED_CYBER_TOOLS).toContain(tool);
      }
      expect(mentioned.length).toBeGreaterThan(0);
    }
  });

  test("every adapter tool the overlays name exists in the registry", () => {
    const registry = new Set(adapters.map((adapter) => adapter.name));
    for (const [name, text] of Object.entries(all)) {
      const named = [...registry].filter((tool) => text.includes(tool));
      expect(named.length).toBe(registry.size);
      for (const tool of named) expect(registry.has(tool)).toBe(true);
    }
  });

  test("the overlays stay in imperative voice without filler", () => {
    for (const [name, text] of Object.entries(all)) {
      expect(text).not.toMatch(/\b(great|awesome|amazing|let's get started|happy hacking)\b/i);
      expect(text).not.toMatch(/\bI will\b/);
    }
    expect(base).toMatch(/act only inside|never expands scope/i);
  });
});
