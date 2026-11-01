---
description: "Professional pentest report generation: full engagement reports, single finding documents, executive summaries, evidence formatting, CVSS scoring, remediation tracking. Use when documenting findings or generating reports."
---

# SKILL — report-gen

## Purpose
Generate professional, evidence-backed penetration test reports from raw findings. Every claim has an evidence reference. Every remediation is specific and actionable.

## When to load
- Engagement is complete and findings need documenting
- Asked to generate, write, or format a pentest report
- Need a finding document for a single vulnerability
- Need to format evidence, request/response pairs, or extraction receipts
- Need an executive summary or remediation tracker

## Severity rating

| Severity | CVSS Range | SLA |
|---|---|---|
| Critical | 9.0–10.0 | Fix immediately / within 24h |
| High | 7.0–8.9 | Fix within 7 days |
| Medium | 4.0–6.9 | Fix within 30 days |
| Low | 0.1–3.9 | Fix within 90 days |
| Informational | N/A | Fix at discretion |

CVSS vector shorthand: AV(N/A/L/P) / AC(L/H) / PR(N/L/H) / UI(N/R) / S(U/C) / C(N/L/H) / I(N/L/H) / A(N/L/H)

## Full engagement report structure

```markdown
# Penetration Test Report
Target: <scope>  |  Report date: <date>  |  Test period: <start> to <end>
Classification: CONFIDENTIAL

## 1. Executive Summary
### Overall risk rating: [CRITICAL / HIGH / MEDIUM / LOW]
<One paragraph: most severe finding and business impact in plain language.
What can an attacker do — not what the vulnerability is called.>

### Key findings summary
| # | Title | Severity | Status |
|---|---|---|---|

### Top remediation priorities
1. [Immediate] <action> — prevents <business impact>
2. [This week] <action>
3. [This month] <action>

## 2. Scope and Methodology
### In-scope targets | Out-of-scope | Testing approach | Phases executed

## 3. Attack Chain Narrative
<Story of the compromise — starting point to highest impact.
Include mermaid diagram:>
graph LR
  A[Internet attacker] --> B[Discovery]
  B --> C[Initial access]
  C --> D[Escalation]
  D --> E[Full compromise]

## 4. Findings
### F-01: <Title>
Severity: Critical  |  CVSS: 9.8 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H)
CWE: <N>  |  CVE: <if applicable>  |  Affected: <URL/component>
Evidence IDs: E-01, E-02  |  Status: Open

#### Description
<What the vulnerability is, why it exists, where it is located.>

#### Evidence
<Exact request/response or command output>

#### Impact
<What an attacker gains — specific and demonstrated>

#### Steps to reproduce
1. <step>

#### Remediation
<Specific fix — not "sanitize input" but the exact code/config change>

## 5. Evidence Index
| ID | Type | Description | Location | SHA256 |
|---|---|---|---|---|

## 6. Remediation Tracker
| ID | Title | Severity | Fix | Effort | Priority | Status |
|---|---|---|---|---|---|---|

## 7. Appendix
Tools used | Methodology reference | Glossary
```

## Single finding document

```markdown
# FINDING: <title>
Date: <date>  |  Status: confirmed

## Summary
<One sentence: what it is and where it is>

## Severity
<Critical/High/Medium/Low>  |  CVSS: <score> (<vector>)

## Affected component
<exact URL, IP, parameter, function>

## Evidence
<exact request + response>

## Impact
<what an attacker can do>

## Remediation
<specific fix>

## References
<CVE, advisory, CWE>
```

## Evidence formatting standards

### HTTP request/response
```
=== REQUEST ===
POST /api/login HTTP/1.1
Host: target.com
Content-Type: application/json
{"username":"admin'--","password":"anything"}

=== RESPONSE ===
HTTP/1.1 200 OK
{"token":"eyJ...","role":"admin"}
```

### Command execution proof
```
=== COMMAND ===
curl "http://target.com/shell.php?cmd=id"

=== OUTPUT ===
uid=33(www-data) gid=33(www-data) groups=33(www-data)
```

### File extraction receipt
```
=== FILE EXTRACTED ===
Source:  /opt/app/.env
Method:  LFI via ?file=../../../../opt/app/.env
Size:    847 bytes
SHA256:  a1b2c3d4...
Stored:  loot/data/env-file.txt
```

## Output format
- Primary: `report.md` in engagement workspace root
- All evidence in `loot/` with SHA256 hashes
- Convert: `pandoc report.md -o report.pdf --pdf-engine=wkhtmltopdf`

## Rules
- Every finding needs at minimum one evidence reference — no undocumented claims
- Distinguish observed from inferred
- Remediation must be specific — exact code, config, or command
- Executive summary is for non-technical readers — no CVE IDs, no jargon
- Never include raw secrets in the report — use `[REDACTED — see loot/credentials/X.txt]`
- All evidence files should have SHA256 hashes recorded
