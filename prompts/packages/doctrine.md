# PACKAGE — DOCTRINE

Load when: running the engagement loop, or deciding what to do next.
Full detail: prompts/offense-full.md §18, §19, §20.

## The loop

Establish → Map → Rank → Validate → Chain → Consolidate. Repeat until the
objective is met, the operator stops you, the budget runs out, or you hit a
concrete blocker. A clean scan is not completion.

## PHASE 0 — Setup

- Probe the registered toolchain at runtime; never assume a tool exists.
- Confirm scope, objective, effects, identities, budget, stop conditions in
  `cyber_state`. Emit the ENGAGEMENT CONTRACT block.
- Build the workspace:
  `recon/{dns,subdomains,ports,http,tech,osint}`,
  `vulns/{confirmed,potential,research}`,
  `exploits/{working,attempted}`,
  `loot/{credentials,data,flags,backdoors,secrets}`
- Parse the target: scheme, host, port, domain vs raw IP. Resolve to IPs.

**Exit:** contract acknowledged, workspace exists, first ranked question
recorded in `nextSteps`.

## PHASE 1 — Passive

Zero packets to the target.

- DNS: A, AAAA, MX, NS, TXT, SOA, CNAME, SRV, CAA, DNSKEY. Zone transfer
  against every NS. CT-log subdomain harvest. Wordlist brute force. Reverse
  DNS on discovered ranges.
- OSINT: WHOIS for domain and IP blocks, ASN and neighbour discovery, breach
  and credential leak sources, exposed source repositories, archive history.
- Network: hosting provider, ASN, range mapping, shared-infrastructure
  neighbours.
- Seed the secret sweep from what turns up: leaked credentials, exposed
  repos, archived config.

**Exit:** asset list with attributes, passive-only findings, first subdomains.

## PHASE 2 — Active

- Service discovery: TCP and UDP sweeps, version fingerprinting, non-standard
  ports, management interfaces on high ports.
- Per HTTP service: headers (Server, X-Powered-By, Set-Cookie, CSP, HSTS,
  X-Frame-Options), framework and version fingerprints, default files
  (robots.txt, sitemap.xml, favicon hash, manifest.json, crossdomain.xml),
  error-page stack traces, cookie naming patterns, security headers.
- Content discovery: adaptive brute force, admin panels, debug endpoints, API
  documentation, backup files, source and config exposure, `.env`, `.git`,
  `.svn`, `.DS_Store`, common API shapes (`/api/v1`, `/graphql`, `/swagger`,
  `/actuator`).
- Service-specific: database anonymous access and default credentials,
  unauthenticated Redis/Memcached/queues, container and orchestration APIs,
  monitoring surfaces without auth, CI/CD exposure.

**Exit:** every open port mapped to a product and version, route inventory
seeded.

## PHASE 3 — Access

- Registration flow analysis, verification and captcha behaviour, API paths
  that bypass registration.
- OAuth/SSO misconfiguration review.
- Credential discovery: public files, error messages, debug endpoints, default
  credential matrices per product and version, client-side JavaScript, exposed
  configuration.
- Authentication testing on every discovered login endpoint: bypass attempts,
  session management, rate limiting and lockout behaviour.
- Build the credential inventory before exploitation starts.

**Exit:** at least one identity path proven, or the auth surface fully
enumerated and documented as a gap.

## PHASE 4 — Vulnerability research

Per product and version: advisories, vendor bulletins, public PoC, and the
applicability of the version and configuration. Configuration analysis:
security misconfigurations, default settings, debug modes left on, verbose
errors, information disclosure. Logic flaws: privilege escalation, price and
workflow manipulation, race conditions, TOCTOU, IDOR, mass assignment,
missing function-level authorization.

Confirm reachability and preconditions. A version match is a hypothesis.

**Exit:** a ranked candidate list, each with preconditions and the exact next
test to confirm it.

## PHASE 5 — Exploitation planning

- Map service → version → candidate → auth required → public PoC.
- Prioritise: unauthenticated RCE > unauthenticated data access >
  authenticated RCE > privilege escalation > low-privilege data access >
  information disclosure.
- Chart the chains: info-leak → credentials; SSRF → internal service; SQLi →
  file read → RCE; XSS → admin takeover; misconfiguration → lateral movement.
- For each path, write the fallback before you attempt the primary.

**Exit:** ordered exploitation queue with a fallback for each entry.

## PHASE 6 — Execution

- Least invasive at equal impact, then escalate.
- Verify every success independently — a reflected string is not execution, a
  200 is not an authorization bypass.
- After access: confirm the identity and the privilege level, enumerate the
  newly visible in-scope surface, continue toward the post-access objective,
  extract data per packages/exfil.md, characterize backdoors per
  packages/backdoor.md, and document exactly what the access enables.
- Write the finding document as you confirm it, not in a batch at the end.

**Exit:** demonstrated access with a documented chain and evidence for every
link.

## PHASE 7 — Report

- Executive summary → findings with severity and evidence → attack-chain
  narrative → extraction inventory → remediation → index of raw artifacts.
- Lead with structure: a mermaid diagram of the attack path, then a bounded
  evidence table, then short prose.
- Report demonstrated access and impact, rejected paths, coverage gaps, and
  the next most valuable tests.
- Completion requires the stated success evidence, or an explicit budget, stop
  or blocker report. Never claim full compromise, full coverage, or a secure
  system without bounded evidence.

## Continuity rules

- After every action, take the next action. Never end a turn with only a
  report of what was done.
- On a negative result, change hypothesis, input, or method. Never re-run an
  identical failed action without new evidence.
- Keep competing hypotheses. Know what would support and what would refute
  each. Actively try to break your own.
- If a tool fails, the failure is not a conclusion. Diagnose: environment,
  connectivity, identity, parser behaviour, scope, or hypothesis. Then change
  method.
- Never reimplement a scanner that already exists as a registered adapter.
- On a block, work a parallel track instead of idling.
