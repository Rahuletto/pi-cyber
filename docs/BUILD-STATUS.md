# Build status

This status applies to the merged `feat/toolchain-buildout` tree. It distinguishes code present in the repository from capabilities exercised on this machine.

## Implemented in the extension

- `/offense`, `/defense`, and `/cyber status|checkpoint|mode …`; offense is the fresh-session default. The theme stays blue in both modes and the mode badge carries the distinction.
- `cyber_state` for branch-aware engagement scope, objective, mode-specific coverage, evidence references and next steps.
- Typed tools for the pinned scanner adapters, serialized job tracking, bounded evidence storage, Obscura browser leases and local-corpus FTS search.
- A separate optional AST search/edit extension and a loopback-only Cyberbench fixture with intentionally seeded access-control and file-upload flaws.
- Specialist task/result contracts and role templates, plus four exact package pins, an isolated profile, explicit DuckDuckGo search configuration and worker spawn caps.

## Verification boundaries

- On 2026-10-21, `bun install --frozen-lockfile`, `bun run install:packages`, `bun run typecheck`, and `bun test` passed: 250 passed, 0 failed, 4 skipped across 19 files.
- `bun run doctor -- --json` reports 15/17 core scanner binaries as validated on this machine. A fresh installer retry skipped those 15 and could not match Darwin/arm64 assets for Zap or Semgrep; both remain cataloged. Doctor reports PATH presence and recorded installer state; it does not execute a tool or prove target behavior.
- The four package versions, local Pi profile paths, selected bigpowers skill copies, worker spawn caps and no-network package wiring checks passed. `pi list` resolved all four local package paths. Pi's interactive extensions, provider calls and a real worker call were not exercised.
- Knowledge search covers the local indexed skills/research/docs corpus after an explicit rebuild. It does not claim a complete or automatically refreshed OWASP, CWE, CVSS or ATT&CK mirror.
- Browser lease behavior is a coordination contract. It does not provide process isolation, authenticated browser profiles, or proof that an external browser MCP is connected.
- Specialist Markdown files and task/result validation do not establish that `pi-subagents` is installed, that workers inherit all intended context, or that concurrency/cancellation is enforced by the harness.
- Network scanning, third-party package runtime compatibility, native Node execution, real provider calls and authenticated browser workflows require separate operator verification.

## Open operational checks

1. Launch Pi with `bun run pi`; inspect loaded resources and confirm the configured web provider is available.
2. Confirm model sign-in in that profile and test one bounded child task with context and tool grants.
3. Connect the selected browser MCP and validate a signed-out/member/admin flow against Cyberbench.
4. Run the documented first engagement against `127.0.0.1` only, then inspect the recorded evidence and remediation handoff.
5. Review platform-specific tool validation results; keep every unavailable, skipped or unsupported executable visible in doctor output.

No external target is configured. Mode prompts and package tool schemas are workflow controls, not an operating-system sandbox or general authorization boundary.
