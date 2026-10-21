# Pi Cyber Toolchain Buildout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the pi-cyber foundation to a real harness: pinned native tools, job adapters, SQLite evidence, Obscura browser, REA light, pi-subagents specialists, packages, knowledge layer, refined instructions, and a local fixture engagement.

**Architecture:** One package (`pi-cyber`) keeps Pi as runtime; extension tools are thin wrappers over tested modules; all native CLIs are pinned/digest-verified downloads under `~/.pi/tools/`; engagement state lives in one SQLite DB per engagement; Obscura/REA are MCP-registrations, one-shot CLIs are typed adapters. Evidence store precedes job store so jobs persist into it (reorder from spec §5 noted here).

**Tech Stack:** Bun + TypeScript, `bun:sqlite` (zero deps), Pi 1.3.0 extension API (pattern: `src/index.ts`), pi-subagents 0.79.x, pi-web-access 0.4x.

**Spec:** `specs/2026-10-21-pi-cyber-toolchain-buildout-spec.md`

## Global Constraints

- No Homebrew existss on this host; every native binary is a pinned GitHub-release download with SHA-256 recorded in `tools/manifest.toml` before use.
- No shell strings through `exec`/`execSync` anywhere in `src/` — `execFile`/`Bun.spawn` with argument arrays only.
- Typebox schemas for all extension-tool parameters (follow `patchSchema` pattern in `src/index.ts`); `additionalProperties: false` everywhere.
- Every task's tests must run modelless (`bun test`); no network, provider, or target required.
- darwin/arm64 only; foreign-platform tools stay `cataloged`, never `validated`.
- Tool states are always the five distinct: `cataloged | installed | available | enabled | validated` (spec §4).
- Keep the semgrep-like secret-pattern check in every store/return path that can carry secrets (`state.ts` `knownSecrets` style).
- `PI_CODING_AGENT_DIR` for the harness = `<repo>/config/cyber` (dedicated profile; personal `~/.pi/agent` untouched).
- Commits: conventional commits (feat/fix/test/docs/chore), one logical change per commit.
- Existing tests must never regress; add, don't delete.

---

### Task 1: Hygiene — harden github tool, fix install.sh, restore scripts/pi.sh

**Files:**
- Modify: `src/tools/github.ts` (rewrite)
- Test: `tests/github.test.ts` (create)
- Modify: `install.sh` (remove key-reference line)
- Create: `scripts/pi.sh`
- Modify: `README.md` (only if a referenced path changes)

**Interfaces:**
- Consumes: `gh` CLI at `/opt/malt/bin/gh` (env PATH).
- Produces: `registerGithubTool(pi: ExtensionAPI): void` — same signature as now. Actions unchanged: `search|read|cve|issues|prs`.

- [ ] **Step 1: Write failing tests** for `tests/github.test.ts`. Mock `gh` by pointing a temp dir with a fake executable; the module must accept an injectable bin path:

```ts
// exports to add in github.ts: export function resolveGhPath(): string | null
import { describe, test, expect } from "bun:test";
import { registerGithubTool, resolveGhPath } from "../src/tools/github.ts";
describe("github tool", () => {
  test("falls back to unavailable state without gh", () => { expect(resolveGhPath(["/nonexistent"])).toBeNull(); });
});
```

Also test: result text ≤ 32_000 chars (clip+truncated flag), no `\n` shell injection (a repo name `x\nrm -rf /` must be passed as a single argv, never interpreted).

- [ ] **Step 2: Run** `bun test tests/github.test.ts` — expect FAIL (module exports missing).
- [ ] **Step 3: Rewrite** `src/tools/github.ts`: use `execFile(ghPath, args)` (promisified); map actions to argv arrays, e.g. read → `["api", `repos/${repo}/contents/${path}`, "--jq", "..."]`; ignore-stdout clip: if text.length > 32_000 → cut + append `[truncated]`; on `ENOENT` of gh → clear error "gh CLI not available". No new deps.
- [ ] **Step 4: Run all tests** `bun test` — PASS (existing extension tests too).
- [ ] **Step 5: install.sh fix** — delete the final echo line containing `aimylove.key`; replace with `echo "pi-cyber: provider credentials are configured separately; never inside this repo."`
- [ ] **Step 6: scripts/pi.sh** — the launcher `bun run pi` expects (create it; conservative version):

