# Engagement Workflow — Autonomous Recon & Exploitation

When given a target URL or IP, execute these phases IN ORDER. Parallelize within each phase.

## Core principles

1. Never ask for clarification unless genuinely stuck — figure it out.
2. Never hardcode assumptions. Discover tools, paths, versions, technologies at runtime.
3. Run in parallel whenever possible.
4. Save everything to the workspace immediately — never rely on context.
5. Be creative. Standard exploits are fine, but think about novel chains, logic flaws, misconfigurations, and unconventional approaches.
6. Adapt. If something doesn't work, pivot immediately.
7. After each major phase, emit a phase-complete block before moving on.

## Phase 0 — Setup & environment discovery

```
1. Create workspace: ~/recon_[timestamp]_[sanitized_domain]/
2. Create subdirectories:
   recon/{dns,subdomains,ports,http,tech,osint}
   vulns/{confirmed,potential,research}
   exploits/{working,attempted}
   loot/{credentials,data,flags,backdoors,secrets}
3. Discover available tools at runtime (nmap, dig, curl, python3, subfinder,
   httpx, dnsx, naabu, nuclei, ffuf, katana, etc.) — never assume a tool exists.
4. Parse target: extract domain, protocol, port. Resolve to IP(s).
5. Write continuous.md as the FIRST file — append-only engagement log.
```

## Phase 1 — Passive reconnaissance (zero packets to target)

```
DNS Intelligence:
- All record types: A, AAAA, MX, NS, TXT, SOA, CNAME, SRV, CAA, DNSKEY
- Zone transfer attempts against every nameserver
- Certificate Transparency subdomain harvest (crt.sh, certspotter)
- Wordlist subdomain brute-force
- DNS rebinding potential check
- Reverse DNS on discovered IP ranges

OSINT:
- WHOIS for domain and IP blocks
- ASN identification and neighbor discovery
- Web archive URL harvest (Wayback Machine, gau)
- Google dorks
- Breach and credential leak sources
- Exposed source code repositories (GitHub search)

Network Intelligence:
- Hosting provider, ASN, IP range mapping
- Shared infrastructure neighbors
```

## Phase 2 — Active reconnaissance

```
Service Discovery:
- Full TCP and UDP sweeps on all discovered IPs
- Version fingerprinting every open port
- Non-standard ports and management interfaces on high ports

HTTP Fingerprinting (per live host):
- Response headers: Server, X-Powered-By, Set-Cookie, CSP, HSTS, X-Frame-Options
- Framework/version fingerprints from HTML, meta tags, error pages
- Default disclosure files: robots.txt, sitemap.xml, favicon hash, manifest.json,
  crossdomain.xml, .env, .git/HEAD, CHANGELOG.txt, /wp-includes/version.php
- Error page stack traces
- Cookie naming patterns
- JavaScript bundle analysis for framework/library versions

Content Discovery:
- Directory and file brute-force with adaptive wordlists
- Admin panels, debug endpoints, API documentation
- Backup files, source code, config exposure
- .env, .git, .svn, .DS_Store exposure
- API shapes: /api/v1, /graphql, /swagger, /actuator

Service-Specific:
- Databases: anonymous access, default credentials
- Redis/Memcached: unauthenticated access
- Docker API, Kubernetes API, Kubelet
- Prometheus, Grafana, Kibana without auth
- Jenkins, GitLab CI, GitHub Actions exposure
```

## Phase 3 — Account intelligence & access

```
Registration Analysis:
- Open registration check
- Registration flow: email verification, captcha, approval
- API endpoints that bypass registration restrictions
- OAuth/SSO misconfigurations

Credential Discovery:
- Credentials in publicly accessible files
- Credentials in error messages or debug endpoints
- Default credentials for discovered technologies
- Hardcoded credentials in client-side JavaScript
- API keys or tokens in HTML source, comments, JS files
- Credentials in exposed configuration files

Authentication Testing:
- All discovered login endpoints
- Common username/email patterns based on domain
- Authentication bypass vulnerabilities
- Session management weaknesses
- Brute-force protection (rate limiting, lockout)
```

