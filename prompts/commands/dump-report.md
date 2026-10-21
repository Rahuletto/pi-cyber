---
description: Stop all work, collect every recorded piece of context, and write the structured engagement report
argument-hint: "[--title <report title>] [--scope <finding|engagement|full>]"
---

Bring the engagement to a clean stop and write the report from the record, not
from memory.

## 1. Stop cleanly

- Abort any in-flight turn and any running job. `cyber_jobs` reports and
  stops jobs; use it to drain what is still running.
- Do not start new work after this point.
- Do not delete or alter evidence. This command reads, it does not clean.

## 2. Collect every piece of context

Read the whole record, not your recollection of it:

- `cyber_state` — scope, objective, coverage, evidence refs, next steps. The
  recorded brief is the authority on what the engagement was.
- `cyber_evidence` — every evidence row, the findings list, and the summary.
  Use the full read, not a recent slice.
- The engagement workspace on disk: `recon/`, `vulns/confirmed/`,
  `vulns/potential/`, `vulns/research/`, `exploits/working/`,
  `exploits/attempted/`, `loot/data/`, `loot/credentials/`,
  `loot/flags/`, `loot/backdoors/`, and `continuous.md`.
- The finding documents under `vulns/` and `loot/` — they hold the depth the
  store does not.
- `loot/findings.md` for the index.

If a file is referenced but missing, that is a finding about the record itself:
list it under `GAPS` rather than silently omitting it.

## 3. Write the report

`--scope finding` — one document per confirmed finding.
`--scope engagement` — the full engagement report (default).
`--scope full` — engagement report plus every finding document concatenated.

`--title` sets the report title; default to the engagement objective.

The report file is `report.md` in the engagement workspace. Use this structure:

    # <title>

    ## Executive summary
    What was attempted, what was demonstrated, what the access is worth, and
    the one or two things that matter most. Plain prose, no bullet soup.

    ## Scope and rules of engagement
    Approved targets, objective, permitted effects, identities, budget, stop
    conditions. What was explicitly out of scope and therefore not tested.

    ## Attack path
    A mermaid graph of the demonstrated chain, one node per access step, each
    labelled with the identity used and the evidence id. Follow with a table
    of the same chain: step, action, precondition, identity, privilege gained,
    evidence id.

    ## Findings
    One subsection per finding, in severity order. Each: title, severity,
    status, exact location, what it is, how it was found, how to reach it, how
    to exploit it, the evidence, the impact, the prerequisites, the
    remediation, and the notes. Link to the full document under `vulns/` or
    `loot/` rather than repeating it.

    ## Access and data obtained
    Identities reached, privilege levels, and what was extracted. Extraction
    receipts: source, record count, byte size, path, hash. Reference the
    files; do not paste the data.

    ## Credentials and secrets
    What was found, what it opens, where it lives, whether it was rotated.
    Report the value where the operator holds it and reference the artefact
    path. Never paste raw secret material into a shared artefact.

    ## Undocumented access paths
    Every backdoor found: mechanism, location, capability envelope, how it was
    reached, its noise profile, its destruction procedure, and that it is
    preserved intact and unpublished. Operator-only — this section does not go
    into a ticket or a shared report.

    ## Coverage
    What was tested, with denominators. What was not tested and why. What
    remains unknown and the exact observation that would settle it.

    ## Rejected paths and negative results
    The hypotheses that failed, and what ruled them out. This is what stops
    the next engagement repeating work.

    ## Remediation
    Ordered, per finding, with the exact change, the regression cases, and
    the retest acceptance criterion.

    ## Artifact index
    Every file this engagement produced, with its path and what it holds.

## 4. Report back

Return to the operator, in the chat:

- `REPORT` — the path written, and the finding count by severity.
- `DEMONSTRATED` — what access was proven, in three lines or fewer.
- `OPEN` — the unresolved items, each with the next test that would close it.
- `BLOCKERS` — anything that stopped a line of work, and what it needs.

Do not paste the report into the conversation. Give the path and the summary.

Never claim full compromise, full coverage, or a secure system without bounded
evidence. Completion is the stated success evidence, or an explicit statement
of what remains unproven and what it would take to prove it.
