# Pi Cyber Harness — toolchain buildout spec

Date: 2026-10-21. Status: approved-direction spec, awaiting implementation plan.
Builds on: [PI-CYBER-HARNESS-DESIGN.md](../HARNESS-DESIGN.md), [BUILD-STATUS.md](../BUILD-STATUS.md), [TOOL-SELECTION.md](../TOOL-SELECTION.md), docs/research/ index (149-candidate catalog).

## 1. Goal

Take the implemented foundation (modes, `/cyber`, `cyber_state`, themes, AST extension) to the design doc's milestone 3–5 core: real native tools, job management, durable engagement evidence, browser, REA light, specialist workers, packages, knowledge, and a first end-to-end engagement on a local fixture.

## 2. Decisions in force (user-approved 2026-10-21)

| Decision | Choice |
|---|---|
| Architecture | Expand the single `pi-cyber` package; six entry points per design doc |
| KXM | **Deferred** — adds local hub/service plane with no demonstrated cross-harness need |
| billion-context | **Deferred** — request/response interceptor; revisit only under measured context pressure |
| Ghidra + JDK 21 | **Deferred** — REA stays light route. Noted honestly: REA full-Mac verification story assumes Ghidra; reach is narrower until then |
| Model provider | User's existing key file (`~/.config/opencode/aimylove.key`) wired into the dedicated cyber profile; per-role models configured in pi-subagents agents, Daleth planner/reviewer vs cheaper researcher split after baseline |
| First target | Local deliberately vulnerable fixture app (no live external target) |
| Tool acquisition | Direct pinned GitHub releases, SHA/digest-verified into `~/.pi/tools/` — no Homebrew (absent), no Go toolchain, no global installs |
| Proxy default | ZAP baseline; one primary traffic workflow per engagement; Burp/Caido later if operator supplies license |

## 3. Environment ground truth (verified 2026-10-21)

- Apple M3, macOS 27.2. Bun 1.4.3; Pi 1.3.0 launcher (`~/.bun/bin/pi`). Python 3.14 at `/opt/malt/bin`.
- Present: `gh`, `cosign`, `git`. Absent: brew, go, all security CLIs, Obscura, ZAP, Java (stub only).
- Uncommitted WIP exists: `src/tools/github.ts` (shell-string built — must be rewritten with argument arrays before commit), `install.sh` enableSkillCommands edit (keep), hardcoded `aimylove.key` echo line (remove).
- Untracked empty `src/tools/` gets filled by this build.

## 4. Package layout (target)

```
pi-cyber/
  config/cyber/          # dedicated PI_CODING_AGENT_DIR for the harness (moved from ad-hoc)
  agents/                # six role templates (exists; wired, not decorative)
  prompts/               # base/offense/defense overlays (active)
  src/
    tools/               # extension-facing tools: cyber_job, cyber_evidence, docs, github
    adapters/            # per-CLI adapters: job definitions, arg builders, parsers, fixtures
    evidence/            # SQLite store (bun:sqlite), schema, appends
    browser/             # Obscura MCP config helpers, session lease/ownership records
    knowledge/           # docs registry, FTS5 search
    specialists/         # pi-subagents wiring + worker contract validation
  fixtures/              # local fixture app(s), Mal-O file artifacts, parser fixtures
  tests/                 # bun test, no model/provider needed
  tools/install.sh       # pinned downloader + digest manifest (tools/manifest.toml)
```

Rules: extension tools stay thin; logic lives in tested modules. `cataloged > installed > available > enabled-for-role > validated` are distinct states, tracked in the manifest and expandable `/cyber tools` output.

## 5. Components

### 5.1 Native tool bootstrap (tools/install.sh, tools/manifest.toml)

- Manifest records: project, pinned version, artifact URL, SHA-256, target path, flags (e.g. x86_64-only), disposition (core/on-demand).
- Downloads darwin/arm64 release artifacts: subfinder, httpx, dnsx, katana, nuclei, uncover, vulnx, interactsh, naabu, ffuf, Obscura (aarch64 tarball), ZAP, semgrep (pip-based into python3), trivy, osv-scanner, gitleaks, syft.
- Each binary: pinned release; verify digest; run `--version`/`-version`; only then `validated`. `--list` prints state machine output. Re-run is idempotent (skips verified pins).
- Honor proxyless network execution; no component launches any scan against any host as part of install. **PATH detection alone is not readiness.**

### 5.2 Job layer (src/tools/job.ts + src/adapters/*)

- `cyber_job_start / cyber_job_status / cyber_job_cancel / cyber_job_output` per design contract.
- Durable job IDs + state machine: queued, running, succeeded, failed, cancelled, interrupted, outcome-unknown; scope revision + mode stamped at launch; stale queued work rejected after policy change.
- Adapter: fixed executable, argument-array builder, typed inputs only (targets, rate, auth refs, template IDs, wordlist IDs — never raw flag strings), JSON/JSONL/SARIF parsers with parser-version + raw-output retention, output caps to artifact files under evidence dir, process-group cancellation, per-job/host/provider budgets.
- Generic `cyber_job_exec` escape hatch: argument-array exec, explicit "outside typed-adapter guarantees", provenance preserved, never claims shell-string filtering grants scope enforcement.

### 5.3 Evidence store (src/evidence/*)

- SQLite (bun:sqlite, zero deps), one DB file per engagement under the cyber profile dir, append-only events. Schema: engagement, scope_revision, asset, relationship, job, browser_session, observation, evidence, hypothesis, finding, remediation, retest, citation, event. Raw + sanitized artifact dirs; hashes; sensitivity metadata.
- `cyber_evidence_add / cyber_evidence_read`; coordinator brief rehydrates from stored records (checkpoints stay pointers; big payloads stay in artifacts).
- Secret-predaction heuristic (existing) extended to results entering the DB.

