# Task 10 + 11 Report — Specialist agents and harness package wiring

Branch: `feat/packages-install` · Date: 2026-10-21 · Plan: `docs/superpowers/plans/2026-10-21-pi-cyber-toolchain-buildout.md`

## Ledger amendment honoured

The Anthropic-Cybersecurity-Skills library is **done**: 48 curated skills are
installed in `~/.agents/skills` and Pi loads them natively (verified below:
they appear in the loaded skill catalog without any copy in this repo). Task
10's skill-installation portion is therefore complete and was **not** re-done.
What remained of Task 10 was the specialist-agent wiring, and that is what this
branch delivers: plan Task 10 does define named specialists beyond the skills
(`agents/*.md`, six roles, plus `src/specialists/contracts.ts`), so they were
wired into the cyber profile rather than invented on the spot.

## Packages installed (exact identities from the research notes)

Installed with `bun add` into this repository (the harness runs under bun):

| Package | Pin | Source of the identity |
|---|---|---|
| `pi-subagents` | 0.79.2 | `research/PACKAGES-ORCHESTRATION-RESEARCH.md` (catalog 0.79.2; plan tech stack "0.79.x") |
| `pi-web-access` | 0.43.0 | `research/PACKAGES-CONTEXT-WEB.md` (catalog 0.43.0) |
| `pi-btw` | 0.8.0 | `research/PACKAGES-WORKFLOW-SIDECONVERSATIONS.md` (catalog 0.8.0) |
| `bigpowers` | 2.88.9 | `research/PACKAGES-WORKFLOW-SIDECONVERSATIONS.md` (catalog 2.88.9) |

No install failed. `bun.lock` is now committed (825 lines) because these are
runtime dependencies and the lockfile is what pins their integrity — earlier
task reports called it "untracked noise" while it only covered devDependencies.

## What was built

1. **Profile wiring** (`config/cyber/settings.json`): the four packages are
   declared as **local** package sources (`../../node_modules/...`). Pi loads
   them from this repository's `node_modules` instead of downloading a second
   copy; `pi list` under `PI_CODING_AGENT_DIR=config/cyber` lists all four.
   Resource filters are exact: pi-subagents contributes its extension, two
   skills and six prompt templates; pi-web-access contributes **only**
   `dist/index.js` (the MCP CLI bundle in the same directory is not loaded as an
   extension); pi-btw contributes its extension and skill; bigpowers
   contributes **nothing** — its extension and all 81 of its skills stay
   disabled.
2. **Selective bigpowers skills** (`config/cyber/skills/`): `survey-context`,
   `research-first`, `plan-work`, `develop-tdd`, `verify-work`, `audit-code`
   copied verbatim from the pinned package (MIT), with provenance in
   `config/cyber/SKILLS-NOTICE.md`. `scripts/install-packages.ts` refreshes them
   from the installed package and fails per package when a pin drifts.
3. **Search configuration** (`config/cyber/web-search.json`): explicit provider
   `duckduckgo` (keyless, explicit-only — never auto-selected), `workflow:
   "none"`, curator disabled, `allowBrowserCookies: false`,
   `fetchRouting.allowRemoteHostedProviders: false`.
4. **Specialist agents** (`config/cyber/agents/*.md`, six roles): `recon`,
   `web-api`, `vulnerability-research`, `validation`, `offensive-operator`,
   `source-remediation` — the first six roles of the harness design roster.
   Each file has pi-subagents frontmatter (name, description, advertise,
   strict `tools` allowlist drawn from the adapter catalog, `extensions:
   ../../../src/index.ts`, `inheritSkills: false`, `maxSubagentDepth: 0`,
   `async: true`, timeout, acceptance, acceptanceRole), a capabilities section,
   the `TaskResult` output contract and explicit stop conditions.
5. **Task contract** (`src/specialists/contracts.ts`): Typebox schemas for the
   task contract and the result, `assertContract` (throws naming the exact
   field), `critiqueResult` (returns objections, never throws), capability
   whitelist derived from the adapter registry, secret-pattern refusal on
   credential references, and the caps `MAX_CONCURRENT_CHILDREN = 2`,
   `MAX_TOTAL_SPAWNS_PER_RUN = 8`.
