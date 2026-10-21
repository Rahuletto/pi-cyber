#!/usr/bin/env bash
# pi-cyber tool validator — probes already-installed binaries only, never the network.
#
# For each state-file entry with state "installed": run `<bin> <versionFlag>` with a 10s timeout.
# Exit 0 → write state "validated" + version + validatedAt. Otherwise the tool stays "installed"
# and the failure is explicit (never silent). semgrep special case: binary missing → print the
# pip installation instruction and leave state "installed".
#
# Env: PI_TOOLS_DIR (default ~/.pi/tools). Usage: validate.sh
set -u -o pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PI_TOOLS_DIR="${PI_TOOLS_DIR:-$HOME/.pi/tools}"
BIN_DIR="$PI_TOOLS_DIR/bin"
STATE_FILE="$PI_TOOLS_DIR/state.json"
TOOLCTL="$ROOT/tools/toolctl.ts"

command -v bun >/dev/null 2>&1 || { echo "validate: bun is not on PATH — the pi-cyber toolchain requires Bun" >&2; exit 1; }

FAILURES=0
VALIDATED=0
TOUCH_LOCK=""

fail() { # fail <tool> <reason>
  echo "validate: FAIL $1: $2" >&2
  FAILURES=$((FAILURES + 1))
}

# Defaults per ruling; manifest `versionFlag` entries override.
default_flag() {
  case "$1" in
    ffuf) echo "-V" ;;
    obscura) echo "--help" ;;
    trivy|osv-scanner|gitleaks|syft|semgrep) echo "--version" ;;
    zap) echo "-version" ;;
    *) echo "-version" ;;
  esac
}

# Runs argv with a 10s wall-clock cap. Sets PROBE_RC (124 = timed out).
probe_with_timeout() {
  "$@" >"$PROBE_OUT" 2>"$PROBE_ERR" &
  local pid=$!
  local i=0
  while [ "$i" -lt 100 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null
      PROBE_RC=$?
      return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  kill -9 "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  PROBE_RC=124
  return 0
}

[ -f "$STATE_FILE" ] || { echo "validate: no state file at $STATE_FILE — nothing is installed yet; run tools/install.sh first" >&2; exit 0; }

INSTALLED_LIST="$(bun "$TOOLCTL" installed --file "$STATE_FILE")" || { echo "validate: reading state file via toolctl failed" >&2; exit 1; }
if [ -z "$INSTALLED_LIST" ]; then
  echo "validate: no state \"installed\" entries in $STATE_FILE — nothing to probe."
  exit 0
fi

PROBE_OUT="$(mktemp "${TMPDIR:-/tmp}/pi-cyber-validate-out.XXXXXX")"
PROBE_ERR="$(mktemp "${TMPDIR:-/tmp}/pi-cyber-validate-err.XXXXXX")"

while IFS= read -r name; do
  [ -n "$name" ] || continue

  bin="$BIN_DIR/$name"
  if [ "$name" = "semgrep" ] && [ ! -x "$bin" ]; then
    if semgrep_path="$(command -v semgrep 2>/dev/null)" && [ -n "$semgrep_path" ]; then
      bin="$semgrep_path" # pip-installed semgrep still satisfies the probe
    else
      echo "validate: semgrep: no binary at $bin and no pip-installed semgrep on PATH. Instruction: python3 -m pip install --user semgrep (state stays installed; re-run validate.sh after installing)."
      continue
    fi
  fi
  if [ ! -x "$bin" ]; then
    fail "$name" "not executable at $bin (stale installed state?)"
    continue
  fi

  flag="$(bun "$TOOLCTL" list 2>/dev/null | awk -F '\t' -v t="$name" '$1 == t && $4 != "" {print $4; exit}')"
  [ -n "$flag" ] || flag="$(default_flag "$name")"

  IFS=' ' read -r -a flag_args <<<"$flag"
  probe_with_timeout "$bin" "${flag_args[@]}"
  rc=$PROBE_RC

  # A --help probe is a marker probe: usage text has no trustworthy x.y.z to scrape — record help-ok.
  if [ "$flag" = "--help" ]; then
    version="help-ok"
  else
    version="$(grep -hoE '[0-9]+(\.[0-9]+)+' "$PROBE_OUT" "$PROBE_ERR" 2>/dev/null | head -n 1)"
    [ -n "$version" ] || version="unknown"
  fi

  if [ "$rc" -ne 0 ]; then
    if [ "$rc" = "124" ]; then
      fail "$name" "version probe \"$flag\" timed out after 10s"
    else
      fail "$name" "version probe \"$flag\" exited with code $rc: $(tr '\n' ' ' <"$PROBE_ERR" | head -c 200 | sed 's/ *$//')"
    fi
  else
    NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if bun "$TOOLCTL" state-set --file "$STATE_FILE" "$name" validated --version "$version" --validatedAt "$NOW"; then
      echo "validate: ok $name version=$version → state validated"
      VALIDATED=$((VALIDATED + 1))
    else
      fail "$name" "probe passed but state write failed"
    fi
  fi
done < <(printf '%s\n' "$INSTALLED_LIST")

rm -f "$PROBE_OUT" "$PROBE_ERR"

echo "validate: $VALIDATED validated, $FAILURES failed, of $(printf '%s\n' "$INSTALLED_LIST" | grep -c .) installed entries."
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
