/**
 * Knowledge layer: a searchable FTS5 index over the local corpus.
 *
 * The corpus is deliberately small and local:
 * - `skill`    — every `~/.agents/skills/<name>/SKILL.md` (frontmatter name +
 *                description parsed; body capped at 8 KiB).
 * - `research` — the repo research markdown (`docs/research/*.md`, falling
 *                back to the repo-root `research/*.md` when the former is
 *                absent).
 * - `doc`      — the repo top-level docs (`docs/*.md`, e.g. REA-LIGHT.md).
 *
 * Storage is a **separate** SQLite file from the evidence store (the evidence
 * DB is engagement-scoped and append-only; the knowledge DB is a derived
 * index that can be rebuilt at any time):
 *   default: `<repoRoot>/config/cyber/knowledge/knowledge.sqlite`
 *   override: `CYBER_KNOWLEDGE_DIR` (directory holding `knowledge.sqlite`).
 *
 * Secret discipline: every piece of text that would be indexed is checked
 * with the evidence store's `containsSecretLike` BEFORE it reaches SQLite.
 * A hit skips the document entirely and records a refusal that NAMES THE
 * PATH, so a tainted file is never searchable and never silently dropped.
 *
 * Rebuild policy: the index is never rebuilt implicitly (that is expensive
 * and must be an explicit operator/model decision). `stats` reports
 * staleness; `rebuild` performs the work.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { containsSecretLike, SECRET_REFUSAL_MESSAGE } from "../evidence/secrets.ts";

export const KNOWLEDGE_SOURCES = ["skill", "research", "doc"] as const;
export type KnowledgeSource = (typeof KNOWLEDGE_SOURCES)[number];

/** Hard cap on returned hits (the model-facing surface never returns more). */
export const MAX_HITS = 10;
/** Maximum characters of a rendered snippet (per hit). */
export const MAX_SNIPPET_CHARS = 240;
/** Body budget for a skill document (frontmatter + body). */
export const SKILL_BODY_CAP = 8 * 1024;
/** Body budget for a research/doc markdown document. */
export const DOC_BODY_CAP = 32 * 1024;
/** Maximum characters of a search query accepted by the index. */
export const MAX_QUERY_CHARS = 512;
/** Marker appended to a body that hit its cap (counted inside the cap). */
const TRUNCATION_MARKER = "[truncated]";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('skill','research','doc')),
  ref TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE (source, ref)
);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title, body, content='documents', content_rowid='id', tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, title, body) VALUES('delete', old.id, old.title, old.body);
  INSERT INTO documents_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
