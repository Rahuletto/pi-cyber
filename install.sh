#!/usr/bin/env bash
# Install the cyber harness on a machine: global Pi, the extension, the
# specialist roles, the operator commands, the workflow skills, and the pinned
# scanner toolchain.
#
#   curl -fsSL https://raw.githubusercontent.com/Rahuletto/pi-cyber/main/install.sh | bash
#
# or, from a clone:
#   git clone https://github.com/Rahuletto/pi-cyber.git && ~/.pi/pi-cyber/install.sh
#
# Requires bun on PATH. Everything else is fetched or written by this script.
#
# Env:
#   SKIP_DEPS=1       skip `bun install` in the repository
#   CYBER_REPO_URL    repository base (default the GitHub project)
#   CYBER_REF         branch or tag to fetch (default main)
#   CYBER_REPO_DIR    where to unpack the repository (default ~/.pi/pi-cyber)
#   SKIP_TOOLS=1      skip the scanner download (~1GB, needs network)
#   SKIP_GLOBAL_PI=1  do not `bun add -g` the Pi CLI
#   SKIP_WORDLIST=1   do not install the ffuf SecLists wordlist
#   --check           verify an existing install, change nothing
set -euo pipefail

REPO_URL="${CYBER_REPO_URL:-https://github.com/Rahuletto/pi-cyber}"
# A private repository needs credentials. The git credential helper or an SSH
# key is enough for the clone; the raw script fetch is the caller's problem.
REF="${CYBER_REF:-main}"
REPO_DIR="${CYBER_REPO_DIR:-$HOME/.pi/pi-cyber}"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PI_VERSION="${PI_VERSION:-1.3.0}"
TOOLS_DIR="${PI_TOOLS_DIR:-$HOME/.pi/scanners}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# --- bootstrap ---------------------------------------------------------------
# Piped from curl there is no script on disk and no repository next to it, so
# clone the tree first and re-run from the clone.
bootstrap() {
  if [[ "${CYBER_BOOTSTRAPPED:-0}" == "1" ]]; then
    echo "pi-cyber: could not fetch the repository. Clone it manually:" >&2
    echo "  git clone $REPO_URL $REPO_DIR && $REPO_DIR/install.sh" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$REPO_DIR")"
  if [[ -d "$REPO_DIR/.git" ]]; then
    echo "pi-cyber: updating $REPO_DIR"
    git -C "$REPO_DIR" fetch --depth 1 origin "$REF"
    git -C "$REPO_DIR" reset --hard "origin/$REF"
  else
    echo "pi-cyber: cloning $REPO_URL@$REF into $REPO_DIR"
    rm -rf "$REPO_DIR"
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$REPO_DIR"
  fi
  CYBER_BOOTSTRAPPED=1 bash "$REPO_DIR/install.sh" "$@"
}

# Resolve the script path before deciding whether the repository is present.
# Piped from curl there is no script on disk, so $0 is the shell and the
# bootstrap takes over.
SOURCE="${BASH_SOURCE[0]:-$0}"
if [[ -f "$SOURCE" ]]; then
  SOURCE="$(cd -- "$(dirname -- "$SOURCE")" && pwd -P)/$(basename -- "$SOURCE")"
fi
if [[ ! -f "$SOURCE" || ! -f "$(dirname -- "$SOURCE")/package.json" ]]; then
  bootstrap "$@"
fi

ROOT="$(dirname -- "$SOURCE")"

say() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

# ── preflight ────────────────────────────────────────────────────────────────
step "preflight"
command -v bun >/dev/null 2>&1 || { echo "pi-cyber: bun is not on PATH. Install bun, then rerun." >&2; exit 1; }
say "bun      $(bun --version)"
say "repo     $ROOT"
say "agent    $AGENT"
say "tools    $TOOLS_DIR"

if [[ $CHECK_ONLY -eq 0 ]]; then
  step "repository dependencies"
  if [[ "${SKIP_DEPS:-0}" == "1" ]]; then
    say "skipped (SKIP_DEPS=1)"
  else
    (cd "$ROOT" && bun install --frozen-lockfile)
    say "installed"
  fi

  step "global Pi CLI"
  if [[ "${SKIP_GLOBAL_PI:-0}" == "1" ]]; then
    say "skipped (SKIP_GLOBAL_PI=1)"
  else
    bun add -g "@earendil-works/pi-coding-agent@${PI_VERSION}"
    say "installed pi@${PI_VERSION}"
  fi
fi

# ── agent configuration ──────────────────────────────────────────────────────
step "agent configuration"
mkdir -p "$AGENT"
[[ -f "$ROOT/config/models.json" ]] && cp "$ROOT/config/models.json" "$AGENT/models.json"

