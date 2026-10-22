#!/usr/bin/env bash
set -euo pipefail

# Install cloakbrowser (the stealth Chromium engine whose wrapper is MIT but
# whose Chromium binary ships under its own BINARY-LICENSE) plus
# playwright-core (its required driver) as an operator-managed node package
# OUTSIDE the Bun harness package: the node subprocess in
# src/tools/cloak-driver.mjs loads it from this directory. Pinned exact
# versions; the harness package.json is never touched.

TOOLS_DIR="${PI_TOOLS_DIR:-$HOME/.pi/scanners}"
DEST_DIR="$TOOLS_DIR/cloakbrowser"
CLOAK_VERSION="0.6.3"
PWCORE_VERSION="1.56.1"

mkdir -p "$DEST_DIR"
if [[ ! -f "$DEST_DIR/package.json" ]]; then
  printf '%s\n' '{"name":"pi-cyber-cloakbrowser","private":true}' > "$DEST_DIR/package.json"
fi

if command -v bun >/dev/null 2>&1; then
  (cd "$DEST_DIR" && bun add "cloakbrowser@${CLOAK_VERSION}" "playwright-core@${PWCORE_VERSION}" >/dev/null)
elif command -v npm >/dev/null 2>&1; then
  (cd "$DEST_DIR" && npm install --no-fund --no-audit "cloakbrowser@${CLOAK_VERSION}" "playwright-core@${PWCORE_VERSION}" >/dev/null)
else
  echo "pi-cyber: neither bun nor npm found — cloakbrowser cannot be installed here" >&2
  exit 1
fi

if [[ ! -f "$DEST_DIR/node_modules/cloakbrowser/package.json" ]]; then
  echo "pi-cyber: cloakbrowser did not land under $DEST_DIR/node_modules; refusing" >&2
  exit 1
fi

# Record the installed version next to the tree for doctor/readiness reporting.
printf '%s\n' "$CLOAK_VERSION" > "$DEST_DIR/.installed-version"

echo "pi-cyber: cloakbrowser $CLOAK_VERSION (playwright-core $PWCORE_VERSION) installed at $DEST_DIR"