CREATE TABLE IF NOT EXISTS index_state (
  source TEXT PRIMARY KEY,
  last_indexed_at TEXT,
  doc_count INTEGER NOT NULL DEFAULT 0,
  refused_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS refusals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  ref TEXT NOT NULL,
  reason TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Repo root, derived from this module's location (…/src/knowledge/fts.ts). */
export function repoRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

export interface KnowledgeEnv {
  CYBER_KNOWLEDGE_DIR?: string;
  CYBER_KNOWLEDGE_SKILLS_DIR?: string;
  CYBER_KNOWLEDGE_RESEARCH_DIR?: string;
  CYBER_KNOWLEDGE_DOCS_DIR?: string;
  [key: string]: string | undefined;
}

export interface KnowledgePaths {
  /** SQLite file of the knowledge index. */
  dbPath: string;
  /** Root holding `<name>/SKILL.md` directories. */
  skillsDir: string;
  /** Directories holding top-level research markdown. */
  researchDirs: string[];
  /** Directory holding top-level doc markdown. */
  docsDir: string;
}

export interface KnowledgePathOverrides {
  dir?: string;
  path?: string;
  skillsDir?: string;
  researchDirs?: string[];
  docsDir?: string;
}

/** Default research roots: `docs/research` when present, else the repo `research/`. */
export function defaultResearchDirs(root = repoRoot()): string[] {
  const nested = join(root, "docs", "research");
  const flat = join(root, "research");
  const dirs = [nested, flat].filter((dir) => existsSync(dir));
  return dirs.length ? dirs : [nested];
}

/** Resolve every path the index needs. Env overrides win over repo defaults. */
export function resolveKnowledgePaths(
  env: KnowledgeEnv = process.env,
  overrides: KnowledgePathOverrides = {},
): KnowledgePaths {
  const dir = overrides.dir ?? env.CYBER_KNOWLEDGE_DIR?.trim() ?? "";
  const base = dir || join(repoRoot(), "config", "cyber", "knowledge");
  const dbPath = overrides.path ?? join(base, "knowledge.sqlite");
  const skillsDir = overrides.skillsDir ?? (env.CYBER_KNOWLEDGE_SKILLS_DIR?.trim() || join(homedir(), ".agents", "skills"));
  const researchOverride = env.CYBER_KNOWLEDGE_RESEARCH_DIR?.trim();
  const researchDirs = overrides.researchDirs ?? (researchOverride ? [researchOverride] : defaultResearchDirs());
  const docsDir = overrides.docsDir ?? (env.CYBER_KNOWLEDGE_DOCS_DIR?.trim() || join(repoRoot(), "docs"));
  return { dbPath, skillsDir, researchDirs, docsDir };
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export interface ParsedFrontmatter {
  /** Top-level scalar keys (lowercased keys, string values). */
  data: Record<string, string>;
  /** Everything after the closing frontmatter fence. */
  body: string;
}

/**
 * Minimal YAML-ish frontmatter reader: enough for the agentskills.io shape
 * (`name`, `description`, tags, framework mappings) without pulling in a YAML
 * dependency. Scalars may be plain, single/double quoted (possibly spanning
 * lines) or folded/literal block scalars.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: normalized };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---" || lines[i].trim() === "...") { end = i; break; }
  }
  if (end === -1) return { data: {}, body: normalized };
  const data = parseFrontmatterBlock(lines.slice(1, end));
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  return { data, body };
}

/** Locate the closing quote of a quoted scalar, honouring YAML escapes. */
function closingQuote(line: string, quote: string): number {
  for (let i = 1; i < line.length; i++) {
    const ch = line[i];
    if (quote === '"' && ch === "\\") { i++; continue; }
    if (ch !== quote) continue;
    if (quote === "'" && line[i + 1] === "'") { i++; continue; }
    return i;
  }
  return -1;
}

function unquote(value: string, quote: string): string {
  if (value.length < 2 || value[0] !== quote) return value.trim();
  const inner = value.slice(1, -1);
  return quote === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\"/g, '"').replace(/\\n/g, "\n");
}

function parseFrontmatterBlock(lines: string[]): Record<string, string> {
  const data: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(line);
    if (!match) { i++; continue; }
    const key = match[1].toLowerCase();
    const rest = match[2].trim();

    if (rest === "") {
      // A nested block (list or map) — not a scalar we need; skip it.
      i++;
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) i++;
      continue;
    }

    const block = /^([>|][-+]?)$/.exec(rest);
    if (block) {
      const folded = block[1].startsWith(">");
      const parts: string[] = [];
      i++;
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) {
        parts.push(lines[i].trim());
        i++;
      }
      data[key] = parts.join(folded ? " " : "\n").trim();
      continue;
    }

    const quote = rest[0];
    if (quote === "'" || quote === '"') {
      const close = closingQuote(rest, quote);
      if (close >= 0) {
        data[key] = unquote(rest.slice(0, close + 1), quote);
        i++;
        continue;
      }
      // Multi-line quoted scalar: fold the continuation lines.
      const parts = [rest.slice(1)];
      i++;
      let closed = false;
      while (i < lines.length) {
        const current = lines[i];
        const at = closingQuote(current, quote);
        if (at >= 0) {
          parts.push(current.slice(0, at));
          i++;
          closed = true;
          break;
        }
        parts.push(current.trim());
        i++;
      }
      const joined = parts.join(" ").trim();
      data[key] = closed ? unquote(`${quote}${joined}${quote}`, quote) : joined;
      continue;
    }

    // Plain scalar: the line plus any more-indented continuation lines.
    const parts = [rest];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && /^\s/.test(lines[i])) {
      parts.push(lines[i].trim());
      i++;
    }
    data[key] = parts.join(" ").trim();
  }
  return data;
}