```bash
#!/usr/bin/env bash
# Launch Pi with the cyber extension + profile, preserving personal config elsewhere.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROFILE="$ROOT/config/cyber"
mkdir -p "$PROFILE"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$PROFILE}"
PI="$ROOT/node_modules/.bin/pi"
[ -x "$PI" ] || { echo "run: bun install --frozen-lockfile" >&2; exit 1; }
EXTRA_ARGS=()
[ "${AST:-0}" = "1" ] && EXTRA_ARGS+=(-e "$ROOT/src/ast-extension.ts")
exec "$PI" -e "$ROOT/src/index.ts" --theme "$ROOT/config/cyber" "${EXTRA_ARGS[@]}"
```

Also mkdir `config/cyber/` with a README: "dedicated profile; provider login happens here; nothing personal copied."
- [ ] **Step 7: Commit** `git add -A && git commit -m "fix: harden github tool with execFile, drop key reference, restore launcher"`

### Task 2: Tool manifest module + doctor v2

**Files:**
- Create: `tools/manifest.toml`
- Create: `src/tools/manifest.ts`
- Test: `tests/manifest.test.ts`
- Modify: `src/doctor.ts` (consume manifest), `tests/doctor.test.ts`

**Interfaces:**
- Produces (used by tasks 3,5,6,8,9): `loadManifest(): Manifest` where `Manifest = { tools: ToolEntry[] }`, `ToolEntry = { name: string; category: "recon"|"discovery"|"web"|"defense"|"reverse"|"browser"|"misc"; repo?: string; version: string | "pin-at-install"; artifact?: string; sha256?: string | null; disposition: "core"|"on-demand"|"reference"|"platform-limited"|"deferred"; }`.
- Produces: `toolStates(m, stateFile): Record<name, "cataloged"|"installed"|"available"|"enabled"|"validated">`.

- [ ] **Step 1: manifest.toml** — sections per category; include (core) subfinder, dnsx, httpx, katana, nuclei, uncover, vulnx, interactsh-client, naabu, ffuf, obscura, zap, semgrep, trivy, osv-scanner, gitleaks, syft; (on-demand) nmap (platform-limited: x86_64-only installer), rea,JWT/tooling; (deferred) ghidra, jdk21 with comment "deferred 2026-10-21 per operator decision". Version `pin-at-install` for all executables until first successful download.
- [ ] **Step 2: failing test** then implement `src/tools/manifest.ts` — parse TOML with a tiny hand-rolled section parser? No: use Bun's built-in `import` of toml? Bun doesn't import TOML; keep it as JSON instead — **decide: `tools/manifest.json`** (simpler, zero deps). Rename file accordingly. Loader reads/validates: unknown category or disposition → throw; duplicate name → throw.
- [ ] **Step 3: doctor v2** — after PATH inventory, merge manifest: for each entry, emit `{ name, category, disposition, state }` where state = cataloged → installed (stateFile says so) → available (on PATH) → validated (stateFile has pass mark). Keep doctor read-only; `bun run doctor` still never executes tools. Update `tests/doctor.test.ts` for new output shape.
- [ ] **Step 4: test** `bun test tests/manifest.test.ts tests/doctor.test.ts` PASS.
- [ ] **Step 5: Commit** `feat: tool manifest and doctor state machine`

### Task 3: Installer — pinned downloads + verification

**Files:**
- Create: `tools/install.sh`
- Create: `tools/validate.sh`
- Test: `tests/install-integration.test.ts` (skipped unless `PI_CYBER_NET=1`)

