# Task 2 Report — Tool manifest module + doctor v2

Branch: `feat/tool-manifest` · Commit: `96a6739` · Date: 2026-10-21

## What was built (per controller rulings, not the original plan text)

- **`tools/manifest.json`** — JSON manifest (ruling overrode `manifest.toml`), 22 entries:
  - core (17): subfinder, dnsx, httpx, katana, nuclei, uncover, vulnx, interactsh-client, naabu, ffuf, obscura, zap, semgrep, trivy, osv-scanner, gitleaks, syft
  - on-demand (2): nmap (note "official macOS installer is x86_64-only…"), rea
  - deferred (2): ghidra, jdk21 — note "deferred per operator decision 2026-10-21"
  - reference (1): understand-anything (comprehension lane; no upstream repo is recorded anywhere in the repo docs, so `repo` is omitted — the field is optional per the exported type)
  - All `version: "pin-at-install"`. Repo slugs sourced from the repo's own research/TOOLS.md citations (projectdiscovery/*, ffuf/ffuf, h4ckf0r0day/obscura, zaproxy/zap, semgrep, aquasecurity, google, gitleaks, anchore, nmap/nmap, morluto/rea, NationalSecurityAgency/ghidra; jdk21 → Adoptium/temurin21-binaries).
- **`src/tools/manifest.ts`** — Bun JSON.parse loader with hand-rolled validation (throws on unknown category, unknown disposition, duplicate name, malformed shape/JSON). Exports: `loadManifest(): Promise<Manifest>`, `Manifest { tools: ToolEntry[] }`, `ToolEntry { name; category; repo?; version; disposition; note? }` with the exact category/disposition unions ruled by the controller, plus `toolStates(manifest, stateFile = ~/.pi/tools/state.json, pathEnv = $PATH): Promise<Record<name, ToolState>>`.
  - State machine: `cataloged` → `installed` (statefile says so) → `available` (executable present on PATH, X_OK + regular file) → `validated` (statefile pass mark wins over PATH). `enabled` is reachable only via mode wiring (Task 7) — the doctor never sets it.
  - Missing state file = all `cataloged`. A *present but malformed* state file throws (not silently ignored) — JSAR "never skip silently".
- **`src/doctor.ts` v2** — still strictly read-only (no exec, no probes). Emits `{ platform, architecture, note, runtime, tools }` where `runtime` is the unchanged `inventory()` (now defaulting to harness binaries bun/node/pi/rg/git/ast-grep/sg) and `tools` is one `{ name, category, disposition, state }` row per manifest entry via `toolStates()`.
- **Tests**
  - `tests/manifest.test.ts` (new, 7 tests): valid real-catalog load + field invariants + no duplicates + nmap x86_64 note + ghidra/jdk21 deferred; throws on bad category / bad disposition ("validated" correctly treated as invalid *disposition*) / duplicate name; toolStates matrix — cataloged-only (empty PATH + missing statefile), available-on-PATH, statefile installed-beaten-by-PATH → available, validated-wins-over-anything, malformed statefile → throw.
  - `tests/doctor.test.ts` (updated): kept the invariant inventory test (X_OK discovery without execution, sentinel never created) and added a v2 report test — exact row key shape `{category, disposition, name, state}`, missing statefile ⇒ all cataloged, subfinder available from injected PATH, httpx validated from statefile, obscura cataloged, nmap on-demand; sentinel asserted absent (doctor never executes tools).

## Verification

- `bun test tests/manifest.test.ts tests/doctor.test.ts` → **10 pass, 0 fail**.
- Full `bun test` → **28 pass, 1 fail** — the 1 fail (`tests/extension.test.ts` `h.extension.tools.size` expected 1, received 2) is **pre-existing on the wip base commit** `2e0ee3c` (verified by re-running with all Task-2 changes stashed) and belongs to Task 1's github-tool scope. Existing tests did not regress.
- `bun run typecheck` → **pre-existing failure in `src/tools/github.ts`** (`Tool`/`ToolParams` missing from `@earendil-works/pi-coding-agent` 1.3.0), also present at stashed baseline — Task 1 territory, untouched by Task 2.
- Full suite otherwise green incl. 22 manifest rows rendered by `bun run doctor` (spot-checked JSON shape + exit 0).

## Concerns for the controller

1. **Pre-existing breakage inherited from the wip base commit** `2e0ee3c`: `src/tools/github.ts` typecheck errors and the extension-tools-count test failure. Task 1's worktree presumably fixes both; a merge/rebase order should account for it.
2. **`understand-anything` has no `repo` slug** in any repo doc; left `repo`-less. If upstream GitHub exists, Task 16 should backfill it.
3. `toolStates` gained a third optional param `pathEnv` (beyond the ruled signature) so tests — and Task 3 — can inject PATH without mutating `process.env`. `loadManifest` also accepts an optional path override for the same reason. Signatures are backwards-compatible with the rulings.
4. Doctor defaults `inventory()` to harness runtime binaries only; the big old default catalog is superseded by manifest rows (nmap/java/tshark/yara etc. were in the old list). If some later task relied on `inventory()` returning those by default, pass names explicitly.