/** First markdown H1 of a body, without the leading `#`. */
export function firstHeading(body: string): string {
  const match = /^#\s+(.+)$/m.exec(body);
  return match ? match[1].trim() : "";
}

// ---------------------------------------------------------------------------
// Search query handling
// ---------------------------------------------------------------------------

/** A search term that survived sanitization. */
export interface QueryTerm {
  /** The term as written (phrases keep their inner spacing). */
  text: string;
  /** Lowercased term, used for matching and marking. */
  lower: string;
}

/**
 * Turn a free-text query into a safe FTS5 MATCH expression.
 *
 * Only quoted phrases and alphanumeric tokens survive; FTS5 operators
 * (`AND`, `OR`, `NOT`, `NEAR`, `*`, `-`) are dropped and the remaining terms
 * are ANDed. That keeps a model-supplied string from ever changing the query
 * semantics and makes a malformed query impossible to smuggle into SQL.
 */
export function toMatchExpression(query: string): { expression: string; terms: QueryTerm[] } {
  const text = query.slice(0, MAX_QUERY_CHARS);
  const terms: QueryTerm[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const close = text.indexOf(ch, i + 1);
      const phrase = (close > i ? text.slice(i + 1, close) : text.slice(i + 1)).trim();
      i = close > i ? close + 1 : text.length;
      if (phrase) {
        const lower = phrase.toLowerCase();
        if (!seen.has(lower)) { seen.add(lower); terms.push({ text: phrase, lower }); }
      }
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const token = text.slice(i, j);
      i = j;
      const lower = token.toLowerCase();
      if (!seen.has(lower)) { seen.add(lower); terms.push({ text: token, lower }); }
      continue;
    }
    i++;
  }
  if (!terms.length) {
    throw new Error("search query must contain at least one alphanumeric term (or a quoted phrase).");
  }
  const expression = terms.map((term) => `"${term.text.replace(/"/g, "")}"`).join(" ");
  return { expression, terms };
}

/**
 * Build a short snippet around the first matched term and mark every hit.
 * Falls back to the head of the body when the term only matched the title.
 *
 * The marker is `«term»` on purpose: the corpus is markdown, so `**bold**`
 * would collide with a `**` marker and render as `****term**`.
 */
