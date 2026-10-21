#!/usr/bin/env bash
# Install global Pi and point it at this cyber package.
# From a clone: ./install.sh
# Fresh machine: git clone <this-repo> ~/.pi/pi-cyber && ~/.pi/pi-cyber/install.sh
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PI_VERSION="${PI_VERSION:-1.3.0}"

if ! command -v bun >/dev/null 2>&1; then
  echo "pi-cyber: bun is not on PATH. Install bun, then rerun." >&2
  exit 1
fi

bun add -g "@earendil-works/pi-coding-agent@${PI_VERSION}"

mkdir -p "$AGENT"
cp "$ROOT/config/models.json" "$AGENT/models.json"

python3 - "$AGENT/settings.json" "$ROOT" <<'PY'
import json, os, sys
settings_path, root = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(settings_path):
    try:
        data = json.load(open(settings_path))
    except json.JSONDecodeError:
        data = {}
data["theme"] = "cyber-defense"
data["extensions"] = [os.path.join(root, "src", "index.ts")]
data["themes"] = [
    os.path.join(root, "themes", "cyber-defense.json"),
    os.path.join(root, "themes", "cyber-offense.json"),
]
data["enableSkillCommands"] = True
json.dump(data, open(settings_path, "w"), indent=2)
open(settings_path, "a").write("\n")
print(settings_path)
PY

echo "pi-cyber: installed. Start with: $(command -v pi || echo "$HOME/.bun/bin/pi")"
echo "pi-cyber: provider credentials are configured separately, never inside this repo."
