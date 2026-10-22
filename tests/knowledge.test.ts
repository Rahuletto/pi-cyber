import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  MAX_HITS,
  MAX_SNIPPET_CHARS,
  SKILL_BODY_CAP,
  buildSnippet,
  openKnowledge,
  parseFrontmatter,
  toMatchExpression,
  type KnowledgeStore,
} from "../src/knowledge/fts.ts";
import { registerKnowledgeTool } from "../src/tools/knowledge.ts";
import { SECRET_REFUSAL_MESSAGE } from "../src/evidence/secrets.ts";

/**
 * Knowledge layer tests — fully offline. Every fixture is written into a
 * temporary directory: a minimal SKILL.md (frontmatter + body), a research
 * markdown, a repo doc and a secret-tainted skill.
 */

const SKILL_BODY = "Always run the fixture validation step before reporting findings.";
const RESEARCH_BODY = "The fixture corpus documents the validation matrix for regression checks.";
const DOC_BODY = "Fixture documentation for the local engagement harness.";
const TAINTED_BODY = "Use password=hunter2 in the fixture login form.";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  skillsDir: string;
  researchDir: string;
  docsDir: string;
  skillPath: string;
  taintedSkillPath: string;
  researchPath: string;
  docPath: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "cyber-knowledge-"));
  directories.push(root);
  const skillsDir = join(root, "skills");
  const researchDir = join(root, "research");
  const docsDir = join(root, "docs");
  await mkdir(join(skillsDir, "fixture-skill"), { recursive: true });
  await mkdir(join(skillsDir, "tainted-skill"), { recursive: true });
  await mkdir(researchDir, { recursive: true });
  await mkdir(docsDir, { recursive: true });

  const skillPath = join(skillsDir, "fixture-skill", "SKILL.md");
  await writeFile(skillPath, [
    "---",
    "name: fixture-skill",
    "description: Detects fixture scanning patterns for regression checks",
    "domain: cybersecurity",
    "tags:",
    "- fixture",
    "---",
    "",
    "# Fixture Skill",
    "",
    "## When to Use",
    "",
    "- When a fixture regression must be reproduced",
    "",
    "## Workflow",
    "",
    SKILL_BODY,
    "",
  ].join("\n"), "utf8");

  const taintedSkillPath = join(skillsDir, "tainted-skill", "SKILL.md");
  await writeFile(taintedSkillPath, [
    "---",
    "name: tainted-skill",
    "description: Fixture skill that carries a raw credential",
    "---",
    "",
    "# Tainted Skill",
    "",
    TAINTED_BODY,
    "",
  ].join("\n"), "utf8");

  const researchPath = join(researchDir, "fixture-research.md");
  await writeFile(researchPath, `# Fixture Research\n\n${RESEARCH_BODY}\n`, "utf8");

  const docPath = join(docsDir, "FIXTURE-DOC.md");
  await writeFile(docPath, `# Fixture Doc\n\n${DOC_BODY}\n`, "utf8");

  return { root, skillsDir, researchDir, docsDir, skillPath, taintedSkillPath, researchPath, docPath };
}

function openStore(fixture: Fixture): KnowledgeStore {
  return openKnowledge({
    dir: join(fixture.root, "knowledge"),
    skillsDir: fixture.skillsDir,
    researchDirs: [fixture.researchDir],
    docsDir: fixture.docsDir,
  });
}

test("parses agentskills-style frontmatter (name, description, tags) and keeps the body", () => {
  const parsed = parseFrontmatter([
    "---",
    "name: fixture-skill",
    "description: >-",
    "  Folded description",
    "  over two lines",
    "domain: cybersecurity",
    "tags:",
    "- fixture",
    "---",
    "",
    "# Body",
  ].join("\n"));
  expect(parsed.data.name).toBe("fixture-skill");
  expect(parsed.data.description).toBe("Folded description over two lines");
  expect(parsed.data.domain).toBe("cybersecurity");
  expect(parsed.body.trim().startsWith("# Body")).toBe(true);
});

