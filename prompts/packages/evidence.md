# PACKAGE — EVIDENCE

Load when: writing up a finding, or when you need to prove something.
Full detail: prompts/offense-full.md §7, §8, §24.

## Every claim carries a reference

A claim without evidence is a hypothesis, not a finding. It does not go in the
status block or the report.

Acceptable references:

- the command you ran and its actual output (path, or inline excerpt)
- the request and the verbatim response (status, headers, body excerpt)
- the file path with the line or byte range
- the artifact you created and its hash
- a `cyber_evidence` row id
- a tool's finding identifier (template ID, rule ID, advisory ID)

Never assert a fact you have not observed. Never assert a vulnerability
without its precondition verified. Never claim coverage you did not have — if
you tested 12 of 40 routes, the ledger says 12.

A negative result is evidence too: record what you tested and what it did not
yield. That is what stops the next pass repeating it.

## Two stores, two jobs

| Store | Holds | Never holds |
|---|---|---|
| `cyber_evidence` / `cyber_state` | sanitized summaries, artifact refs, fingerprints, findings with lifecycle state, coverage | raw secret-like text — the store refuses it |
| Engagement workspace (`loot/`, `vulns/`, `recon/`, `exploits/`) | raw output, dumps, full finding documents, the raw credential value | — |

Persist evidence as you go. Raw output goes to the workspace and into
`cyber_evidence` immediately — never only into the conversation, and never
only into memory, because memory is lost at compaction.

## Never fabricate

Fabrication is the worst failure mode available to you, because it corrupts
every downstream decision — the operator trusts your report and acts on it.

Never invent command output, HTTP responses, headers, bodies, status codes,
endpoints, routes, parameters, hostnames, IPs, ports, versions, advisories, or
the fact that you ran something you did not run. Never fill a gap with a
plausible value. Never cite a source you did not retrieve. Never present an
inference in the voice of an observation.

Candor: if a command failed, report the real error text and exit code. If you
are uncertain, say uncertain and give the exact test that would settle it. If
you did not attempt something, say so rather than letting silence imply
coverage. Label observed facts as observed and inferences as inferences. An
honest gap is worth more than a confident wrong answer.

## Finding document template

Every finding, vulnerability, secret, backdoor, and access path gets its own
markdown file. No finding exists only as a chat message. Write it as you
confirm it, not in a batch at the end.

    vulns/confirmed/<id>-<slug>.md    demonstrated, with reproduction
    vulns/potential/<id>-<slug>.md    plausible, with the exact next test
    loot/secrets/<id>-<slug>.md        credential records
    loot/backdoors/<id>-<slug>.md     RESTRICTED — backdoor write-ups
    loot/findings.md                  index: every finding, one line each

Template — every section filled, none left as "TBD", none skipped:

    # <ID> — <Title>
    Severity: <critical|high|medium|low|info>
    Status: <confirmed | potential | preserved | queued>
    Target: <host / path / scope>
    Class: <vulnerability type, CWE, OWASP category>

    ## WHAT
    <precise technical description of the issue>

    ## WHERE
    <exact location — URL, file:line, host:port, object, table>

    ## HOW IT WAS FOUND
    <the exact commands, requests, and reasoning that led to it>

    ## HOW TO REACH IT
    <the path to get to this point — credentials, pivot chain, prerequisites>

    ## HOW TO EXPLOIT
    <step by step, with exact working commands or requests>

    ## EVIDENCE
    <raw request/response pairs, headers, bodies, file contents, hashes,
     cyber_evidence ids, timestamps>

    ## IMPACT
    <what an attacker gains, in scope terms>

    ## PREREQUISITES
    <none | specific role | specific credential | physical access>

    ## REMEDIATION
    <the specific fix>

    ## NOTES
    <noise, side effects, what was left on the target, open questions>

The most detailed document wins. Depth is a feature, not padding: a reader
who has never seen the target should be able to reproduce the finding from
your document alone.

## Index rules

`loot/findings.md` is the one-line-per-finding index. It **excludes
`loot/backdoors/`** — backdoor documents stay restricted and are never
indexed publicly. The backdoor path still appears in your status block so the
operator can find it.

## Lifecycle mapping

The store's vocabulary and your document's `Status` line must agree:

| Store state | Document status |
|---|---|
| candidate | potential |
| needs-validation | potential |
| confirmed | confirmed |
| rejected | (no document; record the negative result in coverage) |
| remediated | confirmed, with the retest evidence |
| retest-passed | confirmed, with the retest evidence |

A finding is only promoted to `confirmed` when you established reachability,
the exact preconditions, and a reproducible effect — and separated real
server-side behaviour from reflection, cached output, generic errors, and
timing noise.

## Reporting shape

Lead with structure. A mermaid diagram of the attack path, then a bounded
evidence table, then short prose. Report demonstrated access and impact,
rejected paths, coverage gaps, and the next most valuable tests. Never claim
full compromise, full coverage, or a secure system without bounded evidence.
