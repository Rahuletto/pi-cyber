# Task 3 Report — Installer: pinned downloads + verification

Branch: `feat/tool-installer` · Commit: `4c46b67` (`feat: pinned native tool bootstrapper`) · Date: 2026-10-21

## Baseline (confirmed before any change)

- `bun install --frozen-lockfile` → 123 packages, OK.
- `bun test` → **49 pass / 0 fail** (8 files). `bun run typecheck` → clean (wave-1 merges fixed the previously reported github.ts issues).

## What was built

- **`tools/install.sh`** — per `core` manifest entry: (1) resolve latest release via `https://api.github.com/repos/<repo>/releases/latest` (tag + deterministic darwin/arm64 asset pick); (2) download via `curl -fsSL` to a per-tool temp dir; (3) verify `shasum -a 256` against the manifest `sha256` pin, falling back to the previously frozen pin — a first-ever pin is computed and frozen; (4) install to `$PI_TOOLS_DIR/bin/<name>` + `chmod +x` (installed-file sha re-verified); (5) freeze `{name, repo, tag, assetUrl, sha256, resolvedAt}` into `tools/manifest.resolved.json` (**manifest.json never mutated**) and write state `installed` (+version=tag, sha) via `toolctl state-set`. Env: `PI_TOOLS_DIR` (default `~/.pi/tools`), `PI_RESOLVED_FILE` override for the freeze ledger. `-n|--dry-run` prints `[plan] <name> repo=… pattern="…" target=…` for exactly the core entries and creates nothing (verified empty-dir assertion). Per-tool failures print `install: FAIL <tool>: <reason>` on stderr (non-zero overall; other tools continue; nothing skipped silently). Header note included: "PATH alone is not readiness."
- **`tools/validate.sh`** — probes only state-file `installed` entries, never the network. Runs `<bin> <versionFlag>` under a 10s wall-clock cap (pure-bash timeout, no external `timeout` binary — none exists without Homebrew). Exit 0 → state `validated` + `version` (first captured semantic version from stdout/stderr) + `validatedAt`. versionFlag default map per ruling: subfinder/dnsx/httpx/katana/uncover/naabu/interactsh-client/nuclei/vulnx=`-version`, ffuf=`-V`, obscura=`--help`, zap=`-version`, trivy/osv-scanner/gitleaks/syft/semgrep=`--version`; a manifest `versionFlag` overrides. semgrep: no binary in `$PI_TOOLS_DIR/bin` and none pip-installed on PATH → prints `Instruction: python3 -m pip install --user semgrep`, leaves state `installed`. Failures (missing/stale binary, non-zero probe, timeout, state-write failure) are explicit and keep state `installed`; overall exit non-zero if any failed.
- **`src/tools/installer.ts`** (pure TS, no shell strings) — `resolveLatest(repo)` (GitHub API + strict shape validation), `pickDarwinArm64Asset()` (darwin|macos|osx + arm64|aarch64; excludes x86_64/x86/amd64/386/64bit/32bit, checksum/sbom/meta files, dmg/pkg/jar/sh/py; accepts zip/tar*/bare binary), `freezeResolved()` (atomic temp+rename, strict record validation), `loadResolved()`; `RESOLVED_FILE` = repo `tools/manifest.resolved.json`.
- **`tools/toolctl.ts`** — Bun CLI bridge so bash never parses JSON: `list [disposition…]` (TSV from the strict loader), `resolve`, `resolved-get`, `freeze`, `installed`, `state-set`, `pattern`.
- **`src/tools/manifest.ts`** (ruling) — `ToolEntry` extended with `artifact?: string`, `sha256?: string | null`, `versionFlag?: string` (absent = defaults, backward compatible); **unknown-key strictness switched on**: any key outside `{name, category, repo, version, disposition, note, artifact, sha256, versionFlag}` now throws (`unknown key "…"`), resolving the ledgered Task-2 deferral. sha256 must be 64-hex or null.
- **Tests** — `tests/install-integration.test.ts`: both integration tests `skipIf(!(PI_CYBER_NET=1))`; when gated on they run `install.sh --dry-run` in a temp `PI_TOOLS_DIR` (no network) asserting the plan lists **exactly** the core names from `loadManifest()` with repo+pattern+target, and that the dir stays empty (touches nothing); `freezeResolved` exercised directly with fixture data (merge, replace, atomic pretty write) plus byte-equality of `tools/manifest.json` before/after. One *always-on* incremental test covers the pure `pickDarwinArm64Asset` matcher (no spawn, no fs, no network) — kept ungated because it has no environment side effects; flagged here for the controller. Plus 2 new manifest strictness tests (unknown key, malformed sha256) in `tests/manifest.test.ts`.

## Verification

- `bun test` → **52 pass / 0 fail / 2 skip** (9 files, 365 expect calls); `bun run typecheck` → clean.
- `PI_CYBER_NET=1 bun test tests/install-integration.test.ts` → 3 pass / 0 fail (all gated tests verified green).
- Manual smoke: dry-run plan + exit 0 + zero files created; bad-arg → exit 2; validate.sh against a fake tmp state/bin tree: ok→validated with version+validatedAt, semgrep instruction path (state untouched), stale-installed explicit FAIL, sleepy bin → exact 10s timeout FAIL, overall exit 1 as designed. `bun run doctor` still renders all 22 rows.
- **No live network install was executed** (not required; resolution-to-install path is exercised only logically — see concerns).