export function buildSnippet(body: string, terms: QueryTerm[], width = MAX_SNIPPET_CHARS): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term.lower);
    if (found >= 0 && (at === -1 || found < at)) at = found;
  }
  const start = at === -1 ? 0 : Math.max(0, at - 60);
  const end = Math.min(flat.length, start + width);
  let snippet = flat.slice(start, end);
  for (const term of terms) {
    if (!term.lower) continue;
    const pattern = new RegExp(term.lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    snippet = snippet.replace(pattern, (match) => `«${match}»`);
  }
  if (start > 0) snippet = `…${snippet}`;
  if (end < flat.length) snippet = `${snippet}…`;
  return snippet;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface KnowledgeDoc {
  source: KnowledgeSource;
  ref: string;
  title: string;
  body: string;
  indexedAt: string;
}

export interface Refusal {
  source: KnowledgeSource;
  ref: string;
  reason: string;
}

export interface IngestResult {
  source: KnowledgeSource;
  /** Files scanned for this source. */
  scanned: number;
  /** Newly indexed documents. */
  indexed: number;
  /** Documents whose content changed. */
  updated: number;
  /** Documents removed because their file disappeared. */
  pruned: number;
  /** Files skipped because their text looks secret-like (path named). */
  refused: Refusal[];
}

export interface KnowledgeHit {
  source: KnowledgeSource;
  title: string;
  ref: string;
  snippet: string;
  score: number;
}

export interface SourceStat {
  source: KnowledgeSource;
  count: number;
  lastIndexedAt: string | null;
  /** True when a source file on disk is newer than the last index run. */
  stale: boolean;
  /** Newest source-file mtime seen on disk (ISO). */
  newestFileAt: string | null;
  /** Number of secret-like refusals recorded for this source. */
  refused: number;
}

export interface KnowledgeStats {
  path: string;
  counts: Record<KnowledgeSource, number>;
  total: number;
  lastRebuiltAt: string | null;
  sources: SourceStat[];
  refusals: Refusal[];
}

export interface KnowledgeStore {
  readonly path: string;
  readonly paths: KnowledgePaths;
  ingest(source: KnowledgeSource): IngestResult;
  rebuild(source?: KnowledgeSource): { results: IngestResult[]; indexed: number; updated: number; refused: number };
  search(query: string, opts?: { limit?: number; source?: KnowledgeSource }): KnowledgeHit[];
  stats(): KnowledgeStats;
  clear(): void;
  close(): void;
}

interface CandidateFile {
  path: string;
  mtimeMs: number;
}

function listSkillFiles(skillsDir: string): CandidateFile[] {
  if (!existsSync(skillsDir)) return [];
  const out: CandidateFile[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(skillsDir, entry.name, "SKILL.md");
    if (!existsSync(candidate)) continue;
    out.push({ path: candidate, mtimeMs: statSync(candidate).mtimeMs });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function listMarkdownFiles(dirs: string[]): CandidateFile[] {
  const out: CandidateFile[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      const candidate = join(dir, entry.name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push({ path: candidate, mtimeMs: statSync(candidate).mtimeMs });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function filesForSource(source: KnowledgeSource, paths: KnowledgePaths): CandidateFile[] {
  if (source === "skill") return listSkillFiles(paths.skillsDir);
  if (source === "research") return listMarkdownFiles(paths.researchDirs);
  const docs = listMarkdownFiles([paths.docsDir]);
  // The root catalog is intentionally kept at TOOLS.md, but make it part of
  // the same searchable documentation corpus exposed by cyber_knowledge.
  const toolCatalog = join(repoRoot(), "TOOLS.md");
  if (existsSync(toolCatalog) && !docs.some((file) => file.path === toolCatalog)) {
    docs.push({ path: toolCatalog, mtimeMs: statSync(toolCatalog).mtimeMs });
  }
  return docs.sort((a, b) => a.path.localeCompare(b.path));
}

function isSource(value: string): value is KnowledgeSource {
  return (KNOWLEDGE_SOURCES as readonly string[]).includes(value);
}

function createStore(db: Database, paths: KnowledgePaths): KnowledgeStore {
  const selectDoc = db.prepare("SELECT id FROM documents WHERE source = ? AND ref = ?");
  const insertDoc = db.prepare(
    "INSERT INTO documents (source, ref, title, body, indexed_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
  );
  const updateDoc = db.prepare(
    "UPDATE documents SET title = ?, body = ?, indexed_at = ? WHERE id = ?",
  );
  const deleteDoc = db.prepare("DELETE FROM documents WHERE id = ?");
  const selectDocsOfSource = db.prepare("SELECT id, ref FROM documents WHERE source = ?");
  const countBySource = db.prepare("SELECT source, COUNT(*) AS n FROM documents GROUP BY source");
  const upsertState = db.prepare(
    "INSERT INTO index_state (source, last_indexed_at, doc_count, refused_count) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(source) DO UPDATE SET last_indexed_at = excluded.last_indexed_at, doc_count = excluded.doc_count, refused_count = excluded.refused_count",
  );
  const selectState = db.prepare("SELECT source, last_indexed_at, doc_count, refused_count FROM index_state");
  const insertRefusal = db.prepare("INSERT INTO refusals (ts, source, ref, reason) VALUES (?, ?, ?, ?)");
  const clearRefusals = db.prepare("DELETE FROM refusals");
  const selectRefusals = db.prepare("SELECT source, ref, reason FROM refusals ORDER BY id");
  const clearDocuments = db.prepare("DELETE FROM documents");
  const clearState = db.prepare("DELETE FROM index_state");
  const countOfSource = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE source = ?");

  /** Title of a document: frontmatter name (skills), then the first H1, then the file name. */
  const deriveTitle = (source: KnowledgeSource, data: Record<string, string>, body: string, path: string): string => {
    if (source === "skill" && data.name) return data.name.trim();
    const heading = firstHeading(body);
    if (heading) return heading;
    if (data.name) return data.name.trim();
    return basename(path).replace(/\.md$/i, "");
  };

  /** Indexed body: for skills the frontmatter description is prepended (it is searchable text). */
  const assembleBody = (source: KnowledgeSource, data: Record<string, string>, body: string): string => {
    if (source !== "skill") return body.trim();
    const description = (data.description ?? "").trim();
    return description ? `${description}\n\n${body.trim()}` : body.trim();
  };

  const writeDoc = db.transaction((source: KnowledgeSource, ref: string, title: string, body: string, at: string) => {
    const existing = selectDoc.get(source, ref) as { id: number } | null;
    if (existing) {
      updateDoc.run(title, body, at, existing.id);
      return { id: existing.id, updated: true };
    }
    const inserted = insertDoc.get(source, ref, title, body, at) as { id: number };
    return { id: Number(inserted.id), updated: false };
  });

  const ingestTx = db.transaction((source: KnowledgeSource) => {
    const files = filesForSource(source, paths);
    const at = new Date().toISOString();
    const refusals: Refusal[] = [];
    let indexed = 0;
    let updated = 0;
    const live = new Set<string>();

    for (const file of files) {
      let raw: string;
      try {
        raw = readFileSync(file.path, "utf8");
      } catch (error) {
        refusals.push({ source, ref: file.path, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      // Secret gate on the raw file: a tainted document is never indexed.
      if (containsSecretLike(raw)) {
        refusals.push({ source, ref: file.path, reason: SECRET_REFUSAL_MESSAGE });
        continue;
      }
      const { data, body } = parseFrontmatter(raw);
      const title = deriveTitle(source, data, body, file.path);
      const assembled = assembleBody(source, data, body);
      if (containsSecretLike(assembled) || containsSecretLike(title)) {
        refusals.push({ source, ref: file.path, reason: SECRET_REFUSAL_MESSAGE });
        continue;
      }
      const cap = source === "skill" ? SKILL_BODY_CAP : DOC_BODY_CAP;
      // The stored body never exceeds the cap: the truncation marker is part of it.
      const capped = assembled.length > cap ? `${assembled.slice(0, cap - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}` : assembled;
      const result = writeDoc(source, file.path, title, capped, at);
      live.add(file.path);
      if (result.updated) updated++; else indexed++;
    }

    // Prune documents whose file disappeared from the source.
    let pruned = 0;
    for (const row of selectDocsOfSource.all(source) as Array<{ id: number; ref: string }>) {
      if (!live.has(row.ref)) { deleteDoc.run(row.id); pruned++; }
    }

    const docCount = (countOfSource.get(source) as { n: number }).n;
    upsertState.run(source, at, Number(docCount), refusals.length);
    for (const refusal of refusals) insertRefusal.run(at, refusal.source, refusal.ref, refusal.reason);
    return { source, scanned: files.length, indexed, updated, pruned, refused: refusals } satisfies IngestResult;
  });

  const stateRows = (): Map<string, { lastIndexedAt: string | null; count: number; refused: number }> => {
    const map = new Map<string, { lastIndexedAt: string | null; count: number; refused: number }>();
    for (const row of selectState.all() as Array<Record<string, unknown>>) {
      map.set(String(row.source), {
        lastIndexedAt: (row.last_indexed_at as string | null) ?? null,
        count: Number(row.doc_count ?? 0),
        refused: Number(row.refused_count ?? 0),
      });
    }
    return map;
  };

  const refusalsOf = (): Refusal[] =>
    (selectRefusals.all() as Array<Record<string, unknown>>).map((row) => ({
      source: String(row.source) as KnowledgeSource,
      ref: String(row.ref),
      reason: String(row.reason),
    }));

  return {
    path: paths.dbPath,
    paths,
    ingest(source: KnowledgeSource): IngestResult {
      if (!isSource(source)) throw new Error(`unknown knowledge source: ${source}`);
      return ingestTx(source);
    },
    rebuild(source?: KnowledgeSource): { results: IngestResult[]; indexed: number; updated: number; refused: number } {
      const targets = source ? [source] : [...KNOWLEDGE_SOURCES];
      const results = targets.map((target) => ingestTx(target));
      return {
        results,
        indexed: results.reduce((sum, result) => sum + result.indexed, 0),
        updated: results.reduce((sum, result) => sum + result.updated, 0),
        refused: results.reduce((sum, result) => sum + result.refused.length, 0),
      };
    },
    search(query: string, opts?: { limit?: number; source?: KnowledgeSource }): KnowledgeHit[] {
      if (typeof query !== "string" || !query.trim()) {
        throw new Error("search query must be a nonempty string.");
      }
      const { expression, terms } = toMatchExpression(query);
      const limit = Math.max(1, Math.min(MAX_HITS, Math.floor(opts?.limit ?? MAX_HITS)));
      const source = opts?.source;
      let rows: Array<Record<string, unknown>>;
      try {
        const sql = source
          ? "SELECT d.source AS source, d.title AS title, d.ref AS ref, d.body AS body, bm25(documents_fts) AS score " +
            "FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid " +
            "WHERE documents_fts MATCH ? AND d.source = ? ORDER BY score ASC LIMIT ?"
          : "SELECT d.source AS source, d.title AS title, d.ref AS ref, d.body AS body, bm25(documents_fts) AS score " +
            "FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid " +
            "WHERE documents_fts MATCH ? ORDER BY score ASC LIMIT ?";
        rows = (source
          ? db.prepare(sql).all(expression, source, limit)
          : db.prepare(sql).all(expression, limit)) as Array<Record<string, unknown>>;
      } catch (error) {
        throw new Error(`invalid search query: ${error instanceof Error ? error.message : String(error)}`);
      }
      return rows.map((row) => ({
        source: String(row.source) as KnowledgeSource,
        title: String(row.title),
        ref: String(row.ref),
        snippet: buildSnippet(String(row.body ?? ""), terms),
        score: Number(row.score ?? 0),
      }));
    },
    stats(): KnowledgeStats {
      const counts = { skill: 0, research: 0, doc: 0 } as Record<KnowledgeSource, number>;
      for (const row of countBySource.all() as Array<{ source: string; n: number }>) {
        if (isSource(row.source)) counts[row.source] = Number(row.n);
      }
      const states = stateRows();
      const sources: SourceStat[] = KNOWLEDGE_SOURCES.map((source) => {
        const state = states.get(source);
        const files = filesForSource(source, paths);
        // Reduce (not Math.max(...)) so a huge corpus cannot blow the stack.
        const newestMs = files.reduce((max, file) => (file.mtimeMs > max ? file.mtimeMs : max), 0);
        const newest = files.length ? new Date(newestMs).toISOString() : null;
        const lastIndexedAt = state?.lastIndexedAt ?? null;
        const lastMs = lastIndexedAt ? new Date(lastIndexedAt).getTime() : 0;
        const stale = files.length > 0 && newestMs > lastMs;
        return {
          source,
          count: counts[source],
          lastIndexedAt,
          stale,
          newestFileAt: newest,
          refused: state?.refused ?? 0,
        };
      });
      const lastRebuiltAt = sources
        .map((entry) => entry.lastIndexedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
      const total = counts.skill + counts.research + counts.doc;
      return { path: paths.dbPath, counts, total, lastRebuiltAt, sources, refusals: refusalsOf() };
    },
    clear(): void {
      const tx = db.transaction(() => {
        clearDocuments.run();
        clearRefusals.run();
        clearState.run();
      });
      tx();
    },
    close(): void {
      db.close();
    },
  };
}

/** Open (or create) the knowledge index. */
export function openKnowledge(overrides: KnowledgePathOverrides = {}): KnowledgeStore {
  const paths = resolveKnowledgePaths(process.env, overrides);
  if (paths.dbPath !== ":memory:") mkdirSync(dirname(paths.dbPath), { recursive: true });
  const db = new Database(paths.dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(SCHEMA);
    return createStore(db, paths);
  } catch (error) {
    db.close();
    throw error;
  }
}