python3 - "$AGENT/settings.json" "$ROOT" <<'PY'
import json, os, sys

settings_path, root = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(settings_path):
    try:
        data = json.load(open(settings_path))
    except json.JSONDecodeError:
        data = {}

def as_list(value):
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []

# Extension, theme and skills: the harness owns these.
data["theme"] = "cyber-offense"
data["extensions"] = [os.path.join(root, "src", "index.ts")]
data["themes"] = [os.path.join(root, "themes", "cyber-offense.json")]
data["skills"] = [os.path.join(root, "config", "cyber", "skills")]
data["prompts"] = [os.path.join(root, "prompts", "commands")]
data["enableSkillCommands"] = True
data["fullscreenExitOutput"] = "resume-hint"

# Packages: keep whatever the operator already had, add the harness packages.
existing = data.get("packages") or []
if isinstance(existing, str):
    existing = [existing]
packages = [p for p in existing if isinstance(p, str)]
packages += [
    {
        "source": os.path.join(root, "node_modules", "pi-subagents"),
        "extensions": ["index.js"],
        "skills": ["skills/**"],
        "prompts": ["prompts/**"],
    },
    {"source": os.path.join(root, "node_modules", "pi-web-access"), "extensions": ["dist/index.js"]},
    {"source": os.path.join(root, "node_modules", "pi-btw"), "extensions": ["extensions/btw.ts"], "skills": ["skills/**"]},
    {"source": os.path.join(root, "node_modules", "bigpowers"), "extensions": [], "skills": [], "prompts": []},
]
seen, merged = set(), []
for pkg in packages:
    key = pkg if isinstance(pkg, str) else pkg.get("source")
    if key in seen:
        continue
    seen.add(key)
    merged.append(pkg)
data["packages"] = merged

# Specialist roles: the wired role definitions live in the repo, so point the
# user-scope discovery at them instead of copying them into the agent dir.
subagents = data.get("subagents") if isinstance(data.get("subagents"), dict) else {}
scan_dirs = as_list(subagents.get("agentScanDirs"))
roles_dir = os.path.join(root, "config", "cyber", "agents")
if roles_dir not in scan_dirs:
    scan_dirs.append(roles_dir)
subagents["agentScanDirs"] = scan_dirs
data["subagents"] = subagents

json.dump(data, open(settings_path, "w"), indent=2)
open(settings_path, "a").write("\n")
print(settings_path)
PY
say "wrote $AGENT/settings.json"

# ── provider key ─────────────────────────────────────────────────────────────
step "provider key"
KEY_PATH="${CYBER_PROXY_KEY_PATH:-$HOME/.config/opencode/aimylove.key}"
KEY_DIR="$(dirname "$KEY_PATH")"
KEY_HINT="mkdir -p \"$KEY_DIR\" && printf '%s' '<key>' > \"$KEY_PATH\" && chmod 600 \"$KEY_PATH\""
if [[ -f "$KEY_PATH" ]]; then
  say "present at $KEY_PATH"
elif [[ -n "${CYBER_PROXY_KEY:-}" ]]; then
  mkdir -p "$KEY_DIR"
  printf '%s' "$CYBER_PROXY_KEY" > "$KEY_PATH"
  chmod 600 "$KEY_PATH"
  say "written to $KEY_PATH (mode 600)"
elif [[ -t 0 ]]; then
  read -r -s -p "  paste the proxy key (blank to skip): " KEY
  echo
  if [[ -n "$KEY" ]]; then
    mkdir -p "$KEY_DIR"
    printf '%s' "$KEY" > "$KEY_PATH"
    chmod 600 "$KEY_PATH"
    say "written to $KEY_PATH (mode 600)"
  else
    say "skipped — write it yourself before the first request:"
    say "  $KEY_HINT"
  fi
else
  say "no key found at $KEY_PATH"
  say "  $KEY_HINT"
fi

# ── search key ───────────────────────────────────────────────────────────────
# Only when the effective web-search config selects the You.com provider: the
# credential is resolved at request time from this file, never from the repo.
step "search key"
SEARCH_KEY_PATH="${CYBER_SEARCH_KEY_PATH:-$HOME/.config/opencode/you.key}"
SEARCH_KEY_DIR="$(dirname "$SEARCH_KEY_PATH")"
SEARCH_KEY_HINT="mkdir -p \"$SEARCH_KEY_DIR\" && printf '%s' '<key>' > \"$SEARCH_KEY_PATH\" && chmod 600 \"$SEARCH_KEY_PATH\""
WEB_SEARCH_EFFECTIVE="$AGENT/web-search.json"
[[ -f "$WEB_SEARCH_EFFECTIVE" ]] || WEB_SEARCH_EFFECTIVE="$ROOT/config/cyber/web-search.json"
SEARCH_PROVIDER=""
if [[ -f "$WEB_SEARCH_EFFECTIVE" ]]; then
  SEARCH_PROVIDER="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("provider",""))' "$WEB_SEARCH_EFFECTIVE" 2>/dev/null || echo "")"
