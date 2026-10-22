# Tooling gap analysis: AI-provider signup/API triage pattern

Scope: gap analysis only — no installs, no code changes. Baseline is the currently installed adapter set in `~/.pi/scanners` (subfinder, dnsx, httpx, katana, nuclei, ffuf, naabu, uncover, vulnx, interactsh, semgrep, trivy, osv-scanner, gitleaks, syft, nmap, zap, obscura, patchright, cloakbrowser, curl-impersonate) on a Bun-based macOS arm64 harness. Every install method below avoids npm/node in the package; binaries are meant to land as typed CLI adapters. Nothing below was executed in this harness. Licenses were checked via the GitHub API on 2026-10-22; anything I could not confirm is marked **(verify)**.

Observed pattern across ~36 AI-inference-provider targets: enumerate free-API/signup surfaces, then classify each failure into classes A–G. The classification logic itself is prompt/orchestrator work; the gaps are the specific wheels we currently have to invent per run.

## Class A — no signup path / enterprise-only identity

**Verdict: no tool gap.** This is a routing/policy observation, not a tool shape. httpx + katana plus well-known probes (`/.well-known/openid-configuration`, SSO redirect hosts) already surface "enterprise-only identity" reliably. Build a typed probe list in our own adapter; do not spend adapter budget installing anything.

## Class C — Cloudflare bot-tier 403/429/521 on API endpoints

Highest-value class. Our curl-impersonate lane solves TLS/JA3 simulation but not cf_clearance-stateful bypass, WAF-tier identification, or origin-IP fallback. Three picks:

1. **wafw00f** — `github.com/EnableSecurity/wafw00f`, **BSD-3-Clause**, active (pushed 2026-04). Identifies and fingerprints WAF products (100+ signatures) from benign probes. Why the gap: our stack tells us *we got 403'd*, not *by which WAF at which tier*; httpx's tech-detect is page-tech only. First fixture for deciding whether class C is a wafw00f-fingerprint problem or a bot-tier problem. Install: `uv tool install wafw00f` (PyPI; python 3.9+) — `pipx install wafw00f` is equivalent. Adapter: `wafw00f -a <url>` → map JSON/text fingerprint verdict to a `waf` field; keep the `behind-cloudflare` boolean as the class-C discriminant.
2. **Censys CLI (censys/censys-python)** — Apache-2.0, maintained (pushed 2026-08). Provides `censys search` for origin-IP discovery queries (cert names, ASN, TLS cert matching historical records). Why the gap: uncover covers some third-party search APIs, but the censys v2 CLI is the maintained path for hosted-scan origin-correlation, and 2025–2026 search results show the classic tooling (CloudFlair, old censys v1 scripts) is broken against Censys v2 while the official CLI is not; nevertheless **origin-IP discovery reliability is degraded industry-wide** (Cloudflare responds aggressively; certificate-transparency origin leaks are mostly patched) — treat hits as hypotheses. Install: `uv tool install censys` + `CENSYS_API_ID/SECRET` env (free account). Adapter: typed `censys search "<brand>.com and not ip: [cf ranges]" --output-format json`, followed by an httpx differential probe to verify the origin actually serves the domain (Host-header check).
3. **nemesida-waf/waf-bypass** — MIT, active (pushed 2026-07). 50+ bypass payloads (headers like `X-Forwarded-For: [127.0.0.1]`, pairing, evil verb sets) as a scanner we can point at a blocked endpoint rather than at a WAF sandbox. Why the gap: ffuf can run arbitrary headers, but this packages the vetted bypass corpus; reimplementing it in our ffuf recipes is duplication. Install: Python; `uv tool install git+https://github.com/nemesida-waf/waf-bypass` **(PyPI presence unverified — verify)**. Adapter: `waf-bypass --url <endpoint>` → present only the per-method 2xx/3xx results; wire optional `--proxy` to reuse our curl-impersonate lane when we know fingerprint is the failure mode.

**Rejected here:** byp4xx (lobuhi/byp4xx, Go) — no LICENSE file in the repo **(verify)**; its corpus overlaps waf-bypass and can be reimplemented as our own ffuf recipe list. Old Go bypassers (403-bypass forks of BypoXx) are stale/lower quality.