6. **Spawn caps** (`config/cyber/extensions/subagent/config.json`): 2 concurrent
   children, 8 spawns per run, 16 per session, scheduled runs off.
7. **Docs**: `docs/PACKAGES.md` (rationale, risks, update cadence, explicit
   exclusions: KXM, billion-context, Feynman full, the bigpowers extension and
   its other 75 skills) and a rewritten `config/cyber/README.md` with the
   operator steps.
8. **`scripts/pi.sh`**: now `cd`s to the repository root so the session, the
   evidence store and the job artifacts resolve inside the harness repo.

## Verification (offline, modelless)

- `bun run typecheck` → clean (`tsc --noEmit`, no output; `scripts/**` added to
  the tsconfig include).
- `bun test` → **193 pass, 4 skip, 0 fail, 1202 expect() calls** (baseline 167
  pass + 4 skip; **26 new tests** in `tests/packages.test.ts` and
  `tests/specialists.test.ts`).
- `PI_CODING_AGENT_DIR=config/cyber pi list` → all four packages resolve.
- Pi resource loader with `agentDir=config/cyber`: **3 extensions loaded, 0
  errors, 0 warnings**; 97 skills loaded — the 6 selected bigpowers skills, the
  2 pi-subagents skills, the pi-btw skill and the 48 Anthropic cybersecurity
  skills from `~/.agents/skills` (native load, no copy), while all 81 bigpowers
  skills remain disabled.
- pi-subagents discovery with the same profile: the 6 cyber roles are found
  with their tool allowlists, `maxSubagentDepth: 0`, `advertise: true` and the
  harness extension resolved to the real `<repo>/src/index.ts`; **0
  diagnostics**.
- `bun scripts/install-packages.ts --check` → all four pins ok, all profile
  paths present.

## Operator steps that cannot be verified offline

Documented in `config/cyber/README.md`:

1. Provider login happens in this profile (`config/cyber/auth.json`); the
   personal `~/.pi/agent` is untouched.
2. **Search provider**: DuckDuckGo is keyless and explicit-only, so the harness
   works without a key. Any other provider needs a key in `web-search.json` or
   the environment, and `provider` and `webSearch.allowedProviders` must agree
   — Pi rejects a configured provider outside the allowlist. `workflow` stays
   `"none"`.
3. **Worker caps** live in `config/cyber/extensions/subagent/config.json` and
   should only be raised after measuring memory, cost and result quality.
4. **bigpowers skills** reference `scripts/bp-*.sh` and `specs/` state that
   this harness does not provide; those steps cannot run here.
5. **`/btw`** children share this repository's working directory and have no
   isolation; prefer `/btw:ask`.

## Concerns for the controller

1. **pi-web-access version mismatch**: the research note lists catalog 0.43.0
   while upstream `main` said 0.44.0 at review time; npm now serves 0.44.0 as
   latest. 0.43.0 is pinned (the version the note reviewed). Bump deliberately
   and re-run the suite; the config file keys used here are stable across
   0.43/0.44 but were read, not executed.
2. **No child has been launched** and **no search request has been made**: both
   need a provider and, for some paths, network access. Everything above is
   file-level and loader-level verification only.
3. **Extension paths in agent frontmatter resolve against the agents
   directory**, not the working directory (`config/cyber/agents/../../..` →
   `<repo>/src/index.ts`). A profile copied elsewhere needs that path adjusted;
   `tests/specialists.test.ts` fails loudly if it dangles.
4. **Pi package filters do not accept a leading `./`**: `"./index.js"` matched
   nothing and silently disabled the extension. The profile uses `index.js`,
   `dist/index.js`, `extensions/btw.ts`, `skills/**`, `prompts/**`. This is a
   Pi 1.3.0 quirk worth remembering for future package wiring.
5. **`bun.lock` is now tracked.** If the controller prefers an untracked
   lockfile (earlier task reports treated it as noise), say so and it will be
   untracked again — but then the four package pins have no integrity record.
6. The working tree was committed once by the environment mid-task as
   `fade00a feat: wire pinned packages and scoped worker profile`; the final
   commit message requested for this task is applied on top of that history.
