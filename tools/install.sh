#!/usr/bin/env bash
# pi-cyber pinned native tool installer.
#
# PATH alone is not readiness. For every manifest entry with disposition "core":
#   1. resolve the pinned release via the GitHub API (latest release tag + matching darwin/arm64 asset)
#   2. download the artifact to a temp dir
#   3. verify SHA-256 against the manifest pin / previously frozen pin (first run records + freezes it)
#   4. install the executable to $PI_TOOLS_DIR/bin/<name> and chmod +x
#   5. write state "installed" + sha256 into the state file
# The reviewed tools/manifest.json is NEVER mutated; freezes land in tools/manifest.resolved.json.
#
# Per-tool failures are always explicit (tool + reason on stderr, non-zero exit for that tool),
# other tools continue, and the overall exit is non-zero if any tool failed. Nothing is skipped silently.
#
# Env: PI_TOOLS_DIR (default ~/.pi/tools) — bin dir, state file; override for tests.
#      PI_RESOLVED_FILE (default <repo>/tools/manifest.resolved.json).
# Usage: install.sh [-n | --dry-run]  — prints the plan (repo, asset pattern, target) and touches nothing.
set -u -o pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PI_TOOLS_DIR="${PI_TOOLS_DIR:-$HOME/.pi/tools}"
BIN_DIR="$PI_TOOLS_DIR/bin"
STATE_FILE="$PI_TOOLS_DIR/state.json"
RESOLVED_FILE="${PI_RESOLVED_FILE:-$ROOT/tools/manifest.resolved.json}"
TOOLCTL="$ROOT/tools/toolctl.ts"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    -n|--dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "install: unknown argument \"$arg\" (usage: install.sh [-n|--dry-run])" >&2; exit 2 ;;
  esac
done

command -v bun >/dev/null 2>&1 || { echo "install: bun is not on PATH — the pi-cyber toolchain requires Bun" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "install: curl is not on PATH" >&2; exit 1; }

FAILURES=0
PLANNED=0
SUCCEEDED=0

fail() { # fail <tool> <reason>
  echo "install: FAIL $1: $2" >&2
  FAILURES=$((FAILURES + 1))
}

cleanup() { [ -n "${TMP_DIR:-}" ] && rm -rf "$TMP_DIR"; }

# Fetch and cut the download into single space-safe steps; everything through bun argv arrays.
LIST="$(bun "$TOOLCTL" list core)" || { echo "install: manifest list failed (strict loader rejected tools/manifest.json)" >&2; exit 1; }
PATTERN="$(bun "$TOOLCTL" pattern)"

