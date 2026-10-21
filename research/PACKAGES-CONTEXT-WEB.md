# Pi package evaluation: context compression and web research

Reviewed 2026-10-21 from the Pi package listings, upstream GitHub documentation/manifests, and release history. This is source review only: neither package was installed or run, and this is not a code or security audit. Package listings and `main` can point at different release snapshots; pin and inspect the exact artifact before enabling either.

## Decision for a lean Pi harness

`pi-web-access` is the more directly useful optional package for source-led research. `web_search`/`fetch_content` provide lookup and extraction; `source_check` records passage locations and hashes but leaves semantic review to a person or agent. The default `none` workflow avoids a separate summary call and curator UI. It complements Obscura: search/extraction versus rendered-page interaction and controlled actions. It is not general browser automation.

`billion-context` addresses a different pressure: management of a conversation that grows beyond a comfortable context window. It is not needed to make research tools available, does not expand the model's native context window, and introduces a proxy path that rewrites provider requests and streaming responses. Defer it until long-session context pressure is demonstrated. If evaluated, use one integration mode only: Pi's `billion-context` native plugin or the older standalone `billion-context-pi`, never both. It can also add `acp_delegate` subagent tools by default, which may be redundant in a lean harness; confirm whether they can be disabled in the chosen release/config.

The Pi directory listed `billion-context` 0.1.202 (Oct 19; entry `./dist/agent/pi-native.js`) and `pi-web-access` 0.43.0 (Oct 20; entry `./dist`). Pi Web Access says Pi v0.37.3+ minimum and Pi 1.0+ for code-mode, so Pi 1.3 falls in range, not a runtime-tested claim. The primary agent's direct read of the root GitHub `main` manifest instead says 0.44.0 and lists `@earendil-works/pi-ai`, `pi-coding-agent`, and `pi-tui` 1.0.4 as development/optional peers, plus `typebox`. Resolve this source/release mismatch against the exact tarball. Billion-context's native entry is separate from legacy `billion-context-pi`; current source uses the newer `@earendil-works/pi-coding-agent` namespace. Smoke-test exact artifact/host matching.

## What each package does

### `pi-web-access`: on-demand lookup, extraction, and evidence

The extension exposes `web_search`, `fetch_content`, `get_search_content`, and `source_check`. Retrieval supports HTML, GitHub, PDFs, YouTube, images, and local video, with readable, raw, and grounded-answer modes. Its manifest requires Node 22.19+ and includes extraction/MCP dependencies (`undici`, Readability, Defuddle, LinkeDOM, `unpdf`, Turndown, MCP SDK); Pi host peers are optional. Optional `ffmpeg`/`yt-dlp` support video frames on macOS. The curator UI supports result selection/summary review; it is not a browser control server.

Keep research narrow: search, fetch selected primary sources, and use `source_check` for structured review. It caps search at 20 sources and fetch at five pages. The session artifact has claim-status fields, source hints, SHA-256 hashes, offsets, and a `responseId` for paged retrieval. Retrieved passages remain `unclear` until a person/agent judges whether they support the claim. Export artifacts and selected URLs/excerpts with tool/version/session metadata; a Pi session is not a durable evidence vault. Avoid unnecessary full-page injection; codemode can return full fetched content outside normal inline bounds.

It supplies search, retrieval, and optional curator/summary review, not a guaranteed multi-step research plan, source triangulation, or verified conclusion. Use narrow search/fetch by default and structured review for claims; a model-backed search answer is not primary-source verification.

### `billion-context`: reversible-by-design compression, with wire interception

The upstream describes an intermediary that parses Anthropic/OpenAI-compatible requests, injects context-management tools and instructions, executes compression, forwards to the model, then rewrites streaming responses. In Pi native mode, a plugin starts/routes through the proxy; this is more invasive than an ordinary extension tool and broadens the behavior that must be regression-tested. API keys and model calls still traverse the configured provider path, while session compression state is persisted locally by the proxy. The published claims of incremental, reversible, prefix-cache-friendly compression are upstream claims, not independently verified here.

“Reversible” means the extension/proxy can restore stored original ranges on demand from its saved fold state; it does not mean the LLM's native context got larger or that every token can always be reconstructed after state loss, incompatible session migration, or bad summaries. Compression replaces part of the live prompt with summaries and references, reducing prompt tokens at the cost of extra tool behavior/state. Test round-trip restoration, restarts, provider switching, Pi's own auto-compaction interaction, context boundary handling, and streaming/error paths before relying on it. Preserve raw session/evidence records separately where source excerpts or tool outputs matter. Do not treat compressed history as the sole forensic record.

