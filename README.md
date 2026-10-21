# Pi Cyber Harness

A lean Pi extension harness for offense and defense investigation. It adds `/cyber` plus `/offense` and `/defense`, a structured `cyber_state` tool, typed scanner tools, serialized job tracking, evidence storage, browser-session leases, local knowledge search, mode instructions and durable session checkpoints. The theme stays blue in both modes; the mode badge is colored. Pi remains the agent runtime and its native tools and automatic compaction stay available.

See [the design](PI-CYBER-HARNESS-DESIGN.md), [build status](docs/BUILD-STATUS.md), and the [first local engagement](docs/FIRST-ENGAGEMENT.md). No external assessment target is configured. The included Cyberbench target binds only to loopback and is intentionally vulnerable.

## Run locally

Requires Bun for the development scripts. Pi 1.3.0 officially specifies Node >=22.19.0; this workspace's Node command is a Bun shim. The implementation and SDK fixtures were verified with Bun 1.4.3, not an independent Node installation or a live provider.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run doctor
bun run pi
```

Check pinned package wiring and refresh the selected profile skills after installation:

```sh
bun run packages
# read-only verification: bun run packages:check
```

The exact package pins are installed by `bun install --frozen-lockfile` and loaded only through `config/cyber`; see [package setup and limits](docs/PACKAGES.md). The profile checker does not copy personal provider credentials.

`bun run pi` uses the local pinned Pi CLI and defaults `PI_CODING_AGENT_DIR` to `config/cyber` in this directory. It explicitly loads this extension, preserving existing personal Pi configuration. Set `PI_CODING_AGENT_DIR` explicitly to choose another dedicated directory. Configure provider login there; this project does not copy personal credentials. Pi still uses its normal project trust and project instructions.

For use from another project directory, provide absolute paths:

```sh
PI_CODING_AGENT_DIR=/absolute/path/to/cyber-config \
  /absolute/path/to/this/package/node_modules/.bin/pi \
  -e /absolute/path/to/this/package/src/index.ts \
  --theme /absolute/path/to/this/package/themes
