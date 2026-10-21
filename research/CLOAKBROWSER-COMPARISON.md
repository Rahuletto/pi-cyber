# CloakBrowser vs Obscura for Pi cyber browsing

**Research date:** 2026-10-21. **Scope:** official upstream source and documentation only. No browser was installed or launched. Free/Pro terms below reflect upstream pages at research time; the two CloakHQ sources currently disagree on access to the newest binary, so verify the terms for the specific build before adopting it.

## Recommendation

Keep **Obscura as the default/fallback** for the lean free Pi harness. It is a standalone Apple Silicon binary with native rendering, an included MCP server, and an Apache-2.0 upstream license. Its anti-fingerprinting mode is opt-in, so ordinary browser inspection can run without intentionally changing fingerprint and tracker behavior. It remains an independent, incomplete browser engine; use it for exploratory/agent inspection, not as proof of Chrome or Safari enforcement behavior. The existing [browser research](BROWSER-REA-TOOLS.md) records those limits and the REA integration boundary.

Treat **CloakBrowser as an optional Chrome-based comparison lane**, not a replacement/default. Its strongest case is controlled testing against Chromium-specific behavior or investigating how source-level fingerprint patches affect a site. The core CloakBrowser project is a Python/JavaScript/.NET Playwright/Puppeteer wrapper around a patched Chromium binary; it is not itself an MCP server. CloakHQ's separate [CloakBrowser-Agent](https://github.com/CloakHQ/CloakBrowser-Agent) repo supplies an MCP server, but that is an autonomous task agent, with a Jev API dependency and configurable text model, rather than a thin set of browser primitives. It also uses CloakBrowser sessions and the license key. For Pi, Obscura's native `obscura mcp` fits the direct-tool shape more closely.

Do not use CloakBrowser stealth defaults or Obscura `--stealth` for browser-security conformance evidence. Both deliberately alter detection-facing signals; Obscura stealth additionally blocks trackers. For a Chrome-specific policy result, use a pinned stock Chrome build/profile. For Safari-specific results, use Safari/WebKit. Obscura can find hypotheses cheaply, and CloakBrowser can provide a Chromium-family cross-check, but neither result should be generalized beyond the actual engine/configuration tested.

## Comparison

| Dimension | CloakBrowser | Obscura |
|---|---|---|
| What it is | Chromium binary modified at source level plus wrappers; automation uses familiar Playwright/Puppeteer APIs. | Rust browser engine with embedded V8, its own evolving DOM/CSS/network implementation, plus a partial CDP surface. |
| Pi/MCP surface | Core repo documents wrapper APIs, not a built-in MCP server. Separate CloakBrowser-Agent exposes `browse`, `snapshot`, `act`, and `close_tab`; it has its own decision-agent/model dependencies and longer task-level tool semantics. | Ships `obscura mcp` over stdio or HTTP with direct navigate, inspect, and act tools; CDP is also available for lower-level control. |
| macOS arm64 | Supported. Current README says latest Pro Stable Chromium 155 supports Apple Silicon; README’s free-build matrix/release history identifies older free binaries, while the GitHub v146 release lists macOS arm64. | Official `obscura-aarch64-macos.tar.gz` release; rendering is included. README says no Chrome, Node, or other runtime dependency. |
| License/cost | Wrapper source is MIT. The compiled browser has a separate proprietary binary license. Current README calls latest Chromium 155 free after GitHub sign-in for one concurrent session and says v146 remains free; current binary license says the version listed on cloakbrowser.dev requires an active paid subscription. This is a direct upstream-doc conflict. Pro grants latest-version access at its tier; the binary cannot be redistributed or offered as a customer-controlled browser without separate OEM/SaaS rights. | Repository license is Apache-2.0; README says the open-source engine stays fully featured with no feature gating. Hosted Obscura Cloud is a separate planned service. |
| Main tradeoff | Closest Chromium-family behavior, but patches/default spoofing make it a poor neutral browser oracle; proprietary binary and subscription/version policy add friction. | Lightweight independent implementation and direct MCP, but engine coverage/fidelity differs from Chromium/WebKit. |

## License and access details

CloakHQ explicitly splits licensing: wrapper source in `CloakBrowser` is MIT, while the compiled CloakBrowser Chromium binary is subject to `BINARY-LICENSE.md`. That binary license grants personal, commercial, and internal business use subject to version-specific access terms. It bars binary redistribution, repackaging, third-party bundling, and customer-facing browser service/control without a separate license. Internal use includes the organization’s own research, scraping, automation, and CI/container use, provided the organization controls browsing; simply listing the package as a dependency is not redistribution when each user downloads from CloakHQ.