test("parses a multi-line single-quoted description (agentskills.io shape)", () => {
  const parsed = parseFrontmatter([
    "---",
    "name: quoted-skill",
    "description: 'Parses software bills of materials",
    "  and correlates components against the CVE database",
    "",
    "  '",
    "domain: cybersecurity",
    "---",
    "",
    "# Quoted",
  ].join("\n"));
  expect(parsed.data.name).toBe("quoted-skill");
  expect(parsed.data.description).toContain("correlates components");
  expect(parsed.data.description.startsWith("Parses software bills")).toBe(true);
});

test("ingest indexes skill, research and doc sources", async () => {
  const fixture = await makeFixture();
  const store = openStore(fixture);
  try {
    const skill = store.ingest("skill");
    expect(skill.scanned).toBe(2);
    expect(skill.indexed).toBe(1);
    expect(skill.refused).toHaveLength(1);

    const research = store.ingest("research");
    expect(research.indexed).toBe(1);

    const doc = store.ingest("doc");
    expect(doc.indexed).toBe(1);
  } finally {
    store.close();
  }
});

test("search finds the right document and marks the matched term", async () => {
  const fixture = await makeFixture();
  const store = openStore(fixture);
  try {
    store.rebuild();
    const hits = store.search("validation");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThanOrEqual(MAX_HITS);
    const skillHit = hits.find((hit) => hit.source === "skill");
    expect(skillHit).toBeDefined();
    expect(skillHit!.title).toBe("fixture-skill");
    expect(skillHit!.ref).toBe(fixture.skillPath);
    expect(skillHit!.snippet).toContain("«validation»");
    expect(skillHit!.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS + 8);
    expect(skillHit!.id).toMatch(/^[a-f0-9]{64}$/);
    const fetched = store.fetch(skillHit!.id, { offset: 4, length: 12 });
    expect(fetched).toMatchObject({ source: "skill", title: "fixture-skill", ref: fixture.skillPath, offset: 4, totalChars: expect.any(Number) });
    expect(fetched!.text.length).toBeLessThanOrEqual(12);
    expect(fetched!.indexedAt).toBeTruthy();
    const lookupPlan = new Database(store.path, { readonly: true });
    try {
      const plan = lookupPlan.prepare("EXPLAIN QUERY PLAN SELECT source, ref, title, body, indexed_at, content_id FROM documents WHERE content_id = ?").all(skillHit!.id) as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes("documents_content_id_idx"))).toBe(true);
    } finally {
      lookupPlan.close();
    }

    const researchHit = store.search("corpus")[0];
    expect(researchHit.source).toBe("research");
    expect(researchHit.ref).toBe(fixture.researchPath);
    expect(researchHit.title).toBe("Fixture Research");
  } finally {
    store.close();
  }
});

test("a search can be narrowed to one source", async () => {
  const fixture = await makeFixture();
  const store = openStore(fixture);
  try {
    store.rebuild();
    const all = store.search("fixture");
    expect(all.some((hit) => hit.source === "skill")).toBe(true);
    const onlyDoc = store.search("fixture", { source: "doc" });
    expect(onlyDoc.length).toBeGreaterThan(0);
    expect(onlyDoc.every((hit) => hit.source === "doc")).toBe(true);
  } finally {
    store.close();
  }
});

test("an unrelated query returns nothing", async () => {
  const fixture = await makeFixture();
  const store = openStore(fixture);
  try {
    store.rebuild();
    expect(store.search("kubernetes")).toHaveLength(0);
  } finally {
    store.close();
  }
});

test("secret-tainted fixture is refused, named by path, and never indexed", async () => {
  const fixture = await makeFixture();
  const store = openStore(fixture);
  try {
    const result = store.ingest("skill");
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].ref).toBe(fixture.taintedSkillPath);
    expect(result.refused[0].reason).toBe(SECRET_REFUSAL_MESSAGE);
    // The tainted document must not be searchable.
    expect(store.search("hunter2")).toHaveLength(0);
    const stats = store.stats();
    expect(stats.refusals.some((refusal) => refusal.ref === fixture.taintedSkillPath)).toBe(true);
    expect(stats.counts.skill).toBe(1);
  } finally {
    store.close();
  }
});