```

The package manifest also declares the extension and themes for Pi package loading. Internal prompt files are instruction layers; they are not registered as mode-changing slash templates.

## Commands and durable brief

```text
/cyber status
/cyber checkpoint
/cyber mode offense|defense
/offense
/defense
```

Fresh sessions default to offense; `mode.json`-less starts are offense, while a session with recorded checkpoints keeps its saved mode. `/cyber mode offense|defense` remains for compatibility, and the top-level `/offense` and `/defense` run the exact same guarded switch. Both modes render the same blue theme; the OFFENSE badge is red and the DEFENSE badge is blue in the status and notice lines. Mode switching requires an idle agent, no running native/nested tools, and no queued messages. Terminal theme restoration failures block subsequent tool calls until corrected; headless sessions require no UI.

Ask the coordinator to record the established scope and objective using `cyber_state`, then maintain investigation coverage, evidence references and next steps. Example tool input:

```json
{
  "action": "update",
  "patch": {
    "scope": ["operator-approved local fixture repository"],
    "objective": "Investigate access control and prepare remediation guidance",
    "coverage": ["Signed-out route checked; member/admin identities unavailable"],
    "evidenceRefs": ["evidence/route-01.redacted.txt"],
    "nextSteps": ["Obtain authorized role fixtures and trace the affected handler"]
  }
}
```

Use `{"action":"get"}` first: supplied lists replace prior values. Scope and objective are shared across modes. Coverage, evidence references and next steps are stored separately for each mode. Switching mode preserves the engagement's scope and objective. A mode does not authorize targets or effects. Scope recording is a workflow contract, not an authorization verifier.

Each update and mode change appends a complete versioned snapshot through Pi's session API. `/cyber checkpoint` snapshots only the already recorded brief; it does not summarize unrecorded tool output. Recovery follows the active session branch, including entries before compaction, so changing sessions or navigating the tree cannot inherit a different branch's brief. Pi writes a session file once a conversation exists; commands entered before the first user/assistant message are only held in its in-memory session until then.

The extension preserves Pi's native summarizer, automatic compaction settings and overflow retry. It adds the selected mode instructions at the start of a turn, and an ephemeral current brief to every provider request, including a continuation after compaction. Rehydration is only as complete as the recorded fields. A damaged or unsupported latest checkpoint blocks tool interaction rather than silently restoring stale scope. Use Pi `/tree` to return before that checkpoint, or start a new session and establish scope again.

## Investigation behavior

Offense follows objective-driven discovery, deep enumeration, discriminating active validation, confirmed path chaining and relevant authorized post-access investigation. It separates prerequisites and hypotheses from demonstrated access and impact. It persists through routine failures while respecting the engagement's budget and stop conditions.

Defense investigates with the same evidence discipline. Its default output is an implementation-ready remediation dossier with reproduction, affected roles/routes, root cause, proposed correction, implementation scope, regression cases and retest criteria. It applies changes when implementation is part of the task, and distinguishes proposed, applied and verified outcomes.

The six specialist profiles and their task/result contract are available for bounded delegation when `pi-subagents` is installed in the dedicated profile. Definitions do not prove that workers inherit all parent context or that the host enforces budgets, isolation or cancellation; verify those behaviors before relying on them. See [package setup and limits](docs/PACKAGES.md).

`cyber_knowledge` searches the local skills, research and documentation index after an explicit rebuild. It does not mirror every OWASP or cybersecurity document and does not fetch or rebuild content automatically. `cyber_browser` coordinates one active owner for a browser session; it does not install or sandbox an external browser. Scanner tools use typed parameters and the job runner; their availability and validation state are reported separately by `bun run doctor`.

## Evidence and execution boundaries

Store concise sanitized summaries and artifact references in the brief. Ordinary Pi session files and model context are not a secret vault. A partial heuristic rejects common credential patterns, with per-field, list and overall size limits; arbitrary secrets can still evade it. The caller must redact before invoking the tool, since tool arguments themselves can appear in the transcript even when an update is rejected. Evidence references are not evidence ingestion, hashing, existence verification or protected storage.

Mode prompts do not constrain the underlying account's filesystem or network permissions. Native tools retain normal Pi execution and trust behavior. This extension does not enforce target scope in arbitrary shell commands and does not provide an OS sandbox. It blocks mode changes during tracked Pi work; it cannot discover unmanaged background processes or work launched by other runtimes.

`bun run doctor` reads PATH and filesystem metadata only. Its output distinguishes executable presence from validation; it never launches a scanner, browser, REA setup, Java or version probe. A name collision such as Python `httpx` or an unrelated `sg` is not compatibility proof.

## Optional structural search and staged edits

`bun run pi:ast` explicitly loads [the separate AST extension](src/ast-extension.ts) alongside the cyber foundation. The default launcher and `pi.extensions` manifest omit it. The engine, `@ast-grep/napi` **0.51.0**, is an exact optional dependency; its native code is loaded only when an AST tool executes. `bun install --omit=optional` keeps it out of a foundation-only installation. No global install, shell search command, project ast-grep configuration, custom parser loading or LSP service is involved. From another project, add `-e /absolute/path/to/this/package/src/ast-extension.ts` to the Pi invocation above; that project's working directory becomes the workspace boundary.

The bundled supported languages are `javascript` (`.js`, `.jsx`, `.mjs`, `.cjs`), `typescript` (`.ts`, `.mts`, `.cts`), `tsx`, `css` and `html` (`.html`, `.htm`). An explicit `language` selects one of these parsers for another filename. Other languages are reported as unsupported; no parser is installed on demand. The implementation follows the official [ast-grep JavaScript API](https://ast-grep.github.io/guide/api-usage/js-api.html).

`ast_grep` accepts explicit workspace files, a structural `pat`, an optional `language`, and a match `limit`:

```json
{"paths":["src/handler.ts"],"pat":"console.log($A)","limit":20}
```

Results include relative paths, one-based line/column positions, matched syntax, engine-resolved named captures, parser diagnostics, skipped files and truncation. Columns use the engine's JavaScript UTF-16 indexing. `$NAME` and `$$$NAME` capture syntax; `$_` and `$$$` act as anonymous engine wildcards. Search accepts 1–32 files, at most 256 KiB per file and 2 MiB of source per call, and at most 100 returned matches. Each snippet/capture is clipped to 1,000 UTF-16 units and the whole result to 64 KiB; `truncated` also signals omitted diagnostics or skipped-file records. Directories, glob expansion and symlink paths are refused.

`ast_edit` previews operations against the same original syntax tree in **one file**. Named captures come from the AST engine; substitutions preserve the captured source span, including comments and Unicode. An empty `out` deletes the matched node. For example:

```json
{"action":"preview","path":"src/handler.ts","ops":[{"pat":"console.log($$$ARGS)","out":"logger($$$ARGS)"}]}
```

Preview writes nothing and returns an opaque `proposalId`, before/after changes and SHA-256 hashes. Apply that exact proposal with a separate invocation:

```json
{"action":"apply","proposalId":"<ID returned by preview>"}
```

Apply checks the original content hash, mode, file identity, canonical workspace path, session and active branch, then uses a same-directory atomic rename preserving file mode. Symlink components, hardlinks, overlapping replacements, unknown replacement captures, parser-error inputs and parser-error outputs are refused. Missing tokens are conservatively treated as parse errors. Files must be plain UTF-8 without a BOM. Edits allow at most 8 operations and 100 total matches; an oversized preview is refused instead of creating a partial proposal. Proposals are held in memory, with at most eight pending, and expire on session replacement, tree navigation or extension restart. Normal forward session progress can retain a proposal. There is no multi-file transaction, semantic-refactoring guarantee or rollback service.

Use this in a workspace under a single writer's control: the final recheck and rename cannot form a compare-and-swap against another process modifying the file or its parent directories. This is not an OS sandbox. Loading the extension is deliberate tool availability; mode instructions do not authorize modifications. Apply when implementation is part of the task. AST matches and parseable output establish syntactic evidence only; review the diff and run the project's compiler, linter and tests.

Before/after records remain in the ordinary tool result; the extension adds no automatic evidence or session entries. Tool arguments and results can still enter Pi's normal transcript and provider context. Select sanitized source and redact credentials before persisting or sharing results.

## Verification

Tests run without a model, external target or external scanner. They exercise the pinned Pi extension loader and temporary sessions, typed adapter/job/evidence paths, browser lease transitions, knowledge FTS over fixtures, specialist contracts, the loopback Cyberbench app and reporting utilities.

Interactive terminal appearance, a native Node runtime, provider calls, live automatic token-threshold compaction, pi-subagents and external tools remain untested. Themes derive from Pi 1.3.0's complete dark theme, retaining its success/error/warning semantics; light-terminal visual QA remains open. Dependency lifecycle scripts are not required for these checks and were left blocked by Bun.

Optional AST tests use the actual pinned Pi loader, the installed native ast-grep engine, and temporary files. They cover structural capture matching, unchanged previews, Unicode/comment-preserving substitutions, mode-preserving apply, parser and missing-token failures, overlap, stale/session/branch rejection, workspace containment and response/source limits. Native AST execution was verified on this host; other engine platform binaries remain untested.
