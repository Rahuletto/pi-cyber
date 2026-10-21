# Build status

This status applies to the merged `feat/toolchain-buildout` tree. It distinguishes code present in the repository from capabilities exercised on this machine.

## Implemented in the extension

- `/offense`, `/defense`, and `/cyber status|checkpoint|mode …`; offense is the fresh-session default. The theme stays blue in both modes and the mode badge carries the distinction.
- `cyber_state` for branch-aware engagement scope, objective, mode-specific coverage, evidence references and next steps.
- Typed tools for the pinned scanner adapters, serialized job tracking, bounded evidence storage, Obscura browser leases and local-corpus FTS search.
- A separate optional AST search/edit extension and a loopback-only Cyberbench fixture with intentionally seeded access-control and file-upload flaws.
- Specialist contracts and role templates, plus pinned package/profile setup. Package installation and worker-runtime behavior are reported separately from the role definitions.

## Verification boundaries

- The extension, parsers, job and evidence paths, browser lease state transitions, knowledge indexing, prompts and Cyberbench loopback tests are exercised by the local test suite when it passes on the final tree.
- `bun run doctor` reports PATH presence and recorded installer state. It does not execute a tool, verify its version, connect to a target or prove compatibility.
- Knowledge search covers the local indexed skills/research/docs corpus after an explicit rebuild. It does not claim a complete or automatically refreshed OWASP, CWE, CVSS or ATT&CK mirror.
- Browser lease behavior is a coordination contract. It does not provide process isolation, authenticated browser profiles, or proof that an external browser MCP is connected.
- Specialist Markdown files and task/result validation do not establish that `pi-subagents` is installed, that workers inherit all intended context, or that concurrency/cancellation is enforced by the harness.
- Network scanning, third-party package runtime compatibility, native Node execution, real provider calls and authenticated browser workflows require separate operator verification.

## Open operational checks

1. Install and inspect the pinned packages in the dedicated cyber profile; verify exact loaded resources and explicit search-provider configuration.
2. Confirm model sign-in in that profile and test one bounded child task with context and tool grants.
3. Connect the selected browser MCP and validate a signed-out/member/admin flow against Cyberbench.
4. Run the documented first engagement against `127.0.0.1` only, then inspect the recorded evidence and remediation handoff.
5. Review platform-specific tool validation results; keep every unavailable, skipped or unsupported executable visible in doctor output.

No external target is configured. Mode prompts and package tool schemas are workflow controls, not an operating-system sandbox or general authorization boundary.
