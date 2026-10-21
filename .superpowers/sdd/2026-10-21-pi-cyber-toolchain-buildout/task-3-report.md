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

---

# Task 3 Fix Report Round 2 — digest semantics, 403 backoff, zap slug, LIVE verification

Commit: `614e343` (`fix: digest verification semantics, 403 backoff, zap slug`) · Date: 2026-10-21 · Network tool downloads authorized by controller for this round.

## 1. Digest re-check semantics (CRITICAL) — FIXED

The v2 comparison (archive digest vs extracted-binary digest) was removed; installed binaries are no longer compared against the archive digest. New flow: download archive → `shasum -a 256` the archive → verify against manifest pin / frozen pin (trust-on-first-use) → extract (explicit rc checks) → assert the located binary exists and is executable (NO digest comparison) → record both digests separately: `sha256` = archive digest, additive field **`binary_sha256`** = digest of the installed executable. Bare-binary assets get the same value in both fields (verified live on osv-scanner: `d4926ef8…` appears as both archive_sha and binary_sha). `ResolvedRecord` gained optional `binary_sha256` (64-hex-validated, lowercase-normalized, accepted-missing for older records); `toolctl freeze` gained `--binary BINARY_SHA256`; install.sh ok-line prints `archive_sha=` and `binary_sha=`. `tools/manifest.resolved.json` now holds 15 live records, **all with binary_sha256**. Also fixed: `curl` now uses `--connect-timeout 30 --max-time 600` (indeterminate hang → explicit download failure; discovered when a slow-connection download outlived a probe timeout).

## 2. HTTP 403 resilience (IMPORTANT) — FIXED in `resolveLatest` (src/tools/installer.ts; toolctl `resolve` consumes it)

403/429/5xx retried up to **3 retries** with exponential backoff **2s/5s/15s** (network errors also retried); 404 fails permanently on the first attempt with its own message ("no published release — repo may not use GitHub Releases"); 401 gets a distinct "check GITHUB_TOKEN validity" message. `GITHUB_TOKEN` or `GH_TOKEN` (whichever set) is sent as `Authorization: Bearer <token>` — never logged, persisted, or echoed (verified: no code path places it in an error/echo; timeout/log directives added mid-hunt touch only curl). `resolveLatest` now takes injectable `{fetchImpl, delayMs}` and covered by three new ungated tests (403×2→200 success with delay sequence [2000,5000]; 404 single-attempt permanent message; Bearer header from GITHUB_TOKEN, never leaking).

## 3. zap repo slug (IMPORTANT) — FIXED with API evidence

Via the GitHub REST API (`gh api`): `repos/zaproxy/zap` → **HTTP 404 Not Found**; `repos/zaproxy/zaproxy` → **HTTP 200 `{"full_name":"zaproxy/zaproxy","id":36817565,"description":"The ZAP by Checkmarx Core project","default_branch":"main"}`**, whose `releases/latest` is `v2.17.0` with assets including `ZAP_2.17.0_aarch64.dmg`. `tools/manifest.json` repo → `zaproxy/zaproxy` (strict-key loader unaffected).

## 4. Additional data fix: vulnx versionFlag

Live validate proved the ruled default `-version` doesn't exist for vulnx (cobra error `unknown shorthand flag: 'e' in -ersion`; note `vulnx --help` exits 0 and itself prints `[INF] Current vulnx version 2.0.2`). Fixed via the ruled override mechanism: `versionFlag: "--help"` recorded on the manifest entry with an explanatory note (validate records `help-ok` per finding-4 semantics).

## 5. LIVE results (verbatim, run with GITHUB_TOKEN fed from the local gh keyring; token never printed/persisted)

**`bash tools/install.sh`** → `install: 8 installed, 7 skipped (already installed), 2 failed, of 17 core entries.` overall-exit 1:
- ok: interactsh-client v1.4.1, naabu v2.6.1, ffuf v2.3.0, obscura v0.2.5, trivy v0.76.0, osv-scanner v2.7.0 (bare binary: archive_sha == binary_sha), gitleaks v8.30.1, syft v1.55.0
- skipped: subfinder v2.17.0, dnsx v1.3.1, httpx v1.12.0, katana v1.8.0, nuclei v3.11.1, uncover v1.2.1, vulnx v2.0.2 (frozen pins from the earlier partial run)
- FAIL zap: `no darwin/arm64 asset on tag v2.17.0` — asset picker saw only dmg-style artifacts: `bom.json, ZAP_2.17.0.dmg, ZAP_2.17.0_aarch64.dmg, ZAP_2.17.0_Core.zip, ZAP_2.17.0_Crossplatform.zip, ZAP_2.17.0_Linux.tar.gz, ZAP_2_17_0_unix.sh, ZAP_2_17_0_windows-x32.exe, ZAP_2_17_0_windows.exe` (macOS CLI shape is a .dmg; literate exclusion for dmg, not an arm64 archive)
- FAIL semgrep: `no darwin/arm64 asset on tag v1.182.0` (semgrep ships no darwin binary asset at all; pip-distributed — validate.sh already prints the pip instruction path)

**`bash tools/validate.sh`** → run 1: `validate: 14 validated, 1 failed, of 15 installed entries.` — FAIL vulnx: `-version` shorthand error (see §4) → after the manifest versionFlag fix, run 2: vulnx `version=help-ok → state validated`. **Final: 15/15 installed entries validated** (subfinder 2.17.0, dnsx 1.3.1, httpx 1.12.0, katana 1.8.0, nuclei 3.11.1, uncover 1.2.1, vulnx help-ok, interactsh-client 1.4.1, naabu 2.6.1, ffuf 2.3.0, obscura help-ok, trivy 0.76.0, osv-scanner 2.7.0, gitleaks 8.30.1, syft 1.55.0). zap/semgrep remain uninstalled by design (no probeable binary).

## Verification

- `bun run typecheck` clean; `bun test` → **56 pass / 0 fail / 4 skip** (60 tests, 9 files); `PI_CYBER_NET=1 bun test tests/install-integration.test.ts` → 9 pass / 0 fail.
- New tests this round: binary_sha256 round-trip (uppercase→lowercase normalization, older-records compatibility), 403-retry backoff sequence, 404 permanence, Bearer-from-env. Second-run-skip/gated fixtures unaffected by the semantics change (skip gate predates binary_sha256 and stays optional).
- Committed `tools/manifest.resolved.json` (frozen pin ledger: names, tags, asset URLs, archive+binary digests, timestamps — no secrets) so downstream tasks can re-hash in place without re-networking. `state.json` lives outside the repo and is not committed.

## Concerns for the controller

1. **zap/semgrep are structurally uninstallable via GitHub zip/tar releases** — zap macOS is a .dmg (mount-installer route needed, or reclassify as on-demand), semgrep is pip-only. Today they fail explicitly + overall non-zero; recommend an operator decision rather than a silent skip.
2. vulnx `help-ok` validated state: `--help` proves presence + exits 0, so `validated` is earned, but it is not a version-string mark (finding-4 ruling applied) — flagging in case the controller wants vulnx re-authored as a `version` subcommand probe (`vulnx version` exists).
3. The 403 backoff never fired under load this round (authenticated token kept us over quota limits), so the retry path is exercised by the injected-fetch tests, not yet by a live 403 storm; the now-completed hourly hit on our IP earlier round shows real 403s are reachable without a token.
4. `state.json` remains the plain read-modify-write ledger (race still ledgered as before); its live content now holds 15 `validated` entries with per-tool sha256 + version + validatedAt.


