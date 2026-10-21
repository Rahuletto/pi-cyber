# Optional Pi packages

`bun install --frozen-lockfile` installs the exact package versions into this repository's `node_modules`. `config/cyber/settings.json` loads them from those local paths in the isolated Pi profile; `scripts/pi.sh` points Pi at this profile by default. `bun run install:packages` verifies pins and profile paths and refreshes the six selected bigpowers skills. It performs no network access and does not copy personal provider credentials.

| Package | Pin | Use | Limits |
| --- | --- | --- | --- |
| `pi-subagents` | 0.79.2 | Optional bounded worker runtime for the six role templates | Parent context, tool grants, isolation, cancellation and budgets need runtime verification; contracts in this repository validate handoffs only. |
| `pi-web-access` | 0.43.0 | Explicit DuckDuckGo search and selected-page fetch | Search is explicitly set to DuckDuckGo, workflow is `none`, hosted fetch providers and browser cookies are disabled; provider availability and compatibility can change. |
| `pi-btw` | 0.8.0 | Optional side conversation command | Shares the working directory and is not an isolated coding worker. Use read-only for parallel interpretation. |
| `bigpowers` | 2.88.9 | Optional on-demand workflow skills | Broad skills are not enabled wholesale; do not run its project initializer. Its guardrails are not a security boundary. |

The Pi profile loads `pi-subagents`, `pi-web-access`, and `pi-btw` from the pinned local packages. Bigpowers contributes only six copied skills; its extension, prompts, themes and remaining skill catalog are excluded. To inspect loaded package resources, launch the dedicated profile and use Pi's `/settings` or `pi list`. A cataloged package is not evidence of a working capability.

Bigpowers has many workflows. Keep only the selected skills in scope: `survey-context`, `research-first`, `plan-work`, `develop-tdd`, `verify-work`, and `audit-code`. Avoid enabling KXM, billion-context features, the full Feynman pack, broad default prompt overlays, or `bigpowers init`; those add unrelated context or mutate a project. `pi-btw` does not replace the specialist worker boundary.

Pins reviewed from package manifests and local package contents on 2026-10-21. Runtime behavior in a native Node Pi process, authenticated worker inheritance, provider calls and macOS-specific package scripts remain unverified. See the source reviews in [`research/PACKAGES-ORCHESTRATION-RESEARCH.md`](../research/PACKAGES-ORCHESTRATION-RESEARCH.md), [`research/PACKAGES-WORKFLOW-SIDECONVERSATIONS.md`](../research/PACKAGES-WORKFLOW-SIDECONVERSATIONS.md), and [`research/SEARCH-AND-COMPACTION.md`](../research/SEARCH-AND-COMPACTION.md).
