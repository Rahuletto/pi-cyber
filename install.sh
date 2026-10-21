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
REF="${CYBER_REF:-main}"
REPO_DIR="${CYBER_REPO_DIR:-$HOME/.pi/pi-cyber}"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PI_VERSION="${PI_VERSION:-1.3.0}"
TOOLS_DIR="${PI_TOOLS_DIR:-$HOME/.pi/scanners}"
CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

# --- bootstrap ---------------------------------------------------------------
# Piped from curl there is no script on disk and no repository next to it, so
# fetch the tree first and re-run from the unpacked copy.
bootstrap() {
  if [[ "${CYBER_BOOTSTRAPPED:-0}" == "1" ]]; then
    echo "pi-cyber: could not fetch the repository. Clone it manually:" >&2
    echo "  git clone $REPO_URL $REPO_DIR && $REPO_DIR/install.sh" >&2
    exit 1
  fi
  local tarball="${CYBER_REPO_TARBALL:-$REPO_URL/archive/refs/heads/$REF.tar.gz}"
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "pi-cyber: fetching $tarball"
  if ! curl -fsSL "$tarball" -o "$tmp/repo.tar.gz"; then
    echo "pi-cyber: download failed" >&2
    exit 1
  fi
  tar -xzf "$tmp/repo.tar.gz" -C "$tmp"
  local extracted
  extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)"
  if [[ -z "$extracted" ]]; then
    echo "pi-cyber: the archive did not contain a directory" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$REPO_DIR")"
  rm -rf "$REPO_DIR"
  mv "$extracted" "$REPO_DIR"
  echo "pi-cyber: unpacked to $REPO_DIR"
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

# ── scanner toolchain ────────────────────────────────────────────────────────
if [[ $CHECK_ONLY -eq 0 && "${SKIP_TOOLS:-0}" != "1" ]]; then
  step "scanner toolchain"
  (cd "$ROOT" && bash tools/install.sh) || say "one or more tools failed; see the output above and rerun tools/install.sh"
  step "toolchain validation"
  (cd "$ROOT" && bash tools/validate.sh) || say "validation reported gaps; see the output above"
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
