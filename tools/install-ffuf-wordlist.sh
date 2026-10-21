#!/usr/bin/env bash
set -euo pipefail

TOOLS_DIR="${PI_TOOLS_DIR:-$HOME/.pi/scanners}"
WORDLIST_DIR="$TOOLS_DIR/wordlists"
DEST="$WORDLIST_DIR/seclists-common.txt"
TEMP_FILE="$(mktemp "${TMPDIR:-/tmp}/pi-cyber-wordlist.XXXXXX")"
trap 'rm -f "$TEMP_FILE"' EXIT

SOURCE_COMMIT="10a38f6cbe8ed6b89d55348756eff7486cd0f0ea"
SOURCE_URL="https://raw.githubusercontent.com/danielmiessler/SecLists/$SOURCE_COMMIT/Discovery/Web-Content/common.txt"
EXPECTED_SHA256="47fb86ca6fb3f97e5491161581900d6d99851fb16764eacddf16aa85617c956a"

curl --fail --location --proto '=https' --tlsv1.2 "$SOURCE_URL" --output "$TEMP_FILE"
ACTUAL_SHA256="$(shasum -a 256 "$TEMP_FILE" | cut -d ' ' -f 1)"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "pi-cyber: ffuf wordlist SHA-256 mismatch; refusing installation" >&2
  exit 1
fi

mkdir -p "$WORDLIST_DIR"
install -m 600 "$TEMP_FILE" "$DEST"
echo "pi-cyber: installed SecLists common web-content wordlist at $DEST"
