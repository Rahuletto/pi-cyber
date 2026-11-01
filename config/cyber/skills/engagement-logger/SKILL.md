---
description: "Continuous engagement logging protocol: auto-maintains continuous.md per engagement, 8 entry types, intent-before-execution protocol, state snapshots, cross-session resume. Load at the start of every engagement."
---

# SKILL — engagement-logger

## Purpose
Govern how the agent maintains `continuous.md` throughout every engagement. The log is the single source of truth for everything that happened, in order. It survives session resets, compaction, and context loss. Every action is logged before execution (intent) and after (result). Nothing is kept only in memory.

## Log file location

```
~/recon_[YYYYMMDDTHHMMSS]_[sanitized_domain]/continuous.md
```

`continuous.md` is the **first file written** in Phase 0. It is **append-only** — entries are never edited or deleted. Corrections are written as new NOTE entries below the original.

## Entry format

Every entry:
```markdown
---
[ENTRY_TYPE] [sequence_number] · [ISO-8601 timestamp]
---
<content>
```

Sequence number: monotonically increasing integer, padded to 4 digits (0001, 0002, ...).

## 8 entry types

### PHASE-START / PHASE-COMPLETE
```markdown
---
PHASE-START 0001 · 2026-11-01T08:30:42Z
---
**Phase:** 0 — Setup
**Target:** example.com (resolved: 93.184.216.34)
**Objective:** Create workspace, verify toolchain, parse target
```

```markdown
---
PHASE-COMPLETE 0008 · 2026-11-01T08:34:11Z
---
**Phase:** 0 — Setup
**Duration:** 3m 29s
**Key outputs:** <bullet list>
**Next phase:** 1 — Passive Reconnaissance
```

### COMMAND-INTENT (before every command)
```markdown
---
COMMAND-INTENT 0009 · 2026-11-01T08:34:15Z
---
**Tool:** subfinder
**Purpose:** Passive subdomain discovery
**Command:**
```bash
subfinder -d example.com -all -silent -o recon/subdomains/subfinder.txt
```
**Output file:** recon/subdomains/subfinder.txt
**Expected:** Subdomains via CT logs and OSINT sources
```

### COMMAND-RESULT (immediately after every command)
```markdown
---
COMMAND-RESULT 0010 · 2026-11-01T08:34:44Z
---
**Ref:** COMMAND-INTENT 0009
**Exit code:** 0  |  **Duration:** 28s
**Output (truncated — full: recon/subdomains/subfinder.txt):**
```
dev.example.com
api.example.com
```
**Observations:** Two subdomains via CT logs. dev warrants investigation.
```

### FINDING
```markdown
---
FINDING 0031 · 2026-11-01T09:14:52Z
---
**ID:** FIND-004
**Title:** Directory listing enabled on /backup/
**Severity:** HIGH  |  **Status:** confirmed  |  **CWE:** CWE-548
**Where:** https://example.com/backup/
**How found:** ffuf → 200 → curl confirmed Apache directory index
**Proof:** <exact request/response excerpt>
**Impact:** Unauthenticated access to 142MB DB backup and 4.2MB config archive
**Next step:** Download both archives → extract credentials
**Evidence file:** vulns/confirmed/FIND-004-directory-listing.md
```

### CREDENTIAL (raw values go to loot/credentials/ ONLY — never inline)
```markdown
---
CREDENTIAL 0047 · 2026-11-01T09:31:07Z
---
**ID:** CRED-003
**Type:** Database password (MySQL)
**Raw file:** loot/credentials/CRED-003.txt
**Fingerprint:** sha256:a3f8...c912
**Found in:** db_backup.sql.gz → config/database.php line 14
**Accesses:** MySQL on 10.0.1.5:3306, database app_production, user app_user
**Status:** untested
```

### NOTE (observations, hypotheses, dead ends, pivots, corrections)
```markdown
---
NOTE 0022 · 2026-11-01T09:02:18Z
---
**Type:** hypothesis | dead-end | correction | pivot
**Content:** <observation or reasoning>
**Follow-up action:** <what to do next>
```

### EVIDENCE (HTTP exchanges, command output, artifact references)
```markdown
---
EVIDENCE 0033 · 2026-11-01T09:15:44Z
---
**ID:** EVID-007
**Type:** http-exchange | command-output | artifact-download
**For finding:** FIND-004
**Artifact path:** loot/data/db_backup.sql.gz
**sha256:** e3b0c44...
```