test("stats reports per-source counts, last rebuild and the stale marker", async () => {
  const fixture = await makeFixture();
  const store = openStore(fixture);
  try {
    expect(store.stats().lastRebuiltAt).toBeNull();
    store.rebuild();
    const stats = store.stats();
    expect(stats.counts).toEqual({ skill: 1, research: 1, doc: 1 });
    expect(stats.total).toBe(3);
    expect(stats.lastRebuiltAt).not.toBeNull();
    expect(stats.sources.map((source) => source.stale)).toEqual([false, false, false]);

    // A newer source file makes the index stale.
    const future = new Date(Date.now() + 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(fixture.researchPath, future, future);
    const stale = store.stats();
    expect(stale.sources.find((source) => source.source === "research")!.stale).toBe(true);
  } finally {
    store.close();
  }
});

test("rebuild is idempotent: a second run updates instead of duplicating", async () => {
  const fixture = await makeFixture();
  const store = openStore(fixture);
  try {
    const first = store.rebuild();
    expect(first.indexed).toBe(3);
    const second = store.rebuild();
    expect(second.indexed).toBe(0);
    expect(second.updated).toBe(3);
    expect(store.stats().total).toBe(3);
  } finally {
    store.close();
  }
});

test("knowledge IDs survive unchanged rebuilds and stale IDs never resolve to changed content", async () => {
  const fixture = await makeFixture();
  const store = openStore(fixture);
  try {
    store.rebuild();
    const id = store.search("validation", { source: "skill" })[0].id;
    store.rebuild();
    expect(store.search("validation", { source: "skill" })[0].id).toBe(id);
    await writeFile(fixture.skillPath, "# Changed document\n\nvalidation content changed\n", "utf8");
    store.rebuild("skill");
    expect(store.fetch(id)).toBeNull();
  } finally {
    store.close();
  }
});

test("empty and invalid MATCH queries raise typed errors", async () => {
  const fixture = await makeFixture();
  const store = openStore(fixture);
  try {
    store.rebuild();
    expect(() => store.search("")).toThrow(/nonempty/i);
    expect(() => store.search("   ")).toThrow(/nonempty/i);
    expect(() => store.search("!!! ???")).toThrow(/alphanumeric/i);
    expect(() => toMatchExpression("")).toThrow(Error);
    // FTS5 operators cannot smuggle semantics into the query.
    const sanitized = toMatchExpression("idor OR * NEAR(x)");
    expect(sanitized.expression).toBe('"idor" "OR" "NEAR" "x"');
  } finally {
    store.close();
  }
});

test("the skill body is capped and the index keeps the FTS5 virtual table", async () => {
  const fixture = await makeFixture();
  const longSkill = join(fixture.skillsDir, "long-skill");
  await mkdir(longSkill, { recursive: true });
  await writeFile(join(longSkill, "SKILL.md"), [
    "---",
    "name: long-skill",
    "description: Fixture skill with an oversized body",
    "---",
    "",
    "# Long Skill",
    "",
    "x".repeat(SKILL_BODY_CAP * 2),
    "",
  ].join("\n"), "utf8");

  const store = openStore(fixture);
  try {
    store.ingest("skill");
    const db = new Database(store.path, { readonly: true });
    try {
      const row = db.prepare("SELECT body FROM documents WHERE source = 'skill' AND ref = ?").get(join(longSkill, "SKILL.md")) as { body: string } | null;
      expect(row).not.toBeNull();
      expect(row!.body.length).toBeLessThanOrEqual(SKILL_BODY_CAP);
      expect(row!.body.endsWith("[truncated]")).toBe(true);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toContain("documents_fts");
      const documents = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
      expect(documents.n).toBe(2);
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
});

test("search output is capped at 10 hits even when more documents match", async () => {
  const fixture = await makeFixture();
  for (let i = 0; i < 14; i++) {
    const dir = join(fixture.skillsDir, `bulk-${i}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: bulk-${i}\ndescription: bulk fixture\n---\n\n# Bulk\n\n${SKILL_BODY}\n`, "utf8");
  }
  const store = openStore(fixture);
  try {
    store.rebuild();
    const hits = store.search("validation");
    expect(hits).toHaveLength(MAX_HITS);
    // An explicit limit is clamped to the same cap.
    expect(store.search("validation", { limit: 3 }).length).toBeLessThanOrEqual(MAX_HITS);
  } finally {
    store.close();
  }
});

test("snippet marks every matched term and stays short", () => {
  const snippet = buildSnippet("a ".repeat(200) + "unique-token " + "b ".repeat(200), [{ text: "unique-token", lower: "unique-token" }]);
  expect(snippet).toContain("«unique-token»");
  expect(snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS + 10);
});

test("cyber_knowledge tool registers and exposes search, stats and rebuild", async () => {
  const fixture = await makeFixture();
  const registered: Array<{ name: string; execute: (...args: never[]) => unknown }> = [];
  registerKnowledgeTool({
    registerTool: (tool: { name: string; execute: (...args: never[]) => unknown }) => { registered.push(tool as never); },
  } as never);
  expect(registered).toHaveLength(1);
  expect(registered[0].name).toBe("cyber_knowledge");

  const previous = { ...process.env };
  process.env.CYBER_KNOWLEDGE_DIR = join(fixture.root, "knowledge");
  process.env.CYBER_KNOWLEDGE_SKILLS_DIR = fixture.skillsDir;
  process.env.CYBER_KNOWLEDGE_RESEARCH_DIR = fixture.researchDir;
  process.env.CYBER_KNOWLEDGE_DOCS_DIR = fixture.docsDir;
  try {
    const tool = registered[0] as unknown as {
      execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
      executionMode?: string;
      parameters?: { additionalProperties?: boolean };
    };
    expect(tool.executionMode).toBe("sequential");
    expect(tool.parameters?.additionalProperties).toBe(false);

    const rebuild = await tool.execute("fixture", { action: "rebuild" }, undefined, undefined, {});
    expect(rebuild.content[0].text).toContain("knowledge rebuild");
    expect(rebuild.content[0].text).toContain(fixture.taintedSkillPath);
    expect(rebuild.content[0].text).toContain("refused");

    const search = await tool.execute("fixture", { action: "search", query: "validation", source: "skill" }, undefined, undefined, {});
    expect(search.content[0].text).toContain("«validation»");
    expect(search.content[0].text).toContain("[skill] fixture-skill");
    expect(search.content[0].text).toContain("id: ");
    expect((search.details as { hits: number }).hits).toBeGreaterThan(0);
    const hitId = /id: ([a-f0-9]{64})/.exec(search.content[0].text)![1];
    const fetched = await tool.execute("fixture", { action: "fetch", id: hitId, offset: 0, length: 64 }, undefined, undefined, {});
    expect(fetched.content[0].text).toContain(`ref: ${fixture.skillPath}`);
    expect(fetched.content[0].text).toContain("indexed:");
    expect((fetched.details as { returnedChars: number }).returnedChars).toBeLessThanOrEqual(64);
    await expect(tool.execute("fixture", { action: "fetch", id: "deadbeef" }, undefined, undefined, {})).rejects.toThrow(/invalid, stale, or withheld/);

    const stats = await tool.execute("fixture", { action: "stats" }, undefined, undefined, {});
    expect(stats.content[0].text).toContain("counts: skill=");
    expect(stats.content[0].text).toContain("last rebuilt:");

    await expect(tool.execute("fixture", { action: "search" }, undefined, undefined, {})).rejects.toThrow(/query required/i);
    await expect(tool.execute("fixture", { action: "search", query: "!!!" }, undefined, undefined, {})).rejects.toThrow(/alphanumeric/i);
  } finally {
    process.env = previous;
  }
});

test("the knowledge index never lives inside the evidence database", async () => {
  const fixture = await makeFixture();
  const store = openStore(fixture);
  try {
    expect(store.path.endsWith(join("knowledge", "knowledge.sqlite"))).toBe(true);
    expect(store.path.includes("evidence")).toBe(false);
  } finally {
    store.close();
  }
});
