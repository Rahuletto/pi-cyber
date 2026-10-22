# Agent Tool Improvements Implementation Plan

> For agentic workers: use subagent-driven-development. The user explicitly approved the recommendations and requested Luna subagents. Implementation used scoped file ownership in the shared dirty checkout; the user subsequently authorized committing and pushing the completed work.

**Goal:** Implement the six improvement groups accepted in the conversation and retain existing browser capabilities.
**Architecture:** Keep existing tool names and backward-compatible actions. Add bounded, typed actions around current local implementations. Preserve state ownership, cancellation correctness, artifact provenance and secret-handling boundaries. Avoid edits to installed third-party packages.
**Tech stack:** Bun, TypeScript, TypeBox, SQLite, Playwright-compatible CloakBrowser, installed CLI binaries.
**Spec:** docs/TOOL-CAPABILITIES.md, particularly Recommended order; the accepted scope is the six summary recommendations in the conversation.

## Constraints

- Luna implementation/review subagents, with precise prompts and exclusive file ownership.
- Keep all pre-existing dirty browser changes. Implementation workers did not commit or push; the user's subsequent commit/push request authorizes the final publication step. No resets, installs, external messages, or live third-party scanning/signups.
- Tests use local fixtures, synthetic subprocesses, and isolated data roots; actual browser smoke uses temporary profiles.
- No fabricated credential/runtime verification. Preserve original request bytes for transport; never replay uncertain mutations.
- Existing synchronous actions remain usable. New asynchronous work must expose cancellation, bounded progress and results.
- Keep a record of completed tasks and exact checks in the ledger below.

## Task 1: Complete discovery

Own src/tools/cyber-tools.ts and focused tests only. List all actual ctx.tools, add name/capability filtering and bounded schema/description inspection using runtime registry data. Preserve readiness action and distinguish registration from executable/credential/runtime proof. Add examples only where supported by real tool contracts.

- [x] Implement with focused failing tests, run relevant tests, report changed files.
- [x] Independent spec/quality review and fix verified issues.

## Task 2: Precise research retrieval

Own src/tools/github.ts, src/tools/knowledge.ts, src/knowledge/fts.ts and focused tests. Replace GitHub query-space guessing with explicit search kind (repos/issues/code); add ref selection, bounded pagination and PR diff retrieval. Add knowledge fetch by search-hit ID with bounded windows and provenance. Preserve source restrictions, redaction and explicit index rebuild semantics.

- [x] Implement and test with local/mock upstream contracts.
- [x] Independent spec/quality review and fix verified issues.

## Task 3: Shared artifacts and manageable jobs

Own src/jobs, src/tools/jobs.ts and new artifact module; coordinate before touching src/evidence/db.ts or tool registration. Keep run/status/list compatible; add async start/cancel/progress/result retrieval with real process cancellation and bounded concurrency. Implement durable opaque artifact references, content hashes and bounded text/binary read APIs reusable by HTTP and browser tools. Publish exact exported interfaces for downstream agents before they integrate.

- [x] Implement cancellable async jobs and artifact lifecycle with isolated subprocess/filesystem tests.
- [x] Independent spec/quality review and cancellation/isolation audit.

## Task 4: HTTP and inbox workflows

Own src/tools/bypass-fetch.ts, src/tools/mailgen.ts, new associated helper modules and focused tests. Reuse Task 3 artifact interfaces for binary responses and explicit upload bodies. Add typed multipart/file inputs without shell interpolation, response headers/redirect provenance, preserving transport bytes. Add stable mail message/cursor semantics and sender/subject/time filters using installed provider capabilities; never invent an upstream message API. Separate list/read-by-ID availability from providers that support only first-message waits.

- [x] Implement and test through local/fake binaries/provider fixtures; report provider limitations honestly.
- [x] Independent spec/quality review and mutation-replay audit.

## Task 5: Browser event workflows

Own src/tools/browser*.mjs/.ts plus browser tests/docs, after browser acceptance returns. Resolve acceptance findings, then add bounded structured DOM snapshots, popup/dialog/download handling and explicit network artifact capture. Reuse Task 3 artifacts for exports. Keep Turnstile recovery isolated and normal explicit tab semantics intact.

- [x] Implement and test local fixtures; run real browser smoke.
- [x] Independent spec/quality review.

## Task 6: Integration and final verification

Own registration/schema integration and docs. Expose artifact retrieval through an existing or explicit typed tool surface, update capability documentation around actual shipped actions and limitations. Run the full suite/typecheck serially after agents finish; independent review of all changes, then fix and scoped re-review.

- [x] Integrate shared interfaces and documentation.
- [x] Full tests, typecheck, diff check and real browser smoke.
- [x] Final independent review and verified corrections.

## Execution ledger

- Initial state: browser implementation already modified/untracked, 316 pass / 4 skip, typecheck and local live smoke passed. Browser acceptance subagent already running read-only.
- Ruling: Keep the shared dirty checkout and exclusive ownership instead of isolated worktrees — the implementation under test is uncommitted and worktrees would omit it — incorrect ownership would risk conflicts, mitigated by explicit file boundaries and sequential integration.
- Scope interpretation: Implement the six accepted summary groups, not every speculative per-tool enhancement in the 149-candidate research catalog. Preserve proposals beyond those groups for later decisions.
- Dispatch: discovery_impl (gpt-6-luna), research_impl (gpt-6-luna), jobs_artifacts_impl (gpt-6-luna), all with exclusive paths and focused-test ownership.
- Independent browser acceptance completed: real registered-tool workflows passed; synthetic replacement token at 2.126s and no-navigation completion at 10.787s. Confirmed P2: dedicated Turnstile renderer drops token-page finalUrl/tabId/screenshot metadata. Include fix in Task 5.

- Final verification: 343 tests passed, 4 skipped, 0 failed; typecheck and diff checks clean. Independent Luna reviews approved fixes. Actual local HTTP and installed-browser smokes passed in root verification. The user subsequently requested committing and pushing all completed work with a clean Git checkout.
