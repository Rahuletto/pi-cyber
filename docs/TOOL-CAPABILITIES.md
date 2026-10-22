# Tool capabilities and proposed improvements

Inspected 2026-10-22. This inventory describes the local Pi-cyber harness, not the
separate tools exposed by the T3/Codex host. The SDK loader confirmed 23 tools
from `src/index.ts`, nine tools from the configured web/subagent extensions, and
two optional AST tools. Extensions can hide tools until enabled; this is the
wired surface, not a claim that every tool is active in an already-running Pi
session. Existing sessions must reload to pick up browser changes.

The twelve adapter executables are present on disk. Eleven have recorded
validated state; jwt-hack is present with recorded installed state. These are
readiness checks, not fresh scanner execution or credentials verification.

The implemented improvements and examples are documented in [Agent tool workflows](AGENT-TOOLS.md). Remaining ideas below stay proposals; third-party package tools were not forked or modified.

## Harness tools: 23

- **browser**: persistent browser profiles; stable tab IDs and exact-URL selection;
  open/select/close tabs; history navigation; snapshots, JavaScript, screenshots;
  frame discovery and targeting; bounded auto-waiting interactions; retained
  network metadata; Turnstile, clearance, and fingerprint actions. See
  [examples and limits](BROWSER.md). Now includes document-bound DOM refs,
  popup discovery, dialog controls, download artifacts and explicit bounded
  network response artifacts. Next: progress event subscriptions and broader
  explicit request export controls.
- **bypass_fetch**: HTTP methods, raw text bodies, custom headers, impersonation
  profiles, named cookie jars, redirects, and timeouts. Artifact-backed binary
  uploads, typed multipart inputs, binary response artifacts, redacted final-hop
  headers and redirect provenance are implemented. Next: explicit reusable
  authentication references.
- **mailgen**: allocate disposable inboxes, inspect provider health, probe
  providers, wait for mail, retrieve body/links, extract OTPs. Provider state is
  stored separately. Provider message IDs, list/read-by-ID, older-page cursors,
  sender/subject/time filters and newer-than-message waits are implemented for
  providers supporting the Inbox API. Unsupported provider operations fail
  explicitly. Next: provider capability discovery before a workflow starts.
- **github**: explicit repos/issues/code search, bounded search pagination,
  file reads at a selected ref, issue/PR listings, PR diff retrieval and advisory
  queries through gh. Next: richer advisory contracts and cross-result citations.
- **cyber_state**: read or replace durable scope, objective, coverage, evidence
  references, and next steps. Lists currently replace previous lists. Next:
  revision-checked append/remove operations and scoped checkpoints so independent
  agents cannot accidentally overwrite each other's progress.
- **cyber_spec**: retrieve the full operator specification, focused packages,
  and supported role playbooks. Next: section-level retrieval and version/hash
  metadata, so an agent can request the exact instruction it needs.
- **cyber_evidence**: add/read durable evidence, list findings, summaries, and
  optional lifecycle diagrams. Next: evidence text search, cursor pagination,
  artifact hashes, deduplication, and explicit finding transitions linked to
  supporting evidence rather than free-form notes.
- **cyber_jobs**: typed run/start/status/cancel/result/list, serialized bounded
  execution, real subprocess cancellation, progress counters and durable normalized
  result artifacts. Runtime cancellation handles remain process-local. Next:
  native agent wake subscriptions and configurable concurrency after resource
  ownership is explicit.
- **cyber_artifacts**: create bounded text/base64 upload artifacts, inspect private
  metadata, or read integrity-checked bounded windows. References are opaque,
  engagement-scoped and reusable across jobs, browser and HTTP tools. Next:
  explicit retention/expiry and structured observation query interfaces.
- **cyber_tools**: complete session registry discovery, bounded name/capability
  filters, live schema/description lookup and existing runtime/manifest readiness.
  Registration is distinguished from credential/runtime proof. Next: supported
  examples and credential diagnostics supplied by each tool's own provider.
- **cyber_knowledge**: local FTS search across skills/research/docs, stats/staleness,
  explicit rebuilds and bounded fetch by indexed content-bound IDs. Unchanged
  rebuilds retain IDs; changed/removed content invalidates them. Next: related
  document links and section-aware retrieval.
- **subfinder**: passive subdomain discovery with source selection. Next: typed
  source inclusion/exclusion and delta results against an earlier job.
- **httpx**: HTTP service probing for URLs/hosts, with port selection. Next:
  expose supported title/status/technology/TLS fields as typed controls and
  filters; preserve each observation's source target and timestamp.
- **dnsx**: resolve selected record types for domain batches. Next: resolver
  profiles, TTLs, complete answer chains, and wildcard/negative-answer metadata.
- **katana**: crawl target batches with a depth limit. Next: typed same-origin
  scope controls, extraction filters, request provenance, and bounded incremental
  crawl results.
- **ffuf**: URL fuzzing with a configured operator-owned wordlist, HTTP method,
  status filters, and extensions. Next: named wordlist profiles, typed response
  size/word/line filters, calibration controls, and result pagination.
- **naabu**: port scans for host batches, selected ports, and scan type. Next:
  typed concurrency/timeouts and incremental host/port deltas.
- **nuclei**: template-based checks for target batches, template IDs, and severity
  filters. Next: template metadata lookup, explicit template-set versions,
  preflight counts, and resumable findings with matched request references.
- **uncover**: asset-search queries across selected engines with a result limit.
  Next: cursor pagination, provider capability/credential diagnostics, normalized
  assets, and source-by-source provenance.
