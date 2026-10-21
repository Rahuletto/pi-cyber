# Task 5 Report — Adapter registry (typed CLI definitions)

Branch: `feat/adapter-registry` · Commit: `4135fb3` · Date: 2026-10-21

## What was built

- **`src/adapters/types.ts`** — the required `Normalized` / `AdapterDef` interfaces, kept literal per the mission, with two additions forced by reality (both are report items 1/2 below):
  - a `declare module` augmentation for `@earendil-works/pi-coding-agent`, because the pinned 1.3.0 package exports **no `ToolParams`** (Task 2's report had flagged the same gap for `src/tools/github.ts`);
  - `export type { ToolParams };` so the 11 per-adapter modules can type `buildArgs` against the same shape.
- **`src/adapters/util.ts`** (small extra file, not in the mission's file list) — shared, well-tested-by-consumers parse helpers: `clipRaw` (4000-char cap), `jsonLines` (per-line JSON, malformed skipped), `jsonDocument` (single-doc tolerated, BOM-stripped), `stringList`/`intList` (defensive narrowing of validated params).
- **11 adapters** (one file each), all with `additionalProperties:false` Typebox object schemas, `mutating: false`, enumerable/typed model-facing params, `extra` arrays capped at `maxItems: 4` appended verbatim as separate argv elements (documented operator-approved only), and **no free-form flag string parameter anywhere**:
  - `subfinder` (schema `{domain, sources?, extra?}`; repeated `-d` per domain, comment: no `-l` file, no temp files),
  - `httpx` (`{targets[256], ports?[16], extra?}`; positional multi-target — upstream `-l` unused, documented),
  - `dnsx` (`{domains[256], recordType? enum of 9, extra?}`; repeatable `-d` StringSlice instead of `-l`),
  - `katana` (`{targets[256], depth? 1..10, extra?}`; positional targets + `-jsonl`),
  - `ffuf` (**throws exactly `"operator wordlist required"` when `opts.wordlistPath` is missing**; wordlist is operator-injected via opts, never a schema param; `{target, method? enum 7, statusCodes?[32], extensions?[16], extra?}`; `versionFlag: "-V"`; `-l`-style lists deliberately absent — one `-u` per job),
  - `naabu` (`{hosts[256], ports?[64], scanType? "connect"|"syn", extra?}`; repeated `-host`; `"syn"` mapping guarded with a default table for known values),
  - `nuclei` (reference implementation from the plan; `versionFlag: "-version"`; `{targets[256], templates?[64] IDs only, severity?[5] enum, extra?}`; repeated `-u`; `opts.templatesDir` → `["-t", dir]`, operator-side),
  - `uncover` (`{query, engines? enum of 8 providers[8], limit? 1..200, extra?}`; `-l` as upstream result-count limit — named in comment to avoid the dnsx `-l` file connotation),
  - `vulnx` (PD advisory/CVE query client per `research/RECON-WEB-TOOLS.md`; `{action: "search"|"id"|"analyze", query?, cveIds? ≤64, extra?}`; sub-command routing with explicit `throw` messages, e.g. `"search" requires a query string`),
  - `interactsh` (binary `interactsh-client`; `{server?, pollIntervalSec? 5..120, extra?}`; parse maps OOB interactions to `full_id` keys; doc comment: callbacks are event evidence, no-callback is inconclusive),
  - `semgrep` (`{paths ≤64, ruleSet: "auto" | "p/owasp-top-ten" | "p/typescript", extra?}`; `versionFlag: "--version"`; artifactKind `sarif`; `extra` operator-only by design).
- **`src/adapters/index.ts`** — `export const adapters: AdapterDef[]` (11 entries) + `export function byName(name)`.
- **`tests/adapters.test.ts`** — 28 tests: registry shape (unique names, schema `additionalProperties:false` holds for all, Task-3 versionFlag map asserted case by case, all `mutating:false`), then per adapter: parse() on fixture content **with an appended malformed line** (junk skipped, valid hit preserved; malformed whole documents → `[]` for document-kind non-streaming tools), buildArgs argv equality snapshots, and edge cases (ffuf wordlist throw, vulnx action validation). 11 small fixtures under `tests/fixtures/adapters/` (jsonl for all flow tools, `ffuf.json`, `vulnx.json`, `semgrep.sarif`).
- Target-list handling is documented **in code comments per adapter**, exactly like the mission asks: repeated argv (`-d`/`-host`/`-u`/positional) everywhere instead of `-l` list files; **no adapter builds temp files inside buildArgs**; every upstream `-l` semantic is called out by name (uncover result-limit vs dnsx file-list connotations).

## Verification (from the merged state of this worktree)

- `bun install --frozen-lockfile` → ok (postinstalls blocked by Bun policy, pre-existing).
- Baseline `bun test` → **49 pass, 0 fail** (the mission's "~34" was stale: Tasks 1/2/9/14 already merged into this base). Baseline `bun run typecheck` → clean.
- After implementation: `bun run typecheck` → clean. `bun test` → **77 pass, 0 fail** (49 pre-existing + 28 new, full suite, no regressions).
- `tests/extension.test.ts` and `src/index.ts` untouched (Task 6–7 wiring; git patch is a pure addition — 26 new files, no modifications).

## Concerns for the controller

1. **`ToolParams` does not exist in `@earendil-works/pi-coding-agent` 1.3.0.** types.ts keeps the required literal shape via a `declare module` augmentation (index-signature interface). If the pi runtime later exports `ToolParams`, the augmentation can be deleted in one line — the adapters' `buildArgs` signature stays unchanged.
2. **`Type.Items` doesn't exist in typebox 1.3.27** (verify: `typeof Type.Items === "undefined"`), so the plan's `Type.Items(Type.Union([...]))` for `nuclei` severity is a plain `Type.Array(Type.Union([...]), { maxItems: 5 })`. Same construction used for every enum-array param.
3. Plan-level drift handled per mission: `mutating` is a **required** `boolean` (plan had it optional, mission overrode); the plan's `type: "recon"|"probe"|"valid"|"defense"` discriminator field was **dropped** (mission's types.ts omits it); nuclei `templates` severity arrays also gain `maxItems` caps (mission: "typed and enumerable"); `parse` returns `Normalized[]` (not `[] | null`) per mission.
4. Upstream-shape honesty: fixtures encode **realistic observed JSON/JSONL/SARIF/ffuf shapes**, and parse() tolerates the documented variant generations (uncover `{"event":{...}}` legacy vs. flat, vulnx `results`/`vulnerabilities`/array roots). Distinguishing upstream quirks from truth requires an actual binary: the **pre-first-run TODO for Task 3's `validate.sh`** covers only flags ("PD `-json` first-run confirmation for `vulnx`/`ffuf`/`katana` order" / "`ffuf` ≥2.1 `-json`-stdout equivalence"), which the harness design already expects to be validated when the pinned binaries land.
5. **`interactsh-client` writes a session file by default** (operator-visible filesystem side effect). Left to Task 6 runner / operator `extra` — deliberately not smuggled into buildArgs path construction here.
6. The parse layer never throws; malformed input surfaces as fewer `Normalized` rows while the runner's raw artifact (Task 6) preserves the untouched output — that "evidence survives even when parsing can't" contract is commented at the top of `util.ts` and in `ffuf`/`vulnx`/`semgrep`.
7. `vulnx` — the PD tool is a CVE/advisory query client (search/id/analyze), NOT a target scanner, per the repo's research ledger; the schema forces that framing (no target param exists). If an upstream releases a scanning behavior later, it would need its own adapter, not this one.

---

# Task 5 Fix Report — review findings (F1, F2, M1–M5)

Branch: `feat/adapter-registry` · Commit: `2369101` (`fix: adapter flag-injection guards and argv ordering`) · Date: 2026-10-21

## F1 (IMPORTANT) — `-`-prefix flag-smuggling guard, applied centrally and everywhere

- **`src/adapters/util.ts`** gained the single choke point `rejectFlagLike(value, paramName)` → throws `TypeError` with exactly `field-param "<param>" must not start with "-"`, plus narrow combinators that funnel every model-supplied free string through it:
  - `modelList(value, paramName)` / `modelString(value, paramName)` — for free-string **model** params,
  - `requireModelList` / `requireModelString` — which also carry the M3 missing-input throws,
  - `stringList` stays the plain filter, still used for **closed-set enums** (`nuclei.severity`, `uncover.engines` — literal-validated Type.Literal unions, flagged in comments) and inside the helpers.
- Applied to every model-controlled value before it enters argv: httpx `targets`, katana `targets`, dnsx `domains`, naabu `hosts`, nuclei `targets` + `templates`, subfinder `domain` + `sources`, ffuf `target` + `extensions`, uncover `query`, vulnx `query` + `cveIds`, semgrep `paths`. Closed enums (severities/recordTypes/engines/ruleSets/methods/scanTypes) deliberately not re-guarded — they are `Type.Literal` unions. Ints (`ports`, `statusCodes`, `limit`, `depth` become `String(int)`) cannot carry `-`.
- **`extra` is deliberately NOT guarded and keeps verbatim append** — it is the operator-approved flag surface by design (now via `operatorExtra`, see M4). Test pins this behavior explicitly, plus a test pinning the cap under a 5-element attempt.
- Tests: 11 case rows across 8 adapters (incl. the reviewer's `["-l","/etc/passwd"]` httpx case, `--config`/`scan`/`--sarif` semgrep smuggling examples, `--json` via vulnx cveIds, `--help` via uncover query) all assert the exact `field-param …` error.

## F2 (IMPORTANT) — semgrep argv ordering

Canonical order now: `semgrep scan --sarif --config <ruleSet> <paths?> <operator extra?>` — subcommand + flags first, model paths last, operator `extra` always last. Comment in semgrep.ts documents the canonical form rationale; snapshot test updated; paths can never precede `scan`.

## M1 — ffuf fixture key

`tests/fixtures/adapters/ffuf.json` run-configuration key renamed `configdata` → `config` (ffuf ≥2.1 nests it under `config`). Parse path only touches `results`, unaffected.

## M2 — vulnx doc-comment mojibake

Stray `одель` cleaned from `vulnx.ts`.

## M3 — degenerate argv on missing required input

Centralized in `requireModelString`/`requireModelList` (`<adapter>: missing required param "<param>"`): bare `,-json` argv (subfinder), empty positional targets (httpx/katana/semgrep/naabu paths), and `String(undefined)` (ffuf `-u undefined`) are all gone — missing required target/domain/targets/query/hosts stops buildArgs with a named-param error. vulnx keeps its action-specific messages (also mapped into the same matrix).

## M4 — local `extra` cap

New `operatorExtra(value)` = filter + `.slice(0, 4)`; used by all 11 adapters, so the ≤4 cap is now a local invariant in buildArgs, redundantly safe against schema-bypass validation.

## M5 — registry drift test

New registry test: iterates all 11 adapters' schema `properties` and requires any `type: "array"` param to carry a numeric `maxItems > 0` (the binding constraint). 42 model-controlled `-`-prefix rejection + degenerate-argv cases across the suite stay pinned.

## Verification

- `bun run typecheck` → clean.
- `bun test` → **101 pass, 0 fail** (all 77 from the initial Task 5 state still pass; +24 tests mandated by review findings: 11 flag-injection rows, 9 degenerate-argv rows, operator-extra verbatim + cap, maxItems registry test, semgrep reorder, ffuf missing-target/subfinder missing-domain error names; count grew 28 → 52 in tests/adapters.test.ts).
- `src/index.ts` and `tests/extension.test.ts` untouched (git diff shows only `src/adapters/*`, `tests/adapters.test.ts`, `tests/fixtures/adapters/ffuf.json`).
- Ledgered (NOT fixed, per ruling): vulnx fixture shape verification waits for the Task 3 validate run against pinned binaries.

## Added concerns

1. `field-param` error text is the registry's contract for Task 6 — the job runner should surface these verbatim to the model rather than re-wrapping them, so the model can self-correct without an operator round-trip.
2. Flag guard is `-`-prefix-only; Windows-style `/flag` isn't a concern on darwin/arm64 targets (all tools here are POSIX-argv CLIs), and values with embedded `--` (e.g. `ssl.cert.subject.CN:-`) are unaffected since the guard inspects only the first character.

---

# Task 5 Fix Note — re-review residuals (interactsh)

Commit: `1f914eb` (`fix: interactsh flag guard and extra cap`) · Date: 2026-10-21

- F1 residual: interactsh `server` now routes through the central guard (`modelString(p.server, "server")`), so `server: "-foo"` → `field-param "server" must not start with "-"`; argv row added to the existing F1 case matrix in `tests/adapters.test.ts`.
- M4 residual: interactsh `extra` switched from bare `stringList` to `operatorExtra` (local ≤4 cap), matching the other 10 adapters; dedicated cap test row added.
- Verified: `tsc --noEmit` clean; `bun test` → 103 pass, 0 fail (previous 101 stayed green, +2 new rows). Only `src/adapters/interactsh.ts` and `tests/adapters.test.ts` touched; `src/index.ts` and `tests/extension.test.ts` still untouched.