**Origin-IP alternatives:** CF-Hero (musana/CF-Hero, Go, multi-source crawl) shows **no LICENSE via the API — (verify)**; gwen001/cloudflare-origin-ip is MIT but last pushed 2024 and needs adaptation to Censys v2. Both are lower priority than the censys CLI directly. CloudFlair (christophetd) is MIT but abandoned and Censys-v1-bound — reject.

**JSdegrade lane (parallel):** FlareSolverr (FlareSolverr/FlareSolverr, MIT, active) could serve as an always-on cf_clearance jar provider, but with the stealth-browser lane (patchright/cloakbrowser) in place it is redundant, and its Docker/service shape is adapter-hostile. **(uncertain)**: its 2026 solve-rate against updated Cloudflare challenges — actively maintained but challenge compatibility reportedly degrades often.

**TLS beyond curl-impersonate:** bogdanfinn/tls-client (BSD-3-Clause, very active) is a Go *library* — no CLI exists to install. It's the right answer only if we ever need HTTP/2 + header-order fingerprints curl-impersonate can't reproduce, which means compiling our own tiny wrapper binary. **(uncertain; defer — curl-impersonate covers JA3 and, in newer releases, HTTP/2 for Chrome.)**

## Class D — no real API surface found (JS bundle hides the real base)

1. **jsluice** — `github.com/BishopFox/jsluice`, **MIT** (confirmed LICENSE file, "Copyright (c) 2023 Bishop Fox"), Rust-backed Go CLI. Extracts URLs, paths, secrets, cloud ARNs and other interesting bits from JavaScript with a real tree-sitter AST parser (httpx mode, URLs-and-secrets mode, semgrep-like pattern mode). Why the gap: katana crawls a page tree including *.js links* but does not parse bundle contents; api.<brand>.com guessing is exactly what jsluice's AST pass fixes — it reads the actual scripts. Install: `go install github.com/BishopFox/jsluice/cmd/jsluice@latest` — no published release assets exist, so this is the source build path; native build requires clang toolchain on macOS arm64 **(tree-sitter C compilation — verify it builds clean without extra deps on arm64; it's known to need a recent Go and clang on macOS)**. Adapter: feed `jsluice --mode urls -i <bundle.js>` output into our own base-URL clustering; also run `--mode secrets` as an enforcement of class F against our JS-corpus lane. Note: last push 2024-05 — caveat: dormant but stable, AST core unlikely to rot.
2. **LinkFinder** — `github.com/GerbenJavado/LinkFinder`, **MIT**, Python; regex-based endpoint extraction from JS. A sibling listed in `docs/TOOLS.md` as catalog-only; a fallback where jsluice's AST pass misses legacy patterns. Install: `uv tool install git+https://github.com/GerbenJavado/LinkFinder` **(PyPI presence unverified)**. Caveat: Python regex vs jsluice's parser; last push 2024-04.
3. **Hakrawler is already cataloged in our docs as a likely overlap** (GPL-3.0) but not installed; only add if katana's crawl mode misses raw-HTML `src` extraction in JS-heavy single-page providers.

**OpenAPI/spec discovery:** after surveying the ecosystem (openapi.tools, awesome-api-security, recent release pages) I did **not find a clean, actively-maintained, license-clear standalone OpenAPI-spec-discovery CLI** — the best entries are WAF testers (gotestwaf), spec *consumers* (openapi-to-cli/ocli, openapicmd — turn an already-found spec into a CLI; license **(verify each)**), or node-based integrations which we exclude. Until one appears, our ffuf (`-w SecLists/api-endpoints.txt`) + katana + jsluice pipeline plus the ZAP OpenAPI-import lane must serve. Mark as an open gap.

## Class E — unverified-email account states

We already own mail parsing, so the gap is only domain reputation/catch-all handling for signup automation.