## Concerns for the controller

1. **The brief said "the 21 core entries"; the merged manifest has 17 core entries** (of 22 total; the 21 likely referred to entries-with-`repo`). The test asserts set-equality against `loadManifest()` output rather than a hardcoded count, so it stays correct either way.
2. **Untried live path:** the download/extract/binary-pick section of install.sh (zip/tar vs bare binary, exec-bit recovery) has never run against real GitHub releases here (no network use was authorized for this task). vulnx (`projectdiscovery/vulnx` — slug sourced in Task 2) may 404 (upstream vulnx is a different owner), and zap/semgrep have non-zip/tar asset shapes (dmg/pip) that will fail *explicitly* rather than install. Expect first live run to be partially failed-by-design; every failure names the tool + reason.
3. **semgrep overall exit:** I chose *not* to count a missing-pip semgrep as a hard failure (instruction + state stays `installed`, exit code unaffected); if the controller wants "missing semgrep = non-zero exit", that's a one-line change.
4. `freezeResolved` is keyed by tool name; a re-resolution (new tag) replaces the record rather than append — matching "freeze the resolved release" semantics, replay-safe and idempotent.
5. The always-on pure `pickDarwinArm64Asset` test inside the otherwise-gated file is a deliberate deviation flagged above.

---

# Task 3 Fix Report — review findings

Commit: `83d240a` (`fix: installer column-order, install-skip, extraction error checks`) · Date: 2026-10-21

## Fixes applied

1. **CRITICAL — TSV column mismatch (install.sh vs toolctl.ts).** The install loop now reads toolctl's actual emitted column order `IFS=$'\t' read -r name repo artifact versionFlag manifest_sha` (v1 bound `manifest_sha` to the artifact column, silently ignoring the manifest sha256 pin). Regression test added (`toolctl list column contract …` in `tests/install-integration.test.ts`, ungated, local-only): a fixture manifest with all five fields populated is run through `bun tools/toolctl.ts list core --file fixture.json` and parsed **exactly the way install.sh parses it** (`IFS=$'\t' read` in bash); the test asserts the pinpoint lands in `manifest_sha` (plus artifact/versionFlag binds). This also required adding `--file <path>` support to toolctl `list`.
2. **IMPORTANT — already-installed skip (plan §3 idempotency).** install.sh now skips resolve+download when a tool's state is already `installed`/`validated` AND its frozen sha256 pin exists in `manifest.resolved.json` AND the binary is still present+executable (a missing bin correctly triggers reinstall rather than a false skip); prints `install: skip <name> (already installed, pinned sha=…)`, counts a new `SKIPPED` bucket in the summary, keeps the manifest pin as-is and never re-freezes. New `toolctl state-get` subcommand backs the state read. Regression test (gated `PI_CYBER_NET=1`, fully network-free): full fixture environment (state installed / bins present / pins frozen for all 17 core tools) → `bash tools/install.sh` must exit 0 with 17 skip lines, summary `17 skipped (already installed), 0 failed`, byte-identical `resolved.json`, untouched state sha pins. Because the skip branch sits before any resolve/download (fixtures point at `example.invalid`), a skip regression would hit network and fail the test.
3. **MINOR — extraction status checks.** `unzip`/`tar` failures now surface IMMEDIATELY as `extraction failed (unzip exit N)` / `extraction failed (tar exit N)` with cleanup + per-tool failure + continue, instead of propagating to a misleading downstream "could not locate an executable". Verified offline: both tools return non-zero rc on corrupt archives (tar=1, unzip=9).
4. **MINOR — `--help` probes.** When the probe flag is `--help`, validate.sh no longer scrapes digits from usage text: it records `version=help-ok` in state.json (smoke: an obscura-style usage containing "1.2.4" now yields `version=help-ok`, was previously recorded as version 1.2.4).
5. Finding 5 acknowledged — Task 4 code not touched (other worktree).

## Verification

- `bun run typecheck` → clean. `bun test` → **53 pass / 0 fail / 3 skip** (all previous 52 pass retained; +1 ungated column-contract test, +2 gated tests). `PI_CYBER_NET=1 bun test tests/install-integration.test.ts` → 5 pass / 0 fail.
- Manual smoke: full-run skip behavior (17/17 skip, exit 0, no freeze/state writes); `--help` → `help-ok`; corrupt tar/zip → explicit extraction failures; column-contract parse asserts exact binds.
- Ledgered items (state.json write race, freeze-after-install ordering, semgrep exit nuance) intentionally unchanged.
- Constraints held: manifest.json never mutated (re-asserted by the freeze test), freezes only to manifest.resolved.json, PI_TOOLS_DIR/PI_RESOLVED_FILE overrides honored, one conventional commit.

## Residual concerns

1. The skip rule is "state installed/validated + frozen pin + bin executable"; it does NOT re-verify the installed binary's on-disk sha against the pin on second run (that would require hashing 17 binaries — cheap, but deliberately not added; the pin chain from v1 still verifies on genuine reinstall). Say the word and I'll add it.
2. The second-run-skip test would genuinely hit the network if skip logic regresses (by design — that's what makes it a guard); with the gate off nothing runs at all.