fi
if [[ "$SEARCH_PROVIDER" != "you" ]]; then
  say "skipped — the search provider is '${SEARCH_PROVIDER:-unset}'"
elif [[ -f "$SEARCH_KEY_PATH" ]]; then
  say "present at $SEARCH_KEY_PATH"
elif [[ -n "${CYBER_SEARCH_KEY:-}" ]]; then
  mkdir -p "$SEARCH_KEY_DIR"
  printf '%s' "$CYBER_SEARCH_KEY" > "$SEARCH_KEY_PATH"
  chmod 600 "$SEARCH_KEY_PATH"
  say "written to $SEARCH_KEY_PATH (mode 600)"
elif [[ -t 0 ]]; then
  read -r -s -p "  paste the You.com search key (blank to skip): " SEARCH_KEY
  echo
  if [[ -n "$SEARCH_KEY" ]]; then
    mkdir -p "$SEARCH_KEY_DIR"
    printf '%s' "$SEARCH_KEY" > "$SEARCH_KEY_PATH"
    chmod 600 "$SEARCH_KEY_PATH"
    say "written to $SEARCH_KEY_PATH (mode 600)"
  else
    say "skipped — write it yourself before the first search:"
    say "  $SEARCH_KEY_HINT"
  fi
else
  say "no key found at $SEARCH_KEY_PATH"
  say "  $SEARCH_KEY_HINT"
fi

# ── agent-dir resources ──────────────────────────────────────────────────────
# Two profile files are read from the agent directory by convention rather than
# by path: the pi-subagents spawn caps and the web-search provider config.
step "agent resources"
mkdir -p "$AGENT/extensions/subagent"
for rel in "extensions/subagent/config.json:config/cyber/extensions/subagent/config.json" "web-search.json:config/cyber/web-search.json"; do
  dest="$AGENT/${rel%%:*}"
  src="$ROOT/${rel##*:}"
  if [[ -f "$src" ]]; then
    # A real file in the agent dir is operator-owned (a different provider, a
    # local key source). Never replace it with a link to the repository copy.
    if [[ -e "$dest" && ! -L "$dest" ]]; then
      say "kept $dest (operator-owned file left untouched)"
    else
      ln -sfn "$src" "$dest"
      say "linked $dest"
    fi
  fi
done

# ── scanner toolchain ────────────────────────────────────────────────────────
if [[ $CHECK_ONLY -eq 0 && "${SKIP_TOOLS:-0}" != "1" ]]; then
  step "scanner toolchain"
  (cd "$ROOT" && bash tools/install.sh) || say "one or more tools failed; see the output above and rerun tools/install.sh"
  step "toolchain validation"
  (cd "$ROOT" && bash tools/validate.sh) || say "validation reported gaps; see the output above"
fi

# A symlink whose target moved — for example when the toolchain directory was
# relocated — is repointed at the same file under the current tools directory.
if [[ -d "$TOOLS_DIR/bin" ]]; then
  step "stale link repair"
  repaired=0
  for link in "$TOOLS_DIR"/bin/*; do
    [[ -L "$link" ]] || continue
    [[ -e "$link" ]] && continue
    base="$(basename "$link")"
    candidate="$(find "$TOOLS_DIR" -maxdepth 4 -name "$base" -type f 2>/dev/null | head -1)"
    if [[ -n "$candidate" ]]; then
      ln -sfn "$candidate" "$link"
      say "repaired $base -> $candidate"
      repaired=1
    else
      say "dangling link $base — no replacement found under $TOOLS_DIR"
    fi
  done
  [[ $repaired -eq 0 ]] && say "none"
fi

if [[ $CHECK_ONLY -eq 0 && "${SKIP_WORDLIST:-0}" != "1" ]]; then
  step "ffuf wordlist"
  (cd "$ROOT" && bash tools/install-ffuf-wordlist.sh) || say "wordlist install skipped or failed; the ffuf adapter needs one"
fi

# ── verification ─────────────────────────────────────────────────────────────
step "verification"
(cd "$ROOT" && bun run packages:check) || say "package check reported issues"
(cd "$ROOT" && bun run doctor) || say "doctor reported issues"
say ""
say "start with:  pi"
say "commands:    /probe  /understand  /drill  /dump-report  /cyber status  /offensespec full"
say "credentials: configure the provider separately; they never live in this repo"