1. **martenson-disposable-email-domains** — `github.com/di/martenson-disposable-email-domains`, **CC0**, actively maintained. Machine-readable txt list, no binary install. Why the gap: signup-lane failures are not uniform around disposable/catch-all addresses; a typed list lets the harness decide when state E is a disposable-domain artifact vs a real unverified account surface. Install: `curl` the txt into config at checkout. Adapter: typed data adapter returning `is_disposable`, list version, and hash for provenance.
   - The bigger `disposable-email-domains/disposable-email-domains` (5.6k stars) shows license "NOASSERTION" via the GitHub API — README suggests a CC0 dedication but the license file isn't reliably detected **(verify)**; martenson's repo is the cleaner pick.
2. Nothing else worth installing. Turnstile/CAPTCHA signup (class B) is covered by the existing stealth-browser lane — noted here only to confirm that the browser lane's contract (cookies + identity state handoff) should be part of the signup fixture, not a separate tool.

## Class F — leaked/available API keys as alternative access

1. **TruffleHog** — `github.com/trufflesecurity/trufflehog`, **AGPL-3.0** (confirmed via GitHub API and pkg.go.dev), very active. 800+ detectors with *live credential verification* and org-level scans (`trufflehog github --org <name>`), whereas our gitleaks is regex-only (MIT) and stops at detection. Why the gap: verification is decisive here — a `sk-...` match alone is not an access path; a confirmed one is. Install: `brew install trufflehog` or the upstream script `curl -sSf https://trufflesecurity.com/sh | sh` **(verify script URL at deploy)**. License note: AGPL is fine as a *separately-installed binary adapter invoked as a subprocess*; never statically embed it in a non-AGPL binary. Adapter: `trufflehog filesystem <path> --only-verified --json` → typed `{source, verified, raw_verdict}` stream.
2. **GitHub dorks automation** is the remaining sub-gap. GitDorker (obheda12/GitDorker, Python) and gwen001/github-search (MIT, stale since 2023) exist, but GitDorker has **no LICENSE file (confirmed via GitHub API)** — reject on license cleanliness. Practical pick: fold a curated dork list (`org=<brand> filename:.env sk-`, `filename:credentials openai`, `in:file "anthropic"`, etc.) into a trufflehog-org-follow-up lane instead of another binary. nuclei-templates already ships the `http/secrets-exposure` corpus (MIT) — our nuclei adapter just needs to keep using that path.
3. Nuclei's secret templates (MIT) plus gitleaks cover static-file/UI-leak cases; write a dedicated "what could a leaked key open" fixture only if a provider uses niche SDK keys.

## Class G — JWT / DOM-context privilege gaps

1. **jwt-hack** — `github.com/hahwul/jwt-hack`, **MIT**, Rust (v2 rewrite, 2025) with strong active maintenance (pushed 2026-10); available in Homebrew core. Decode/verify/JWE, plus an explicitly-typed `payload` mode for alg confusion, jku/x5u injection, **claims tampering, signature (ECDSA-style) malleability**, kid injection; and a `scan` mode that boxes up all common JWT weaknesses + a dict/brute cracker for secret-based tokens. Why the gap: this is precisely the verified:false / claim-tampering shift we're already doing by hand. Install: `brew install jwt-hack` (homebrew core, Apple Silicon; a Homebrew formula already exists) — no npm, no python, typed CLI from day one. Adapter: `jwt-hack decode <jwt> --json`, `jwt-hack payload <jwt> --claims '{"verified":"true"}' --secret=<tampered-signature>` → feed result into our HTTP client lane. It also ships an MCP server (`jwt-hack mcp`) if we ever want a non-CLI shape — keep for now as a runtime option.
2. **jwt_tool** — `github.com/ticarpi/jwt_tool`, **GPL-3.0** (confirmed), Python. The classic token-scanning kit (kid/jku dictionaries, report format). Marginal value vs jwt-hack; **reject** for now on license redundancy and weaker CLI ergonomics — revisit only if class G coverage proves thin in practice.

## Ranked by impact against this recurring pattern