The current official sources disagree on whether the newest build is free: the README says the latest Chromium 155 build is free with GitHub sign-in and one concurrent session, while the binary license says the version currently listed on cloakbrowser.dev requires an active paid subscription. Both agree that the old v146 build stays free; release notes say the Mac arm64 Pro build is supported, and the current README lists Apple Silicon for Pro. Do not infer exact usable free Mac arm64 version/session rights from repo claims alone. Resolve against the binary’s download page and license presented at acquisition time. A lean free harness should avoid a dependency whose current access tier is unclear.

Obscura's GitHub repository identifies Apache-2.0 and says the open-source engine remains fully featured. Its release archive includes the renderer without Chromium or Node. Its own stealth rendering/transport is optional at build/runtime, but introduces materially different behavior (fingerprint randomization and a tracker-block list).

## Fingerprint and fidelity evidence boundary

CloakBrowser's upstream README claims 87 source-level Chromium patches and reports results on detection sites, including a 0.9 reCAPTCHA v3 score, Turnstile success, and BrowserScan results. Those are project-reported measurements, not independent verification in this research. The documented patch scope includes canvas, WebGL, audio, fonts, GPU/screen properties, WebRTC, network timing, automation signals, and CDP input behavior. The ordinary launch has stealth configuration by default; `stealth_args=False` disables default stealth arguments, but the custom Chromium binary retains its compiled source patches. It is therefore not equivalent to stock Chrome even with that option.

Obscura's own stealth documentation lists per-session fingerprint randomization, Chrome-like `userAgentData`, `navigator.webdriver` suppression, event/function masking, and a 3,520-domain tracker block. These too are upstream claims, not independently measured here. Unlike CloakBrowser, stealth is explicitly enabled with `--stealth` and requires a stealth build; the normal release is the better baseline for inspection. However, the non-stealth build is still not Chromium: the project documents gaps in long-tail CSS, some Web APIs, media, compositor effects, and font rasterization. CDP support is an implemented subset, not Chromium parity.

These distinctions matter in a cyber harness:

- A CloakBrowser/Obscura stealth pass/fail says how that altered configuration behaved against that test, not what a normal user’s browser exposes or how a control performs in stock Chrome.
- A default Obscura observation can guide investigation, but cannot establish CSP/CORS/cookie/service-worker/Safari ITP enforcement in another browser engine.
- A detection-site success is not proof of general stealth, undetectability, or production behavior. Fingerprints are multi-signal, server- and version-dependent; rerun controlled fixtures with the exact engine/version/configuration in scope.
- Do not point either agent automation surface at unscoped third-party sites. CloakBrowser-Agent's example browser task and Obscura both navigate and execute page-driven requests; use an owned fixture or explicitly authorized target.

## Fit with the existing REA/Pi design

Obscura provides a direct MCP endpoint for Pi, which matches a constrained tool harness: its tools are discrete browser operations, and a caller can record URL, binary version/hash, mode, context/page IDs, and capture output alongside REA Evidence. Serialize its stateful MCP page or give each independent experiment its own process/target, as described in [BROWSER-REA-TOOLS.md](BROWSER-REA-TOOLS.md).

CloakBrowser can be driven from a Pi-created custom MCP adapter using its Playwright APIs, or through the separate CloakBrowser-Agent server. The latter exposes task-level actions that invoke Jev to choose steps, can take a configured text model for typing, retains tabs/profile state, and reports the model's confidence. That is useful for user-like exploratory workflows, but it adds external model calls, autonomous action interpretation, session-state management, and a less direct evidence chain. Its README says page content is untrusted and returned in a fence, and notes that frames, closed shadow roots, canvas apps, uploads, new-tab links, and CAPTCHAs are unsupported; it also warns a valid action can still be the wrong action. Those limits make it a secondary operator aid, not the default cyber browser primitive.

Neither project is documented as a supported executable for REA's Chrome-family `capture_browser_scenario` provider. Obscura's CDP/Playwright compatibility and CloakBrowser's Chromium base do not prove REA support. Treat REA passive observation, active scenario capture, and direct browser MCP as separate paths unless the pinned REA version explicitly accepts and verifies one of these binaries.

## Primary sources

- [CloakBrowser repository and current README](https://github.com/CloakHQ/cloakbrowser)
- [CloakBrowser binary license](https://github.com/CloakHQ/cloakbrowser/blob/main/BINARY-LICENSE.md)
- [CloakBrowser v146 release](https://github.com/CloakHQ/cloakbrowser/releases)
- [CloakBrowser-Agent repository](https://github.com/CloakHQ/CloakBrowser-Agent)
- [Obscura repository and current README](https://github.com/h4ckf0r0day/obscura)
- [Obscura releases](https://github.com/h4ckf0r0day/obscura/releases)
- [REA browser scenario contract](https://github.com/morluto/rea/blob/main/docs/browser-scenario-contract.md)
- [REA browser observation](https://github.com/morluto/rea/blob/main/docs/browser-observation.md)

Claims about prices, free-session limits, supported versions, security behavior, stealth efficacy, and compatibility can change. This is source research, not local installation or compatibility test evidence.
