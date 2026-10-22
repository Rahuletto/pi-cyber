import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Shared CloakBrowser (cloak) engine plumbing for the browser lane — the
 * ONE browser tool since the Oct 2026 merge (the old challenge lane and the
 * obscura/patchright fallback were deleted after the driving-layer A/B probe
 * showed patchright-changing the engine's ja3 — breaking cloak's vendor-tuned
 * TLS coherence — while adding nothing to the static JS surface: the cloak
 * binary already neutralizes those artifacts).
 *
 * The engine lives in an operator-managed npm root (default
 * ~/.pi/scanners/cloakbrowser), never inside the Bun package — a missing
 * install is a typed, resolvable readiness failure.
 *
 * Key proven facts the lane relies on (do not re-litigate without re-probing):
 *   - Headed launch (even with the window positioned offscreen at
 *     -32000,-32000) resolves Cloudflare Turnstile reliably; headless NEVER
 *     starts the challenge (widget iframe mounts but stays empty, proven
 *     with the plain build and --headless=new).
 *   - The token harvest needs NO page injection: poll
 *     window.turnstile.getResponse() on the host page. A naive
 *     window.turnstile accessor trap BREAKS api.js ("already loaded" bail).
 *   - Driving through anything other than the bundled playwright-core
 *     (e.g. patchright) reshapes the TLS ClientHello (ja3 hash changed on
 *     the 2026-10 A/B probe) — the bundled driver IS the coherence.
 */

/** An installed node (>=20 required by the node driver for playwright-core); env override first. */
export function resolveNodeBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CYBER_NODE_BIN?.trim();
  if (override) return override;
  const pathEnv = env.PATH ?? "";
  for (const directory of pathEnv.split(":")) {
    if (!directory) continue;
    const candidate = join(directory, "node");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("node not available — the browser driver needs node >= 20 on PATH or CYBER_NODE_BIN");
}

/**
 * Operator-managed cloakbrowser npm root. Accepts an npm root (contains
 * node_modules/cloakbrowser) or a bare node_modules tree that directly
 * holds the package.
 */
export function resolveCloakDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CYBER_CLOAKBROWSER_DIR?.trim();
  const roots = override
    ? [override, join(override, "node_modules")]
    : [join(homedir(), ".pi", "scanners", "cloakbrowser"), join(homedir(), ".pi", "scanners", "cloakbrowser", "node_modules")];
  for (const root of roots) {
    if (existsSync(join(root, "cloakbrowser", "package.json"))) return root;
  }
  throw new Error(
    `cloakbrowser not installed (${roots[0]}) — run tools/install-cloakbrowser.sh or set CYBER_CLOAKBROWSER_DIR to its npm root`
  );
}

const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

/**
 * Persistent-profile directory for the browser lane. Cookies and
 * localStorage live in Chromium's profile, so state SURVIVES across calls
 * (launch → work → close → relaunch restores state) — including a solved
 * challenge's cf_clearance.
 */
export function browserProfileDir(name: string, env: NodeJS.ProcessEnv = process.env): { dir: string; name: string } {
  const profileName = name || "default";
  if (!PROFILE_NAME_PATTERN.test(profileName)) {
    throw new Error(`invalid profile name (rejected ${JSON.stringify(profileName.slice(0, 40))}); use [a-z0-9._-], max 32, start alphanumeric`);
  }
  const base = env.CYBER_BROWSER_PROFILE_DIR?.trim() || join(homedir(), ".pi", "scanners", "browser-profiles");
  return { dir: join(base, profileName), name: profileName };
}