### 5.4 Browser (src/browser/*)

- Obscura stdio MCP registered in the cyber profile's `mcp.json`; loopback binding kept, private-address protection understood (explicit opt-in only for local fixture work, scoped to the fixture).
- Session model: engagement+mode+identity alias+purpose identifies each browser session; one owner per mutable page; leases recorded in the evidence DB; on lap dance close, preserve request summaries to artifacts.
- Evidence capture: page identity, action summary, network records references, engine version; screenshots only when visual evidence matters; redact tokens before model dispatch.

### 5.5 REA (light)

- Pin `reverse-engineer-anything` skill (v37 present on host) + REA server to one tested pair; register via cyber profile MCP; verify `tools/list`.
- Light providers: Apple native inspection (`file/otool/strings/nm/dwarfdump/dyld_info/codesign/spctl`), plus FIX any deterministic transforms. Document that Ghidra-less REA is a reduced-capability lane; defer deep decompilation.
- Exports of Evidence IDs precede close; one owner per REA session.

### 5.6 Specialists (src/specialists/*)

- Install `pi-subagents` (pinned near 0.79.2) into the cyber profile; six role templates under `agents/` (recon, web, auth, reverse, reviewer, remediation) + add web/validation reviewer rosters per design crew table as dormant templates.
- Worker contract task/result fields enforced via SDK checks in a thin validate step; structured `outputSchema` from results into evidence store.
- Limits: ≤2 concurrent children, bounded total spawns (way below the 64/rum default), no recursive fan-out, cancellation tests, mode-switch refusal while workers own mutable sessions.
- Role model split: strong model for planning/review, cheaper for bulk research/normalization — after first baseline.

### 5.7 Packages

- **pi-web-access** (pinned; catalog/main drift resolved at install): `cyber research` route on top; explicit provider config; failure/throttle reporting; no DDG/auto reliance without records.
- **pi-btw**: optional, `/btw:ask` read-only route favorite for side questions; not a specialist replacement.
- **bigpowers**: selectively copy `survey-context`, `research-first`, `plan-work`, `develop-tdd`, `verify_work`, `audit-code` as defense remediation skills; **never** `bigpowers init` in the harness, existing skills are wrapped through their discovery surface.
- **Feynman**: workflows borrowed as reference only; not installed into cyber core.

### 5.8 Knowledge (src/knowledge/*)

- Registry table (source ID, URL/paths, version selector, license, update policy); OWASP packs first: WSTG stable, ASVS release-candidate pin, Cheat Sheets, API Security Top 10; MITRE ATT&CK STIX; CWE; CVSS; PD docs (`llms.txt`).
- `cyber_docs_search` = SQLite FTS5 over versioned chunks; `docs_read` bounded; failed syncs visible; citations carry source revision.
- Community (Stack Exchange etc.) deferred until packs work; no embeddings before index proves it.

### 5.9 GitHub (rewrite WIP)

- `src/tools/github.ts` → `execFile` + argument arrays; typed actions only (search/read/cve/issues/prs); results clipped/output bounds mutated; secret-pattern filter on returned text; provenance recorded.

### 5.10 Fixture + first engagement

- Single fixture app checked in under `fixtures/` (small Node app, deliberately seeded: authz/broken-object-data-level checks, one injection, one secret exposure; real sign-in identities member/admin; simple sqlite session state).
- Milestone: run offense recon→map→validate→chain→report; switch mode and run defensive deep-dives→root-cause→remediation dossier→retest; verify coverage/evidence termination; measure prompt/context/cost/perf vs design eval.

## 6. Testing & acceptance

- All extension behavior testable modelless (bun test): adapters keyed fixtures, job lifecycle/cancellation/timeout, DB migration append-only, secret heuristic, session lease conflicts, worker contracts validation, docs FTS5 search relevance, github tool execFile safety, install manifest integrity.
- `install.sh` fixtures: no network in CI paths (digests checked, simulated); tool states exposed end-to-end by `/cyber tools`.
- Fixture engagement acceptance mirrors design doc milestone 3–5 acceptance lines: attributed dedup inventory; scanner candidate ≠ confirmed; callback evidence correlated with restart survival; no-callback timeout = inconclusive; role/identity coverage matrix across signed-out/member/admin; proposed ≠ applied ≠ verified fix; regression cases; compaction recovery keeps brief; secret pattern refusal.
- Mode switch refuses while a browser session/job/worker owns mutable state; theme/mode consistency (existing test base).

## 7. Risks / open items

- PD binaries keyless download of darwin/arm64 assets unverified for some tools until first install run — manifest makes failures explicit per tool, never silent.
- Obscura runtime behavior (snapshots/forms/PWA etc.) is upstream-claim until fixture tests complete.
- REA without Ghidra = reduced lane; observed limits get recorded in `/cyber tools`.
- Provider key: aimylove key used through OpenCode catalog — model IDs and limits confirmed at profile setup, not assumed.
- No OS sandbox anywhere: scope is engagement policy + typed inputs, never containment.
- gh CLI auth must be present for github tool; action fails loudly if not.

## 8. Out of scope for this build

Ghidra/JDK deep analysis, KXM, billion-context, scanner pack breadth beyond the selection list, cloud/identity/DFIR packs (catalog only), multi-model bench, remote external targets, project-mangement style reporting beyond fixture dossier.
