#!/usr/bin/env bash
# Launch Pi with the cyber extension + profile, preserving personal config elsewhere.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROFILE="$ROOT/config/cyber"
mkdir -p "$PROFILE"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$PROFILE}"
# The job runner spawns pinned scanner binaries by name. Make the installer-owned
# directory visible to those child processes in sessions launched from this script.
TOOLS_BIN_DIR="${CYBER_TOOLS_BIN_DIR:-${PI_TOOLS_DIR:-$HOME/.pi/scanners}/bin}"
export PATH="$TOOLS_BIN_DIR:${PATH:-}"
DEFAULT_FFUF_WORDLIST="${PI_TOOLS_DIR:-$HOME/.pi/scanners}/wordlists/seclists-common.txt"
if [[ -z "${CYBER_FFUF_WORDLIST:-}" && -f "$DEFAULT_FFUF_WORDLIST" ]]; then
  export CYBER_FFUF_WORDLIST="$DEFAULT_FFUF_WORDLIST"
fi
# The harness is repo scoped: run the session from the repository root so the
# specialist roles, the evidence store and the job artifacts resolve there.
cd "$ROOT"
# Persistent V8 bytecode cache — eliminates repeated JIT compilation of the pi bundle
export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-$HOME/.pi/agent/.v8cc}"
mkdir -p "$NODE_COMPILE_CACHE"
PI="$ROOT/node_modules/.bin/pi"
[ -x "$PI" ] || { echo "run: bun install --frozen-lockfile" >&2; exit 1; }
EXTRA_ARGS=()
[ "${AST:-0}" = "1" ] && EXTRA_ARGS+=(-e "$ROOT/src/ast-extension.ts")
# No --theme argument: unverified flag on Pi 1.3.0; theme resources load via the package.json manifest.
exec "$PI" -e "$ROOT/src/boot.ts" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
