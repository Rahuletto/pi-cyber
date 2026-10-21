# Packages in the cyber profile

What the cyber harness installs, why, what it risks, and what it deliberately
leaves out. Source basis: `research/PACKAGES-ORCHESTRATION-RESEARCH.md`,
`research/PACKAGES-CONTEXT-WEB.md`, `research/PACKAGES-WORKFLOW-SIDECONVERSATIONS.md`
(source review only, 2026-10-21). The pins below are the versions those notes
reviewed; the harness installs them into this repository with `bun add` so the
runtime and the manifest agree.

## Installed

| Package | Pin | Role | Loaded from the profile |
|---|---|---|---|
| `pi-subagents` | 0.79.2 | Specialist worker engine (foreground + background children, role discovery, spawn budgets) | extension `index.js`, its 2 skills, its 6 prompt templates |
| `pi-web-access` | 0.43.0 | Search and extraction (`web_search`, `fetch_content`, `get_search_content`, `source_check`) | extension `dist/index.js` only — the MCP CLI bundle is not loaded as an extension |
| `pi-btw` | 0.8.0 | Optional side conversation (`/btw`, `/btw:ask`, `/btw:tangent`) | extension `extensions/btw.ts` and its skill |
| `bigpowers` | 2.88.9 | Engineering workflow skills for defense remediation | **no extension**; six skills copied into `config/cyber/skills/` |

All four are declared in `config/cyber/settings.json` as local package sources
(`../../node_modules/...`). Pi loads them from this repository's `node_modules`
instead of downloading a second copy, and the version check in
`bun scripts/install-packages.ts` fails loudly when a pin drifts.

## Why these, in one line each

- **pi-subagents** is Pi's supported child-session engine. A custom worker
  engine would duplicate lifecycle and result handoff machinery before there is
  evidence it is needed. The harness defines task/result validators in
  `src/specialists/contracts.ts`, but these helpers are not wired into the
  package's launch/return path and must not be treated as runtime enforcement.
- **pi-web-access** is the source-led research lane: bounded search plus
  explicit fetch, with `source_check` for passage provenance. It complements
  Obscura (search/extraction versus rendered interaction) and does not replace
  it.
- **pi-btw** is an operator convenience, not the specialist engine: a side
  conversation that stays out of the main transcript. `/btw:ask` is read-only;
  `/btw` shares the working directory and is used only when writes are intended.
- **bigpowers** contributes a bounded engineering loop (survey, research, plan,
  TDD, verify, audit) that fits defense remediation. Its project lifecycle
  ceremonies do not belong in an assessment run.

## Risks that stay with the operator

- **Every child is another model run.** Specialists cost tokens and inherit the
  provider credentials. The caps (2 concurrent, 8 per run, 16 per session) bound
  the blast radius; the coordinator still decides whether to delegate at all.
- **Capability lists are not sandboxes.** A role's `tools` allowlist narrows
  what a child may call inside Pi; it does not confine the operating system.
  Children share the operator's own privileges.
- **Search providers see the query.** `web-search.json` pins keyless
  DuckDuckGo, disables the curator, browser cookies and hosted extractors, and
  keeps `workflow: "none"`, so the harness never opens a summary model or a
  curator window on its own. Switching to a keyed provider changes who receives
  the query and the fetched text.
- **The bigpowers skills are not native to this repository.** They expect
  `scripts/bp-*.sh` and `specs/` state that the harness does not provide; those
  steps cannot run here.
- **pi-btw has no filesystem isolation.** `/btw` and the main session can touch
  the same files.
- **Upstream moves fast.** pi-subagents shipped 0.79.2 and 0.80.0 within days
  of the review; pi-web-access 0.43.0 and 0.44.0 likewise, and the research
  notes already flag a catalog-versus-`main` mismatch for pi-web-access. Pins
  are the only reason this harness is reproducible: bump deliberately, run
  `bun scripts/install-packages.ts --check`, then re-run the suite.

## Deliberately excluded

| Excluded | Why |
|---|---|
| `billion-context` | A proxy that rewrites provider requests and streaming responses. Context pressure is not yet demonstrated, and Pi's native compaction plus the evidence store cover the need. If it is ever evaluated, use one integration mode only, and never treat compressed history as the forensic record. |
| `@kontextmind/kxm` | Adds a hub, a separate CLI/Runtime, tokens and project state — a service plane for cross-harness coordination that this single-process harness does not need. Revisit only if durable coordination across harnesses becomes a requirement. |
| `@companion-ai/feynman` (full stack) | Its CLI owns the whole Pi stack, its roles are academic-research oriented, and it bundles PostHog telemetry. Its planning/verification patterns are the useful part; the package is not. |
| bigpowers extension + 75 other skills | The extension is a workflow guardrail implemented by string matching, not an authorization boundary; the full lifecycle (`orchestrate-project`, release ceremonies, the 94% audit gate) does not belong in an assessment run. Only six skills are exposed. |
| pi-subagents built-in agents (`scout`, `researcher`, `worker`, …) | They stay available; the 12 cyber roles are the project-specific roster. |
| Anthropic-Cybersecurity-Skills copies | The 48 curated skills are already installed in `~/.agents/skills` and Pi loads them natively — copying them into the profile would duplicate them. |

## Verification status

Verified in this checkout: all four package pins and profile paths exist;
`pi-subagents` discovers the 12 profile roles and resolves their cyber
extension paths; the six selected workflow skills are present in the profile.
The `TaskContract` and `TaskResult` helper validators have unit coverage but
are not connected to specialist dispatch or result handling. A provider-backed
specialist spawn and web request still require live credentials and are not
verified by package-path checks.