| Rank | Tool | Class | License | Install (arm64 macOS, no npm/node) | Adapter note |
|---|---|---|---|---|---|
| 1 | jwt-hack | G | MIT | `brew install jwt-hack` (homebrew core) | Typed CLI; JSON decode; payload/scan; MCP available |
| 2 | jsluice | D (+F) | MIT | `go install github.com/BishopFox/jsluice/cmd/jsluice@latest` (no release assets; needs clang toolchain — **verify clean build on arm64**) | Real AST JS parsing; fix class D; feed class F lane |
| 3 | TruffleHog | F | AGPL-3.0 | `brew install trufflehog` | `--only-verified --json`; org scanning; use as subprocess, never embed |
| 4 | wafw00f | C | BSD-3-Clause | `uv tool install wafw00f` | `-a <url>` → fingerprint verdict + behind-cloudflare boolean |
| 5 | censys CLI | C | Apache-2.0 | `uv tool install censys` + API creds | `censys search` for origin-hypothesis; reliability caveat 2025–2026 |
| 6 | nemesida-waf/waf-bypass | C | MIT | `uv tool install git+https://github.com/nemesida-waf/waf-bypass` **(PyPI unverified)** | Bypass-corpus scanner; wire proxy to fingerprint lane |
| 7 | martenson-disposable-email-domains | E | CC0 (via repo; **verify license file rendering**) | `curl` into config | Typed list adapter; provenance fields |
| 8 | LinkFinder | D | MIT | `uv tool install git+…/LinkFinder` **(PyPI unverified; source build fine)** | Fallback regex JS endpoints; overlap with jsluice |
| 9 | FlareSolverr | C | MIT | docker/uv run | **(uncertain)** cf_clearance jar provider; likely redundant with stealth-browser lane |

Explicit non-recommendations with reasons: byp4xx (no license file), GitDorker (no license file), CF-Hero (no license visible), CloudFlair (abandoned, Censys v1), jwt_tool (GPL redundancy vs jwt-hack), hakrawler (GPL-3, overlap with katana/jsluice; add only when a spare crawl is demonstrably needed), WhatWeb (GPL-2.0, overlap with httpx/wafw00f), bogdanfinn/tls-client (library only — requires us to compile a wrapper; defer).

## Marked uncertain / open items

- jsluice arm64 source build (tree-sitter C compile) — no clean testimonial found; first thing to verify at install time.
- Origin-IP discovery reliability 2025–2026: Censys-based approaches have widely degraded accuracy; treat as passive leads only, never as proof of a working origin.
- Waf-bypass and LinkFinder PyPI packaging — unverified; source-git install is the fallback.
- disposable-email-domains main repo license — API says NOASSERTION, README suggests CC0; verify before mixing lists.
- OpenAPI-spec-discovery standalone tool: no clean maintained CLI found in this pass; open gap.
- TruffleHog one-line shell install path — verify the current URL upstream at deploy.

## Update 2026-10-22 — turnstile solver evaluated live (macOS arm64)

The baseline above is stale: obscura and patchright were purged, and browser work now runs through the single typed `browser` tool on the CloakBrowser engine. Against that baseline, the external solver `B00H0O/cloudflare-solver` (Rust, MIT, zero deps, raw-CDP daemon) was built and tested locally:

- `cargo build --release` clean on darwin/arm64 (~700KB binary); daemon healthy on `PORT=4077` driving the CloakBrowser Chromium via `CHROME_BIN`.
- `POST /turnstile` against the solver's own documented example (bypass.city) returned a real token in ~4s (length 816).
- With `COWBIRD_SOLVER_URL=http://localhost:4077`, cowbird acquired addresses from both solver-gated providers: `zenvex` (stateless) and `cftempmail` (stateful, state blob stored out of band).

**Verdict: adopt as a mailgen companion daemon, not as a typed tool.** It unlocks the two cowbird providers whose domains dodge the disposable-domain filtering that blocks mail.tm-style inboxes — that is capability the in-house lane does not have. It does not replace the `browser` tool's turnstile/clearance harvest, which stays the lane for target-site challenges (token single-use, clearance jar + matching UA). Run it headed (`HEADLESS=0`) as a local daemon only when a signup flow needs those providers; no adapter surface needed. Secret discipline held: token and state values were checked by length and prefix only.
