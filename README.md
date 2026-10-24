# Pi Cyber

Pi Cyber is a local-first security assessment harness for [Pi](https://pi.dev/). It adds an offense-only workflow, durable engagement notes, a typed scanner toolset, searchable project references, and specialist profiles. It is designed to help an operator conduct authorized assessments; it does not grant authorization or sandbox the host.

## What it provides

- One offense workflow with a red-accented Pi theme and durable session checkpoints.
- Typed Pi tools for the installed scanner adapters, job tracking, evidence, browser automation, GitHub lookups, and local documentation search.
- A pinned installer and readiness checks for supported command-line tools.
- Twelve specialist profiles available through `pi-subagents`.
- Six project workflow skills and an indexed research catalog.

The repository does not include a vulnerable demo target. Use only systems you are authorized to assess.

## Requirements

- macOS or Linux. Binary availability depends on the individual tool and platform.
- [Bun](https://bun.sh/) for installation, scripts, tests, and the `bun:sqlite` runtime.
- Node.js for the Pi CLI and browser driver, Python 3 for installer configuration, and Git/curl plus platform archive and SHA-256 utilities for downloads.
- Pi CLI 1.3.0 or compatible. This repository pins the Pi package at 1.3.0.
- A Pi-supported model provider configured in the dedicated profile before model-backed work or specialist runs.

## Install and launch

With the requirements above available:

```sh
curl -fsSL https://raw.githubusercontent.com/Rahuletto/pi-cyber/main/install.sh | bash
```

The script fetches the repository itself when it is piped, so there is no
separate clone step for a public checkout. A private fork needs Git credentials.
From a clone the same script works directly:

```sh
git clone https://github.com/Rahuletto/pi-cyber.git ~/.pi/pi-cyber && ~/.pi/pi-cyber/install.sh
```

That installs the repository dependencies, the global `pi` CLI, the agent
configuration (extension, theme, skills, operator commands, the twelve
specialist roles and the pinned packages), and the
digest-pinned scanner toolchain under `~/.pi/scanners`. It then verifies the
result. If an operator-owned `config/models.json` exists, the installer copies
it into the agent directory. That catalogue is ignored by Git and is absent
from a fresh clone; configure your provider separately as described below.

Then just run `pi` — from any directory. The harness resolves its own paths,
so no launcher, environment variable or working directory is required.

| Env | Effect |
| --- | --- |
| `SKIP_DEPS=1` | Skip `bun install` in the repository. |
| `SKIP_TOOLS=1` | Skip the scanner download. |
| `CYBER_REPO_URL` / `CYBER_REF` | Fetch the harness from another fork or tag. |
| `SKIP_WORDLIST=1` | Skip the ffuf SecLists wordlist. |
| `SKIP_GLOBAL_PI=1` | Do not install the `pi` CLI. |
| `PI_VERSION=…` | Override the global Pi CLI version; the default is 1.3.0. |
| `PI_CODING_AGENT_DIR=…` | Choose the agent profile configured by the installer. |
| `CYBER_PROXY_KEY=…` | Create a missing provider key file without prompting. |
| `CYBER_PROXY_KEY_PATH=…` | Choose the key-file location; defaults to `~/.config/opencode/aimylove.key`. |
| `PI_TOOLS_DIR=…` | Install the toolchain elsewhere. |

`./install.sh --check` skips dependency and scanner installation, but still
writes agent configuration, can copy the local model catalogue, and repairs
resource links. For read-only inspection, use `bun run packages:check` and
`bun run doctor`.

`bun run pi` launches the harness through the dedicated profile in
`config/cyber` by default; an existing `PI_CODING_AGENT_DIR` overrides that
choice. Provider credentials and settings for this profile are separate from
your personal Pi profile. The first launch may require provider sign-in.

To refresh the six selected workflow skills from the pinned `bigpowers` package, run `bun run packages`. `bun run packages:check` checks without refreshing them.

### Model provider

The current proxy endpoint is `https://ai.marban.lol/v1`, with provider ID
`marban` and API type `openai-completions`. Configure it in the profile you
actually launch: `~/.pi/agent/models.json` for plain `pi`, or
`config/cyber/models.json` for `bun run pi`. The two profiles do not share
provider configuration automatically.

A minimal model catalogue is:

```json
{
  "providers": {
    "marban": {
      "name": "marban.lol",
      "baseUrl": "https://ai.marban.lol/v1",
      "api": "openai-completions",
      "apiKey": "!cat ~/.config/opencode/aimylove.key",
      "models": [{ "id": "claude-sonnet-4-6" }]
    }
  }
}
```

The legacy key filename is compatible with the renamed provider; it is a local
credential source, not the provider ID. Point `apiKey` at your own configured
key source, add the model definitions you need, then restart Pi and select
`marban/claude-sonnet-4-6`. Existing sessions may still reference the old
`aimylove` ID and need the model selected again.

For a small inference check, with `MARBAN_API_KEY` set in your shell:

```sh
curl https://ai.marban.lol/v1/chat/completions \
  -H "Authorization: Bearer $MARBAN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","messages":[{"role":"user","content":"Reply with OK"}],"max_tokens":32}'
```

A model appearing in `/v1/models` does not establish inference access. Model
routes can differ in credentials, credits, tool support, and streaming behavior.
A rejected tool schema is a request-compatibility problem; a 502
`upstream_connection_error` indicates a gateway/upstream failure and requires
server logs to identify its precise cause. Tool schemas use an object at the
root; action-specific checks run before execution so providers that reject
top-level schema unions can accept the tools.

## Commands

| Command | Purpose |
| --- | --- |
| `/cyber status` | Show the current offense brief. |
| `/cyber checkpoint` | Append the already recorded brief to the Pi session. |
| `/offensespec [package]` | Load the full offense specification or a focused package. |
| `/probe <target>` | Bounded read-only surface map with a ranked shortlist. |
| `/understand <target>` | Comprehension pass: components, flows, trust boundaries, identity, data. |
| `/drill <target>` | Recursive drill: hypothesise, test, learn, adapt, chain, until a way in is found. |
| `/dump-report` | Stop the work and write the structured engagement report. |
| `/subagents` | List specialist profiles discovered by `pi-subagents`. |

Offense is the only workflow; there is no mode toggle. The `cyber_state` tool maintains scope, objective, coverage, evidence references, and next steps. Checkpoints preserve recorded state; they do not summarize unrecorded output.

## Pi tools

The extension registers 23 custom tools, including 12 scanner adapters. Pi's own built-in tools and tools supplied by optional extensions are separate.

| Tool | Function |
| --- | --- |
| `cyber_state` | Read or update the durable offense brief. |
| `cyber_spec` | Load the full specification or one of its focused packages. |
| `cyber_evidence` | Store and retrieve sanitized evidence references, findings, and summaries. |
| `cyber_jobs` | List adapters, start synchronous or background jobs, inspect/cancel jobs, and read bounded result windows. |
| `cyber_artifacts` | Create small upload artifacts, inspect metadata, and read bounded UTF-8 or base64 windows using opaque IDs. |
| `cyber_tools` | List the live tool registry, describe a tool's schema, and inspect scanner readiness. |
| `mailgen` | Create disposable mailboxes and wait for messages, OTPs, and verification links through the installed mail provider tooling. |
| `bypass_fetch` | Make typed HTTP requests through the configured curl-impersonate bundle, with artifact-backed uploads and response storage. |
| `browser` | Drive the CloakBrowser engine: navigate, eval, snapshot, and harvest Turnstile/Cloudflare clearance with persistent profiles. |
| `cyber_knowledge` | Search, inspect, and explicitly rebuild the local skills, research, and documentation index. |
| `github` | Perform supported GitHub lookups through the `gh` executable. |
| `subfinder` | Passive subdomain discovery. |
| `dnsx` | Resolve DNS records. |
| `httpx` | Probe and fingerprint HTTP targets. |
| `katana` | Crawl web targets. |
| `naabu` | Scan TCP ports. |
| `nuclei` | Run template-based vulnerability checks. |
| `ffuf` | Fuzz one URL using an operator-provided wordlist. |
| `uncover` | Query supported search-index providers. |
| `vulnx` | Query vulnerability intelligence. |
| `interactsh` | Run an out-of-band callback client. |
| `semgrep` | Scan local source paths with a selected ruleset. |
| `jwt-hack` | Run typed JWT inspection, payload, and cracking operations through the installed adapter. |

The twelve adapter tools use typed parameters and route execution through the job runner. Their presence in Pi does not prove that a binary is installed, compatible, authenticated, or able to reach a target. Use the readiness checks below and inspect each job result.

### Tool installation and readiness

```sh
bun run doctor              # read PATH and recorded readiness state
bash tools/install.sh       # download pinned core binaries; requires network access
bash tools/validate.sh      # probe installed binaries and update readiness state
```

The installer verifies release digests and writes binaries under `~/.pi/scanners/bin` by default. Set `PI_TOOLS_DIR` to use another location. The doctor is read-only and does not execute tools. The validator performs a bounded version or help probe; that is not an end-to-end target test.

Install the pinned SecLists common web-content wordlist for `ffuf` separately:

```sh
bash tools/install-ffuf-wordlist.sh
```

The launcher uses `~/.pi/scanners/wordlists/seclists-common.txt` automatically. Set `CYBER_FFUF_WORDLIST` to use another operator-managed list.

`docs/TOOLS.md` catalogs 149 researched candidates. It is documentation, not an install manifest or callable-tool registry. Search it through `cyber_knowledge` after rebuilding the `doc` source; candidates need a registered adapter and an available binary before Pi can invoke them. For example, ZAP and Nmap are cataloged, but this extension does not currently expose them as typed adapter tools.

## Specialist agents and extensions

The dedicated profile loads `pi-subagents`, which exposes a `subagent` tool and discovers these twelve project roles:

`auth`, `backdoor`, `exfil`, `offensive-operator`, `recon`, `reverse`, `reviewer`, `secrets`, `source-remediation`, `validation`, `vulnerability-research`, and `web-api`.

The profiles declare role-specific instructions and tool lists, and request the cyber extension in child sessions. Profile limits are two concurrent children, eight spawns per run, and sixteen per session; scheduled runs are disabled. `src/specialists/contracts.ts` defines task/result validators, but they are not wired around the `pi-subagents` launch and return path, so they are not runtime enforcement. A real specialist run requires a configured provider/model and makes another model call. Verify provider behavior before relying on cancellation, isolation, or cost ceilings.

The profile also loads:

| Package | Configuration |
| --- | --- |
| `pi-web-access` | Explicit search provider with explicit fetches; hosted extraction and browser cookies are disabled. The repository profile pins keyless DuckDuckGo; the installed pi agent may pin a keyed provider such as You.com through its own operator-owned `web-search.json`. |
| `pi-btw` | Optional side conversations. It is not the specialist engine. |
| `bigpowers` | Pinned as a package, but its extension is disabled. Six selected skills are copied into `config/cyber/skills`. |

Feynman is not installed; only selected research workflow ideas informed the project. Browser control runs through the typed `browser` tool on the CloakBrowser engine (`~/.pi/scanners/cloakbrowser`, installed by `tools/install-cloakbrowser.sh`), with head-offscreen harvest actions for Turnstile/Cloudflare challenges and persistent named profiles; there is no Obscura or Patchright lane anymore.

The six project skills are `survey-context`, `research-first`, `plan-work`, `develop-tdd`, `verify-work`, and `audit-code`. They are available in the dedicated Pi profile. Some upstream workflow steps refer to project scripts or capsule files not included here; follow only steps supported by this repository.

## Instructions, data, and limits

At the start of a model turn, the extension injects `prompts/base.md`, `prompts/offense.md`, and a model-family overlay. The full specification and focused instruction packages are loaded on request. `cyber_knowledge` indexes project docs, research, the `docs/TOOLS.md` catalog, and the configured skills directory after an explicit rebuild.

Engagement state is stored in the Pi session. Evidence and job records use local SQLite storage under `config/cyber` by default; the knowledge index is a separate rebuildable local database. These paths are ignored by Git. Treat evidence and session files as potentially sensitive and manage their retention accordingly.

Prompt instructions and typed tools are not an operating-system sandbox or a general authorization boundary. Native Pi shell and file tools retain their normal behavior. The harness cannot enforce target scope for arbitrary shell commands or tools outside its adapters. Establish authorized scope before testing and keep sensitive artifacts out of committed files.

## Development checks

```sh
bun run typecheck
bun test
AST=1 bun run pi             # opt in to the separate AST extension
```

Tests use temporary sessions, fake scanner executables, parser fixtures, and local-only unit fixtures. They do not establish live provider behavior or validate an external target. The optional AST extension registers `ast_grep` and `ast_edit`; it is not loaded by the default launcher.

Browser fixture tests bind localhost; a sandbox that blocks local listeners
cannot run those fixtures successfully. The missing-binary readiness fixture
also expects scanner binaries to be absent from its test PATH. Keep live API
benchmark scripts and raw results outside the checkout; report failures and
sample counts alongside latency percentiles, and distinguish stream delivery
bursts from model generation speed.

## License, security, and citation

The harness source in this repository is released under the [MIT License](LICENSE).
Third-party packages and the scanner binaries installed by `tools/install.sh`
keep their own licenses; `tools/manifest.json` lists the upstream project for
each.

| Document | Purpose |
| --- | --- |
| [SECURITY.md](SECURITY.md) | How to report a vulnerability in this repository privately, what is in scope, and the responsible-use rules. |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | The behavior expected of anyone taking part in this project's spaces. |
| [CITATION.cff](CITATION.cff) | Citation metadata. The **Cite this repository** button on the repository page renders it. |

Pi Cyber is for authorized assessment only. It does not sandbox the host, it
does not grant authorization, and the harness cannot enforce target scope on
shell commands or tools outside its adapters.

### Citation

The repository is citable with `CITATION.cff`. Rendered:

```bibtex
@misc{pi-cyber,
  author = {Marban, Rahul},
  title  = {Pi Cyber},
  year   = {2026},
  month  = {10},
  url    = {https://github.com/Rahuletto/pi-cyber},
  note   = {Version 0.1.0},
}
```

APA: Marban, R. (2026). *Pi Cyber* (version 0.1.0).
https://github.com/Rahuletto/pi-cyber

## Project map

- `src/` — Pi extension, typed tools, adapters, job runner, state, evidence, and knowledge index.
- `prompts/` — runtime instructions and focused operator specification packages.
- `config/cyber/` — dedicated Pi profile, specialist definitions, and selected workflow skills.
- `agents/` — detailed specialist playbooks referenced by the profile definitions.
- `tools/` — pinned binary catalog, installer, validator, and wordlist installer.
- `scripts/` — package installer and launcher.
- `themes/` — the Pi theme.
- `docs/` — harness design, research notes, plans, specs, and the tool catalogue.
- `docs/research/` and `docs/TOOLS.md` — tool research and candidate inventory.
- `install.sh` — the one-command installer.
- `tests/` — adapter, extension, persistence, and parser fixtures.