- **vulnx**: advisory search plus CVE ID lookup/analysis. Next: typed ecosystem,
  package/version filters, machine-readable affected-version ranges, and source
  freshness metadata.
- **interactsh**: record out-of-band callback events against a configured server
  with a polling interval. Runs currently last until the job timeout. Next:
  persistent subscription IDs, event cursors, explicit stop, and correlation
  with the originating job/evidence IDs.
- **semgrep**: local static analysis with explicit paths and a pinned rule set.
  Next: rule-set discovery, incremental changed-file scans, stable finding
  fingerprints, and SARIF artifact retrieval.
- **jwt-hack**: decode, scan, signature verification, typed offline payload
  generation, and bounded dictionary/brute-force modes through the installed
  toolkit. Next: separate offline analysis from live work in the result schema,
  clarify supported algorithms and mode prerequisites, return structured claims
  and signature verdicts, and use opaque references for sensitive inputs.

## Configured extension tools: 9

- **web_enable**: enable the configured web surface without making a request.
  Improvement: expose readiness and provider availability as structured output.
- **web_search**: one or several queries, provider/domain/recency controls,
  result limits, and retained full-content references. Improvement: consistent
  provenance and freshness metadata across providers.
- **source_check**: gather evidence for a claim with passage citations.
  Improvement: distinguish supporting, contradicting, and inconclusive sources.
- **fetch_content**: fetch readable or raw content; supported adapters include
  images, PDFs, YouTube, GitHub repositories, and local video.
  Improvement: stable chunk IDs, extraction diagnostics, and deterministic
  artifact retrieval across formats.
- **get_search_content**: retrieve bounded windows or search passages in retained
  search/fetch results. Improvement: cross-artifact search and reusable citations.
- **subagents_enable**: expose delegation/management tools without launching work.
  Improvement: report exact enabled capabilities and available agent profiles.
- **subagent**: launch one child or workflows; model/cwd/worktree/output controls;
  manage existing runs. Improvement: standardized input/output artifacts, clear
  ownership conflicts, and result validation against a declared task contract.
- **contact_supervisor**: send blocking questions, interviews, or progress to a
  parent session. Improvement: typed decision IDs and links to supporting artifacts.
- **bg_wait**: wait/subscribe for background work without native notifications.
  Ordinary asynchronous subagent work already wakes the session. Improvement:
  expose a single consistent event/result handle across background providers.

`pi-btw` adds side-conversation commands, not model-callable tools. The OpenCode
bridge configures a provider and commands, not another browser/tool inventory.
`bigpowers` is installed with extensions/skills/prompts disabled in this profile;
its `bigpowers_skill` tool is therefore not part of the configured surface.

## SDK built-ins and optional AST tools

Pi's default coding set is **read** (text/images), **bash** (commands), **edit**
(exact text replacements), and **write** (create/replace files). The SDK also
provides **grep** (content search), **find** (file search), **ls** (directory
listing), and **powershell** (PowerShell execution) when selected. Their presence
in the SDK does not mean every session enables all eight.

**ast_grep** is optional structural search over explicit JS/TS/TSX/CSS/HTML files.
**ast_edit** previews structural changes and applies a separate proposal after
hash/session/path checks. Both load with `AST=1`. Improvements: broader language
coverage where the installed parser supports it, reusable query references, and
explicit multi-file transactions with stale-file checks and atomic rollback.

For filesystem tools, the most useful additions are artifact handles, bounded
read windows, and atomic multi-file edits with a reviewable diff. Extend the
harness around the SDK instead of forking package implementations.

## Recommended order

1. **Fix discovery first.** Make cyber_tools describe every wired tool and its
   actual readiness, examples, input requirements, and output artifacts. Agents
   should not have to guess names or shell out to discover capability.
2. **Make jobs manageable.** Start/cancel/progress/result cursors are especially
   valuable for scans, callbacks, and long-running tasks. Keep concurrency bounded.
3. **Make results composable.** Shared artifact IDs and typed observations let an
   agent pass host lists, request references, and finding IDs to the next tool
   without copying large text blobs. Retain source attribution and timestamps.
4. **Expose useful typed knobs.** Prioritize adapter-specific filters listed
   above over expanding generic raw CLI passthrough.
5. **Strengthen stateful HTTP/mail workflows.** Cursor-based inbox reads and
   explicit HTTP payload/response artifacts remove common sources of guesswork.
6. **Improve targeted research retrieval.** Explicit GitHub search kinds and
   knowledge hit retrieval provide immediate utility with relatively small changes.
7. **Add browser event artifacts.** Popup/download/dialog handling and structured
   page snapshots are the next browser improvements after this change.

The six accepted summary groups have been implemented: discovery, manageable
jobs, shared artifacts, HTTP/mail workflows, research retrieval and browser event
controls. The remaining per-tool enhancements above are still proposals. No
external scanner, inbox or GitHub operation was invoked for the inventory or
fixture verification. The existing [149-candidate research catalog](TOOLS.md) remains
a separate research list, not a list of model-callable tools.

## Inspection sources

- [Harness registration](../src/index.ts), [adapter registry](../src/adapters/index.ts),
  [tool implementations](../src/tools), [runner](../src/jobs/runner.ts).
- [Boot stack](../src/boot.ts), [profile package wiring](../config/cyber/settings.json),
  [optional AST registration](../src/ast-extension.ts), [launcher](../scripts/pi.sh).
- Installed SDK extension loading and package tool definitions were inspected
  directly; package tools are activation-dependent and third-party provider
  capabilities were not exercised.
