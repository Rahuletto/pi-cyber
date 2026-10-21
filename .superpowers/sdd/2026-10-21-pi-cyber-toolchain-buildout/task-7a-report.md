# Task 7a Report — Cyber slash-command UX (`/offense` `/defense`, offense default, single blue accent)

Branch: `feat/cyber-commands` · Commit: `bf2f153` · Date: 2026-10-21

## What was built (user directive: raw `/cyber mode` usage errors, no autocomplete, wrong default mode, doubled error prefix, unwanted theme swap)

- **Top-level `/offense` and `/defense` commands** (`src/index.ts`, `registerModeCommand`): real `pi.registerCommand` entries with palette descriptions (autocomplete comes from the command palette), one line each. Both route through a new shared `setMode(ctx, state, mode)` which is the *only* piece carrying the idle/agent/tool/queued-messages guard + `switchMode` + save + decorate + notice — `/cyber mode offense|defense` calls the same `setMode`, so there is no duplicated switch logic.
- **Startup default = OFFENSE** (`src/state.ts`): `emptyState()` default mode `defense → offense`. A checkpoint-less (`mode.json`-less / fresh-branch) start is therefore offense; any persisted checkpoint still restores its recorded mode via `parseState` (explicitly tested: a saved defense checkpoint resumes defense). This builds on prior tasks' removal of the external mode file — persistence is the session checkpoint branch.
- **Single blue accent**: the offense/defense theme swap is gone. `applyTheme(ctx)` now applies exactly one theme (`CYBER_THEME = "cyber-defense"`, the blue one) on restore/`before_agent_start` regardless of mode; the mode-switch path no longer touches themes at all (the old apply→save→rollback dance is deleted). `themes/cyber-offense.json` is still registered as a `resources_discover` theme resource (registration untouched, still schema-validated by `tests/themes.test.ts`, user-selectable via `/theme`) but the harness never applies it.
- **Color-coded badge**: new `badge(ctx, mode)` uses the SDK's own `ctx.ui.theme.fg(...)` ANSI facility (the same one Pi uses for the `Error:`/`Warning:` notice wrapping): OFFENSE renders in the theme `error` color (red), DEFENSE in `accent` (blue). Emitted in the status line (`setStatus("cyber", …)`), the session title stays plain, and the mode word in the mode-switch + checkpoint notices. Falls back to plain `OFFENSE`/`DEFENSE` text whenever the theme object is unreachable (print/RPC mode, minimal fixture UIs), so headless output is never polluted with ANSI.
- **Doubled "Error: Error:" fixed at the source**: the doubling was ours — `String(error)` on an `Error` yields `"Error: <msg>"`, which the SDK's `showError()` then prefixes again. New `errorText(error)` returns `error.message` for `Error` instances and is used at every error-notice site (`/cyber` catch, `/offense`//`/defense` catch, `restore`, `before_agent_start`) and for the `tool_call` block reason; the SDK prefix stays the single "Error: ". The `/cyber` usage error is now one clearer line: `Usage: /cyber [status|checkpoint|mode offense|defense] · /offense · /defense`.
- README quick-start + behavior paragraph updated to match; `cyber_state` tool description now points users to `/offense`//`/defense`.
- **Not touched**: `src/tools/adapter-tools.ts` (parallel owner), other worktrees, `src/index.ts` command-registration edit kept surgical (no structural refactor beyond extracting `setMode`/`registerModeCommand`).

## Tests (all existing 158 kept; 4 new/updated behaviors)

- `tests/state.test.ts`: default is offense (renamed test); mode-separation test flipped to switch offense→defense; recovery test key flips; **new** "a saved checkpoint keeps its recorded mode; only a fresh start is offense" (persistence respected).
- `tests/extension.test.ts`: fixture `command(name, args)` helper now targets any registered command and the TUI fixture exposes the real `cyber-defense` theme object so badges carry actual SGR codes. New tests:
  1. **command routing**: `/offense`//`/defense` registered, guarded refusal while idle=false through the top-level command (shared guard), successful `/defense`→`/offense`, argument-usage error leaves mode intact, `/cyber mode` compatibility switch.
  2. **badge**: TUI labels contain both `OFFENSE` and `DEFENSE` with ANSI prefixes, distinct colors, while the applied theme itself never changes (`cyber-defense` in both modes).
  3. **single theme**: mode switches never swap themes; theme-restore failure still blocks `tool_call` until resolved (checkpoint → reopen → failed restore).
  4. **error shape**: `/cyber mode superuser` and `/cyber mode offense extra` surface exactly one `Usage:` notice starting with the message (no `Error: Error:` doubling), state untouched.
- Old "theme failure does not persist a new mode" test deleted with the swap — there is no theme step in the mode-switch path anymore; a failed restore now blocks tools from `session_start` (`before_agent_start` behaves as before).

## Verification

- `bun run typecheck` → clean (`tsc --noEmit`, no output).
- `bun test` → **162 tests: 158 pass, 4 skip, 0 fail, 900 expect() calls** (baseline was 158/154+4skip/0 fail; all prior tests kept green).
- Committed on `feat/cyber-commands` as `bf2f153 feat: /offense //defense commands, offense default, single blue accent` (5 files, +140/−61).

## Concerns for the controller

1. **Badge colors via `ctx.ui.theme.fg` are dependent on SDK behavior at 1.3.0**: `showStatus`/`showError`/footer status pass the string through a `ThemedText` that handles embedded ANSI (verified in the SDK source: footer `sanitizeStatusText` does not strip escapes; `visibleWidth`/`truncateToWidth` are ANSI-aware). The status badge renders mid-line inside Pi's own dim wrapping, so the text *after* a colored badge in a notice line inherits the terminal default fg (SGR 39) rather than dim gray — cosmetic only.
2. **`cyber-offense.json` remains registered but unused by the harness** (kept the working `resources_discover` registration per the "keep the resource registration" instruction; deleting the file would churn `tests/themes.test.ts`). If the controller prefers a truly single-theme package, a follow-up can drop the file and its `themes.test.ts` half.
3. `registerCommand("offense"/"defense")` occupies two top-level palette names — if another extension someday registers the same names, Pi's collision resolution applies (last loaded wins per loader `commands.set`); no conflict exists today.
4. `bun.lock` is untracked noise from a local `bun install` (fresh node_modules in the worktree); not committed.
5. The `tool_call` block reason for a damaged checkpoint lost its `Error: ` prefix (now the bare message via `errorText`); if any downstream logic matched on that prefix, it would need updating — no such dependency found in this repo's tests.
