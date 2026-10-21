# Task 8 Report — Obscura browser lease lane

Branch: `feat/browser-leases` · Commit: `dd4703a` (`feat: browser lease lane over session store`) · Date: 2026-10-21 · Worktree: `/Users/marban/.pi/pi-cyber-t8` only (no other worktree touched)

## Baseline

- `bun install --frozen-lockfile` → 123 packages installed (2 postinstalls blocked by bun; nothing executed).
- `bun test` on the untouched base → **167 pass / 4 skip / 0 fail** across 171 tests in 13 files (1021 expect() calls). This matches the expected baseline exactly; no test was deleted or edited to make room.
- `bun run typecheck` was clean on the base as well.

## What was built

### `src/tools/browser.ts` (new) — the `cyber_browser` Pi tool

`registerBrowserTool(pi)` registers one tool named **`cyber_browser`** (label `Cyber browser lease`). Shape follows `src/tools/evidence.ts`: Typebox parameters with `additionalProperties: false`, `executionMode: "sequential"`, `annotations: { readOnlyHint: false, openWorldHint: false }`, results clipped at 16 KiB with a surrogate-safe clipper, and no raw output dumps.

Schema (flat, `additionalProperties: false`):

| field | type | notes |
|---|---|---|
| `action` | `"acquire" \| "release" \| "status"` | required |
| `mode` | `"read" \| "act"` | required **at runtime** for `acquire` (the schema cannot express "required if action === acquire") |
| `purpose` | closed enum `recon \| capture \| reproduction \| validation \| remediation-check` | required **at runtime** for `acquire` |
| `sessionId` | string (1–500) | required **at runtime** for `release` |

Actions:

- **acquire { mode, purpose }** — takes the exclusive lease. Mode/purpose are validated first (`BrowserLeaseError` code `validation-error`), then, **only for `mode: "act"`**, the Obscura readiness gate runs. The lease is booked in the evidence store via the sanctioned `addSession` (no schema change). Returns `sessionId` + `owner` + `acquiredAt` (plus mode/purpose) in the text and in `details`; the text also states that nothing was downloaded, launched or attached.
- **release { sessionId }** — releases the lease through the store's sanctioned `releaseSession` (the controller-ruled UPDATE of `released_at` + typed `session` event). Releasing an **unknown session is a typed no-op, not an error** (`details.released === false`, text `no active lease for session <id> — nothing to release.`). Both release outcomes repeat the **export-before-close rule** from `docs/REA-LIGHT.md`: *export the Evidence bundle (`export_evidence_bundle`) before `close_binary` — closing clears that connection's retained Evidence ledger, and an exported bundle is the only durable copy afterwards* (exported as `EXPORT_BEFORE_CLOSE_REMINDER` and asserted in the tests).
- **status** — the current lease, or exactly `no active lease` when the engagement holds none.

Typed errors (class `BrowserLeaseError`, stable `code` so the model can branch on the code and not on prose): `lease-conflict`, `validation-error`, `bin-not-available`.

### Lease discipline (from `docs/REA-LIGHT.md`)

- **Acquiring never downloads and never launches a browser.** Nothing in `src/tools/browser.ts` spawns a process; a test asserts the (comment-stripped) source contains no `execFile`/`execSync`/`spawn`/`child_process` call. A missing browser stays an operator decision (`tools/install.sh`), never an automatic download (REA-LIGHT: *no second browser may be downloaded silently*).
- **`mode: "read"` is passive**: it books the lease and performs no readiness probe at all, so it can never turn into a launch. A read lease is granted even with no browser installed.
- **`mode: "act"`** means "this lease will drive the browser", so the Obscura bin must be usable **before** the lease is taken: the operator's state file must record the bin (`installed | validated`) **and** the binary must resolve on disk. Otherwise the tool fails fast with the adapter-tools readiness message, byte-for-byte: `bin not available: obscura — run tools/install.sh (state: cataloged)` (the recorded label is reported verbatim instead, e.g. `(state: installed)`, when the state file has gone stale). No lease is booked for an unusable browser.
- The module doc also records the two boundaries the plan asked for: `-stealth` is never used by this lane (stealth deliberately changes fingerprint/tracker behavior, so it must not appear in browser-security conformance evidence), and private/loopback destinations are only in scope for owned fixtures.

