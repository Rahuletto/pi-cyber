# Build status

Status of the merged `feat/toolchain-buildout` tree as verified on this host on 2026-10-21
(macOS darwin/arm64, Bun 1.4.3, pinned Pi 1.3.0). It separates code present in the repository
from capabilities actually exercised, and it records what is still unverified and who owns it.

## Implemented in the extension

- `/offense`, `/defense`, and `/cyber status|checkpoint|mode …`; offense is the fresh-session default. The theme stays blue in both modes and the mode badge carries the distinction.
- `cyber_state` for branch-aware engagement scope, objective, mode-specific coverage, evidence references and next steps.
- 17 registered Pi tools: `github`, `cyber_state`, `cyber_evidence`, `cyber_jobs`, `cyber_browser`, `cyber_knowledge`, and one typed tool per adapter (`nuclei`, `subfinder`, `httpx`, `katana`, `ffuf`, `naabu`, `dnsx`, `uncover`, `vulnx`, `interactsh`, `semgrep`).
- A separate optional AST search/edit extension and a loopback-only Cyberbench fixture with intentionally seeded access-control and file-upload flaws.
- Specialist task/result contracts and role templates, plus four exact package pins, an isolated profile, explicit DuckDuckGo search configuration and worker spawn caps.

---

# Verified from here

## Installed and validated native tools (15)

`tools/install.sh` installed these into `~/.pi/tools/bin`; `tools/validate.sh` probed each one
and recorded `validated` in `~/.pi/tools/state.json`. `bun run doctor` reports the same 16 as
`validated` and the remaining 8 catalog entries as `cataloged`.

| Tool | Version | Probe | Note |
| --- | --- | --- | --- |
| `subfinder` | 2.17.0 | `-version` | version string |
| `dnsx` | 1.3.1 | `-version` | version string |
| `httpx` | 1.12.0 | `-version` | version string; **input-flag drift, see below** |
| `katana` | 1.8.0 | `-version` | version string; **input-flag drift, see below** |
| `nuclei` | 3.11.1 | `-version` | version string; **output-flag drift, see below** |
| `uncover` | 1.2.1 | `-version` | version string |
| `vulnx` | `help-ok` | `--help` | **marker probe only** — `-version` does not exist upstream; v2.0.2 `--help` exits 0 and prints the version, so the recorded version is `help-ok`, not a parsed semver |
| `interactsh-client` | 1.4.1 | `-version` | version string |
| `naabu` | 2.6.1 | `-version` | version string |
| `ffuf` | 2.3.0 | `-V` | version string |
| `obscura` | `help-ok` | `--help` | **marker probe only** — usage text carries no trustworthy semver |
| `trivy` | 0.76.0 | `--version` | version string |
| `osv-scanner` | 2.7.0 | `--version` | version string |
| `gitleaks` | 8.30.1 | `--version` | version string |
| `syft` | 1.55.0 | `--version` | version string |
| `semgrep` | 1.181.0 | `--version` | installed by the operator through the **pip path** (`validate.sh` accepts a pip-installed binary) and symlinked into `~/.pi/tools/bin`; `tools/install.sh` still has no darwin/arm64 asset for it |

"Validated" means *a version probe exited 0*. It does not mean the tool was run against a
target, that its output parses into this harness, or that it is compatible with the adapter
that wraps it.

## Store states asserted by the automated suite

`bun test` (250 pass / 0 fail / 4 skip) asserts these contracts without a model, an external
target or an external scanner:

- **Evidence store** — schema, persistence, per-row SHA-256, secret-pattern refusal on every write path, list/summary rendering, bounded output.
- **Job ledger** — `running → succeeded / failed / interrupted / outcome-unknown` transitions, argv-only spawn, timeout kill, signal-exit mapping, counters-only event payloads, secret check on the full argv.
- **Adapter contracts** — schema validation errors naming the offending instance path, `buildArgs` argv for all 11 adapters, parse tolerance for malformed lines, artifact-kind mapping.
- **Mode and state** — fresh-session OFFENSE default, guarded switch (busy agent, running tool, queued messages), per-mode coverage isolation, branch/session isolation, corrupt-checkpoint refusal, revision counters.
- **Browser lease** — acquire/release/status, single-owner conflict, `mode: "act"` readiness refusal, export-before-close reminder.
- **Knowledge layer** — FTS index build, search, staleness marker over the local corpus.
- **Extension wiring** — pinned Pi extension loader, temporary sessions, theme resolution, AST preview/apply guards.