**Interfaces:**
- Consumes: `loadManifest()` from Task 2 semantics (script reads same manifest file).
- Produces: `~/.pi/tools/state.json` — `Record<name, { state, version, sha256, validatedAt }>`.

- [ ] **Step 1: install.sh** — for every `core` tool with a download URL: (1) `curl -fsSL -o tmp` artifact; (2) verify `shasum -a 256` matches manifest sha256 (if null → record and freeze it into manifest on first run); (3) install to `~/.pi/tools/bin/`; (4) chmod +x; (5) write state `installed`+sha into state.json. Failures per tool are **explicit and per-tool** (JSAR: never skip silently). Note in header: "PATH alone is not readiness."
- [ ] **Step 2: validate.sh** — for each installed: run `<bin> --version` (tool-specific flag via per-tool override map in the manifest: `versionFlag`), record version, then state `validated` only if exit 0. Obscura: `obscura --help` marker. semgrep uses `pip install semgrep` path — note `semgrep` in python3.14 at install.sh with `python3 -m pip install --user semgrep`.
- [ ] **Step 3: integration test** with `PI_CYBER_NET=1` in CI env only: run with `--dry-run` mode (prints plan + URLs); assert idempotency (second run = "all installed/validated, no re-download").
- [ ] **Step 4: Commit** `feat: pinned native tool bootstrapper`

### Task 4: Evidence store (SQLite)

**Files:**
- Create: `src/evidence/db.ts`, `src/evidence/schema.sql` (as TS template string in db.ts is fine — one file OK), `src/evidence/secrets.ts`
- Create: `src/tools/evidence.ts`
- Test: `tests/evidence.test.ts`
- Modify: `src/index.ts` (registerCyberEvidence)

**Interfaces:**
- Produces: `openEvidence(path): EvidenceStore`, methods: `appendEvent(kind, payload)`, `addEvidence({kind, refs, text, sensitivity})`, `addFinding(init)`, `addJob(row)` (jobs share the DB), `addSession(row)` (browser leases; Task 8), `briefSummary(mode): string`, `all tables append-only (no UPDATE/DELETE exposed)`.
- Produces: `containsSecretLike(text): boolean` — superset of state.ts regex (also jwt, ghp_, gho_, `-----BEGIN OPENSSH`).

- [ ] **Step 1: failing test** — open `:memory:` DB; insert event; insert finding; rehydrate `briefSummary`; secret refusal: adding text containing `sk-` errors with message "possible raw secret, store a redacted artifact reference instead".
- [ ] **Step 2: schema** tables: `events(id, ts, kind, payload_json)`, `evidence(id, ts, kind, refs, text, sensitivity, hash)`, `findings(id, state CHECK IN ('candidate','needs-validation','confirmed','rejected','remediated','retest-passed'), title, evidence_ids, impact, confidence)`, `jobs(...)`, `browser_sessions(...)` — write full DDL in code (quoted for reserved words as needed).
- [ ] **Step 3: db.ts** — `import { Database } from "bun:sqlite"`; open with `PRAGMA journal_mode=WAL`; prepared statements only.
- [ ] **Step 4: evidence tool** — tool name `cyber_evidence`, actions `add|read|findings|summary`, Typebox params; clip results 24 KiB; count-capped returns (≤50 rows).
- [ ] **Step 5: index.ts integration** — `pi.on("context")` brief gains one extra line only if store path is set: `Evidence: <count> records at <path>` (do NOT dump contents).
- [ ] **Step 6: tests** PASS full suite; **Step 7:** Commit `feat: durable evidence store with secret heuristics`

### Task 5: Adapter registry (typed CLI definitions)

**Files:**
- Create: `src/adapters/types.ts`, `src/adapters/index.ts`
- Create: per-tool: `src/adapters/subfinder.ts`, `httpx.ts`, `dnsx.ts`, `katana.ts`, `nuclei.ts`, `uncover.ts`, `vulnx.ts`, `interactsh.ts`, `naabu.ts`, `ffuf.ts`, `semgrep.ts` (11 small files)
- Test: `tests/adapters.test.ts` with tiny JSON fixtures in `tests/fixtures/`

