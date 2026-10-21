# Pi Cyber Harness — deeper design proposal

Research date: 2026-10-21. Status: research and design only. No Pi, browser, scanner, REA provider, or target environment was installed or executed. This document supersedes the initial [research plan](RESEARCH-PLAN.md).

## Product decision

Build a specialized cyber harness through **Pi extensions**, skills, native tools, and MCP integrations. Pi supplies the agent runtime and terminal interface. Our package supplies the cybersecurity experience. No Pi fork, replacement agent runtime, or general-purpose customization suite is proposed.

The user works through one coordinator backed by specialist agents. Two explicit modes — **offense** and **defense** — have separate task instructions, role rosters, tool capabilities, and workflow state. Both can use reconnaissance, scanning, a browser, reverse engineering, and research. The mode determines the purpose and action contract, not whether a tool's name sounds offensive.

The core user flows are:

- Offense: objective → discovery → deep enumeration → active probing → exploit validation and attack-path chaining → objective/post-access investigation → impact evidence and report.
- Defense: assets/source/artifacts → probing and scanning → triage → root cause → reviewed remediation → retest → regression/detection evidence.

Switching mode is deliberate. It does not change target scope, grant new credentials, or convert every discovered host into an approved target.

## Research artifacts

- [Recon and web tool research](research/RECON-WEB-TOOLS.md).
- [Defense, cloud, identity, and exercise tools](research/DEFENSE-CLOUD-IDENTITY-TOOLS.md).
- [Obscura, REA, and analysis tools](research/BROWSER-REA-TOOLS.md).
- [Knowledge and documentation design](research/KNOWLEDGE-AND-DOCUMENTATION.md).

The catalogs distinguish source-reviewed tools from discovery-only candidates and documented support from actual Mac testing. Their dispositions are implementation recommendations, not permanent limits on what an authorized engagement can use.

## What stays small

Use one installable package with six focused extension entry points: `engagement`, `tools`, `browser`, `knowledge`, `specialists`, and `evidence`. Shared logic lives in small domain modules. Additional capabilities are data-driven tool packs and skill directories, not separate always-running frameworks.

