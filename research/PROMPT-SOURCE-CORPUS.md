# Prompt and orchestration source notes

Catalog-only design references reviewed for this buildout; no external prompt pack is installed or copied wholesale.

| Source pattern | Adopted boundary | Consuming task |
| --- | --- | --- |
| Piebald Claude Code prompt corpus: concise security-review plans and findings | Keep prompts capability-aware, separate hypotheses from demonstrated evidence, and report blockers and coverage | Task 13 |
| Piebald background-agent/state patterns | Make worker task/result fields explicit, bound concurrency and spawn count, and distinguish complete, partial, blocked and failed | Task 10 |
| Piebald autonomous-action/security-monitor patterns | Treat scope, credentials, stop conditions and prompt-injection attempts as engagement controls; prompts remain workflow guidance, not enforcement | Task 13 |
| shanraisshan Claude Code best-practice: layered rules | Keep shared rules in base instructions and mode-specific sequencing in offense/defense files | Task 13 |
| Mermaid-style report structure | Pair bounded prose and evidence tables with compact coverage and finding diagrams | Task 16 |

These are adopted concepts, not claims of equivalence to source systems. No prompt text, extension, agent runtime or security boundary is imported from those projects. See upstream catalogs [`Piebald-AI/claude-code-system-prompts`](https://github.com/Piebald-AI/claude-code-system-prompts) and [`shanraisshan/claude-code-best-practice`](https://github.com/shanraisshan/claude-code-best-practice); review date 2026-10-21.