**Interfaces:**
- Produces: `AdapterDef = { name, bin, versionFlag, type: "recon"|"probe"|"valid"|"defense", schema: TypeBoxSchema, buildArgs(params): string[], parse(stdout, stderr): Normalized[] | null, artifactKind: "raw"|"json"|"jsonl"|"sarif", mutating?: boolean }`.
- Normalized finding shape (used by Task 6 & evidence): `{ kind, target|host|path, raw (≤4000 chars), meta? }`.

- [ ] **Step 1: types.ts + one full adapter guide (nuclei.ts as reference implementation, others same shape but distinct schemas):**

```ts
// src/adapters/types.ts
import type { ToolParams } from "@earendil-works/pi-coding-agent";
export interface Normalized { kind: string; key: string; raw: string; meta?: Record<string, unknown>; }
export interface AdapterDef {
  name: string; bin: string; versionFlag: string;
  mutating?: boolean;
  schema: unknown; // Typebox schema
  buildArgs(params: ToolParams, opts: { wordlistPath?: string; templatesDir?: string }): string[];
  parse(stdout: string, stderr: string): Normalized[] | null;
  artifactKind: "raw" | "json" | "jsonl" | "sarif";
}
```

```ts
// src/adapters/nuclei.ts
import { Type } from "typebox";
import type { AdapterDef, Normalized } from "./types.ts";
export const nuclei: AdapterDef = {
  name: "nuclei", bin: "nuclei", versionFlag: "-version", artifactKind: "jsonl",
  schema: Type.Object({
    targets: Type.Array(Type.String(), { maxItems: 256 }),
    templates: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })), // template IDs only, never paths from model
    severity: Type.Optional(Type.Items(Type.Union([Type.Literal("info"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]))),
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })), // operator-approved emulator args
  }, { additionalProperties: false }),
  buildArgs: (p) => ["-json", ...p.severity.map(s => ["-severity", s]).flat(), ...p.templates.flatMap(t => ["-id", t])],
  parse: (stdout) => stdout.split("\n").filter(Boolean).map((l) => {
    try { const o = JSON.parse(l); return { kind: "nuclei", key: `${o.url || o.host}:${o.templateID}`, raw: JSON.stringify(o).slice(0, 4000), meta: { sev: o.info?.severity, name: o.info?.name } }; } catch { return null; }
  }).filter(Boolean),
};
```

Requirement: every `buildArgs` treats model input as data — no flag strings possible. `extra` args come via operator list only, never a typebox string surface.

