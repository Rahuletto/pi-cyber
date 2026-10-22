#!/usr/bin/env bash
set -euo pipefail

# Install patchright (the patched Playwright driver, Apache-2.0) as an
# operator-managed node package OUTSIDE the Bun harness package: the node
# subprocess in src/tools/challenge-driver.mjs loads it from this directory
# with createRequire. Pinned exact version; the harness package.json is never
# touched.

TOOLS_DIR="${PI_TOOLS_DIR:-$HOME/.pi/scanners}"
DEST_DIR="$TOOLS_DIR/patchright"
VERSION="1.64.1"

mkdir -p "$DEST_DIR"
if [[ ! -f "$DEST_DIR/package.json" ]]; then
  printf '%s\n' '{"name":"pi-cyber-patchright","private":true}' > "$DEST_DIR/package.json"
fi

if command -v bun >/dev/null 2>&1; then
  (cd "$DEST_DIR" && bun add "patchright@${VERSION}" >/dev/null)
elif command -v npm >/dev/null 2>&1; then
  (cd "$DEST_DIR" && npm install --no-fund --no-audit "patchright@${VERSION}" >/dev/null)
else
  echo "pi-cyber: neither bun nor npm found — patchright cannot be installed here" >&2
  exit 1
fi

if [[ ! -f "$DEST_DIR/node_modules/patchright/package.json" ]]; then
  echo "pi-cyber: patchright did not land under $DEST_DIR/node_modules; refusing" >&2
  exit 1
fi

# Record the installed version next to the tree for doctor/readiness reporting.
printf '%s\n' "$VERSION" > "$DEST_DIR/.installed-version"

echo "pi-cyber: patchright $VERSION installed at $DEST_DIR"