### Tool-level single-owner enforcement (store schema untouched)

- The store has **no partial unique constraint** and none was added — the DDL in `src/evidence/db.ts` is byte-identical, `browser_sessions` remains a plain append-only ledger plus the sanctioned `released_at` column.
- The tool therefore reads the **active leases before it writes**: `store.listSessions({ activeOnly: true, limit: 1 })` → if one is live, it throws the typed conflict naming the **current owner and the current purpose** and the current session id: `browser lease conflict: session <id> is already held by owner <owner> (purpose: <purpose>); release it with cyber_browser release before acquiring another lease.` The refused acquire changes nothing (still exactly one live lease).
- **Why the check-then-act is safe**: the tool declares `executionMode: "sequential"`, so Pi never runs two `cyber_browser` calls concurrently inside one process — no second acquire can interleave between the read and the write. The store's own per-`sessionId` check remains as a second line of defence (its error is mapped to the same `lease-conflict` code). The cross-process case (a second Pi process on the same engagement file) is documented as best-effort, not a hard mutex.
- The **owner is derived, never model-supplied**: `pi-session:<session id>` from the tool context, falling back to `engagement:<CYBER_ENGAGEMENT_ID>` and then `agent:unknown`. The model cannot claim to be another owner, and two Pi sessions are two owners.

### Store change (read-only, additive)

`src/evidence/db.ts` gained exactly one read path — `listSessions(opts?: { activeOnly?: boolean; limit?: number }): SessionRow[]` — with two prepared statements, mirroring the existing `listEvidence` / `listFindings` / `listJobs` style. **No DDL change, no new table, no new column, no constraint.** The store's module doc now states where single-owner enforcement lives and why.

### `src/tools/adapter-tools.ts` (additive, no behavior change)

`BinReadiness` gained an optional `recorded?: "installed" | "validated"` field — the state the operator's state file records for that bin (the pre-existing `state` field is the doctor-computed label and is unchanged, so the adapter tools' fail-fast messages are untouched). The browser lane needs the recorded pin to decide whether an interactive lease may be taken.

### `src/index.ts` (2 lines)

Exactly one import (`import { registerBrowserTool } from "./tools/browser.ts";`) and one call (`registerBrowserTool(pi);`), right after `registerAdapterTools(pi)`. Nothing else in the file changed.

### `tests/extension.test.ts` (1 line)

`expect(h.extension.tools.size).toBe(15)` → `toBe(16)` (11 adapter tools + github + evidence + jobs + cyber_state + cyber_browser), asserted through the real SDK loader.

### `tests/browser.test.ts` (new) — 14 tests, modelless

No browser, no network, no provider, no target. The lease is a real row in a real SQLite file under a temp `CYBER_EVIDENCE_DIR`; the tests drive the actual store and read the raw event log back with `bun:sqlite`.

- **Schema**: tool name `cyber_browser`, `executionMode: "sequential"`, `additionalProperties: false`, the purpose enum in the schema is exactly the five closed values, and `Value.Check` (typebox) confirms the schema rejects an unknown purpose, an unknown action, an unknown mode and extra properties.
- **Lifecycle**: acquire → status → release → status; asserts the returned `sessionId` (`bs-…`), `owner` (`pi-session:session-fixture`), `mode`, `purpose`, an ISO `acquiredAt`, that status shows the live lease, that release returns `released: true` and repeats the export-before-close reminder, and that status then returns exactly `no active lease`.
- **Store round-trip**: the live row carries the same sessionId/owner/mode/purpose with `releasedAt === null`; after release the row keeps `releasedAt` set and the active set is empty.
- **Typed event**: acquiring writes **no** event; the release appends exactly one `kind = "session"` event whose payload is `{ sessionId, owner, action: "released" }` (read straight from the `events` table). A no-op release writes no event.
- **No-op release**: releasing an unknown session resolves (no throw) with `released: false` and the `no active lease` text.
- **Conflict**: a second acquire while a lease is live throws `BrowserLeaseError` with `code === "lease-conflict"`, naming the *current* owner (`owner-a`) and the *current* purpose (`capture`) and the current session id — and not the rejected claimant (`owner-b`); the store still holds exactly one live lease. After the holder releases, a new owner can take the lease.
- **Validation**: an invalid purpose, an invalid mode, a missing mode, a missing purpose and a missing `sessionId` all raise `code === "validation-error"` and never reach the store.
- **Lane discipline**: a passive read lease is granted with no browser installed at all; an interactive lease fails fast with exactly `bin not available: obscura — run tools/install.sh (state: cataloged)` and books nothing; a recorded `installed` state with no binary on disk fails fast with `(state: installed)`; a recorded `installed` state **with** the binary on disk grants the `act` lease. The readiness tests run with an empty `PATH` so no ambient binary can make them flaky.

