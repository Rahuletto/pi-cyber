# Security Policy

Pi Cyber is an offensive security tool that runs on the operator's own machine
and points at systems the operator is authorized to assess. This policy
describes what counts as a vulnerability **in this repository**, how to report
one privately, and what is explicitly not covered.

Vulnerabilities in the systems you assess are not ours — see
[Reporting a vulnerability that is not ours](#reporting-a-vulnerability-that-is-not-ours).

## Supported Versions

The project is pre-1.0 and has no published release tags. The `main` branch is
the supported line, and an installation is effectively pinned by
`package.json`, `bun.lock`, and `tools/manifest.resolved.json`.

| Version | Supported | Notes |
| --- | --- | --- |
| `main` (0.1.x) | Yes | Current development line. Digest-pinned toolchain and pinned packages apply. |
| Older forks, local patches | No | Fixes are not backported. Track `main` and re-run `install.sh --check`. |

There is no LTS branch. Assume a fix lands on `main` and is picked up by
re-running the installer.

## Reporting a vulnerability

**Use GitHub private vulnerability reporting.** It creates a private advisory
thread visible only to you and the maintainer, and it is the fastest route to a
tracked fix.

- Report: <https://github.com/Rahuletto/pi-cyber/security/advisories/new>
- Fallback (if private reporting is unavailable): email
  **rahulmarban@gmail.com** with the subject `SECURITY: <short summary>`.

Please do not open a public issue for a suspected vulnerability. A public issue
is visible to everyone and may be exploited before a fix exists.

If you have already disclosed a vulnerability publicly, say so plainly in your
report. We will still triage it and credit you.

### What to include

A useful report contains:

1. **What is wrong** — the specific behavior that is incorrect or unsafe.
2. **Where** — the file, function, or tool parameter involved. A file path and
   line reference are ideal.
3. **How to reproduce** — exact steps, inputs, and configuration. If a specific
   target is needed, say so and describe it without needing to include live
   target data.
4. **Why it matters** — the impact for an operator running the harness. State
   it as a concrete consequence (a key written to a world-readable file, a
   parameter reaching a shell, an index poisoning an agent's instructions),
   not as a category name.
5. **Evidence** — logs, excerpts, or a minimal reproduction. Redact real
   credentials, tokens, and target data before sending.

### Response expectations

This is a volunteer-maintained project. These are the commitments we can make:

| Stage | Target |
| --- | --- |
| Acknowledgement of a complete report | 3 business days |
| Initial assessment (valid / invalid, severity) | 7 business days |
| Fix released for critical and high severity | 14 and 30 days respectively |
| Fix released for medium and low severity | Next release, at the maintainer's discretion |

We will keep you informed while the report is open, and we will credit you in
the advisory unless you ask us not to.

### Handling of a report

- Reports are handled in a private advisory thread until a fix and advisory are
  published.
- We will not share your identity or report details with third parties beyond
  the upstream projects that need the fix.
- If the report is invalid or out of scope, we will say so and explain why.
- If the report is already fixed upstream in a pinned dependency, we will
  coordinate the bump with you rather than patch around it.

## In scope

A vulnerability is in scope when it is a defect in code **shipped in this
repository** — the extension source, the installers, the profile configuration,
or the pinned package/skill copies.

Representative classes:

- **Command injection.** Any adapter, tool parameter, or configuration value
  that reaches a shell, an interpreter, or an environment variable in a way
  that allows injected commands to run. The job runner spawns argv-only via
  `Bun.spawn` and must keep it that way.
- **Path traversal or arbitrary file write.** Any identifier, filename, or path
  fragment that escapes its intended directory — engagement stores under
  `config/cyber`, the knowledge index, the toolchain under `~/.pi/scanners`, or
  the agent directory.
- **Secret disclosure.** Provider keys, `gh` tokens, scanner credentials, or
  engagement data written to logs, job records, evidence rows, the knowledge
  index, or a committed file; or written with permissions broader than the
  intended mode `600`.
- **Installer integrity.** A digest or checksum check that can be bypassed; a
  download that is executed without verification; a TOCTOU window in the
  temporary download path; writes outside the intended install roots; or
  credential files created with predictable names or weak permissions.
- **Indirect prompt injection.** Content reachable through the knowledge index,
  the indexed documentation, or an ingested document that can change the
  agent's instructions, exfiltrate engagement state, or suppress the scope and
  evidence-sanitization constraints.
- **Evasion of the harness's own constraints.** Any path that lets a tainted
  command reach execution, lets unredacted data reach the evidence store, or
  bypasses the secret refusal and coverage/state bookkeeping.
- **Unsafe defaults that create risk for the operator.** A default that
  enables telemetry, weakens digest pinning, exposes a local port, or leaks
  state outside the machine without an explicit opt-in.

## Out of scope

- **Third-party binaries.** Vulnerabilities in the scanner tools installed by
  `tools/install.sh` (ProjectDiscovery tools, `ffuf`, `semgrep`, `trivy`,
  `osv-scanner`, `gitleaks`, `syft`, `zaproxy`, `obscura`, `rea`, `ghidra`, …).
  Report these to their own maintainers; `tools/manifest.json` lists the
  upstream repository for each.
- **Third-party packages.** Vulnerabilities in `bigpowers`, `pi-btw`,
  `pi-subagents`, `pi-web-access`, `@earendil-works/pi-coding-agent`, or
  `@ast-grep/napi`. Report these upstream.
- **Findings in assessed systems.** A vulnerability you found in a target is
  that target's to fix. Report it to the target, not here.
- **The absence of a sandbox.** The harness is not an operating-system
  sandbox, not an authorization boundary, and does not enforce target scope on
  arbitrary shell commands or third-party extensions. This is documented
  behavior, not a vulnerability. Bypassing the constraints the harness *does*
  enforce is in scope; the fact that it cannot enforce everything is not.
- **Hardening suggestions without demonstrated impact.** Recommendations with
  no reproducible consequence in this project's threat model are treated as
  enhancement requests.
- **Untriaged automated scanner output.** A `nuclei`, `semgrep`, `trivy`, or
  `gitleaks` finding against this repository without reproduction steps and an
  impact statement.
- **Local-access attacks.** Anything that already requires the ability to run
  code as the operator on the operator's own machine.
- **Denial of service against third-party infrastructure**, and anything
  requiring excessive traffic, credential abuse, or persistence on systems the
  reporter does not own.

## Responsible use

Pi Cyber exists to support authorized assessments. Use it only on systems you
own or have written permission to test. Where the authorization is unclear or
informal, do not test.

This repository intentionally ships **no vulnerable demo target**. If you need a
lab, stand up your own deliberately vulnerable application and point the
harness at that.

### Reporting a vulnerability that is not ours

If you discover a vulnerability in someone else's infrastructure, do not report
it here. Report it to the system owner through their published disclosure
channel or security.txt, and to your national CERT or law-enforcement
authority where the law requires it. The maintainer of this project will not
act on findings in third-party systems, and no part of this repository grants
authorization for anything.

### Safe harbor

Good-faith research is welcome. If you follow this guidance, the maintainer
supports you and will not pursue action against you for your research:

- Comply with the law of your jurisdiction and any contract you are bound by.
- Only access systems you own or are authorized to assess, and only to the
  extent needed to demonstrate the issue.
- Avoid privacy violations, data destruction, and degradation of service.
- Do not exfiltrate data, establish persistence, or use the finding for
  anything beyond the report.
- Give the maintainer a reasonable opportunity to ship a fix before disclosing
  publicly.
- Do not misrepresent your affiliation or claim the maintainer's endorsement.

This safe harbor covers the research activity itself. It does not cover an
independent legal claim that the harness was used without authorization.

## Security-relevant defaults

These are the behaviors the project maintains today. A regression in any of
them is a security bug, and a report is welcome.

| Area | Default |
| --- | --- |
| Binary installs | Archive digest verified against `tools/manifest.resolved.json` before extraction and execution. |
| Process execution | Argv-only spawn, no shell string; stdin closed; output pipes capped. |
| Secret handling | Secret-pattern check on the full argv refuses before execution; evidence rows are sanitized before storage. |
| Credentials | Written with mode `600`; kept in the dedicated `config/cyber` profile, never in the repository. |
| Storage | Local SQLite for engagement state, evidence, and the knowledge index. No telemetry, no remote state. |
| Provider access | Explicit search provider only; no hosted extraction and no browser cookie access. |
| Subagents | Spawn caps enforced: 2 concurrent children, 8 per run, 16 per session. |

## Secrets and sensitive data

- If you find a leaked credential, key, or token anywhere — in this
  repository, in a log, in an evidence database, or on a public issue — report
  it privately and **do not** include the value in the report. Say which
  artifact and where it was found; redact the secret itself.
- Treat engagement databases, session files, and `config/cyber` as
  operationally sensitive. They are git-ignored by default, but a
  misconfigured workflow can still commit them.
- Rotate anything that is exposed. Assume a credential that reached a public
  channel is compromised, including when the channel is deleted.

## Acknowledgements

We thank our reporters. If you find something, please report it privately —
the fix is the priority, and the credit is yours if you want it.
