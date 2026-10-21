# Pi Cyber

Pi Cyber is a local-first security assessment harness for [Pi](https://pi.dev/). It adds an offense-only workflow, durable engagement notes, a typed scanner toolset, searchable project references, and specialist profiles. It is designed to help an operator conduct authorized assessments; it does not grant authorization or sandbox the host.

## What it provides

- One offense workflow with a red-accented Pi theme and durable session checkpoints.
- Typed Pi tools for the installed scanner adapters, job tracking, evidence, browser leases, GitHub lookups, and local documentation search.
- A pinned installer and readiness checks for supported command-line tools.
- Twelve specialist profiles available through `pi-subagents`.
- Six project workflow skills and an indexed research catalog.

The repository does not include a vulnerable demo target. Use only systems you are authorized to assess.

## Requirements

- macOS or Linux. Binary availability depends on the individual tool and platform.
- [Bun](https://bun.sh/) for installation, scripts, tests, and the `bun:sqlite` runtime.
- Pi CLI 1.3.0 or compatible. This repository pins the Pi package at 1.3.0.
- A Pi-supported model provider configured in the dedicated profile before model-backed work or specialist runs.

## Install and launch

One command, on a machine that has [bun](https://bun.sh) and nothing else:

```sh
curl -fsSL https://raw.githubusercontent.com/Rahuletto/pi-cyber/main/install.sh | bash
```

No clone, no GitHub login, no token. The script fetches the repository itself
and installs everything the harness needs.

The script fetches the repository itself when it is piped, so there is no
clone step. From a clone the same script works directly:

```sh
git clone https://github.com/Rahuletto/pi-cyber.git ~/.pi/pi-cyber && ~/.pi/pi-cyber/install.sh
```

That installs the repository dependencies, the global `pi` CLI, the agent
configuration (extension, theme, skills, operator commands, the twelve
specialist roles and the pinned packages), the model catalogue, and the
digest-pinned scanner toolchain under `~/.pi/scanners`. It then verifies the
result. The clone is under 1 MB; the toolchain is the large part.

Then just run `pi` — from any directory. The harness resolves its own paths,
so no launcher, environment variable or working directory is required.

| Env | Effect |
| --- | --- |
| `SKIP_DEPS=1` | Skip `bun install` in the repository. |
| `SKIP_TOOLS=1` | Skip the scanner download. |
| `CYBER_REPO_URL` / `CYBER_REF` | Fetch the harness from another fork or tag. |
| `SKIP_WORDLIST=1` | Skip the ffuf SecLists wordlist. |
| `SKIP_GLOBAL_PI=1` | Do not install the `pi` CLI. |
| `CYBER_PROXY_KEY=…` | Write the provider key without the interactive prompt. |
| `PI_TOOLS_DIR=…` | Install the toolchain elsewhere. |

`./install.sh --check` verifies an existing install and changes nothing.

`bun run pi` is still available and launches the same harness through the
dedicated profile in `config/cyber`. Provider credentials and settings for this profile are separate from your personal Pi profile. The first launch may require provider sign-in.

To refresh the six selected workflow skills from the pinned `bigpowers` package, run `bun run packages`. The check-only command above does not modify files.

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

The extension registers 18 custom tools. Pi's own built-in tools and tools supplied by optional extensions are separate.

| Tool | Function |
| --- | --- |
| `cyber_state` | Read or update the durable offense brief. |
| `cyber_spec` | Load the full specification or one of its focused packages. |
| `cyber_evidence` | Store and retrieve sanitized evidence references, findings, and summaries. |
| `cyber_jobs` | List adapters, run a typed job, and inspect job status. |
| `cyber_browser` | Acquire, release, and inspect an exclusive browser lease; it does not launch a browser. |
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

The eleven adapter tools use typed parameters and route execution through the job runner. Their presence in Pi does not prove that a binary is installed, compatible, authenticated, or able to reach a target. Use the readiness checks below and inspect each job result.

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

`TOOLS.md` catalogs 149 researched candidates. It is documentation, not an install manifest or callable-tool registry. Search it through `cyber_knowledge` after rebuilding the `doc` source; candidates need a registered adapter and an available binary before Pi can invoke them. For example, ZAP and Nmap are cataloged, but this extension does not currently expose them as typed adapter tools.

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

Feynman is not installed; only selected research workflow ideas informed the project. Obscura's binary is in the tool manifest, but `cyber_browser` only manages a lease and does not install or drive an Obscura browser session. Configure a compatible browser integration separately if you need browser control.

The six project skills are `survey-context`, `research-first`, `plan-work`, `develop-tdd`, `verify-work`, and `audit-code`. They are available in the dedicated Pi profile. Some upstream workflow steps refer to project scripts or capsule files not included here; follow only steps supported by this repository.

## Instructions, data, and limits

At the start of a model turn, the extension injects `prompts/base.md`, `prompts/offense.md`, and a model-family overlay. The full specification and focused instruction packages are loaded on request. `cyber_knowledge` indexes project docs, research, the root `TOOLS.md` catalog, and the configured skills directory after an explicit rebuild.

Engagement state is stored in the Pi session. Evidence and job records use local SQLite storage under `config/cyber` by default; the knowledge index is a separate rebuildable local database. These paths are ignored by Git. Treat evidence and session files as potentially sensitive and manage their retention accordingly.

Prompt instructions and typed tools are not an operating-system sandbox or a general authorization boundary. Native Pi shell and file tools retain their normal behavior. The harness cannot enforce target scope for arbitrary shell commands or tools outside its adapters. Establish authorized scope before testing and keep sensitive artifacts out of committed files.

## Development checks

```sh
bun run typecheck
bun test
AST=1 bun run pi             # opt in to the separate AST extension
```

Tests use temporary sessions, fake scanner executables, parser fixtures, and local-only unit fixtures. They do not establish live provider behavior or validate an external target. The optional AST extension registers `ast_grep` and `ast_edit`; it is not loaded by the default launcher.

## Project map

- `src/` — Pi extension, typed tools, adapters, job runner, state, evidence, and knowledge index.
- `prompts/` — runtime instructions and focused operator specification packages.
- `config/cyber/` — dedicated Pi profile, specialist definitions, and selected workflow skills.
- `agents/` — detailed specialist playbooks referenced by the profile definitions.
- `tools/` — pinned binary catalog, installer, validator, and wordlist installer.
- `research/` and `TOOLS.md` — tool research and candidate inventory.
- `tests/` — adapter, extension, persistence, and parser fixtures.
