# Task 4 Report — Evidence Store (SQLite)

**Status:** COMPLETE
**Commit:** `c8d0df9` — `feat: durable evidence store with secret heuristics`
**Branch:** `feat/evidence-store` (worktree `pi-cyber-t4`)
**Date:** 2026-10-21

## Verification

- `bun install --frozen-lockfile` — OK (123 packages, postinstalls blocked by policy as before)
- `bun run typecheck` — OK (`tsc --noEmit`, strict, zero errors)
- `bun test` — **67 pass, 0 fail** across 9 files (baseline before task: 49 pass; plan estimated ~34 — suite had grown from merged tasks 1–3/9/14)

## Delivered

- `src/evidence/secrets.ts` — `containsSecretLike` superset of `src/state.ts` `knownSecrets` plus `ghp_[A-Za-z0-9]{36}`, `gho_…`, `-----BEGIN OPENSSH PRIVATE KEY-----`, `xox[bp]-`, `sk-ant-`; canonical refusal message `"possible raw secret: store a redacted artifact reference instead."`; `checkedText`/`checkedRefList`/`checkedId` helpers.
- `src/evidence/db.ts` — `bun:sqlite` store, one file per engagement. Path: `CYBER_EVIDENCE_DIR` (default `<repoRoot>/config/cyber/evidence`) + `CYBER_ENGAGEMENT_ID` (default `default`, validated `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, so no traversal) + `cyber.sqlite`; explicit `openEvidence(path)` wins. `PRAGMA journal_mode=WAL`, `foreign_keys=ON`, prepared statements compiled at open (RETURNING id for inserts). Tables: `events`, `evidence` (sensitivity CHECK, sha256 `hash`), `findings` (6-state CHECK, `created_at`, confidence 0–1), `jobs` (7-state CHECK, `jobId` UNIQUE), `browser_sessions`. Append-only for events/evidence/findings/sessions; `updateJobState` is the only UPDATE and also appends a `job` event inside the same transaction. `briefSummary(mode?)` counts + last 5 events. `recordCount()` sums all tables. `contextLine()`/`formatEvidenceLine()` isolated and never throw.
- `src/tools/evidence.ts` — Pi tool `cyber_evidence` (actions `add|read|findings|summary`, Typebox `additionalProperties:false`, `executionMode:"sequential"`); results clipped at 24 KiB (`clipOutput`, surrogate-safe) and ≤ 50 rows; store opened per call and closed afterwards. Exports `registerEvidenceTool(pi)`.
- `src/index.ts` — tool registered next to `github`; `context` hook appends **one** guarded line (`Evidence: <rows> records at <path>`) after `brief()` only when the default-path DB exists; lazy, try/catch, never throws, never dumps contents. Nothing else changed in the hook.
- `tests/evidence.test.ts` — 18 tests: secret superset + exact refusal message; in-memory round-trips (event/evidence/finding/job transitions with typed `job` events/session lease conflict + idempotent release); secret refusal on every text entry point (events payload, refs, title, impact, session purpose); `briefSummary` counts; 50-row clamp; input validation (sensitivity enum, 24 refs, integer evidence ids, confidence bounds); env path resolution + engagement-id rejection; temp-file persistence across close/reopen and per-engagement separation; `contextLine` null-without-DB / count-line / corrupt-DB→null; `cyber_evidence` registration name, add/read/summary round-trip through `execute`, clip boundary at 24 KiB.
- `tests/extension.test.ts` — tool-count expectation 2 → 3 (per task instruction).

## Concerns / notes

- Secret check sees the *stringified* payload for events — nested JSON-object keys of captured secrets are caught on write, but readers should still treat `refs` as the canonical carrier for sensitive material.
- `confidence` modeled as a real number 0–1 (plan left it untyped; finding: documented in code).
- Job-state *transition matrix* (which state may follow which) is deliberately deferred to Task 6's runner; `updateJobState` here only validates membership in the 7-state enum and records every transition as a `job` event.
- WAL creates `-wal`/`-shm` sidecars next to the DB; temp-dir tests clean up wholesale.
- Uncommitted-plan delta: extension tests now observe 3 registered tools; Task 7 must update counts again as more tools register.

---

## Fix Report (review findings) — 2026-10-21

**Status:** COMPLETE
**Commit:** `2f219fa` — `fix: evidence job-event secret check and secret-pattern widening`
**Verification:** `bun run typecheck` clean; `bun test` → **69 pass, 0 fail** (all 67 prior + 2 new tests, no regressions).

### Finding outcomes

1. **IMPORTANT — job event bypassed `saveEvent`** → FIXED. `updateJobTx` now calls `saveEvent("job", {jobId, state})` inside the transaction, so every job-transition payload passes the same secret/size check as `appendEvent` (a refusal also rolls back the row UPDATE atomically).
2. **MINOR — widen secret superset** → FIXED. `EXTRA_SECRETS` now uses `xox[abprs]-` (single pattern covering xoxa-/xoxb-/xoxp-/xoxr-/xoxs-, keeping the xox[bp]- semantics) and adds `github_pat_[A-Za-z0-9_]{50,}` for fine-grained PATs.
3. **MINOR — `startedAt` guard** → FIXED. `normalizeStartedAt` accepts undefined/null (derive from state), ISO-8601 strings, and finite numeric epochs (stored as ISO); any other string/garbage/NaN/Infinity/whitespace is rejected with `Job startedAt must be undefined, an ISO-8601 string, or a numeric epoch.` Interface widened to `startedAt?: string | number`.
4. **MINOR — missing addJob secret test** → ADDED. `addJob` with `ghp_…`/`sk-ant-…` in `argv` (and in jobId/adapter via `checkedId`) is refused with the exact canonical message; verified store stays empty (0 rows) after refusal.
5. **MINOR — vacuous `if (throughDefault)`** → FIXED. The override test now constructs a default-path DB through `CYBER_EVIDENCE_DIR` env override and asserts `contextLine()` deterministically equals `formatEvidenceLine(1, expectedDefault)` on every run.
6. **RULING — browser_sessions release sanctioned** → APPLIED. `releaseSession` runs inside a `releaseSessionTx` that issues the sanctioned `UPDATE … SET released_at` with `RETURNING owner` and, when a row actually changed, appends a typed `session` event `{sessionId, owner, action: "released"}` via `saveEvent`. Idempotent release (no active lease) writes no event — noted here so the event log stays a faithful audit trail. Acquisition still writes no event; the review's proposed payload shape {sessionId, owner, action:"released"} was kept.

### Missing-event test added
The existing session-lease test now asserts: acquisition → `events 0`, first release → `events 1`, idempotent second release → still `events 1`.

### Notes
- Started using `.run(...)`→`.get(...)` for the release statement (RETURNING) — still a single prepared statement, compiled at open.
- The `sk-ant-…` fixture in test 4 matches by the `sk-ant-` prefix regardless of tail length, by design.

