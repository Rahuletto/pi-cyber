# Cyber harness research index

Research date: 2026-10-21. The controlling proposal is [Pi Cyber Harness](../PI-CYBER-HARNESS-DESIGN.md). The original [initial plan](../PI-CYBER-RESEARCH-PLAN.md) is retained as a superseded snapshot.

## Read in this order

1. [Harness design](../PI-CYBER-HARNESS-DESIGN.md): offense/defense modes, specialist contracts, six extension entry points, browser/session ownership, native adapters, evidence, and milestones.
2. [Recon/web/API catalog](RECON-WEB-TOOLS.md): reconnaissance, discovery, HTTP/TLS, API testing, OAST, vulnerability intelligence, proxy alternatives, and Reddit discovery ledger.
3. [Defense/cloud/identity catalog](DEFENSE-CLOUD-IDENTITY-TOOLS.md): source/supply chain, cloud/IaC, endpoint/log/PCAP analysis, directory tools, and exercise frameworks. Includes A-poc category screening and selection reasons.
4. [Browser/REA research](BROWSER-REA-TOOLS.md): Obscura MCP/CDP and fidelity, Mac binary-analysis providers, REA skill/server matching, retained Evidence, and platform-specific limitations.
5. [Knowledge/documentation design](KNOWLEDGE-AND-DOCUMENTATION.md): OWASP/reference packs, official/live retrieval, Stack Exchange, search and reader components, provenance, and coverage evaluation.
6. [Ecosystem patterns](ECOSYSTEM-PATTERNS.md): additional cyber harness/service comparisons and community discoveries; architectural references rather than dependencies to import wholesale.
7. Package evaluations: [orchestration/research](PACKAGES-ORCHESTRATION-RESEARCH.md), [context/web access](PACKAGES-CONTEXT-WEB.md), and [engineering/side conversations](PACKAGES-WORKFLOW-SIDECONVERSATIONS.md). These evaluate the user's proposed packages and the discovered pi-subagents dependency without installing them.
8. [Offense instruction proposal](OFFENSE-INSTRUCTIONS-PROPOSAL.md): an environment-neutral active investigation, exploitation, chaining, and objective-pursuit overlay, not installed agent configuration.
9. [Defense instruction proposal](DEFENSE-INSTRUCTIONS-PROPOSAL.md) and [testing/implementation handoff requirements](TESTING-COVERAGE-AND-HANDOFF.md): role coverage through real sign-in, confirmed vulnerability evidence, secret handling, and an implementation-ready remediation dossier.
10. [Prompt source corpus](../docs/PROMPT-SOURCE-CORPUS.md): lineage for the base/offense/defense overlays and the diagrammatic reporting helpers — the source each section was mined from, what was ported, what was written fresh, and what was rejected.

## How to interpret the catalog

The four tool/ecosystem reports contain **149 candidate/capability rows**: 61 recon/web, 50 defense/cloud/identity, 25 browser/REA, and 13 ecosystem projects. There is overlap across reports. In the recon/web report, 58 rows have upstream documentation or release evidence reviewed and three remain discovery-only; the defense report marks 49 source-reviewed and one catalog-only. These counts describe research depth, not installed or successfully tested tools.

Rows describe tool candidates, platforms, libraries, or capability families; they are not a count of unique executables. Candidates can appear in multiple domain reports. “Source-reviewed” or “docs reviewed” establishes the stated upstream interface, not operational effectiveness, code safety, maintainer trust, or local Apple Silicon compatibility. Discovery-only candidates need further review before integration.

A-poc's catalog was screened by category and used to discover relevant projects. This research does not establish a line-by-line security audit or runtime validation of every linked project, and does not recommend installing all catalog entries. Reddit discussions are dated, anecdotal discovery inputs, including self-promotion; primary project sources support technical interface claims.

## Selection decisions

- Required early capabilities: separate offense/defense mode state, specialist delegation, Obscura browsing, source-aware documentation lookup, native job management, and durable evidence.
- Requested native family: uncover, httpx, Nuclei, Interactsh, and ProjectDiscovery vulnx; add Subfinder/dnsx/Katana/Nmap for the connected asset workflow.
- Required reverse-engineering path: REA with its matching skill/server and a verified native engine; Ghidra with a matching arm64 JDK/decompiler is the proposed noncommercial default.
- Default proxy: connect an existing suitable Burp instance if available; evaluate Caido/ZAP as alternatives based on the chosen workflow and interfaces. Do not enable every proxy stack by default.
- Default native source/fix path: existing repository tools plus a selected SAST and dependency scanner, followed by relevant tests and retests. Broader detection/cloud/identity packs remain discoverable and on demand.
- Catalog breadth does not expand permanent prompt size: direct tools stay small, specialist skills and detailed tool schemas are loaded by task.

## Outstanding verification

Exact releases, licenses, signatures/digests, architecture-specific dependencies, credential/service limits, parser fixtures, native host behavior, browser security fidelity, and worker resource use need verification during implementation. Source-reviewed does not waive these checks.

The initial research involved no installations or target scans. Local implementation has since begun: consult [README](../README.md) and [build status](../docs/BUILD-STATUS.md) for verified runtime behavior. The research reports remain source-review records, not proof that their external tools were installed or tested.

## Implementation follow-up research

- [All candidate tools](../TOOLS.md), with a generated machine-readable inventory.
- [CloakBrowser versus Obscura](CLOAKBROWSER-COMPARISON.md).
- [Free search and native compaction](SEARCH-AND-COMPACTION.md).
- [Selective oh-my-pi tools](OH-MY-PI-SELECTIVE-TOOLS.md).
- [Lean selection](../docs/TOOL-SELECTION.md).