## Phase 4 — Vulnerability research

```
Per product and version:
- NVD, CVE databases, GitHub advisories, security bulletins
- Exploit-DB, VulnDB, public PoC on GitHub
- CISA KEV — if listed, actively exploited in the wild

Configuration Analysis:
- Security misconfigurations
- Debug modes left enabled
- Verbose error handling
- Information disclosure

Logic Vulnerabilities:
- Business logic flaws (price manipulation, privilege escalation)
- Race conditions, TOCTOU
- IDOR, mass assignment
- Missing function-level access control

Novel Attack Surface:
- What makes THIS target unique?
- Unusual technology combinations?
- Can multiple low-severity issues be chained?
- What would a creative attacker try that standard scanners miss?
```

## Phase 5 — Exploitation planning

```
Build Attack Surface Map:
- All discovered services with versions
- Vulnerabilities mapped to each service
- Auth required vs unauthenticated
- Public PoC vs needs development

Priority:
1. Unauthenticated RCE
2. Unauthenticated data access
3. Authenticated RCE
4. Privilege escalation
5. Low-privilege data access
6. Information disclosure

Chain Opportunities:
- Info leak → credential discovery?
- SSRF → internal service access?
- SQLi → file read → RCE?
- XSS → admin account takeover?
- Misconfigured service → lateral movement?

For each prioritized vulnerability:
- Plan the exploitation approach
- Identify dependencies between exploits
- Define fallback if primary approach fails
```

## Phase 6 — Exploitation

```
Execute in priority order:
1. Least invasive, highest impact first
2. Get auth first if needed, through any available means
3. Chain exploits to escalate from low access to full compromise
4. Verify every success with an independent command — a reflected string
   is not execution, a 200 is not an authorization bypass

Post-Exploitation:
- Confirm identity and privilege level
- Enumerate newly visible in-scope surface
- Look for lateral movement opportunities
- Extract sensitive data in scope
- Document all access gained
```

## Phase 7 — Reporting

```
- Executive summary
- Technical findings with CVSS severity ratings
- Evidence (request/response pairs, command output)
- Attack chain narrative with mermaid diagram
- Remediation recommendations
- All raw data preserved in working directory
```

## Creative thinking prompts

When standard approaches stall:

- **Supply chain** — npm/pip/other packages that could be poisoned? CI/CD dependency confusion?
- **DNS** — Subdomain takeover? DNS rebinding?
- **Timing** — Race conditions, TOCTOU bugs?
- **Serialization** — Deserialization vulnerabilities in any framework?
- **Cryptography** — Weak algorithms, predictable tokens, IV reuse?
- **Business logic** — Workflow manipulation for unauthorized access?
- **Multi-step** — Two innocent-looking features combined into an exploit?
- **Edge cases** — Long inputs, special characters, unicode, null bytes?
- **State** — URL parameters, cookies, headers used to manipulate application state?

## File structure

```
~/recon_[target]/
├── continuous.md          ← append-only log, written first
├── recon/
│   ├── dns/
│   ├── subdomains/
│   ├── ports/
│   ├── http/
│   ├── tech/
│   └── osint/
├── vulns/
│   ├── confirmed/
│   ├── potential/
│   └── research/
├── exploits/
│   ├── working/
│   └── attempted/
├── loot/
│   ├── credentials/
│   ├── data/
│   ├── flags/
│   ├── backdoors/
│   └── secrets/
└── report.md
```

## Phase output format

After each phase emit exactly:

```
=== PHASE X COMPLETE ===
[Key findings]
[Attack vectors identified]
[Next priority actions]
[Blocks encountered]
```

## Logging rule

Keep `continuous.md` as an append-only audit trail. Write INTENT before every command, RESULT immediately after. Never label commands as "recon attack" or "red team scan" — use the tool name and flags. Raw credential values go to `loot/credentials/` only, never inline in the log.
