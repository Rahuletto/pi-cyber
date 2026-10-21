# Optional Pi packages

`bun run install:packages` installs exact versions into the isolated `config/cyber` Pi profile. Set `PI_CODING_AGENT_DIR` to target a different dedicated profile. This command modifies that profile's Pi settings and package cache; it does not install packages globally or copy personal provider credentials. It filters bigpowers to six selected skills (`survey-context`, `research-first`, `plan-work`, `develop-tdd`, `verify-work`, and `audit-code`) and disables its extension, prompts, themes, and other skills. It writes `web-search.json` only when absent, choosing explicit Exa search and the `none` workflow. Exa is a hosted service; configure another provider explicitly if that is unsuitable.

| Package | Pin | Use | Limits |
| --- | --- | --- | --- |
| `pi-subagents` | 0.79.2 | Optional bounded worker runtime for the six role templates | Parent context, tool grants, isolation, cancellation and budgets need runtime verification; contracts in this repository validate handoffs only. |
| `pi-web-access` | 0.43.0 | Explicit web search and selected-page fetch | Hosted provider availability, privacy, quotas and compatibility can change; no search is run by installation. |
| `pi-btw` | 0.8.0 | Optional side conversation command | Shares the working directory and is not an isolated coding worker. Use read-only for parallel interpretation. |
| `bigpowers` | 2.88.9 | Optional on-demand workflow skills | Broad skills are not enabled wholesale; do not run its project initializer. Its guardrails are not a security boundary. |

The installer records pins in the isolated profile and skips entries already present. It does not silently install during tests, extension startup or `bun run pi`. To inspect loaded package resources, launch the dedicated profile and use Pi's `/settings` or `pi list`. A cataloged package is not evidence of a loaded or working capability.

Bigpowers has many workflows. Keep only the selected skills in scope: `survey-context`, `research-first`, `plan-work`, `develop-tdd`, `verify-work`, and `audit-code`. Avoid enabling KXM, billion-context features, the full Feynman pack, broad default prompt overlays, or `bigpowers init`; those add unrelated context or mutate a project. `pi-btw` does not replace the specialist worker boundary.

Pins reviewed from package manifests and local package contents on 2026-10-21. Runtime behavior in a native Node Pi process, authenticated worker inheritance, provider calls and macOS-specific package scripts remain unverified. See the source reviews in [`research/PACKAGES-ORCHESTRATION-RESEARCH.md`](../research/PACKAGES-ORCHESTRATION-RESEARCH.md), [`research/PACKAGES-WORKFLOW-SIDECONVERSATIONS.md`](../research/PACKAGES-WORKFLOW-SIDECONVERSATIONS.md), and [`research/SEARCH-AND-COMPACTION.md`](../research/SEARCH-AND-COMPACTION.md).