- [ ] **Step 2:** implement remaining 10 adapters with distinctive schemas (e.g. subfinder `{domain, sources?}`, httpx `{targets, tech?}`, ffuf with explicit **mutating: false** default + explicit wordlist id-resolution, semgrep `{paths, ruleSet: 'auto'|'p/owasp-top-ten'`, etc.
- [ ] **Step 3: tests** — each adapter: parse() valid fixture line, malformed line tolerated (returns fewer), buildArgs snapshot equality.
- [ ] **Step 4:** `bun test tests/adapters.test.ts` PASS; **Commit** `feat: adapters for the PD kit + defense baseline`

### Task 6: Job runner + tools

**Files:**
- Create: `src/jobs/runner.ts`, `src/jobs/store.ts`
- Create: `src/tools/jobs.ts`
- Test: `tests/jobs.test.ts` + fixture fake bin `tests/fixtures/fake-scan.sh`

**Interfaces:**
- Consumes (Task 4, 5): `EvidenceStore.addJob`, `AdapterDef[]`.
- Produces: `JobRunner { start(adapter, params, ctx): {jobId}`, `status(jobId)`, `cancel(jobId)`, `output(jobId, limit): JobOutput` ; `RegisteredJob = { jobId, adapter, argv, pid, state, startedAt, endedAt, exitCode, artifactPath }`.

- [ ] **Step 1: runner.ts** — Bun.spawn with argv array; `process.setpgid(pid)` before start (if child survives), kill with `process.kill(-pgid)` on cancel; timeout default 300s (typed param); stdout/stderr streamed to artifact file under evidence dir; on abrupt exit keep partial artifacts & state `interrupted` (outcome-unknown vs failed distinction) — text per design contract.
- [ ] **Step 2: store.ts** — JSON file per engagement at `config/cyber/evidence/<engagement>/jobs.json` under lock via `Bun.tryWriteNick` — realistic: simple `fs.writeFileSync` with re-try flock via `openSync(...,'r+')` + `flock` (use `Bun.LDAP`? no — simplest correct: read-modify-write guarded by an in-process mutex since one Pi process; document). State machine enforcement: only legal transitions.
- [ ] **Step 3: fake-scan fixture + tests** — start succeeds → running → succeeded; cancel mid-run → `cancelled`; timeout → `interrupted`; oversize stdout clipped to artifact path reference; stale queued job after policy change (simulate scopeRevision change) is rejected.
- [ ] **Step 4: jobs.ts** — 4 Typebox tools wrapping runner (start/status/cancel/output) with `adapter: Type.Literal-options.` (broad list from registry); output tool clips to 16 KiB and prefixes provenance line `<adapter> <version> <argv> <sha>`.
- [ ] **Step 5:** full suite PASS; **Commit** `feat: durable job runner with typed adapters`

### Task 7: `/cyber tools` + mode-tool wiring

**Files:**
- Modify: `src/index.ts` (commands `/cyber tools`, and registration of evidence/job tools if not already done — cross-check imports)
- Test: extend `tests/extension.test.ts`

**Interfaces:**
- Consumes: manifest states (Task 2), job/evidence tools registration.
- Produces: `/cyber tools` output listing: adapter+native tool state matrix; `/cyber` help line updated.

- [ ] Steps: implement `/cyber tools`; a fake mode `{toolStates}`; test: command returns string with at least one installed+one cataloged example; ensure mode-switch refusal on tool execution (regression test already exists — confirm). Commit `feat: /cyber tools status view`.

### Task 8: Browser — Obscura profile + session leases

**Files:**
- Create: `src/browser/leases.ts`, `src/browser/mcp-register.ts`
- Test: `tests/browser-leases.test.ts`
- Modify: `config/cyber/mcp.json` (bootstrapped by `scripts/pi.sh` if missing — Obscura stdio entry)

**Interfaces:**
- Consumes: evidence store SES `addSession`.
- Produces: `acquireLease({sessionId, owner, purpose}): void | throws; releaseLease(id); activeLeases(): BrowserLease[]` — DB-backed, mode included; “two owners per same sessionId” fails.

- [ ] **Step 1:** `mcp-register.ts` writes `config/cyber/mcp.json` `{ mcpServers: { obscura: { command: "obscura", args: ["mcp"] } } }` once, verified idempotent; tests for shape and idempotency (not live server).
- [ ] **Step 2:** leases in DB; plus notes in module doc about private-address exceptions (fixture only) and `-stealth` prohibition for conformance evidence; assert a release of an unknown session is idempotent.
- [ ] **Step 3:** Commit `feat: obscura mcp registration + browser session leases`

### Task 9: REA light

**Files:**
- Create: `docs/REA-LIGHT.md`; `src/reverse/note.ts` optional — keep small.
- Modify: manifest already includes rea/deferred ghidra (Task 2).

**Interfaces:**
- Produces: doc + deferred manifest state for ghidra; explicit REA registration = operator-invoked (REA has a documented Pi setup; not forced here).

- [ ] **Step 1:** Write `docs/REA-LIGHT.md`: (a) narrow-lane stance, scope the Apple-native tools (otool/strings/dwarfdump/dyld_info/codesign) as `cataloged-validatable-now`; (b) REA server = operator-run `rea setup` later; (c) `capture_browser_scenario` is Chrome-family — record that Obscura is NOT established for it; (d) ghidra deferral rationale.
- [ ] **Step 2:** manifest: rea → `on-demand`; `ghidra`/`jdk21` → `deferred` (already done in Task 2 — verify).
- [ ] **Step 3:** Commit `docs: REA light lane and boundaries`

### Task 10: Specialists — pi-subagents

**Files:**
- Create: `scripts/install-packages.ts` (via bun: `pi install`? not found — do: `bun add -g? no — per spec, cyber-profile pi install`)
- Create: `agents/*.md` refinements (6 roles; event if template descriptions only — keep simple but consistent frontmatter)
- Create: `src/specialists/contracts.ts`
- Test: `tests/specialists.test.ts`

**Interfaces:**
- Produces: `validateWorkerTask(t): void` (throws with exact field), `validateResult(r): { problems: string[] }`; caps: `maxConcurrentChildren = 2`, `maxTotalSpawnsPerRun = 8` (well below upstream default 64).

- [ ] **Step 1:** `contracts.ts` — Typebox schemas for Task contract (`taskId, engagementId, mode, role, question, scopeRevision, assetIds, evidenceIds, allowedCapabilities, credentialRefs, sessionLease, outputSchema, budget, stopConditions`) and Result (`status, observations, inferences, evidenceRefs, sourceRefs, candidateFindings, negativeResults, coverageLimits, proposedNextSteps, usage, sideEffects`); exports `assertContract`, `critiqueResult`.
- [ ] **Step 2:** install step in `scripts/install-packages.ts`: uses `pi` with `PI_CODING_AGENT_DIR=config/cyber pi install ...`? — **verify** upstream package name `@nicobailon/pi-subagents` (pin resolved version in `config/cyber/package.json`); if `pi extension list /doctor` supports it, wire MCP-style; fallback manual npm install + manifest. Record actual path in script output. NOT auto-installed at test time.
- [ ] **Step 3:** Role files `agents/recon.md` (etc.) — each ≤ 60 lines: role, tools allowed (union reused from adapter catalog), output contract (references `contracts.ts` schema-keys), stop conditions. Verify frontmatter format from pi-subagents docs at write-time.
- [ ] **Step 4:** tests: validate/critique pure functions, from sample valid/invalid JSON fixtures; do NOT spawn workers in tests.
- [ ] **Step 5:** Commit `feat: pi-subagents wiring + specialist contracts`

### Task 11: Packages — web access, btw, bigpowers

**Files:**
- Create: `scripts/install-packages.ts` (extends Task 10 script), `docs/PACKAGES.md`
- Modify: knowledge provider options in Task 12 (web search uses this)

**Interfaces:**
- Consumes: nothing upstream (own config).
- Produces: `config/cyber` profile gains pi-web-access (search provider explicit; NONE auto-selected), pi-btw (optional but slash-commands present), bigpowers skills copied selectively into `config/cyber/skills/` — only: survey-context, research-first, plan-work, develop-tdd, verify_work, audit-code.

- [ ] **Step 1:** extend install script with per-package pin checks (compare `pi list -e`/`pi extensions` output if pi exposes it, else `check package.json`); ALWAYS install explicit search provider template; set `workflow: "none"` (raw bounded results + explicit fetch) per research recommendation.
- [ ] **Step 2:** docs/PACKAGES.md summarizing inclusion rationale, risks, decade of updates, and what was deliberately excluded (KXM, billion-context, Feynman full).
- [ ] **Step 3:** Commit `feat: pi-web-access + pi-btw + selective bigpowers skills`

### Task 12: Knowledge — registry, sync, FTS5 search

**Files:**
- Create: `src/knowledge/registry.ts`, `src/knowledge/sync.ts`, `src/knowledge/search.ts`
- Create: `src/tools/docs.ts`
- Test: `tests/knowledge.test.ts` + fixture HTML/MD in `tests/fixtures/docs/`

**Interfaces:**
- Consumes: evidence DB path (separate `.sqlite` is fine: `docs.sqlite`).
- Produces: `syncSource(id): {added, updated, failed?}`, `docsSearch(q, {limit}): DocHit[]`, `docsRead(id, section?): string` (≤16 KiB).

- [ ] **Step 1:** registry table `sources(id, kind, url, versionSelector, license, updatedPolicy, lastStatus, lastAt)`; OWASP WSTG/ASVS/Cheat Sheets/API Security/Top 10 + MITRE ATT&CK STIX + CWE + CVSS + PD `llms.txt` pre-seeded (`cataloged` until first sync).
- [ ] **Step 2:** sync.ts — fetch via `fetch()` (Bun native): app levels approved (release archive → raw full-text); pages parsed (headings, code-preserving); no live network in tests (all fetches go through injectable `loader(id, url): Promise<string>`).
- [ ] **Step 3:** FTS5 tables `docs_chunks(id, docId, source, heading, text, rev)`; query with snippet rankings; version filter param; missing sources show up as `failed` not silent.
- [ ] **Step 4:** tools `cyber_docs_search / cyber_docs_read / cyber_docs_sources` in docs.ts; snippet cap: 800 chars; reading caps 16 KiB.
- [ ] **Step 5:** tests with fixtures; **Commit** `feat: knowledge registry with FTS5 retrieval`

### Task 13: Prompt refinement (base/offense/defense — "smart" pass)

**Files:**
- Modify: `prompts/base.md`, `prompts/offense.md`, `prompts/defense.md`
- Test: `tests/prompts.test.ts` (nontrivial: file-length, no metadata leakage, key phrases with present)

**Interfaces:**
- Consumes: real tools now registered (`cyber_job*`, `cyber_evidence`, `cyber_docs*`, `github`, `ast_grep/ast_edit`); mode instructions get capability-aware wording per mode.

Content requirements per file (hard spec — write actual final prose, do not leave bell-marks):
- base.md: evidence discipline; named tools only where they exist (no phantom capabilities); scope/credential constraints; compaction/rehydration warning; worker policy (bounded question, one owner per mutable session); secret-pattern honesty; "cataloged vs validated" prose; the two modes as workflow labels, not permission grants. Target ≤ 40 lines.
- offense.md: mature red-team loop (establish, map, rank, validate, chain, consolidate); score-supporting rationale for ranking queue; rule that scanner/version match ≠ finding; OOB/interactsh handling (callback = event evidence, no-callback = inconclusive); chaining preconditions; coverage matrix role/tenant; persistence rules; stop conditions; no-operating-sandbox reminder. ≤ 25 lines.
- defense.md: coverage matrix ownership; root-cause-first dossier; fix classes (proposed/applied/verified distinct); regression tests required; fail-safe semantics ("a clean scan is one observation"); ≤ 25 lines.
- All three: plain imperative voice, concrete, no cheerleading, no filler; instruct use of evidence store artifact refs not secret text.

- [ ] **Step 1:** write the files directly (they are small; polish repeatedly by reading aloud — but the test asserts lengths + key invariants only).
- [ ] **Step 2:** prompts test: each file ≤ N lines, each ≥ M hits of required probe strings (e.g. "coverage matrix" only in offense/defense; "cataloged" in base).
- [ ] **Step 3:** full suite + typecheck; **Commit** `docs(prompts): capability-aware instruction refinement`

### Task 14: Fixture app (vulnerable local target)

**Files:**
- Create: `fixtures/cyberbench/` (bun app): `app.ts`, `data.sqlite` (seeded), `README.md`, `smoke.test.ts`
- Test: `tests/fixtures/cyberbench.smoke.test.ts` (live local-only server)

**Interfaces:**
- Produces: HTTP app on `127.0.0.1:4747` (fixed); identities `member/memberpw`, `admin/adminpw` via sqlite; the engagement-target surface: 5 routes intentionally injected with interesting behaviors + a `robots.txt` and one practice JWT secret leak (`/debug/session?token=...`).

- [ ] **Step 1:** implement app.ts as Bun.serve — ~180 lines, no framework; routes: `/login`, `/logout`, `/api/balance?user=`, `/api/admin/users`, `/api/upload` (path traversal via `name=../`), `/api/orders/borrowed?id=` (IDOR on tenant boundary), `/search?q=` (error-based string interpolation into log, not templated cmd), `/debug/session` (leaks admin session token). Include deliberate comments `// seeded-vuln:` for identification.
- [ ] **Step 2:** tests: boot in-process, assert each route's vulnerable behavior with curl-like `fetch(...)` inside Bun test; then close server. No network beyond loopback.
- [ ] **Step 3:** README: how to start (`bun fixtures/cyberbench/app.ts`), explicit "local fixture only, keep out of deployments"; login cookbook for the harness to use member/admin identities.
- [ ] **Step 4:** Commit `feat: cyberbench local fixture with seeded authorization faults`

### Task 16: Adopt-as-own catalog work (ports, not installs)

**Files:**
- Create: `docs/research/PROMPT-SOURCE-CORPUS.md` — notes from Piebald-AI/claude-code-system-prompts (security-review methodology, three-state code-review verification, background-agent state classifiers, coordinator/worker instructions, autonomous-action security monitor), shanraisshan/claude-code-best-practice (layered rules), mapped to which plan task consumes each
- Create: `src/reporting/diagrams.ts` — mermaid generators for finding chains, route-role coverage matrices, attack-path graphs
- Modify: `tools/manifest.toml` — add `understand-anything` (on-demand, comprehension lane); record Piebald + awesome-claude-code as catalog-only design sources
- Test: `tests/reporting.test.ts`

**Interfaces:**
- Consumes: evidence-store rows and findings (Tasks 4/6); coverage matrix data.
- Produces: `coverageDiagram(matrix): string`, `findingChainDiagram(finding): string`, `assetGraph(nodes, edges): string` — mermaid blocks, each ≤ 4 KiB.
- Operator rule (2026-10-21): harness output favors diagrams/tables over walls of text; dossier sections pair a diagram with bounded prose.

- [ ] Step 1: write the corpus note with per-task mappings (Task 10 → worker/status-card classifiers; Task 13 → security-review + security monitor + summarization variants)
- [ ] Step 2: failing test, then implement the three diagram generators and mermaid shape assertions
- [ ] Step 3: full test suite PASS
- [ ] Step 4: Commit `feat: diagrammatic reporting + catalog adoptions from claude-code ecosystems`

### Task 17: Engagement checklist docs + final verification

**Files:**
- Modify: `docs/BUILD-STATUS.md`, `README.md` (new commands and tools)
- Create: `docs/FIRST-ENGAGEMENT.md`

- [ ] **Step 1:** FIRST-ENGAGEMENT.md: (1) start fixture, (2) `bun run doctor` expect validated core tools listed, (3) `bun run pi` launch, (4) scope+objective via `cyber_state`, (5) run offense; route-role matrix with (member/admin) real sign-in via browser (optional — fixture can be exercised via adapters alone); (6) confirm evidence rows accumulate; (7) mode-switch to defense; (8) produce remediation dossier re: IDOR + traversal; (9) verify retest criteria measured after fix application; end with expected observed artifacts.
- [ ] **Step 2:** BUILD-STATUS: new verified-from-here sections (store states vs execution; the still-unverified list).
- [ ] **Step 3:** FINAL verification: `bun install --frozen-lockfile && bun run typecheck && bun test && bun run doctor --json`, all PASS; then a manual record in BUILD-STATUS. Commit `docs: first-engagement walkthrough and status refresh`.