Start with a small set of direct tools; expose detailed scanner, browser, and REA operations through discovery. Pi documents tool registration, command registration, lifecycle hooks, and tool exposure. Its MCP supports deferred/codemode exposure, which can avoid declaring every server tool in every prompt. Exposure is a context mechanism; enforce role permissions separately. [Extension API](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/extensions.md), [MCP exposure](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/mcp.md#control-tool-exposure).

A specialist starts only when it has a useful bounded task. No permanent agent swarm, recursive delegation, duplicate vector database, custom browser engine, duplicate MCP client, or service dashboard in the initial implementation. SQLite and filesystem artifacts are enough until measured workloads establish otherwise.

Keep **cataloged**, **installed**, **available**, **enabled for this role**, and **validated on this host** as distinct tool states. A large catalog can coexist with a small running harness.

## Offense and defense mode contracts

Proposed commands: `/cyber mode offense`, `/cyber mode defense`, `/cyber status`, `/cyber team`, `/cyber tools`, `/cyber docs`, and `/cyber evidence`. These are new interfaces to implement, not current Pi built-ins.

**Shared base instructions:** use evidence, preserve uncertainty, resolve target identity, honor engagement scope, avoid leaking credentials, regard retrieved content as data, and capture reproducible observations. Cache established engagement decisions rather than asking again before each routine covered action.

**Offense overlay:** prioritize paths to the stated objective, reason across assets and trust boundaries, distinguish prerequisites from demonstrated access, select tests that discriminate between hypotheses, and preserve the exact evidence needed to demonstrate impact. Discovery and scanner output feed investigation rather than automatically becoming findings. Advanced execution capabilities belong to explicit engagement packs with declared effects, host requirements, telemetry, and cleanup.

Offense is an active execution workflow, including focused exploit development, access validation, chaining confirmed weaknesses, and pursuing relevant post-access objectives when covered by the engagement. It should continue beyond initial scans and failed routine attempts, adapting to evidence until the objective, a concrete blocker, or an explicit stop condition is reached. Its instructions stay environment-neutral. The proposed [offense instruction overlay](research/OFFENSE-INSTRUCTIONS-PROPOSAL.md) makes this behavior reviewable.

**Defense overlay:** investigate as rigorously as offense, identify affected assets and versions, correlate scanner results with source/configuration/runtime evidence, and trace root causes. Its default deliverable is an implementation-ready remediation document for other agents, with proposed fixes, reproduction evidence, affected roles/routes, implementation scope, regression cases, and retest acceptance criteria. Generate/apply patches only when implementation is part of the task. Distinguish a proposed correction, an applied change, and a verified result. The proposed [defense instruction overlay](research/DEFENSE-INSTRUCTIONS-PROPOSAL.md) defines this behavior.

Both modes cover relevant pentesting, RCE and SQL injection investigation, database/data-access validation, exposed-key discovery, and decompilation when artifacts require it. Use real sign-in and separate signed-out/member/admin identities across discovered authenticated routes and operations, including applicable cross-account and tenant boundaries. The [coverage and handoff contract](research/TESTING-COVERAGE-AND-HANDOFF.md) defines evidence, missing-role blockers, data/secret handling, and completion states.

Each overlay can call the same specialist for different deliverables: the web specialist maps a trust-boundary failure in offense and verifies the corresponding access-control fix in defense. The reverse engineer explains shipped behavior in both modes; a source reviewer handles an available complete source repository normally.

Provision the instruction layers explicitly: a dedicated `PI_CODING_AGENT_DIR`, a short shared `AGENTS.md`/appended system layer, a selected mode overlay, and one role brief per worker. Task-specific skills load on demand. Use explicit resource loading for workers so unrelated personal skills, target-provided instructions, or project extensions do not silently expand their tools and responsibilities. The role policy checks actual tool execution, including indirect/MCP routes; merely changing the advertised list is insufficient.

Keep the terminal experience compact: a footer shows mode, engagement, active specialists, running jobs, and remaining budget. A `/cyber team` view shows each worker's question, state, evidence produced, and blocker. The analyst can steer or cancel a task without opening a collection of separate terminals.

### Safe mode transition without pretending it is a sandbox

Proposed transition: stop scheduling → cancel or drain current jobs → resolve uncertain side effects → checkpoint evidence → release browser/native session leases → apply the new instruction/tool/role policy → display the new state. Refuse a silent transition while an active worker owns a mutable target session.

Persist the mode with each task/job/finding event, not only in a prompt. On resume, restore the stored engagement mode. Revoking a capability cancels existing leases; hiding its schema alone is insufficient. Mode-specific settings and prefixes are organizational controls; all native processes still have the operating-system permissions of the account that launched them. [Pi security model](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md).

### Red offense and blue defense themes

Bundle `cyber-offense` and `cyber-defense` theme resources. Offense uses red accents; defense uses blue accents. Keep the base reading surface neutral and retain meaningful success/error/warning distinctions. Show OFFENSE or DEFENSE in the header/footer and terminal title so color is supplementary.

Pi's extension UI exposes `getTheme` and `setTheme`; themes are distributable resources. [Release API types](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/src/core/extensions/types.ts), [theme documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/themes.md). Preflight the selected theme before switching, apply it with the policy transition, and restore it on reload/resume. Report a failed theme change explicitly and do not launch work under a misleading visual state. Headless sessions retain mode metadata without requiring terminal rendering. Test dark/light terminals, reduced-color output, and retained mode labels.

## Specialist team

Use one coordinator and a roster of on-demand specialist roles. The implementation should support all roles below; it need not start them together or require a different model for every role.

| Role | Primary responsibility | Typical tools and output |
|---|---|---|
| Recon analyst | Asset provenance, passive sources, DNS/HTTP inventory, surface changes | uncover, Subfinder, dnsx, httpx; attributed asset records and unresolved ownership questions |
| Web/API analyst | Browser/traffic mapping, role matrices, sessions, API trust boundaries | Obscura, Burp, Katana, selected checks; reproducible request/response and identity-bound observations |
| Vulnerability researcher | Product/version/advisory matching and check selection | vulnx, official advisories, docs search; affected-version rationale and validation candidates |
| Validation analyst | Corroborate candidate findings with the smallest useful test | Nuclei, Interactsh, protocol clients; confirmed/rejected/unknown outcome with limitations |
| Offensive operator | Develop and validate active paths; chain supported weaknesses toward the objective | Engagement-enabled native tools, focused validation code, browser/REA evidence; demonstrated access, effects, and next-step prerequisites |
| Source and remediation engineer | Trace code/configuration root causes; develop reviewable fixes | Normal source tools, Semgrep, dependency scanners, tests; patch plus retest evidence |
| Reverse engineer | Explain shipped binaries/packages and static/runtime relationships | REA and appropriate engines; Evidence IDs, hypotheses, unknowns, exports |
| Cloud/identity analyst | Configuration, IAM, directory, and trust relationships | Approved cloud/LDAP clients and selected posture tools; permission and relationship evidence |
| Detection/DFIR analyst | PCAP/log/artifact triage, timelines, detection validation | TShark, YARA, Sigma tools, selected collection interfaces; source-linked timeline and detection gaps |
| Exercise planner | Offense objectives, dependencies, ATT&CK mapping, expected telemetry, cleanup | Reference corpus and available engagement packs; explicit action plan and coverage ledger |
| Evidence reviewer | Independently challenge confidence, impact, missing data, and report claims | Read access to records and artifacts; objections and confirmation requirements |

The coordinator stays responsible for integration. Specialists return proposals and evidence references; the coordinator validates state changes through one write service. A reviewer should not merely repeat the producing agent's summary.

### Worker runtime and task contract

First evaluate **pi-subagents as the worker engine**, with our cyber extension owning role definitions, mode admission, engagement records, and evidence contracts. Its documented integration API provides structured delegation, preflight, capability ceilings, and lifecycle controls. Its foreground children run in the parent process; background children use a detached runner. Do not describe all workers as separate processes. Write an SDK-backed runner only if a required contract cannot be met through the selected package's supported integration points. Neither arrangement is OS isolation. [pi-subagents](https://github.com/nicobailon/pi-subagents), [integration API](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md), [Pi SDK](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/sdk.md).

Proposed task input fields: `taskId`, `engagementId`, `mode`, `role`, `question`, `scopeRevision`, `assetIds`, `evidenceIds`, `allowedCapabilities`, `credentialRefs`, `sessionLease`, `outputSchema`, `budget`, and `stopConditions`.

Proposed result fields: `status`, `observations`, `inferences`, `evidenceRefs`, `sourceRefs`, `candidateFindings`, `negativeResults`, `coverageLimits`, `proposedNextSteps`, `usage`, and `sideEffects`.

Validate outputs before merging. Bound time, model/tool usage, concurrent jobs, and result size. Start with at most two workers plus the coordinator; tune after measuring memory on the Mac. These are proposed starting limits, not capacity claims.

Choose a strong model for planning, ambiguous analysis, and review; permit a cheaper model for constrained research/normalization after it passes the same evaluation cases. Role isolation and evidence quality matter more than branding the setup as many models. No provider is selected yet.

### What runs in parallel

Parallelize independent work: official-document research, advisory/version checks, analysis of different assets within shared traffic budgets, static review of separate modules, and independent evidence review. Keep dependent validation steps sequential. One worker writes a given patch/worktree; one worker owns a mutable browser page, test identity, or REA session. The coordinator merges results through the evidence service.

Installing a delegation package makes workers available; our base instructions and task scheduler must actually request useful delegation. Start with two concurrent specialists, a bounded total child count, and no recursive spawning by default. Measure speed, cost, and result quality before raising limits. More agents are not automatically a better investigation.

## Deep research and reusable Pi packages

Deep research is a shared workflow available inside either offense or defense mode, not permission to execute tests. Proposed entry point: `/cyber research deep <question>`.

1. Define the question, target software/version context, needed evidence, privacy constraints, and completion criteria.
2. Split independent questions among a small research team: standards/vendor documentation, current advisories/version applicability, implementation/source behavior, and counterevidence.
3. Search and retrieve original passages; preserve source URLs, revisions, timestamps, and bounded excerpts. Fetch full relevant sections before relying on search snippets.
4. Build a claim ledger: supported, contradicted, inferred, outdated, or unresolved. Distinguish reference guidance from target observations.
5. Send material claims to a separate evidence-auditor with access to original sources and an explicit instruction to challenge them.
6. Produce a cited answer, disagreement/coverage notes, and proposed validation steps. Store useful references in the knowledge layer. Running those steps is a separate task under the existing mode and engagement contract.

Package decisions are conditional on a pinned compatibility test, not install instructions:

- **pi-subagents:** preferred candidate for reusable parallel worker mechanics; customize cyber roles and bound its capabilities.
- **pi-web-access:** preferred candidate for live public search/fetch. Configure provider routing and child access deliberately; keep Obscura as the target interaction browser.
- **Feynman:** useful deep-research workflow and reference implementation. Evaluate selected research resources rather than loading its complete academic/experiment environment into the cyber core.
- **pi-btw:** optional analyst side conversation. Favor its read-only ask route for quick questions; a side conversation with coding tools is not a constrained specialist task.
- **billion-context:** optional later compression experiment. It does not increase the model's native context window and cannot replace canonical evidence storage.
- **KXM:** evaluate if durable cross-harness messaging/workflows become a real requirement. It adds a local hub/runtime and model-routing policy beyond the initial Pi-only worker requirement.
- **bigpowers:** optional selected engineering skills for remediation work, not the default assessment methodology or orchestration engine.

Avoid loading multiple competing coordinators or compaction layers. Pin the resolved dependency graph: Feynman's inspected manifest already includes pi-subagents, pi-web-access, and pi-btw; dependency installation is different from loading those resources in a parent or child Pi session. [Feynman manifest](https://github.com/Companion-Inc/feynman/blob/main/package.json). Detailed findings and version boundaries are recorded in the package research reports listed in the [research index](research/README.md).

## Obscura browser integration

Use the requested Obscura as the default agent browser. Upstream documents a macOS Apple Silicon binary, V8 execution, CDP, and independent rendering. Its advertised speed/memory comparisons are not benchmarks for this harness. [Obscura](https://github.com/h4ckf0r0day/obscura).

Use its existing stdio MCP surface for navigation, compact snapshots, interactions, extraction, screenshots, and diagnostics. Create a thin Pi integration for session ownership and evidence capture rather than recreating those tools. Reserve a CDP connection for interception or integration features that the MCP interface cannot express. [Obscura MCP](https://github.com/h4ckf0r0day/obscura/blob/main/docs/Use-the-MCP-server.md), [CDP request interception](https://github.com/h4ckf0r0day/obscura/blob/main/docs/Intercept-and-modify-requests.md).

### Browser session ownership

Identify a browser session by engagement, mode, role identity, purpose, and engine revision. Documentation research uses a separate session from target assessment. Different application accounts use separate processes/storage directories; a child agent leases a session rather than taking over another worker's active page.

Upstream states CDP sessions can share persisted storage and recommends separate processes/directories for independent profiles. Cookies/localStorage persistence differs from sessionStorage and IndexedDB durability. Persisted profile files are sensitive artifacts, not ordinary report attachments. [Storage behavior](https://github.com/h4ckf0r0day/obscura/blob/main/docs/Persist-cookies-and-storage.md).

For each browser action, capture current page identity, identity alias, action summary, relevant network records, engine version, and evidence references. Collect focused screenshots when visual evidence matters. Redact tokens before sending diagnostic data to the model. A partial failure is not permission to blindly repeat a form submission.

Obscura's default private-address protection needs an explicit per-session setting for local/internal assessment. That setting allows an address class, not just our target, so keep the engagement policy separate. Declare required support origins for SSO/CDNs without granting those origins scanning permission. [Network settings](https://github.com/h4ckf0r0day/obscura/blob/main/docs/Environment-variables.md).

### Browser fidelity and REA interoperability

Test snapshots, JS navigation, forms, redirects, cookies, storage, proxying, and network evidence on fixtures. Security conclusions involving browser-enforced policy require validation in the relevant production browser when Obscura's behavior has not been established. An independent engine's result does not prove Safari/Chromium behavior.

The browser research found no established Obscura compatibility for REA's active Chrome-family scenario workflow. Use Obscura for ordinary agent browsing; evaluate passive CDP attachment separately. Any REA workflow requiring a particular runtime keeps that requirement visible. Do not hide a second browser download inside REA setup.

## Native tools: breadth through packs

Maintain a broad tool catalog with exact upstream identities. Each pack declares optional native dependencies, versioned adapter definitions, expected artifacts, supported hosts, and specialist roles. Review the research catalogs before choosing the default install set.

The first-class discovery/validation family should include **uncover, Subfinder, dnsx, httpx, Katana, Nmap, Nuclei, Interactsh, and vulnx**. Most run in both modes, with different task objectives and budgets. Prefer ProjectDiscovery's vulnx, the vulnerability intelligence CLI, for the requested vulnx integration; other projects named VulnX remain distinct candidates. [vulnx](https://github.com/projectdiscovery/vulnx).

Other packs cover content discovery, HTTP proxies, source/supply-chain review, cloud/IaC, identity/network protocols, detection/DFIR, and reverse engineering. A tool's availability in a catalog does not force its installation. Avoid enabling three overlapping crawlers or scanners by default; let the registry explain alternatives and when they add value.

### Adapter contract

Each adapter records canonical project/package, executable path and digest, version probe, architecture, input schema, argument builder, parser schema, artifact formats, network behavior, credential needs, operational effects, cancellation behavior, and compatibility fixtures.

Spawn a fixed executable with argument arrays. Keep large target lists and outputs in bounded artifact files, not prompts. Parse JSON/JSONL/XML/SARIF where supported; do not use an LLM to parse deterministic output first. Keep original stdout/stderr plus the normalized result and parser version. Report partial output, unsupported formats, empty results, and parse failure as different outcomes.

Provide a generic native job escape hatch for expert work, clearly marked as outside typed-adapter guarantees. It must preserve command provenance and evidence; never claim shell-string filtering provides complete scope enforcement.

### Specific additions requested

**uncover:** inventory from external search providers. Preserve provider/query/fetch time and API scope. Search results propose assets; current reachability, ownership, and permission remain separate checks. API keys and provider quotas belong to the service configuration. Querying a provider can disclose the search terms. Adapter details follow upstream research. [uncover](https://github.com/projectdiscovery/uncover).

**vulnx:** vulnerability-data enrichment and affected-version research, separate from target scanning. Correlate intelligence with observed product/version evidence and retain uncertain matches. Its JSON output fits the research specialist. Optional authentication and service limits must remain visible. [vulnx](https://github.com/projectdiscovery/vulnx).

**Interactsh:** treat out-of-band interactions as an asynchronous evidence workflow. Allocate a correlation identifier bound to engagement, test, and finding candidate; retain request timing and bounded polling state; resume collection after a coordinator interruption. A callback is evidence of an observed interaction, not automatically proof of a particular vulnerability. No callback before a timeout is inconclusive. Self-hosted server deployment is a separate infrastructure decision from installing the Mac client. Inspect upstream options before defining exact persisted-session behavior. [Interactsh](https://github.com/projectdiscovery/interactsh).

### Job scheduling

Use durable job IDs and a state machine: queued, running, succeeded, failed, cancelled, interrupted, and outcome-unknown. Key launch requests so retries do not duplicate an active job. Store scope revision and mode at launch; reject stale queued work after a policy change.

Apply per-engagement, per-host, and per-provider budgets; aggregate across workers. Separate passive data queries from target requests. Preserve partial artifacts and stop process groups on cancellation. Do not automatically replay uncertain state-changing tests after restart. Make scanner template/rule updates explicit and record their digests.

## REA as a first-class specialist capability

Include the requested [reverse-engineer-anything skill](/Users/marban/.agents/skills/reverse-engineer-anything/SKILL.md) with a version-matched REA connection. The skill is workflow guidance; the server and analysis engines are separate components. Pin a tested skill/server pair rather than assuming repository main matches an older package.

REA documents Pi setup and respects `PI_CODING_AGENT_DIR`. Implementation should preview changes under the dedicated cyber configuration directory, preserving existing settings. Use the server's live capability schemas and availability reports. Do not run readiness/setup before every task. [Pi-specific setup](https://github.com/morluto/rea/blob/main/docs/client-configuration.md#pi).

Route supplied artifacts by type: native binaries to a selected provider; JS/Electron trees to static JS analysis; managed assemblies and Android packages to their specific tools; archives to inventory; retained network captures to offline inspection. A complete source repository follows normal source analysis unless a shipped artifact or runtime comparison is needed.

Plan the Mac baseline around supported static package/JS routes plus **Ghidra with a matching native arm64 full JDK and decompiler** as the proposed noncommercial deep-analysis route. Current upstream installation documentation records an end-to-end Apple Silicon path using Ghidra 12.1.4 and JDK 21. That resolves the earlier main-branch documentation conflict for planning; compatibility with the exact REA release still needs a real local fixture test. Hopper and an existing licensed IDA setup remain alternatives. A historical REA issue documents a healthy doctor result despite a Rosetta JDK mismatch, so readiness alone is insufficient proof. No tool-count claim implies every format works on this Mac. [Ghidra installation evidence](https://github.com/morluto/rea/blob/main/docs/installation.md#macos-arm64-native-decompiler), [JDK mismatch report](https://github.com/morluto/rea/issues/2785).

One worker owns each mutable REA session. Record artifact digest, provider, analysis profile, Evidence IDs, and limitations. Export bundles into engagement evidence storage; map local REA IDs to durable engagement IDs so reports survive session cleanup. Use summary-first paging for large analyses. Close owned native sessions when finished. Static observations, inferred behavior, and runtime observations remain distinct. [REA](https://github.com/morluto/rea), [provider research](research/BROWSER-REA-TOOLS.md).

Firmware extraction, foreign-platform runtime behavior, and memory acquisition can require a different host or external tools. Keep those capabilities discoverable as unavailable or platform-specific rather than pretending all can execute natively.

## Knowledge layer

Implement the [documentation design](research/KNOWLEDGE-AND-DOCUMENTATION.md): local versioned reference packs, live authoritative reads, and labeled community research. Initial packs cover OWASP WSTG/ASVS/Cheat Sheets/API/MAS, ATT&CK, CWE, severity methodology, tool documentation, and vulnerability intelligence.

Use official source Markdown/APIs first, ordinary HTTP extraction second, Obscura for dynamic pages. Stack Overflow and Security Stack Exchange use the documented API with source attribution and version checks. Community posts and Reddit identify candidates and workflow problems; upstream docs establish tool contracts. Public research must not leak private engagement identifiers or evidence.

Show reference coverage and failed syncs. Add sources through a registry and selected ingest jobs, not by stuffing every document into the permanent prompt. Begin with local full-text/exact-ID search; add embeddings only after retrieval evaluation shows a need.

## Engagement and evidence model

Use one SQLite database per engagement and restricted artifact directories. Proposed entities: engagement, scope revision, asset, relationship, task, job, browser session, native analysis session, observation, evidence, hypothesis, finding, remediation, retest, documentation citation, and append-only event.

An observation references evidence. A hypothesis references observations and tests. A finding references its validation and impact evidence. A remediation references a finding and proposed/applied changes. A retest links the change to the procedure and result. Negative results and unknown coverage are first-class records.

Keep raw and sanitized artifacts separately; preserve hashes and provenance. Hashes detect changes against a recorded value but do not make user-writable records tamper-proof. Restrict credential/profile data, define retention, and record model-provider data disclosure settings.

The coordinator reconstructs its working brief from these records after compaction or restart. Specialists get only the evidence needed for their tasks. Public documentation cache is shareable across engagements; private evidence and browser state are not.

## Concrete behavior examples

**Offense:** the recon analyst retrieves candidates from uncover and passive sources, resolves scope, then inventories HTTP services. A web analyst maps a supplied test account's flows in Obscura. The researcher checks product/version hypotheses with vulnx and official sources. Validation runs selected checks and correlates any Interactsh observations. The evidence reviewer challenges impact before a finding is confirmed.

**Defense:** supplied source and an asset inventory feed scans and manual triage. The remediation engineer traces a candidate to an affected code path and prepares an implementation dossier with fix guidance and a relevant retest procedure. When separately tasked with implementation, a worker produces the diff and the validation specialist repeats the relevant probe. A detection analyst determines whether available logs would reveal that behavior. The final record distinguishes a proposed fix, an applied fix, and a verified result.

**Binary assessment:** a supplied package is identified and hashed. The RE specialist selects the right REA route and traces a specific security-relevant feature. Browser or runtime evidence is added only when the actual runtime is available and required. Its output can support either an offense hypothesis or a defensive hardening change.

## Delivery plan and acceptance

### Milestone 0 — compatibility decisions

Pin Pi, supported Node, Obscura, REA skill/server, and initial tools. Confirm normal-terminal PATH, Apple Silicon builds, licenses, optional credentials, model provider, and available native analysis engine. Preserve a source/version manifest and explicit unsupported capabilities.

Acceptance: documented version matrix and dependency plan, including browser and REA uncertainties. No claim of tested compatibility before tests run.

### Milestone 1 — lean cyber harness and two modes

Create the extension package, dedicated configuration directory, base instructions, offense/defense overlays, red/blue mode themes, engagement/evidence schemas, and two on-demand specialist roles. Implement cancellation, budgets, tool authorization, and mode transitions first.

Acceptance: each worker gets the intended tools/resources, a mode switch cannot leave stale work running, the accent and text label agree with the active policy, task results merge transactionally, and a restart restores the brief and theme.

### Milestone 2 — browser and research available to the team

Connect Obscura stdio MCP, isolated identity/profile sessions, session leases, evidence capture, core OWASP/reference importers, full-text search, and community/API retrieval.

Acceptance: two workers cannot race one current page; different identities stay distinct; JS documentation is readable; citations retain version/page/section; missing coverage and retrieval failures are explicit.

### Milestone 3 — recon and vulnerability intelligence

Integrate uncover, Subfinder, dnsx, httpx, Nmap, vulnx, and asset correlation. Implement the job registry and provider quota accounting against controlled fixtures.

Acceptance: inventory is attributed and deduplicated, exclusions and host/IP permission distinctions work, third-party results are not treated as confirmed live assets, and interrupted jobs do not silently repeat.

### Milestone 4 — web validation and asynchronous evidence

Add Katana, Nuclei template selection, Interactsh correlation, Burp integration, and web/validation/reviewer roles. Evaluate proxy alternatives without enabling overlapping stacks by default.

Acceptance: scanner candidates remain unconfirmed until supported; callback evidence is correlated and survives restart; no-callback timeouts remain unknown; browser and HTTP evidence link to the same test identity.

### Milestone 5 — defense scan, fix, and retest

Add source/supply-chain tools, remediation roles, report importers, focused patch workflows, and retests. Add cloud/identity and detection/DFIR packs according to the catalog priorities and available environment.

Acceptance: the harness produces a reviewable change and a relevant before/after check; it does not confuse version matching with exploitability or a report recommendation with deployment.

### Milestone 6 — REA and deeper specialist packs

Complete REA routing, engine verification, evidence export, session leases, and binary/JS/package fixtures. Add exercise planning and environment-specific offense/defense capabilities without expanding the permanent core.

Acceptance: source-only questions avoid unnecessary decompilation; unsupported providers report limits; evidence IDs remain resolvable after closure; static analysis never masquerades as execution proof.

REA can be brought forward when binary assessment is the first actual use case; the dependency order above prioritizes testing the shared task/evidence plumbing first.

## Evaluation before calling it specialized

Maintain controlled cases for both modes: a seeded web/API issue and fix; misleading scanner output; a version-mismatch advisory; negative OAST observation; cross-role browser contention; multi-account isolation; malicious documentation instructions; a partial job failure; worker timeout; cancelled mode transition; interrupted mutation; binary provenance; and a large REA result that requires paging.

Measure supported findings, false confirmations, evidence/citation completeness, useful next-test selection, successful retests, context size, latency, memory, and cost. Establish the baseline on the actual Mac. Compare added tools and agents against a simpler baseline; remove integrations that add overhead without demonstrated coverage or reliability.

## Open choices

The design incorporates the selected Mac-native execution model, extensions rather than a fork, Obscura, REA, specialist agents, and separate offense/defense modes. Remaining implementation choices are model/provider budget, first real assessment scenario, Burp/Caido availability, native engine license/preferences, passive-provider access, and evidence retention. These do not prevent the current research and design work.

No installation or implementation is authorized by this design document alone. All capability and performance acceptance remains to be demonstrated.
