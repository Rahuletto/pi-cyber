# config/cyber

Dedicated profile; provider login happens here; nothing personal copied.

This directory is the Pi **agent directory** for the cyber harness
(`PI_CODING_AGENT_DIR`). Pi reads `settings.json`, `web-search.json`,
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

The harness extension itself is loaded from the command line
(`pi -e <repo>/src/index.ts`); each specialist role also declares
`extensions: ../../../src/index.ts` so the child session gets the same cyber
tools.

## Operator steps

1. **Install the packages.** `bun install` in the repository root installs the
   four pinned packages. Verify with `bun scripts/install-packages.ts --check`
   (read-only) or `bun scripts/install-packages.ts` (also refreshes the copied
   skills).
2. **Sign in to a provider.** Pi keeps credentials in this profile
   (`auth.json`); nothing personal is copied. `bun run pi` then asks for the
   provider login on first use.
3. **Search provider.** `web-search.json` pins `duckduckgo`, which is keyless
   and explicit-only, so no provider is ever auto-selected and no key is
   required. If the operator prefers a keyed provider (Brave, Tavily, Exa,
   OpenAI…), set the key in `web-search.json` **or** in the environment, change
   `provider`, and add it to `webSearch.allowedProviders` — an allowlist entry
   that disagrees with `provider` is rejected as invalid configuration. Keep
   `workflow: "none"`: raw bounded results plus an explicit `fetch_content`
   call, no summary model and no curator window.
4. **Research boundaries.** `fetchRouting.allowRemoteHostedProviders` is
   `false` and `allowBrowserCookies` is `false`: page fetches stay on the
   direct local HTTP path and never reach a hosted extractor or a Chromium
   cookie jar. Revisit these only with a written reason.
5. **Worker caps.** `extensions/subagent/config.json` keeps the harness at 2
   concurrent children and 8 spawns per run (upstream default: 64). Raise them
   only after measuring memory, cost and result quality on this Mac.
6. **bigpowers.** The extension (`omp-hooks.ts`) is deliberately **not**
   loaded; only six skills are exposed, and they expect `scripts/bp-*.sh` and
   `specs/` state that this harness does not provide — treat those steps as
   unavailable. See `SKILLS-NOTICE.md`.
7. **pi-btw.** `/btw` and `/btw:ask` are available as an optional side
   conversation. A `/btw` child shares this repository's working directory and
   has no isolation; prefer `/btw:ask` (read-only) for parallel reading.

## What is deliberately not here

- No `billion-context`: a request-rewriting proxy in front of the provider is
  not justified yet.
- No KXM, no Feynman CLI stack: both add a service plane this single-process
  harness does not need. See `docs/PACKAGES.md`.
- No Anthropic-Cybersecurity-Skills copies: the 48 curated skills are already
  installed in `~/.agents/skills` and Pi loads them natively.