## Executed for real on this host

- The Cyberbench fixture booted on `127.0.0.1:4747` and served real requests; its seeded faults were reproduced and measured (IDOR on `/api/balance`, missing role check on `/api/admin/users`, tenant IDOR on `/api/orders`, upload path traversal, `/debug/session` secret disclosure). Unauthenticated control returned `401`, so the observed authorization faults are not missing authentication.
- The `naabu` adapter ran against the fixture through the real job runner and produced **2 evidence rows** in a real store (`{"ip":"127.0.0.1","port":4747,"protocol":"tcp","tls":false}`).
- The `semgrep` adapter ran against the fixture source (`semgrep scan --sarif --config p/owasp-top-ten fixtures/cyberbench/app.ts`): job `succeeded`, exit 0, **0 findings**; `--config auto` also returned 0. A clean scan is one observation, never proof of absence — the seeded faults are authorization/traversal logic that neither ruleset flags. The ruleset itself is fetched from the semgrep registry on first use (network), then cached locally.
- A patched scratch copy of the fixture was booted on port 4748 and the retest criteria R1–R10 were measured after the fix (see [FIRST-ENGAGEMENT.md](FIRST-ENGAGEMENT.md)).
- `tools/install.sh -n` printed the 17-entry core download plan; `tools/validate.sh` reported "no state `installed` entries … nothing to probe" (every entry is already `validated`); `bun run packages:check` confirmed the four package pins, the profile paths, the spawn caps, the six role definitions and the six selected bigpowers skills.
- The catalog of skills on this host is `~/.agents/skills`: 88 skill directories, of which 49 match the `mukul975/anthropic-cybersecurity-skills` catalog names; the remainder come from other collections (superpowers, jakubkrehel, mattpocock, vercel-labs, …). `~/.agents/.skill-lock.json` records 39 of them with source attribution; `~/.pi/skills-lock.json` records one (`testing-api-security-with-owasp-top-10`).

## Not exercised

- **No live target engagement.** Every request went to `127.0.0.1`. No external host was scanned, crawled, fuzzed or queried.
- **No real browser.** No browser was launched, no authenticated browser session was driven, and no page was rendered. `cyber_browser` only books a lease; the Obscura MCP server is not registered.
- **No MCP registration of any kind** — no Obscura, no REA server, no other MCP endpoint.
- **REA operator step pending.** The REA server is not run or registered; `rea setup` remains an operator step when binary assessment starts. The reverse lane is research-only posture; no REA analysis path has run.
- **`ghidra` and `jdk21` deferred** by operator decision (2026-10-21); deep decompilation is unavailable until revisited.
- **KXM and billion-context deferred** by design (see [PACKAGES.md](PACKAGES.md) and [TOOL-SELECTION.md](TOOL-SELECTION.md)): KXM adds a hub/CLI/service plane, billion-context a request-rewriting proxy. Neither is installed or evaluated at runtime.
- **`zap` (dmg-only) install path unresolved.** `tools/install.sh` explicitly refuses `.dmg`/`.pkg` artifacts and has no darwin/arm64 asset match for zap; it stays `cataloged`. The **semgrep pip path is resolved**: the operator installed semgrep 1.181.0 through pip/uv (`~/.pi/tools/uv/semgrep/bin/semgrep`, symlinked into `~/.pi/tools/bin`) and `validate.sh` promoted it to `validated` on `--version`.
- **`vulnx` and `obscura` are validated on a `--help` marker probe only** (`help-ok`); no semver was scraped and neither tool was run against a target.
- **`nmap`, `rea`, `understand-anything`, `piebald-claude-code-system-prompts` and `awesome-claude-code`** are catalog entries only — never installed, never run.
- **No provider call, no interactive terminal QA, no light-terminal visual check, no native Node runtime** (the `node` command on this host is a Bun shim), no real compaction-threshold measurement, and no specialist worker spawn.