The current package listing reports one dependency and no peers. Upstream `main` also documents a standalone `billion-context-pi` path and requires its 0.1.72+ marker for the new native entry to safely make it stand down. Old standalone copies may silently double-compress; config scan warnings are not a substitute for checking user and project Pi extension locations. The current native plugin also adds delegate tools by default according to the upstream README; assess those separately from compression and disable them if the harness already has a delegation provider.

## Network, identity, and local-data boundaries

Pi Web Access sends queries, URLs and sometimes page content to configured/fallback search, extraction, video, or answer providers. Keyless search may still use hosted services; no API key does not mean local/private. Summary modes can call another Pi model. Provider-base-URL reuse is opt-in; custom provider credentials are not sent to official OpenAI by default. Gemini Web cookie access is off by default; enabling it can read Chromium cookies and macOS Keychain material, prompt for access, and authenticate to Google. `authFetch` is an explicit local-profile option. Inventory endpoints, fallbacks and auth profiles before sensitive research.

The package documents private-network checks and optional same-origin redirects. Remote extractors can resolve/follow targets independently after receiving a URL; extension preflight does not constrain their egress. Restrict hosted extraction or use isolated self-hosted services for sensitive work. These controls are not a sandbox guarantee.

For `billion-context`, any proxy that can rewrite model requests necessarily sees the conversation payload and auth-bearing request path. Confirm exact header forwarding, log redaction, local bind address, persisted state location/permissions, and upstream destination allowlist in the release configuration before sending confidential sessions. Upstream says its default bind is loopback and session state is local; verify these on the selected artifact. Keep Pi/browser page state and compression state separated by case, and do not let concurrent agents share a mutable active page or compression session.

## Suggested integration and test matrix (before any adoption)

| Case | Check | Expected evidence |
|---|---|---|
| Pi 1.3 + `pi-web-access` pinned release | Load tools; run one keyless search and selected-source fetch; verify versions and tool schemas | Startup logs, provider selected, exact URL/title, retrieved excerpt; no silent fallback |
| `source_check` persistence | Generate artifact, page through `responseId`, restart/resume, then export | Matching source URL/hash/offsets, errors retained, export tied to case/session/tool version |
| Network/privacy | Test configured provider, invalid/unavailable provider, custom base URL, cookie option off/on separately | Destination/provider logs; no credential sent to unintended host; cookie path untouched when off |
| Obscura + Pi Web Access | Keep browser-control session exclusive; run text research and browser action in separate tasks | Search tool never claims page DOM/auth state; browser observations record profile/tab/URL and timestamps |
| Pi 1.3 + `billion-context` native only | Confirm exact release/host API; compare small baseline then controlled long session | Stream completes unchanged apart from documented injected tool/compression semantics; state survives restart |
| Compression recovery | Compress a known range, request restore, inspect saved originals and context counts | Exact source range recoverable, no lost evidence; measured prompt-token reduction vs unchanged model limit |
| Integration conflict | Add/remove test-only legacy `billion-context-pi` and existing subagent tool configs in disposable Pi settings | Double-compression guard/warning behavior understood; one delegate provider; user and project config both checked |
| Failure handling | Simulate proxy/provider outage, malformed stream, timeout, interrupted Pi process | Clear errors; no corrupted session or false “compressed/restored” claim; fallback behavior documented |

Keep offense and defense roles separate in the harness, while making both specialists able to request the same browser and REA packages as needed: offensive tasks use them for controlled interaction/recon and authorized testing; defensive tasks use them for reproduction, evidence capture, configuration review, and mitigation verification. Each gets an isolated target identity/profile and exclusive mutable browser/session lease. Share immutable exports and evidence IDs, never a live tab or active mutable compression session.

## Source basis and evidence limits

- [Pi package page: billion-context](https://pi.dev/packages/billion-context) and [upstream README](https://github.com/ranxianglei/billion-context): package version/entry and upstream behavior claims.
- [Pi package page: pi-web-access](https://pi.dev/packages/pi-web-access), [upstream README](https://github.com/nicobailon/pi-web-access), [package manifest](https://github.com/nicobailon/pi-web-access/blob/main/package.json), and [changelog](https://github.com/nicobailon/pi-web-access/blob/main/CHANGELOG.md): release/minimum version, tool behavior, dependencies and evolving features.
- [billion-context client guide](https://github.com/ranxianglei/billion-context/blob/master/CLIENTS.md), [technical notes](https://github.com/ranxianglei/billion-context/blob/master/TECHNICAL-NOTES.md), and [Pi legacy package](https://github.com/ranxianglei/billion-context-pi): native/standalone distinction and migration caveats.

This research did not install packages, execute either extension, inspect a published tarball, exercise real provider routing, or audit the full source tree. Listed compatibility and safety properties remain unverified until the exact pinned artifacts are tested in an isolated Pi 1.3 profile.
