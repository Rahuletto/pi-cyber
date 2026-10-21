#!/usr/bin/env bash
# Launch Pi with the cyber extension + profile, preserving personal config elsewhere.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PROFILE="$ROOT/config/cyber"
mkdir -p "$PROFILE"
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$PROFILE}"
PI="$ROOT/node_modules/.bin/pi"
[ -x "$PI" ] || { echo "run: bun install --frozen-lockfile" >&2; exit 1; }
EXTRA_ARGS=()
[ "${AST:-0}" = "1" ] && EXTRA_ARGS+=(-e "$ROOT/src/ast-extension.ts")
# No --theme argument: unverified flag on Pi 1.3.0; theme resources load via the package.json manifest.
exec "$PI" -e "$ROOT/src/index.ts" ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}