## Open adapter/binary drift (defects, not environment noise)

The installed binary versions and the adapter `buildArgs` disagree on four tools. Measured
against the loopback fixture on 2026-10-21:

| Tool | Adapter emits | Installed binary expects | Effect through the typed lane |
| --- | --- | --- | --- |
| `httpx` v1.12.0 | positional target | `-u, --target` (`Usage: httpx [flags]`) | job succeeds with **0 rows** |
| `katana` v1.8.0 | positional target | `-u, --list` | job succeeds with **0 rows** |
| `nuclei` v3.11.1 | `-json` | `-j, --jsonl` | job **fails**, exit 2, `flag provided but not defined: -json` |
| `ffuf` v2.3.0 | needs `opts.wordlistPath` | — | refuses with `operator wordlist required`; no tool wiring supplies an operator wordlist |

A fifth, host-level prerequisite: the job runner spawns binaries by name through `PATH`, so
`~/.pi/tools/bin` must be on `PATH` or every adapter fails with
`Executable not found in $PATH: "<bin>"`.

Only `naabu` currently produces evidence rows through the typed tools. The four fixes above
are code changes to `src/adapters/*.ts` and are not part of this documentation task.

---

# Still unverified

| # | Item | Owner | Notes |
| --- | --- | --- | --- |
| 1 | `httpx` / `katana` positional-target drift (0 rows) | Harness maintainer | Change `buildArgs` to `-u`; add a regression test against a fixture binary |
| 2 | `nuclei` `-json` → `-jsonl` drift (exit 2) | Harness maintainer | Same, plus a template-dir note for the first run |
| 3 | `ffuf` operator wordlist wiring | Harness maintainer + Operator | Decide where `buildOpts.wordlistPath` comes from; today no path supplies it |
| 4 | `~/.pi/tools/bin` on `PATH` for adapter spawns | Operator | Export it before `bun run pi`, or teach the launcher to add it |
| 5 | Live target engagement | Operator | Only loopback has been exercised; no external host was touched |
| 6 | Obscura MCP registration + authenticated browser flow | Operator | `obscura` is installed and validated on `--help`; the MCP server is not registered |
| 7 | REA server setup and one real REA run | Operator | `rea setup` is an operator step; no REA analysis has run |
| 8 | `zap` dmg-only install path | Operator | `install.sh` refuses `.dmg`/`.pkg`; no darwin/arm64 asset for zap (the semgrep pip path is resolved) |
| 9 | `vulnx` / `obscura` real version identity | Operator | `help-ok` marker probe only — no semver was scraped |
| 10 | `ghidra` / `jdk21` (deferred) | Operator (deferred decision) | Revisit the 2026-10-21 deferral |
| 11 | KXM / billion-context (deferred) | Operator (deferred decision) | Revisit only if cross-harness durability or context pressure is demonstrated |
| 12 | Provider sign-in and one real model call | Operator | `bun run pi` was not run interactively; no model turn happened |
| 13 | `pi-subagents` worker spawn with inherited context | Operator | Definitions and contracts exist; no worker was actually spawned |
| 14 | Native Node runtime | Operator | The `node` binary here is a Bun shim |
| 15 | Light-terminal visual QA | Harness maintainer | Theme rendering was asserted through Pi's renderer, not by eye |

---

# Final verification record

Run from the repository root on 2026-10-21 (macOS darwin/arm64, Bun 1.4.3). Command chain:
`bun install --frozen-lockfile && bun run typecheck && bun test && bun run doctor --json`.

```text
$ bun install --frozen-lockfile
bun install v1.4.3 (c6da4a4d3)

Checked 392 installs across 397 packages (no changes) [569.00ms]
```

```text
$ bun run typecheck
$ tsc --noEmit
```

Exit code 0, no diagnostics.

```text
$ bun test
bun test v1.4.3 (c6da4a4d3)

 250 pass
 4 skip
 0 fail
 1575 expect() calls
Ran 254 tests across 19 files. [4.21s]
```