while IFS=$'\t' read -r name repo manifest_sha artifact versionFlag; do
  [ -n "$name" ] || continue
  PLANNED=$((PLANNED + 1))
  if [ "$DRY_RUN" = "1" ]; then
    echo "[plan] $name repo=${repo:-<none>} pattern=\"$PATTERN\" target=$BIN_DIR/$name"
    continue
  fi
  if [ -z "$repo" ]; then
    fail "$name" "no repo recorded for a core entry — cannot pin a download"
    continue
  fi

  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-cyber-$name.XXXXXX")"
  EXTRACT="$TMP_DIR/extract"
  DL="$TMP_DIR/artifact.bin"

  # 1. Resolve tag + asset.
  RESOLVE_OUT="$(bun "$TOOLCTL" resolve "$name" "$repo" 2>"$TMP_DIR/resolve.err")"
  resolve_rc=$?
  if [ $resolve_rc -ne 0 ]; then
    fail "$name" "release resolution failed: $(tr '\n' ' ' <"$TMP_DIR/resolve.err" | sed 's/ *$//')"
    cleanup
    continue
  fi
  IFS=$'\t' read -r _r_name tag asset_name asset_url <<<"$RESOLVE_OUT"

  # 2. Download.
  if ! curl -fsSL --output "$DL" "$asset_url"; then
    fail "$name" "download failed for $asset_url"
    cleanup
    continue
  fi
  if [ ! -s "$DL" ]; then
    fail "$name" "download of $asset_url produced an empty file"
    cleanup
    continue
  fi

  # 3. Verify SHA-256: manifest pin first, then previously frozen pin; a first-ever pin gets frozen now.
  file_sha="$(shasum -a 256 "$DL" | awk '{print $1}')"
  file_sha="$(echo "$file_sha" | tr 'A-Z' 'a-z')"
  prev_sha="$(bun "$TOOLCTL" resolved-get --file "$RESOLVED_FILE" "$name" 2>/dev/null)"
  expected="${manifest_sha:-$prev_sha}"
  if [ -n "$expected" ]; then
    if [ "$(echo "$expected" | tr 'A-Z' 'a-z')" != "$file_sha" ]; then
      fail "$name" "sha256 mismatch: expected $expected, got $file_sha (pinned artifact may have been retagged upstream)"
      cleanup
      continue
    fi
  fi

  # 4. Extract / stage the executable.
  mkdir -p "$EXTRACT"
  case "$asset_name" in
    *.zip) unzip -q -o "$DL" -d "$EXTRACT" ;;
    *.tar.gz|*.tgz|*.tar.xz|*.txz|*.tar.bz2|*.tbz2) tar -xf "$DL" -C "$EXTRACT" ;;
    *.dmg|*.pkg|*.jar|*.sh|*.py|*.app) fail "$name" "unsupported artifact type \"$asset_name\" (needs zip/tar*/bare binary)"; cleanup; continue ;;
    *) mv "$DL" "$EXTRACT/$asset_name" ;;
  esac

  BIN_SRC=""
  # Exact-name match first (name may equal the asset stem-less binary).
  while IFS= read -r cand; do
    BIN_SRC="$cand"
    break
  done < <(find "$EXTRACT" -type f -name "$name" | sort)
  if [ -z "$BIN_SRC" ]; then
    # First executable regular file (zips preserve the exec bit; skip docs).
    while IFS= read -r cand; do
      [ -x "$cand" ] || continue
      BIN_SRC="$cand"
      break
    done < <(find "$EXTRACT" -type f ! -name "*.txt" ! -name "*.md" | sort)
  fi
  if [ -z "$BIN_SRC" ]; then
    single="$(find "$EXTRACT" -type f | head -n 1)"
    file_count="$(find "$EXTRACT" -type f | wc -l | tr -d ' ')"
    if [ "$file_count" = "1" ] && [ -n "$single" ]; then
      BIN_SRC="$single"
    fi
  fi
  if [ -z "$BIN_SRC" ] || [ ! -f "$BIN_SRC" ]; then
    fail "$name" "could not locate an executable inside $asset_name"
    cleanup
    continue
  fi

  # 5. Install.
  mkdir -p "$BIN_DIR"
  if ! cp "$BIN_SRC" "$BIN_DIR/$name"; then
    fail "$name" "failed to copy $BIN_SRC to $BIN_DIR/$name"
    cleanup
    continue
  fi
  chmod +x "$BIN_DIR/$name" || { fail "$name" "chmod +x failed on $BIN_DIR/$name"; cleanup; continue; }

  installed_sha="$(shasum -a 256 "$BIN_DIR/$name" | awk '{print $1}')"
  installed_sha="$(echo "$installed_sha" | tr 'A-Z' 'a-z')"
  if [ "$installed_sha" != "$file_sha" ]; then
    fail "$name" "sha256 changed between download and install ($file_sha → $installed_sha)"
    cleanup
    continue
  fi

  # 6. Freeze the resolved pin (never mutates tools/manifest.json) and mark state installed.
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! bun "$TOOLCTL" freeze --file "$RESOLVED_FILE" "$name" "$repo" "$tag" "$asset_url" "$installed_sha" "$NOW" 2>"$TMP_DIR/freeze.err"; then
    fail "$name" "could not freeze resolved pin: $(tr '\n' ' ' <"$TMP_DIR/freeze.err" | sed 's/ *$//')"
    cleanup
    continue
  fi
  if ! bun "$TOOLCTL" state-set --file "$STATE_FILE" "$name" installed --version "$tag" --sha256 "$installed_sha" 2>"$TMP_DIR/state.err"; then
    fail "$name" "could not write state installed: $(tr '\n' ' ' <"$TMP_DIR/state.err" | sed 's/ *$//')"
    cleanup
    continue
  fi

  SUCCEEDED=$((SUCCEEDED + 1))
  echo "install: ok $name tag=$tag sha=$installed_sha → $BIN_DIR/$name"
  cleanup
done < <(printf '%s\n' "$LIST")

if [ "$DRY_RUN" = "1" ]; then
  echo "dry-run: $PLANNED core entries planned; nothing downloaded, installed, or recorded."
  exit 0
fi

echo "install: $SUCCEEDED installed, $FAILURES failed, of $PLANNED core entries."
if [ "$FAILURES" -gt 0 ]; then
  exit 1
fi
exit 0