### CHAIN
```markdown
---
CHAIN 0071 · 2026-11-01T10:12:04Z
---
**ID:** CHAIN-001
**Title:** Directory listing → DB backup → credential reuse → RCE
**Severity:** CRITICAL  |  **Status:** partially-confirmed (steps 1-3 confirmed; step 4 in progress)
**Steps:**
1. [CONFIRMED] FIND-004 — /backup/ directory listing
2. [CONFIRMED] CRED-003 — DB backup contained MySQL credentials
3. [CONFIRMED] FIND-005 — Same password reused for admin panel
4. [IN-PROGRESS] Admin file upload → webshell → RCE
**Chain document:** vulns/confirmed/CHAIN-001.md
```

## Real-time logging protocol

1. Write COMMAND-INTENT **before** every command — no exceptions
2. Write COMMAND-RESULT **immediately after** every command
3. When a finding is suspected → write FINDING with `Status: candidate`
4. After validation → write FINDING with `Status: confirmed` (or NOTE `Type: dead-end`)
5. When a credential is found → write raw value to `loot/credentials/CRED-XXX.txt` first, then CREDENTIAL entry (redacted)
6. When findings connect → assess for CHAIN, write CHAIN entry
7. Write STATE-SNAPSHOT at end of every phase

## STATE-SNAPSHOT (end of every phase)

```markdown
---
STATE-SNAPSHOT 0082 · 2026-11-01T10:15:00Z
---
**Phase just completed:** 3 — Access

### Live Hosts
| IP | Hostname | Notes |

### Open Ports & Services
| Host | Port | Service | Version |

### Confirmed Findings
| ID | Title | Severity | Status | Evidence |

### Credential Inventory
| ID | Type | Accesses | Status |

### Active Chains
| ID | Title | Status | Blocking on |

### Current Access Level
<what has been gained>

### Next Priority Actions
1. <highest priority next step>

### Blockers
<anything blocking progress, or "none">

### Rejected Paths
<what was tried and ruled out>
```

## Cross-session resume protocol

When given a target with an existing workspace:
1. `ls ~/recon_*_[sanitized_domain]/` — find most recent directory
2. Read last STATE-SNAPSHOT in `continuous.md`
3. Read last 50 log entries
4. Write a RESUME entry
5. Continue from "Next Priority Actions" in the last snapshot — do not re-run completed phases

```markdown
---
RESUME 0083 · 2026-11-01T14:22:05Z
---
**Session resumed after:** 4h 7m gap
**Last snapshot:** STATE-SNAPSHOT 0082 (Phase 3 complete)
**Last action before gap:** COMMAND-RESULT 0081 (file upload bypass — .php.jpg returned 500)
**Resuming from:** CHAIN-001 step 4 — file upload extension bypass
**First action this session:** Try PHAR extension bypass on file upload
```

## Finding registry (top of continuous.md — updated on every new confirmed finding)

```markdown
## FINDING REGISTRY
*Last updated: <timestamp> — N findings*

| ID | Title | Severity | Status | Phase | Evidence |
|----|-------|----------|--------|-------|----------|
```

## Credential registry (top of continuous.md — below finding registry)

```markdown
## CREDENTIAL REGISTRY
*Last updated: <timestamp> — N credentials*

| ID | Type | Source | Accesses | Raw file | Status |
|----|------|--------|----------|----------|--------|
```

Raw credential file format (`loot/credentials/CRED-XXX.txt`):
```
ID: CRED-003
Type: MySQL password
Username: app_user
Password: [RAW VALUE]
Host: 10.0.1.5:3306
Database: app_production
Found: <timestamp>
Found in: <file and location>
Tested: yes/no
Result: valid/invalid
```

## Activation checklist

When this skill is active:
1. Create workspace and `continuous.md` before any other action
2. Write `PHASE-START 0001` as the very first log entry
3. Write `COMMAND-INTENT` before every command — no exceptions
4. Write `COMMAND-RESULT` immediately after every command
5. Keep FINDING REGISTRY and CREDENTIAL REGISTRY updated at top of file
6. Write `STATE-SNAPSHOT` at end of every phase
7. On resume: read log, find last snapshot, write RESUME entry, continue
8. Raw credential values go to `loot/credentials/` only — never inline
9. Never delete or overwrite any log entry — append-only always
10. Never label commands as "recon attack" or "red team scan" — use tool names and flags
