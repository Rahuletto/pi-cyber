# Search and compaction integration for the Pi harness

Reviewed 2026-10-21 against the current Pi documentation/source and the current `pi-web-access` package page. This is a documentation/source review only; no extension was installed or exercised. Pi docs marked `latest` and a package listing can move independently of Pi 1.3.0 or a pinned package artifact, so confirm the corresponding API in the exact Pi 1.3.0 package before implementation.

## Pi compaction APIs and native settings

Use Pi's native compaction controls first. `~/.pi/agent/settings.json` or `<project>/.pi/settings.json` accepts:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

These are the documented defaults. Auto-compaction starts when context tokens exceed the active model context window minus `reserveTokens`; `keepRecentTokens` controls how much recent history stays verbatim. Model-specific `compaction.modelOverrides` can override either field. Manual `/compact [instructions]` remains available when automatic compaction is disabled.

The extension event for native auto/manual compaction is `session_before_compact`:

```ts
pi.on("session_before_compact", async (event, ctx) => {
  const {
    preparation,       // messagesToSummarize, turnPrefixMessages,
                       // previousSummary, fileOps, tokensBefore,
                       // firstKeptEntryId, effective settings
    branchEntries,     // all entries on the current branch
    customInstructions,
    reason,            // "manual" | "threshold" | "overflow"
    willRetry,
    signal,
  } = event;

  return {
    compaction: {
      summary: "...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: { schema: 1, /* JSON-serializable extension state */ },
    },
  };
});
```

Returning `{ cancel: true }` cancels compaction. Returning `compaction` supplies the compaction result and replaces the normal Pi summary generation. `session_compact` fires on success with `compactionEntry`, `fromExtension`, `reason`, and `willRetry`. `session_compact_failed` reports `reason`, optional `errorMessage`, `aborted`, `willRetry`, and `fromExtension`. On overflow recovery, `willRetry` tells the extension that Pi will retry the aborted turn after successful compaction; cancellation/failure prevents that internal retry.

The `context` extension event runs before each provider request and can filter or transform conversation messages. `context_with_system` runs afterward over the full transcript including system messages, and its returned message list is the request context. These are prompt construction hooks, not durable storage hooks. Use `session_before_compact` to make native compaction decisions, and use the compaction entry or a separately versioned durable store for saved state.

For durable structured state, place a small, versioned JSON-serializable object in the custom compaction entry's `details`. Pi persists this as metadata on the `CompactionEntry`; subsequent `session_before_compact` events can inspect `branchEntries` to carry it forward. `details` is not automatically placed in the model prompt, so include the essential current state in `summary` in readable form as well. Prefer stable facts, IDs, status, decisions, and next actions; keep large evidence and full records in append-only files/artifacts and summarize references and hashes in the prompt. Pi's native summary sections are Goal; Constraints & Preferences; Progress (Done, In Progress, Blocked); Key Decisions; Next Steps; Critical Context. The default Pi summary also tracks read/modified files, but extensions that provide summaries own their `details` structure.

`firstKeptEntryId` and `tokensBefore` should be passed through unchanged from `preparation`. The session format requires `firstKeptEntryId`; the compaction summary replaces older summarized context while messages from this boundary onward remain. For split user-message spans, include `turnPrefixMessages` in custom summary logic as appropriate; `messagesToSummarize` may be empty in that case. Bind any external state to the session/case identity and branch, and make writes atomic/versioned so a failed or interrupted compaction cannot leave a half-updated checkpoint.

### Exact integration recommendation

Keep native Pi compaction enabled and use its defaults initially. For this harness, persist versioned structured checkpoints as Pi custom session entries via `appendEntry`, recover only from the current session branch, and inject the concise current checkpoint through `context` before each provider request. This covers mid-turn compaction as well as a new turn. Do not return a custom `compaction` result: Pi should continue generating its native conversation summary. The custom `details` contract above is an alternative for extensions that deliberately replace summarization, not the selected implementation. Observe compaction events only where useful for diagnostics. Preserve original evidence in separate artifacts; compression is not the evidence archive.

## Search with `pi-web-access`

The current Pi package page describes `pi-web-access` as offering Exa MCP without an API key, Codex-subscription-backed OpenAI search when eligible, configurable providers, self-hosted SearXNG, public/self-hosted degoog, and explicit-only DuckDuckGo HTML. Keyless means no user API credential in those cases, not a free, stable, private, or SLA-backed search API.

| Option | Credential/cost posture | Reliability and privacy boundary | Harness fit |
|---|---|---|---|
| Self-hosted SearXNG | No paid search API key; SearXNG is self-hosted software. Host, bandwidth, operations, and selected upstream engine terms/capacity still apply. | Query goes to your server and its configured engines. Engine bans, throttling, bot checks, and outages remain possible. | Best default if “free” means avoid paid hosted search and the harness can operate a small service. Configure `searxngBaseUrl`; test the configured JSON endpoint and engine set. |
| DuckDuckGo HTML | Keyless and explicitly selectable. | Pi Web Access documents this as an HTML endpoint, not a stable official API; its bot check is reported as quota, and recency filtering is not guaranteed. | Useful opportunistic fallback/manual provider; never promise availability. It is not selected by `auto`. |
| Exa MCP | No API key required in the documented default path. | Hosted Exa MCP receives queries; no public quota, permanence, or zero-cost guarantee should be inferred from “zero-config”. | Easiest keyless trial if hosted query disclosure and service dependency are acceptable; don't describe it as genuinely free. |
| Public degoog | Keyless public `https://degoog.org` endpoint. | Third-party hosted metasearch service; availability and underlying engine behavior are external. Explicit-only by design. | Optional explicit route; a self-hosted degoog endpoint gives control at added operations cost. |
| Existing eligible Codex subscription | No separate search key when Pi Web Access can reuse its supported sign-in. | Uses authenticated hosted search and sends the query to that service. Requires eligible existing Pi auth. | Convenient for an already-authorized harness account; subscription access is not the same as an unrestricted free API. |

There is no evidence here of a guaranteed, unlimited, genuinely free hosted search API. Recommended minimal approach: self-host SearXNG when local control and avoiding API charges are the priority; otherwise use the already available subscription-backed route or try keyless Exa with its hosted dependency stated. Keep DuckDuckGo/degoog explicit and optional, report selected provider and typed failures, and do not silently represent keyless results as reliable. For a lean profile, disable the curator/summary workflow and use raw bounded results plus explicit `fetch_content` on selected sources; the package documents its `none` workflow as avoiding another summary-model call. Verify exact config/defaults in the pinned package before adopting because this package changes frequently.

## Sources

- Pi Compaction Reference: https://pi.dev/docs/latest/compaction
- Pi Extensions Reference: https://pi.dev/docs/latest/extensions
- Pi session format: https://pi.dev/docs/latest/session-format
- Pi extension event/type source (`earendil-works/pi`, main): https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts
- Pi compaction implementation (`earendil-works/pi`, main): https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/compaction
- Pi Web Access package listing and configuration reference: https://pi.dev/packages/pi-web-access
- Pi Web Access upstream README: https://github.com/nicobailon/pi-web-access
- SearXNG documentation: https://docs.searxng.org/
- DuckDuckGo search engine (product page; not API documentation): https://duckduckgo.com/

## Evidence limits

Current Pi `latest` docs/source may be ahead of the harness's stated Pi 1.3.0 host; validate the hook types against that exact installed package. Package listing text is mutable and did not establish an SLA or stable availability for keyless/hosted providers. No package tarball was downloaded, no providers were queried, and no search uptime, privacy, or cost behavior was tested.
