# config/cyber

Dedicated profile used by `bun run pi`; provider login and custom model
configuration happen here. The global installer configures `~/.pi/agent`
instead, unless `PI_CODING_AGENT_DIR` overrides that destination.

This directory is the default Pi **agent directory** for the repository
launcher (`PI_CODING_AGENT_DIR`); an existing environment override takes
precedence. Pi reads `settings.json`, `web-search.json`,
`extensions/subagent/config.json`, `agents/` and `skills/` from here, and the
personal profile in `~/.pi/agent` stays untouched.

## What is wired here

| Path | Loaded by Pi | Purpose |
|---|---|---|
| `settings.json` | Pi package loader | Declares the four reviewed packages as **local** sources (`../../node_modules/...`), so the bun-installed copies in this repository are used instead of a second download. |
| `web-search.json` | pi-web-access | Explicit search provider, `workflow: "none"`, no curator, no browser cookies, no hosted extraction. |
| `extensions/subagent/config.json` | pi-subagents | Spawn caps: 2 concurrent children, 8 spawns per run, 16 per session, scheduled runs off. |
| `agents/*.md` | pi-subagents | Twelve cyber specialist profiles (user-scope agent discovery). |
| `skills/` | Pi skill loader | The six selected bigpowers skills (copied from the pinned package). |
| `SKILLS-NOTICE.md` | — | Provenance for the copied skills. |

The repository launcher loads `src/boot.ts`, which defers loading the core
extension and package factories until `session_start`. Its optional OpenCode
factory currently references an operator-specific installation path; that
integration needs a local installation at that path. Each specialist role declares
`extensions: ../../../src/index.ts` so the child session gets the same cyber
tools.

## Operator steps

1. **Install the packages.** `bun install` in the repository root installs the
   four pinned packages. Verify with `bun scripts/install-packages.ts --check`
   (read-only) or `bun scripts/install-packages.ts` (also refreshes the copied
   skills).
2. **Configure a provider in this profile.** Pi keeps login credentials in
   `auth.json` and custom provider definitions in `models.json`. For the current
   proxy use provider ID `marban`, base URL `https://ai.marban.lol/v1`, and API
   `openai-completions`; see the [model provider example](../../README.md#model-provider).
   The parent `config/models.json` is an optional installer input, not this
   profile's model catalogue. The personal profile's providers are not copied
   automatically.
3. **Search provider.** `web-search.json` pins `duckduckgo`, which is keyless
   and explicit-only, so no provider is ever auto-selected and no key is
   required. If the operator prefers a keyed provider (Brave, Tavily, Exa,
   OpenAI…), set the key in `web-search.json` **or** in the environment, change
   `provider`, and add it to `webSearch.allowedProviders` — an allowlist entry
   that disagrees with `provider` is rejected as invalid configuration. Keep
   `workflow: "none"`: raw bounded results plus an explicit `fetch_content`
   call, no summary model and no curator window.
4. **The live agent copy is operator-owned.** The installer links this file
   into the agent directory (`~/.pi/agent/web-search.json`) only when nothing
   is there yet. Once the operator writes a real file there — a different
   provider, a local key source — the installer leaves it untouched and the two
   profiles may diverge. The agent copy wins for the `pi` command; this
   repository copy wins for `bun run pi`.
5. **You.com as the agent's provider.** The provider id is `you` and it is
   explicit-only: it is never chosen by `auto` or `provider: "all"`, and each
   request consumes You.com API credits. The credential is read at request
   time, never from the repository:

   ```json
   {
     "provider": "you",
     "youApiKey": "!cat ~/.config/opencode/you.key",
     "webSearch": { "enabled": true, "allowedProviders": ["you", "duckduckgo"] }
   }
   ```

   `!cat` runs the command through a shell and reads the value from a local
   file; `$VAR` and `${VAR}` read one environment variable; a literal value is
   also accepted. `YDC_API_KEY` in the environment works only when the config
   has no `youApiKey` entry — a configured value wins over the environment.
   The installer prompts for the key and writes it with mode 600 when the
   effective config selects `you`.
6. **Research boundaries.** `fetchRouting.allowRemoteHostedProviders` is
   `false` and `allowBrowserCookies` is `false`: page fetches stay on the
   direct local HTTP path and never reach a hosted extractor or a Chromium
   cookie jar. Revisit these only with a written reason.
7. **Worker caps.** `extensions/subagent/config.json` keeps the harness at 2
   concurrent children and 8 spawns per run (upstream default: 64). Raise them
   only after measuring memory, cost and result quality on this Mac.
8. **bigpowers.** The extension (`omp-hooks.ts`) is deliberately **not**
   loaded; only six skills are exposed, and they expect `scripts/bp-*.sh` and
   `specs/` state that this harness does not provide — treat those steps as
   unavailable. See `SKILLS-NOTICE.md`.
9. **pi-btw.** `/btw` and `/btw:ask` are available as an optional side
   conversation. A `/btw` child shares this repository's working directory and
   has no isolation; prefer `/btw:ask` (read-only) for parallel reading.

## What is deliberately not here

- No `billion-context`: a request-rewriting proxy in front of the provider is
  not justified yet.
- No KXM, no Feynman CLI stack: both add a service plane this single-process
  harness does not need. See `docs/PACKAGES.md`.
- No Anthropic-Cybersecurity-Skills copies: the 48 curated skills are already
  installed in `~/.agents/skills` and Pi loads them natively.
