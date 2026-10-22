# Cloudflare Turnstile internals: a field guide for engineers

This document explains how Cloudflare Turnstile works at the depth needed to drive it honestly from automation: the `api.js` load contract, the challenge lifecycle, token properties, the signal set, failure paths, and the current bypass landscape. Every claim is attributed: Cloudflare's documentation, community-verified reverse engineering, or our own harness observations — the latter marked **[our observation]** (the October 2026 sessions where headless builds mounted the widget iframe but the body stayed empty forever), and treated as unconfirmed mechanism.

Primary sources used throughout:

- Cloudflare docs: [client-side rendering](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/), [widget configurations](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/), [server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/), [error codes](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/), [supported browsers](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/), [Privacy Pass](https://developers.cloudflare.com/privacy-pass/).
- Launch blog: ["Announcing Turnstile"](https://blog.cloudflare.com/turnstile-private-captcha-alternative/) (Sept 2022) — the only public enumeration of the signal categories.
- Reverse engineering: [crawlex internals writeup](https://blog.crawlex.net/blog/cloudflare-turnstile-internals/), [invisible_playwright explainer](https://github.com/feder-cr/invisible_playwright/blob/main/docs/cloudflare-turnstile-explained.md), [scrapfly](https://scrapfly.io/blog/posts/how-to-bypass-cloudflare-turnstile), [solvegate's api.js analysis](https://solvegate.io/turnstile-errors/300030).
- Telemetry: Troy Hunt, ["Fighting API Bots with Cloudflare's Invisible Turnstile"](https://www.troyhunt.com/fighting-api-bots-with-cloudflares-invisible-turnstile/).
- Standards: RFC 9576/9577 (Privacy Pass architecture + PrivateToken HTTP scheme), RFC 9578 (issuance), RFC 9474 (RSA Blind Signatures).
- 2025–2026 bypass scene (linked inline): CloakBrowser's README test matrix, the waguriagentic/captcha-solver sidecar, Geber-CF, zeroCaptcha's Turnstile writeups.

---

## 1. The challenge lifecycle and the `api.js` load contract

### One script, fetched verbatim, once

Everything begins with one tag: `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`. Cloudflare is explicit: *"The `api.js` file must be fetched from the exact URL shown above. Proxying or caching this file will cause Turnstile to fail when future updates are released"* ([client-side rendering docs](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)). This is architecture, not hygiene: `api.js` is the delivery vehicle for whatever challenge logic Cloudflare wants to run today, and the launch blog frames the platform as a way to *"rotate new challenges in and out as they become more or less effective."*

The script also validates its own provenance at runtime: the shipped `api.js` rejects self-hosted/minified/inline deployments with `Could not find Turnstile valid script tag…` or `Could not parse Turnstile script tag URL` (solvegate). Bundlers that rewrite the tag break the widget with no other symptom — which is why proxying `api.js` through our own origin is forbidden in the harness: the script checks who served it, not just whether it ran.

### Implicit vs explicit render

Two render paths, both documented:

- **Implicit** (plain `api.js`): on load, the script scans the document *once* for elements with class `cf-turnstile`. The scan is a one-shot pass on the ready event, not a live observer — containers injected later (SPAs, modals, AJAX forms) are never seen (docs + solvegate; echoed across the Next.js, Remix, WordPress, and Nordcraft community threads).
- **Explicit** (`api.js?render=explicit`, optionally `&onload=cb`): page code calls `turnstile.render(container, params)`, usually inside `turnstile.ready(fn)`. Calling `turnstile.ready` while the tag is `async`/`defer` throws *"Remove async/defer from the Turnstile api.js script tag before using turnstile.ready()"* (solvegate).

For our harness, explicit rendering is the viable path because we inject the container ourselves after page load.

### Modes: managed / non-interactive / invisible

Per the [widget types reference](https://developers.cloudflare.com/turnstile/reference/widget-types/) and Troy Hunt's summary:

- **Managed** (Cloudflare's recommendation): silent signal battery first; a checkbox *"only if it detects potentially automated traffic"*.
- **Non-interactive**: visible spinner, never a checkbox; token minted purely from background signals. Scrapfly calls this mode "the hardest for scrapers, because … there is no visual puzzle for a CAPTCHA-solving service to solve."
- **Invisible**: no widget at all; challenge still runs in the background.

All three run the same signal collection; the mode only governs whether an interaction can ever be demanded. Two knobs matter for automation: `execution: render|execute` (auto-run or `turnstile.execute()`) and `appearance: always|execute|interaction-only` (visibility). A container with `display: none`, `visibility: hidden/collapse`, or `opacity ≤ 0.01` is classified by `api.js` as unexpectedly hidden — unless the mode makes hidden the expectation (solvegate).

### Why a widget mounts but never starts

**[our observation]** In our headless builds, the widget iframe mounts but the body stays empty indefinitely — no checkbox, no spinner, no token, silent. Four candidate mechanisms are documented or community-verified, each to be ruled out in order:

1. **Environment classified unsupported or bot-suspect.** The `unsupported-callback` exists in the documented configuration table as *"invoked when a given client/browser is not supported by Turnstile"* — the strongest documented hook for "mounted but never begins." Separately, `300*`/`600*` are documented as *"generic challenge failure … bot behavior detected"*, and Cloudflare's challenge docs state flatly: *"Automated browsers are not supported for solving production challenges"*, naming Selenium, Puppeteer, Playwright, and Cypress explicitly ([supported browsers](https://developers.cloudflare.com/cloudflare-challenges/reference/supported-browsers/)).
2. **The heartbeat watchdog.** `api.js` keeps a map of live widgets and runs an interval watchdog that posts a heartbeat into each widget's iframe, expecting acknowledgement. A still-executing widget that has not acknowledged for ~45 ticks (~40 s at the 900 ms interval) is force-failed with `300030` ("hung") or `300031` ("crashed") (solvegate). If our empty-bodied widgets never produced 300030 either, the parent never registered them as live widgets at all — pointing further upstream.
3. **Visibility / rendering-pipeline gating.** Hidden containers stop the pipeline (above). Both CloakBrowser's README and the waguriagentic sidecar report success only in *headed* sessions (real display or Xvfb), consistent with the pipeline inspecting rendering state (viewport exposure, GPU/compositor presence, focus) rather than only DOM attributes. The classic headless tells — `HeadlessChrome` UA, missing `window.chrome`, `plugins.length === 0`, `navigator.webdriver` — are the observable cousins of that gate class.
4. **Global-assignment failure** — see Section 2. **[our observation]** an accessor property on `window.turnstile` makes `api.js` bail and never assign, in which case the pipeline never starts even if earlier steps ran.

All other silent failures in the community record trace to: CSP `frame-src`/`script-src` omissions (`200500`, iframe load error), `file://` origins (unsupported; `http`/`https` only), or `110200` domain not authorized.

## 2. The `window.turnstile` global load discipline

### The double-load contract

`api.js` installs a `turnstile` object on top-level `window` (`render()`, `reset()`, `getResponse()`, `remove()`, `execute()`, `ready()`, `isExpired()`) plus an internal widget registry keyed by `cf-chl-widget-*` ids (community logs show `Cannot find Widget cf-chl-widget-g9yvd, consider using turnstile.remove()`). If the script runs a second time, its re-assignment check fires and it exits, logging:

> `[Cloudflare Turnstile] Turnstile already has been loaded. Was Turnstile imported multiple times?`

Documented in Cloudflare's troubleshooting text and repeatedly verified in the wild: Next.js `next/script` double-includes (Cloudflare community), WordPress theme + form-plugin collisions (Brevo thread), SPA route churn (Remix thread), and Rocket Loader re-loading `api.js` inside a Cloudflare zone — the AMH-Cloudflare-Ops-MCP repo commit documents the result precisely: *"Turnstile already has been loaded" x3, leaving `turnstile.render` undefined so the widget never renders*. Key verified detail (solvegate, WordPress thread): **the second load does not replace `window.turnstile`; it warns and stops — the first instance wins the global.**

### Our empirical finding: accessor properties silently kill the load

**[our observation]** Pre-installing `window.turnstile` as a plain *accessor property* (getter, no setter, via `Object.defineProperty` before `api.js` executes) sends the script's load-time check down a different branch: it bails **silently** — no "already has been loaded" warning — and never assigns, so the widget pipeline never starts. Plausible mechanism [inference]: the script detects a pre-existing `turnstile` binding it cannot distinguish from a prior genuine load; finding no registry behind ours, it exits quietly.

Mechanically, per ECMAScript global-object semantics and MDN: assignment onto the global via [[Set]] looks up any existing own property. A writable data property is overwritten; a non-writable data property or a get-only accessor makes the write a silent no-op (non-strict) or a `TypeError` (strict). Either way the property's *descriptor shape* differs from what the script's own install produces — and instrumentation detectors probe descriptor shapes routinely: puppeteer-extra issue #239 lists `!!Object.getOwnPropertyDescriptor(navigator.__proto__, "webdriver")` and `!!Object.getOwnPropertyDescriptor(navigator, "languages")` as live detection methods, Clearcote's audit shows a detector accepting a `get` field only if the getter stringifies as `[native code]`, and rebrowser-patches issue #52 carries the relevant warning: *"the presence of a proxy can be detected by client bot detector libraries and a proxy on the window object is probably going to ring some alarm bells"* (daniellionel01, Dec 2024).

Practical conclusion: **never predefine `turnstile` on `window`, never install getters/setters/traps over it, never Proxy `window` globally.** Let `api.js` install its own global verbatim and interact from outside — `getResponse` polling or the hidden `cf-turnstile-response` field — rather than re-wrapping its surface. Anything we need to inject targets the page's form integration, not the global.

## 3. Token properties

All from the [server-side validation docs](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) unless noted:

- **Shape**: opaque string, ≤ 2,048 chars. Field layout not public; opaque to integrators, decodable only by the siteverify endpoint (crawlex characterization, consistent with docs "not meaningful without siteverify").
- **Expiry**: 300 s (5 min) after generation. Token timed out at siteverify → `timeout-or-duplicate`.
- **Single-use**: one redemption. Replay → `timeout-or-duplicate`. Implies server-side state at Cloudflare (crawlex inference, consistent with the docs).
- **Bindings**: `hostname` (serving host), `action` (≤32 chars, alphanumeric/`_`/`-` — [widget configurations](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations/)), `cdata` (≤255 chars, same charset), `challenge_ts` (ISO 8601 solve timestamp). `remoteip` is optional on the request and the strongest binding when supplied.
- **`metadata.ephemeral_id`**: Enterprise-only. A short-lived, per-customer, deliberately non-unique device-class id derived from the same collected signals, "links behavior to a specific client instead of an IP address" (Sept 2024 blog). Surfaced server-side; not visible on the client.
- **Client-side error codes**: `110100/110110` invalid/unknown sitekey, `110200` domain not authorized, `110600` challenge timed out, `200100` clock/cache problem, `200500` iframe load error, `300*`/`600*` generic challenge failures (docs' wording: bot behavior detected), `400020/400021/400070` sitekey config faults — family encoded in the first three digits ([error codes table](https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/)). The widget auto-retries client-side (default 8 s interval) — a transient `300*` can hide under a later success.

Two structural consequences for automation: **[inference, supported by zeroCaptcha's analysis]** the siteverify response "names no browser or device apart from an Enterprise-only ephemeral ID," so a well-formed token plus matching bindings is all a server can see; and per Troy Hunt's production setup, a stale token collapses first-attempt failure and replay into the same 401 — freshness discipline is the one thing an automation layer must get right.

## 4. The signal set

### The four named categories

From the launch blog (Sept 2022), still Cloudflare's most specific public statement:

> "Those challenges include, proof-of-work, proof-of-space, probing for web APIs, and various other challenges for detecting browser-quirks and human behavior."

- **Proof-of-work**: a small CPU puzzle (Hashcash family), cheap to verify, difficulty scaled by ML models — *"computational hardness … may vary by visitor, but is targeted to run fast"* (launch blog). Alone it proves nothing about humanity; it imposes cost a bot farm pays per token.
- **Proof-of-space**: the memory-bound cousin — allocate and touch a chunk of memory, harder to cheaply parallelize on scraper hardware (crawlex).
- **Web API probing / quirk detection**: *consistency*-based fingerprinting — every answer must be coherent with every other answer and with the claimed engine identity. Cloudflare publishes no property list. "A value being wrong matters less than two values disagreeing" (crawlex); a `navigator.platform` contradicting adjacent engine-reported values is a stronger signal than any single wrong field.
- **Human behavior**: mouse trajectories, keystroke dynamics, page-interaction timing (scrapfly's taxonomy of the launch blog's category).

### What is encrypted vs observable

The signal bundle is **encrypted en route**: the widget POSTs background payloads to Cloudflare "carrying encrypted data … that can include browser fingerprints," WebDriver flag and hardware configuration included (DataDome's 2022 vendor analysis, via crawlex). The field list is not public and rotates with `api.js`, so any field inventory describes a snapshot. Observable at the network layer: connection metadata (IP, ASN, datacenter vs residential), the TLS ClientHello and HTTP/2 frame profile, and the endpoints/timing of the widget's own JS calls.

### The network waterfall: judged before any JS runs

Turnstile sits on Cloudflare's network, which reads the TLS ClientHello of *every* connection: *"a connection that claims to be Chrome but has a Python TLS fingerprint triggers immediate detection"* (scrapfly). That layer is invisible to JavaScript — the correct move is a client whose true TLS stack is the claimed one (curl-impersonate / binary-patched Chromium), not a proxy-stack fake.

Troy Hunt's production data (5 months, >100 M challenges) shows how dominating this is: a 91% solve rate; **~990k failed submissions, ~40% of them from just 5 distinct JA3 fingerprints**, ~36% sharing one UA string; a 121,300-requests-per-5-minutes abuse peak dropped to nothing post-deploy. Conclusions: the transport fingerprint is decisive *before* any JS, and once the network story is coherent, the JS-side battery is as much about *coherence* as correctness.

### The Privacy Pass / Private Access Token layer

Turnstile has a second, cryptographic evaluation path alongside the JS battery. *"Private Access Tokens are built directly into Turnstile"*, letting supporting Apple platforms prove device legitimacy *"without completing a CAPTCHA or giving up personal data"*, and it *"never looks for cookies … or uses cookies to collect or store information of any kind"* (launch blog). The standard underneath is Privacy Pass (RFC 9576: four roles — Client/Origin/Attester/Issuer — split so no single party learns both identity and destination; RFC 9577: the `PrivateToken` HTTP scheme; RFC 9578: issuance, with Cloudflare running the publicly verifiable Blind RSA protocol, token type `2` — [Cloudflare Privacy Pass docs](https://developers.cloudflare.com/privacy-pass/concepts/privacy-pass-protocol/)), with RFC 9474 RSA Blind Signatures making issuance unlinkable from redemption. Cloudflare confirms Privacy Pass tokens are *"built into Turnstile as a signal in its application layer challenge decisions"* ([overview](https://developers.cloudflare.com/privacy-pass/)). Reach is limited to supporting Apple OS/browser combinations, so the JS path above remains the universal one — but it explains why a stock Safari/iOS client can pass with fewer observable JS-side effects than a stock Chrome.

## 5. Detection and failure paths

Cloudflare's documented outcome model maps roughly to "real / uncertain / bot":

- **Real**: the non-interactive battery passes; token minted. Where most visitors — and clean stealth runs — land.
- **Uncertain**: escalate to a visual interaction. Per invisible_playwright, the checkbox is exactly this path for Managed contracts ("a simple checkbox that the visitor must click to proceed") — appearing because prior signals scored poorly, not because a fingerprint signature matched.
- **Bot**: `300*`/`600*` generic challenge failures, usually silent.

Headless tells that survive JS-level patching, compiled from puppeteer-extra issue #239, Clearcote's descriptor-audit template, Foil Research's teardown of four stealth browsers, and CloakBrowser's test matrix:

- **Descriptor-shape probes**: an init-script override creates an own data descriptor where stock browsers expose a prototype accessor; `Object.getOwnPropertyDescriptor(navigator, 'webdriver')` returning anything, or a `get` field that does not stringify as `[native code]`, is a confirmed detection path (issue #239; Clearcote).
- **Stack-trace / function-source checks**: a `document.createElement("dummy")` stack containing `Object.apply (<anonymous>)`, or `console.debug + ""` containing `return` (issue #239).
- **Geometry and object shape**: `outerHeight − innerHeight > 160`; `plugins.length === 0` vs stock Chrome's 5; missing `window.chrome`; `HeadlessChrome` UA; visible CDP artifacts (CloakBrowser table).
- **Worker-context reads defeat init-script overrides** (Foil Research): the override never runs in Workers, which is why `playwright-stealth` and `undetected-chromedriver` keep failing while engine-level projects (Camoufox patches Firefox getters in C++ via `MaskConfig`; CloakBrowser patches Chromium source) claim passes.

Cloudflare's docs state that *"custom or heavily modified browser engines and embedded browsers"* have only limited support — the target is the fingerprint class of an ordinary consumer browser, not maximal patching. CloakBrowser's comparison table (self-reported; treat as vendor claims) represents the public state of the art: Turnstile non-interactive and managed **PASS** on its Pro build, credited to 87 C++-level source patches plus a `humanize=true` behavioral layer — with the load-bearing admission *"Some sites detect headless mode even with our C++ patches. Run in headed mode with a virtual display."*

## 6. Bypass landscape as of 2025–2026

Current working paths, ranked by likelihood to hold:

1. **Engine-level stealth browsers** (CloakBrowser for Chromium, Camoufox for Firefox — engine-level fingerprint patches, not script injection, per Foil's comparison). Third-party builds on CloakBrowser (waguriagentic/captcha-solver, Geber-CF) report managed-Turnstile harvest in **2–10 s** behind VPN/WARP egress with humanization on; Geber-CF records **"humanize=True required (without it, Turnstile refuses to solve)"** — behavioral signals still gate even a clean fingerprint.
2. **Headed + virtual display** (`headless=False` under Xvfb), recommended across all of the above; correlates with the Section 1 visibility gate, which C++ patches alone do not neutralize.
3. **Managed click**: humanized click near `(x+20, y + height/2)` of the widget (both Geber-CF and waguriagentic), token read from `input[name="cf_challenge_response"]` on Cloudflare dashboard flows. Requires the real page context: **stub-page-minted tokens are rejected at siteverify with error `1201`** (waguriagentic readme, community-verified).
4. **Solver APIs** (capsolver, 2Captcha, zeroCaptcha-class): send `websiteURL`, `websiteKey`, and `action`/`cdata` when present; poll `getTaskResult` (zeroCaptcha: 180 s deadline); hand the token to the page via `cf-turnstile-response` or its callback. Self-hosted CloakBrowser sidecars (waguriagentic) are the leading no-per-solve-cost option. Universal limits: latency, cost, no `cf_clearance`.
5. **Network coherence**: waguriagentic's `cf_clearance` path makes the binding explicit — the cookie is **bound to exit IP + JA3/TLS fingerprint + User-Agent + the specific challenge**, lives ~15–30 min (site-configurable), and must be replayed from a client whose TLS fingerprint matches: plain `requests`/`httpx`/`curl` get **re-challenged even with the right IP + UA**. Datacenter IPs are scored harshly enough that managed challenges *"may never let a raw VPS/datacenter IP through"* (waguriagentic); residential/mobile egress is usually required.

Practical limits we must respect (and they are hard limits):

- **No `cf_clearance` by default.** Per crawlex's synthesis of the clearance docs, Turnstile's default flow issues *only* a token. `cf_clearance` belongs to the Challenge Page layer and exists in the Turnstile world only as the opt-in *pre-clearance* feature. If a target requires browser-state cookies, a token harvest alone does not get us there.
- **Token freshness.** 300 s, single-use (Section 3). No pre-harvest, no cache, no pool, no replay.
- **TLS coherence is mandatory** (Foil, waguriagentic, CloakBrowser, scrapfly concur): a TLS/UA contradiction cannot be patched from JS.
- **IP reputation is a multiplier**: never approach from datacenter egress; residential through the same session channel.

## 7. Practical playbook: how our agent should approach a Turnstile-gated target

Step-by-step, ordered by cost and grounded in the sections above:

### Step 0 — Identify which Turnstile you're facing

Confirm `https://challenges.cloudflare.com/turnstile/v0/api.js` in the page and inspect the container: `data-sitekey`, the `cf-turnstile` class (or explicit-render container id), `data-action`, `data-cdata`, `data-appearance`, `data-execution`, and the widget mode (managed / non-interactive / invisible). ⚠️ **A full-page "Just a moment…" interstitial is a Challenge Page (WAF path, `/cdn-cgi/challenge-platform/`), not a Turnstile widget** (zeroCaptcha): token harvesting does not apply; `cf_clearance` harvesting does, bound per Section 6 rules.

### Step 1 — Launch conditions (all required simultaneously, per Sections 4–5)

- Residential or mobile proxy egress, matching the browser's geo-locale/timezone (the waguriagentic pattern: `TURNSTILE_GEOIP` aligns these).
- True Chrome TLS stack (CloakBrowser/Camoufox-class binary), never stock `python-requests`.
- Headed mode under Xvfb; never pure `headless=True` against Turnstile.
- `humanize=True` mouse/keyboard/scroll timing.
- Do **not** predefine/trap `turnstile` or Proxy `window` (Section 2). Let `api.js` install its global; we only observe afterward.

### Step 2 — Determine whether the widget actually starts

Poll `turnstile.getResponse(widgetId)` or the hidden `input[name="cf-turnstile-response"]` (auto-injected into the wrapping form), ~60–90 s deadline. Diagnosis ladder (Section 1):

- No iframe → `api.js` bailed (silent bail or duplicate load); check console for the two load-discipline messages; check the global's descriptor shape.
- Iframe present, empty body, silent → headless/unsupported-environment path (Section 1, #1/#3): relaunch headed-under-Xvfb with humanize.
- Iframe present, permanent spinner → CSP/network issue (`200500`) or a `300*`-family auto-retry loop; attach an explicit `error-callback` to read the code, since the default path only console-warns.
- Checkbox appears → escalation (Section 5): a risk-score verdict, recoverable via the Section 6 #3 humanized click.

### Step 3 — Harvest and consume immediately

Consume the token the instant it appears: 300 s TTL, single-use at siteverify. Rules: **no reuse, caching, pooling, or replay** — each mint is exactly one presentation; and **carry `action`/`cdata` through unmodified** if the widget sets them — siteverify echoes both back and server integrations commonly assert equality (zeroCaptcha passes both into solver `metadata` for this reason).

### Step 4 — Presentation shape

Prefer injecting into the widget's own hidden input `cf-turnstile-response` (zeroCaptcha pattern, creating the input if the widget never mounted). If the page consumes the token via its JS callback instead, deliver there: "some pages read the token from the widget's JavaScript callback, not from the input, and ignore a value you write into it" (zeroCaptcha).

### Step 5 — Fallback ladder (Section 6)

1. Engine-level stealth browser, humanize on, residential IP.
2. Self-hosted CloakBrowser-class solver sidecar.
3. Third-party solver API with (url, sitekey, action, cdata); poll ≤180 s.
4. Interstitial instead of widget → `cf_clearance` harvesting in the same session, replayed with matching IP + TLS + UA.

### Anti-goals (Sections 2, 3, 6)

- Never predefine, trap, or getter-wrap `window.turnstile`; never Proxy `window` globally — detectors read descriptor shapes and proxy presence.
- Never mint in a stub page — stub-context tokens fail at siteverify with error `1201`.
- Never replay, pool, or pre-harvest tokens (300 s single-use); a stale token flags the session as a first-attempt failure.
- Never bundle/proxy/rewrite `api.js`; load it verbatim, exactly once per document.
- Never attempt JS-only stealth while TLS contradicts the UA — fix the network stack or drop the claim.

### Recommended reference configuration

```python
# turnstile-harvest sketch (waguriagentic/zeroCaptcha pattern)
# 0. Engine-level stealth build (CloakBrowser/Camoufox class), headed under
#    Xvfb, humanize=True, residential egress matching page locale.
# 1. page.goto(url); wait for window.turnstile / the api.js tag.
# 2. loc = page.locator('div.cf-turnstile, [data-sitekey]').first
#    sitekey = loc.get_attribute('data-sitekey')
#    action  = loc.get_attribute('data-action')   # carry through if present
#    cdata   = loc.get_attribute('data-cdata')    # carry through if present
# 3. Wait for the widget's own solve (90 s deadline):
#    page.locator('input[name="cf-turnstile-response"]').inputValue()
#    or poll turnstile.getResponse(widgetId) in page context.
# 4. Token is valid 300 s and single-use: present immediately —
#    no stash, no replay, no extension.
# 5. No token after the deadline → run the diagnosis ladder above,
#    then escalate to the solver-API path with (url, sitekey, action, cdata).
```
