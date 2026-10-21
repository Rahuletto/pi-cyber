# Task 12 Report — Knowledge layer (FTS5 over the local corpus)

Branch: `feat/knowledge-layer` · Commit: `0b2d951` (`feat: knowledge layer with FTS search over skills and research corpus`) · Date: 2026-10-21 · Worktree: `/Users/marban/.pi/pi-cyber-t12` only (no other worktree touched)

## What was built

- **`src/knowledge/fts.ts`** (new, 695 lines) — the knowledge index, a **separate** SQLite file from the evidence store:
  - Path: default `<repoRoot>/config/cyber/knowledge/knowledge.sqlite`; `CYBER_KNOWLEDGE_DIR` overrides the directory (the file name stays `knowledge.sqlite`). The index never shares a file with the engagement evidence DB (pinned by a test).
  - Schema: `documents(id, source, ref, title, body, indexed_at, UNIQUE(source, ref))` + FTS5 virtual table `documents_fts(title, body, content='documents', content_rowid='id', tokenize='unicode61')` maintained by three triggers (insert/delete/update), plus `index_state(source, last_indexed_at, doc_count, refused_count)` and `refusals(ts, source, ref, reason)`.
  - Sources: `skill` (every `~/.agents/skills/<name>/SKILL.md` — frontmatter `name` + `description` parsed, description prepended to the indexed body so it is searchable; body capped at **8 KiB**), `research` (`docs/research/*.md`, falling back to the repo-root `research/*.md` when `docs/research` does not exist — both are scanned when present), `doc` (top-level `docs/*.md`, e.g. `REA-LIGHT.md`; capped at 32 KiB).
  - Frontmatter parser: dependency-free, handles the agentskills.io shape — plain scalars, single/double-quoted scalars spanning lines, folded/literal block scalars, and list/map keys (skipped). The 48 curated Anthropic-Cybersecurity-Skills are indexed **as installed** (no porting, no rewriting).
  - **Secret gate on every indexed text**: the raw file is checked with the evidence store's `containsSecretLike` before anything is written; a hit **skips the document entirely** and records a refusal that **names the path** (`refusals` table + the path in the rebuild/stats output). The assembled title/body are checked a second time before upsert. A tainted document is never searchable.
  - `rebuild(source?)` re-indexes one source or all three, upserts by `(source, ref)`, prunes documents whose file disappeared, and is idempotent (second run = `updated`, not `indexed`). `clear()` empties documents, refusals and index state. `ingest(source)` is the per-source primitive; `search`, `stats` are read paths.
  - `search(query, {limit, source})` → at most **10** hits, ordered by `bm25`, each with `source`, `title`, `ref` and a short snippet in which the matched term is marked `«like-this»`. The query is sanitized into a safe MATCH expression (quoted phrases and alphanumeric tokens survive; FTS5 operators `AND`/`OR`/`NOT`/`NEAR`/`*`/`-` are dropped and the remaining terms are ANDed) so a model-supplied string can never change the query semantics.
  - `stats()` → per-source counts, total, last rebuild timestamp, per-source `stale` flag (true when a source file on disk is **newer** than that source's last index run) and the recorded refusal paths.
- **`src/tools/knowledge.ts`** (new) — the Pi tool `cyber_knowledge` (Typebox, `additionalProperties: false`), `executionMode: "sequential"`, output clipped at **24 KiB** with a surrogate-safe clipper:
  - `search` — free-text query; renders a compact list (`n. [source] title` / `ref:` / marked snippet), no prose walls; a secret-like query is echoed as `<withheld: …>` instead of being written back into the transcript.
  - `stats` — counts per source, last rebuilt, per-source stale marker, refusal paths (capped at 24 listed + a "N more" marker).
  - `rebuild` — re-index one source or all; reports `scanned/indexed/updated/pruned/refused` per source and lists every refused path with the canonical refusal reason.
- **Rebuild policy** — the index is **never** rebuilt implicitly. Nothing was added to the `context` hook (the hook stays cheap); `stats` reports staleness and the operator (or the model) decides to rebuild. A full rebuild of the real corpus takes ~90 ms.
- **`src/index.ts`** — exactly one import + one `registerKnowledgeTool(pi);` line (diff = 2 insertions). **`tests/extension.test.ts`** — tool count 15 → 16. **`.gitignore`** — the derived index (`config/cyber/knowledge/`) is not committed.
- **`tests/knowledge.test.ts`** (new, 15 tests) — fully offline, temp-dir fixtures: a minimal `SKILL.md` (frontmatter + body), a second secret-tainted `SKILL.md`, a research markdown and a repo doc. Covers: frontmatter parsing (plain, folded block, multi-line quoted), ingest per source, search finding the right document with the term marked, source narrowing, an unrelated query returning nothing, stats counts + last rebuild + the stale marker (via `utimes`), rebuild idempotency, the secret refusal naming the tainted path (and the tainted text not being searchable), typed errors for an empty/invalid MATCH query, the FTS5 operator-stripping rule, the 8 KiB body cap, the 10-hit cap, snippet marking/length, the tool surface (registration, `executionMode`, strict schema, rebuild/search/stats output, typed tool errors) and the separation from the evidence DB.

## Verification

- **Baseline (before changes):** `bun install --frozen-lockfile` → "Checked 123 installs across 132 packages (no changes)"; `bun test` → **167 pass / 4 skip / 0 fail** across 171 tests in 13 files (exactly the expected baseline).
- **After implementation:** `bun run typecheck` → clean (strict `tsc --noEmit`); `bun test` → **182 pass / 4 skip / 0 fail** across 186 tests in 14 files (167 baseline kept green, +15 new).
- **Real-corpus smoke test (offline, local corpus):** rebuild → 97 documents indexed (skill 77, research 15, doc 5), 11 skills refused with their paths named; `search "idor object identifier"` → `exploiting-idor-vulnerabilities` with the terms marked; `search "csrf"` → the pentest and triage skills. The tool was also exercised through the real SDK extension loader: 16 tools registered, `cyber_knowledge` present, `stats`/`search` render correctly.
- One logical commit `0b2d951` (6 files, +1303/−1), plus this report commit. No other worktree touched.

## Concerns for the controller

1. **11 of the 88 installed skills are refused by the secret heuristic and are therefore NOT searchable.** The trigger is `containsSecretLike` on documentation *examples*, not real credentials — e.g. `Bearer eyJhbGciOiJIUzI1NiIs…` (example JWTs), `password=test"`, `api_key=None)`, `secret: Brute-force`, and `sk-based-vulnerability-management` (the `sk-` prefix pattern matching an ordinary hyphenated English word). Refused paths: `analyzing-sbom-for-supply-chain-vulnerabilities`, `conducting-api-security-testing`, `exploiting-sql-injection-vulnerabilities`, `implementing-secret-scanning-with-gitleaks`, `performing-jwt-none-algorithm-attack`, `prioritizing-vulnerabilities-with-cvss-scoring`, `testing-api-authentication-weaknesses`, `testing-api-for-broken-object-level-authorization`, `testing-api-security-with-owasp-top-10`, `testing-for-broken-access-control`, `testing-for-sensitive-data-exposure`. The behaviour is exactly what the task prescribed (skip + name the path), but it costs real search coverage on ~6 of the curated Anthropic-Cybersecurity-Skills. If the operator wants them indexed, the fix belongs in the shared heuristic (e.g. require a minimum entropy/length for the `Bearer`/`password=` families) — **not** in the knowledge layer, which must keep using the shared `containsSecretLike` unchanged.
2. **`research` source root:** the task text says `docs/research/*.md`, but this repo has no `docs/research/` — the research markdown lives in the repo-root `research/`. The implementation scans `docs/research` when it exists and always scans the repo-root `research/`, so it works with either layout; the env override `CYBER_KNOWLEDGE_RESEARCH_DIR` pins a single directory.
3. **Staleness is mtime-based and conservative:** `last_indexed_at` is the *start* of the ingest run, so a file modified during a rebuild is still reported stale (a rebuild is then suggested again). It errs toward showing `STALE`, never toward hiding a stale index.
4. **The search index is a derived artifact:** it is gitignored and rebuilt on demand. `stats` on a fresh checkout reports `last rebuilt: never` with `total=0`, and `search` then answers "The knowledge index is empty — run the rebuild action". The first `stats`/`search` call creates an empty DB file at the default path (no auto-rebuild happens).
5. **The snippet marker is `«term»`, not `**term**`:** the corpus is markdown and `**bold**` is everywhere — a `**` marker rendered as `****CSRF**`. The guillemet marker is unambiguous in both plain text and markdown.
6. **Query semantics are AND-only:** operators are stripped rather than honoured, so `idor OR xss` searches for documents containing **both**. This is deliberate (a model string cannot smuggle FTS operators), but it means the tool cannot express OR queries — a union search is two calls with `source` filters.
7. **Extra env knobs** (`CYBER_KNOWLEDGE_SKILLS_DIR`, `CYBER_KNOWLEDGE_RESEARCH_DIR`, `CYBER_KNOWLEDGE_DOCS_DIR`) exist next to the required `CYBER_KNOWLEDGE_DIR`; they exist for offline testing and for operators who keep the corpus outside the repo. Only `CYBER_KNOWLEDGE_DIR` is required by the task.
8. **`clear()` is module-level only** (not a tool action): there is deliberately no "wipe the index" tool action, since a rebuild is cheap and a wipe would only destroy evidence of what was indexed.

## Verification commands (operator-runnable, modelless)

```sh
cd /Users/marban/.pi/pi-cyber-t12
bun install --frozen-lockfile
bun run typecheck
bun test
git log --oneline -1   # 0b2d951 feat: knowledge layer with FTS search over skills and research corpus
```