```text
$ bun run doctor --json
$ bun src/doctor.ts --json
{
  "platform": "darwin",
  "architecture": "arm64",
  "note": "PATH presence and operator state file only; versions, identity, compatibility and target behavior are unvalidated. An executable named httpx may be unrelated. The doctor never executes tools.",
  "runtime": [
    { "name": "bun", "available": true, "path": "/opt/malt/bin/bun", "validated": false },
    { "name": "node", "available": true, "path": "/Users/marban/.local/bin/node", "validated": false },
    { "name": "pi", "available": true, "path": "<repo>/node_modules/.bin/pi", "validated": false },
    { "name": "rg", "available": true, "path": "/opt/malt/bin/rg", "validated": false },
    { "name": "git", "available": true, "path": "/usr/bin/git", "validated": false },
    { "name": "ast-grep", "available": false, "path": null, "validated": false },
    { "name": "sg", "available": false, "path": null, "validated": false }
  ],
  "tools": [
    { "name": "subfinder", "category": "recon", "disposition": "core", "state": "validated" },
    { "name": "dnsx", "category": "discovery", "disposition": "core", "state": "validated" },
    { "name": "httpx", "category": "web", "disposition": "core", "state": "validated" },
    { "name": "katana", "category": "web", "disposition": "core", "state": "validated" },
    { "name": "nuclei", "category": "web", "disposition": "core", "state": "validated" },
    { "name": "uncover", "category": "recon", "disposition": "core", "state": "validated" },
    { "name": "vulnx", "category": "defense", "disposition": "core", "state": "validated" },
    { "name": "interactsh-client", "category": "recon", "disposition": "core", "state": "validated" },
    { "name": "naabu", "category": "discovery", "disposition": "core", "state": "validated" },
    { "name": "ffuf", "category": "web", "disposition": "core", "state": "validated" },
    { "name": "obscura", "category": "browser", "disposition": "core", "state": "validated" },
    { "name": "zap", "category": "browser", "disposition": "core", "state": "cataloged" },
    { "name": "semgrep", "category": "defense", "disposition": "core", "state": "validated" },
    { "name": "trivy", "category": "defense", "disposition": "core", "state": "validated" },
    { "name": "osv-scanner", "category": "defense", "disposition": "core", "state": "validated" },
    { "name": "gitleaks", "category": "defense", "disposition": "core", "state": "validated" },
    { "name": "syft", "category": "defense", "disposition": "core", "state": "validated" },
    { "name": "nmap", "category": "discovery", "disposition": "on-demand", "state": "cataloged" },
    { "name": "rea", "category": "reverse", "disposition": "on-demand", "state": "cataloged" },
    { "name": "ghidra", "category": "reverse", "disposition": "deferred", "state": "cataloged" },
    { "name": "jdk21", "category": "misc", "disposition": "deferred", "state": "cataloged" },
    { "name": "understand-anything", "category": "misc", "disposition": "on-demand", "state": "cataloged" },
    { "name": "piebald-claude-code-system-prompts", "category": "misc", "disposition": "reference", "state": "cataloged" },
    { "name": "awesome-claude-code", "category": "misc", "disposition": "reference", "state": "cataloged" }
  ]
}
```

Summary lines: **250 pass, 4 skip, 0 fail** across 19 files (1575 `expect()` calls); typecheck
clean; doctor reports **16 `validated` / 8 `cataloged`** tools on `darwin/arm64`.

---

## Open operational checks

1. Export `PATH="$HOME/.pi/tools/bin:$PATH"`, then launch Pi with `bun run pi`; confirm the extension, the theme and the OFFENSE badge load, and confirm the configured web provider is available.
2. Confirm model sign-in in that profile and test one bounded child task with context and tool grants.
3. Connect the selected browser MCP (Obscura) and validate a signed-out/member/admin flow against Cyberbench.
4. Fix the four adapter/binary drifts listed above, then re-run the loopback lane and confirm that `httpx`, `katana` and `nuclei` produce evidence rows.
5. Run the documented first engagement against `127.0.0.1` only, then inspect the recorded evidence and remediation handoff.

No external target is configured. Mode prompts and package tool schemas are workflow controls,
not an operating-system sandbox or general authorization boundary.