## Verification

- `bun run typecheck` → clean (`tsc --noEmit`, strict).
- `bun test` → **181 pass / 4 skip / 0 fail** across 185 tests in 14 files (1098 expect() calls) = the 167-test baseline kept green **+ 14 new tests**.
- Commits: `dd4703a` `feat: browser lease lane over session store` (6 files: 1 new tool, 1 new test, 4 modified) and this report as a separate `docs:` commit, following the task 7a/7b convention in this repo.
- No other worktree was touched; no other branch was checked out.

## Concerns for the controller

1. **`listSessions` was added to the evidence store** (read-only, two prepared statements, **no DDL/column/constraint change**). The brief said "do NOT change the store schema" and "query active sessions before acquire"; the store had no read path for leases, so the query needed a home. Alternative was a second SQLite connection inside the tool (duplicating path resolution and the WAL/secret conventions), which I judged worse. If the controller prefers the store to stay frozen, the read path can be moved into `src/tools/browser.ts` — the call sites are one line each.
2. **"A bin state exists (installed|validated)" is enforced as: recorded state AND binary on disk.** A binary that is on `PATH` but absent from the operator's state file is treated as *not provisioned* for an interactive lease, so the message reads `(state: cataloged)` even though the file exists. This is the strict reading of the brief and matches the example message; the looser reading (on-disk ⇒ available) would allow an unpinned binary to drive a browser. `tools/install.sh` writes `installed` into `~/.pi/tools/state.json` on a verified download and `tools/validate.sh` writes `validated`, so the intended operator flow satisfies the gate. Say the word if the looser reading is wanted — it is a one-line change in `assertBrowserReady`.
3. **The single-owner check is per-engagement-file, not per-machine.** It refuses a second lease for the engagement's evidence file; a second Pi process writing a *different* engagement file is a different scope and is not refused (that is the "parallel work uses separate sessions" boundary from REA-LIGHT, kept by design).
4. **`status` lists every live lease, not only the first.** Under the single-owner rule there is normally exactly one; if a second process ever created one, both are shown rather than hidden.
5. **The lease is bookkeeping, not a sandbox.** It records "one owner at a time" in the engagement file so two specialists cannot silently share a mutable browser state; it does not lock the Obscura MCP server itself. Serializing the actual MCP session stays the operator's job (Obscura MCP has a single current-page model — `research/BROWSER-REA-TOOLS.md`).
6. **Plan-vs-brief scope:** the plan's Task 8 also lists `src/browser/leases.ts`, `src/browser/mcp-register.ts` and a bootstrapped `config/cyber/mcp.json` (the Obscura stdio entry). The brief for this subtask scoped the work to the tool-level lease lane over the existing evidence-store session API, so those three pieces are **not** in this commit and remain open for the controller to schedule (a `src/browser/leases.ts` wrapper would now be a thin facade over the same store rows).
7. **`purpose` and `mode` are required at runtime but optional in the schema.** A flat Typebox object cannot express "required if action === acquire"; the alternative (a per-action `Type.Union` of objects, as `cyber_state` does) would push the requirement into schema validation but would then be unreachable in a modelless unit test and would change the SDK's error surface. The runtime guard raises the same typed `validation-error` the model can act on.
8. **The owner falls back to `agent:unknown`** when the tool context carries no session manager (a headless/bare invocation). In a real Pi run the session id is always present, so two live agents are always distinguishable.

## Verification commands (operator-runnable, modelless)

```sh
cd /Users/marban/.pi/pi-cyber-t8
bun install --frozen-lockfile
bun run typecheck
bun test
git log --oneline -2   # dd4703a feat: browser lease lane over session store + docs commit
```
