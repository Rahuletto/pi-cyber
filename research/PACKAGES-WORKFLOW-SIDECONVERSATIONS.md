# Pi package and workflow review: bigpowers and pi-btw

**Review date:** 2026-10-21. **Scope:** source/document review only; no package installs, runtime compatibility tests, or code safety audit. “Source-reviewed” means the linked manifest, docs, or implementation was inspected; it does not mean behavior was executed. Package versions and registry metadata are the current values displayed by Pi’s catalog at review time.

## Findings

| Package | Current Pi catalog entry | Evidence reviewed | Mac / Pi fit |
|---|---|---|---|
| [bigpowers](https://pi.dev/packages/bigpowers) | 2.88.9; MIT; extension, skills, prompts; 8 dependencies, 0 peers; 10.7 MB | **Source-reviewed:** [Pi catalog manifest](https://pi.dev/packages/bigpowers), [GitHub README](https://github.com/danielvm-git/bigpowers), [current GitHub Pi manifest](https://raw.githubusercontent.com/danielvm-git/bigpowers/main/.pi/package.json), [extension source](https://raw.githubusercontent.com/danielvm-git/bigpowers/main/extensions/omp-hooks.ts) | Pi package resources are platform-neutral, but scripts/workflows assume shell and project tools. This is not evidence that every shell script or dependency works on native Apple Silicon; none were tested here. |
| [pi-btw](https://pi.dev/packages/pi-btw) | 0.8.0; MIT; extension, skill; 0 dependencies, 3 peers; 388.1 KB | **Source-reviewed:** [Pi catalog manifest](https://pi.dev/packages/pi-btw), [README and behavior documentation](https://github.com/dbachelder/pi-btw), [package.json](https://github.com/dbachelder/pi-btw/blob/main/package.json), [extension source](https://raw.githubusercontent.com/dbachelder/pi-btw/main/extensions/btw.ts) | Pi extension/API package intended for Pi 0.85.1 through 1.x. Catalog states three host peers; source uses Pi APIs. Native-Mac runtime remains untested. |

## bigpowers: useful remediation workflow, broad defaults

The project describes an engineering lifecycle: Discover, Elaborate, Plan, Build, Verify, Release. Its per-story sequence includes context survey, plan, feature branch/worktree, TDD, user acceptance verification, a code-quality audit threshold of 94%, conventional commit, and release integration. These are the author’s gates, not independent validation of security outcomes. It relies on project state, release plans, scripts, and verification folders, adding mutable state that does not belong in a read-only assessment run.

For defense fixes, selectively use `survey-context`, `research-first`, `plan-work`, `develop-tdd`, `verify-work`, or `audit-code` as warranted: inspect the finding, scope remediation, use a reproducible check, then review the patch. Full `orchestrate-project` / release ceremonies and the 94% gate are poor prerequisites for scanning, triage, or a narrow fix. Keep authorized offense validation task-specific: plan the requested validation, make scoped changes, verify results, and avoid release ceremony in runtime assessments.

The package's skill descriptions are advertised separately from full skill instructions, which load on demand. Both the Pi catalog manifest and the root GitHub `package.json` for 2.88.9 declare `extensions/omp-hooks.ts` plus skills and prompts. A nested `.pi/package.json` has a different, skills/prompts-only layout; it should not be mistaken for the root npm package manifest. The extension source imports Pi's `ExtensionAPI` and registers stock `session_start` and `tool_call` events. The filename alone does not make it OMP-only. This establishes the intended extension entry point, not runtime-tested compatibility. [Root package manifest](https://github.com/danielvm-git/bigpowers/blob/main/package.json), [extension source](https://github.com/danielvm-git/bigpowers/blob/main/extensions/omp-hooks.ts).

The Git guards block selected dangerous command patterns, protected-branch writes, and malformed commit messages. They are workflow guardrails implemented by string matching, not an OS sandbox or a general authorization boundary. Do not count them as enforcement for offensive tools or defense collectors.

Pi’s package install records the package in personal `~/.pi/agent/settings.json` by default; `--local` records it in `.pi/settings.json`, loaded only after project trust. Extensions execute in Pi. The bigpowers README says install has no lifecycle script; separate `bigpowers init` mutates a project by symlinking `scripts/` and creating `specs/bugs/` and `specs/verifications/`, and refuses to replace existing `scripts/`. Its scripts list Bash and Node 14+ prerequisites. Avoid `init` in assessment-only mode. Registry lists eight dependencies, no peers; native Mac install was not tested.

## pi-btw: useful side conversation, not a task-worker boundary

pi-btw creates a Pi child session with its own in-memory state and tool list. `/btw` inherits the active main-session branch context and instructions, but prior tool calls do not grant capabilities: the child declares its own tools. By default it exposes `read`, `bash`, `edit`, and `write`; it runs concurrently and uses the same `ctx.cwd`, so both sessions can touch the same files. It creates no worktree or filesystem isolation. Use it for quick analysis or a reviewed draft, not as a parallel coder alongside active edits.

`/btw:ask` inherits main context but structurally exposes only `read`, `grep`, `find`, and `ls`; it has no bash/edit/write or arbitrary extensions. Use it as a constrained reader, not a structured task runner. `/btw:tangent` has no inherited conversation and retains writable tools. Switching modes clears/recreates the thread. Extensions are absent by default; optional extensions are trusted code that may use shared files or external services. An SSH workspace is configurable, but by default BTW uses local tools even if the parent uses SSH.

Side exchanges persist as hidden session entries but stay out of main model context. `/btw:inject` sends the full thread; `/btw:summarize` summarizes with the effective model and thinking off. Both queue while Pi is busy and clear the side thread after handoff. `/btw:clear` clears it. First Esc aborts a streaming request and retains partial output; second dismisses it. Model/thinking overrides replace the active child while retaining thread history. Usage metadata and token counts are recorded; every side exchange adds model work and potential provider cost. The extension disposes child sessions on shutdown. The modal needs Pi TUI; inline commands work in RPC/SDK hosts.

Catalog shows 0 runtime dependencies and 3 peers. The repo declares Pi API packages as peers and supports Pi 0.85.1 through 1.x; README reports CI against locked dependencies, 0.85.1, and latest Pi. Its development Pi version requires Node 22.19+, not a separately confirmed runtime floor for the user’s Mac. Installing adds the extension and skill to Pi configuration; no runtime was exercised.

## Recommendation for the harness

Keep **neither package in the core assessment/offense runtime pack**. Consider pi-btw an optional UI convenience: default to `/btw:ask` for parallel read-only interpretation, and use `/btw` only when shared-workspace writes are explicitly intended and coordinated. It does not supply the independent specialist task worker with per-role tool grants, isolated workspace, or structured result contract that the harness needs. Use the selected specialist worker engine with explicit task inputs, tool/permission allowlists, workspace policy, and evidence handoff.

Treat bigpowers as an optional **defense remediation / engineering workflow pack**, with a small selected set of skills available on demand. It is not required to run scanners or assess artifacts, and its broad lifecycle gates should not block task-specific offense validation or defense collection. Before enabling its extension, inspect the root manifest and pinned package contents. Selective skills reduce full-document context load but leave descriptions visible and retain the extension’s separate command-guard behavior when enabled. No compatibility or safety guarantees are inferred from source review alone.

## Sources reviewed

- [Pi Packages documentation](https://pi.dev/docs/latest/packages) — package settings scope, filters, dependency handling, trust, and executable extensions.
- [Pi Extensions documentation](https://pi.dev/docs/latest/extensions) — stock extension API and `tool_call` event.
- [bigpowers Pi catalog](https://pi.dev/packages/bigpowers); [bigpowers README](https://github.com/danielvm-git/bigpowers); [GitHub Pi manifest](https://raw.githubusercontent.com/danielvm-git/bigpowers/main/.pi/package.json); [extension](https://raw.githubusercontent.com/danielvm-git/bigpowers/main/extensions/omp-hooks.ts).
- [pi-btw Pi catalog](https://pi.dev/packages/pi-btw); [README](https://github.com/dbachelder/pi-btw); [package manifest](https://github.com/dbachelder/pi-btw/blob/main/package.json); [extension](https://raw.githubusercontent.com/dbachelder/pi-btw/main/extensions/btw.ts).
