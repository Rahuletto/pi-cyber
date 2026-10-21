# Lean cyber tool selection

The full [candidate inventory](TOOLS.md) covers 149 source-linked rows with overlap. That breadth stays in documentation; it does not become 149 tools in every model request.

## Default runtime surface

Keep Pi's read/bash/edit/write tools. The first custom tool is `cyber_state`, supported by `/cyber` mode/status/checkpoint commands. Structured scope, objective, evidence references, coverage and next steps are more useful to every investigation than another overlapping scanner. The current package does not install external scanners or browser engines. The separately enabled AST module uses a pinned optional native library; the remaining packs are integration selections.

## Native capability packs

| Pack | Selected tools | Why / activation |
|---|---|---|
| Recon | Subfinder, dnsx, httpx, Nmap | Resolve and map approved assets; activate per engagement. |
| Requested discovery/intelligence | Uncover, ProjectDiscovery vulnx | Asset-index and vulnerability-intelligence queries; credentials and free limits vary by provider. Intelligence is separate from live target evidence. |
| Web/API | Katana, ffuf, Nuclei, Interactsh, Schemathesis | Crawl, enumerate, test hypotheses and receive correlated OAST evidence. Select templates, budgets and target identities explicitly. |
| Interception | ZAP or an existing Burp/Caido instance; mitmproxy as needed | One primary traffic workflow per engagement. ZAP provides a free baseline; commercial scanners are not required defaults. |
| Source/defense | Semgrep, osv-scanner or Trivy, Gitleaks | Pick dependency coverage by project; avoid running every overlapping scanner by default. Findings need source validation. |
| Code navigation and remediation | Optional ast_grep and ast_edit; language diagnostics on demand | Search source structure and make narrow reviewable fixes. AST matching does not prove dataflow or vulnerability correctness. |
| Reverse engineering | Matching REA skill/server, Apple inspection tools, LLDB, Ghidra | Bring a suitable native engine and versioned target evidence. Managed/mobile/firmware tools activate for matching artifacts. |
| Browser | Obscura direct MCP; stock Chromium/WebKit for engine-specific validation | One owner per mutable browser session; record actual engine and profile. CloakBrowser remains optional pending license and compatibility resolution. |
| Research | pi-web-access with explicit provider; source-aware official documentation registry | Keyless hosted access has limits. Self-hosted SearXNG avoids a paid search API but adds a service to operate. |
| Specialists | pi-subagents, bounded concurrency and explicit task outputs | Definitions alone do not create an enforced scheduler or isolated workers. Add runtime integration and test propagation before claiming parallel cyber execution. |

## Defer until an engagement needs them

AD/Windows, cloud-account mutation, endpoint agents, C2 platforms, mobile device instrumentation and firmware emulation carry distinct environments and dependencies. Keep them discoverable through the catalog and dedicated instructions. KXM, billion-context and the full Feynman/bigpowers stacks are deferred while native Pi state and compaction are evaluated.

## Adapter acceptance

Pin and verify the executable and output schema; test against local fixtures; account for subprocess cancellation, timeout and output bounds; correlate evidence with job, scope, target and identity; protect credentials; then enable the adapter. PATH detection alone is not readiness proof. Mode prompts do not enforce shell/network isolation, and browser automation does not establish browser security parity.
