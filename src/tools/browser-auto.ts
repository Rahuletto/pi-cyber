import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { containsSecretLike } from "../evidence/secrets.ts";
import { openEvidence } from "../evidence/db.ts";
// cloak.ts is the shared engine plumbing: the cloak root resolver and the
// named persistent-profile dirs for the one-and-only engine.
import { browserProfileDir, resolveCloakDir, resolveNodeBin } from "./cloak.ts";

/**
 * `browser` — the ONE browser tool after the Oct 2026 merge (the old
 * challenge lane folded into it; obscura/patchright deleted after the
 * driving-layer probe proved patchright-driving breaks the engine's ja3
 * coherence while the cloak binary already neutralizes the JS artifacts).
 *
 * CloakBrowser engine, persistent Chromium profiles via
 * launchPersistentContext (src/tools/browser-driver.mjs): cookies +
 * localStorage live in a named profile dir, so state SURVIVES across calls
 * AND close — re-establishing a login is zero-cost, and a solved challenge
 * (cf_clearance) carries forward too. Headless by default; `showUi` opens a
 * real visible window the agent keeps working in. includeScreenshot
 * (+fullPage) saves a PNG the agent can open with the read tool.
 *
 * Actions:
 *   navigate   — open url, run ≤15 steps (click/fill/press/waitSel/
 *                setCookie/eval on MAIN-frame selectors), always a snapshot.
 *   eval       — console break-in on the current page.
 *   snapshot   — snapshot the current page without navigating.
 *   close      — close the driver's page (profile persists by design).
 *   turnstile  — HARVEST: head-offscreen FORCE, run the proven 3-channel
 *                Cloudflare Turnstile recipe (getResponse > host input >
 *                widget-frame input, NO init-script trap), token back with
 *                source+siteKey. Headless NEVER starts the challenge.
 *   clearance  — HARVEST: head-offscreen FORCE, run a full CF challenge
 *                interstitial and wait for cf_clearance; the origin jar +
 *                UA come back for a coherent bypass_fetch handoff, and the
 *                jar persists in the profile for later calls.
 *   fingerprint— the engine's own UA + JA3/JA4/HTTP-2 as any target sees
 *                them (what URLs the network layer presents).
 *
 * Process topology per call:
 *   Bun tool -> (execFile) -> node browser-driver.mjs (single JSON argv)
 *   -> cloakbrowser launchPersistentContext (profile dir)
 *
 * Secret discipline: cookie/token values appear in the tool output ONLY in
 * their designated result fields (short `name=value` lines + details cookie
 * objects; the turnstile token only in its own line). The evidence store
 * records metadata only, and a secret-like summary is refused (same gate as
 * bypass_fetch).
 */

const DRIVER_PATH = fileURLToPath(new URL("./browser-driver.mjs", import.meta.url));
/** execFile watchdog: params budget + engine launch/teardown headroom. */
const EXEC_BUFFER_MS = 45_000;
const MAX_OUTPUT_CHARS = 16_000;
const TRUNCATED = "[truncated]";

const execFileAsync = promisify(execFile);

const URL_PATTERN = /^(https?):\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let cut = text.slice(0, MAX_OUTPUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

export function validateUrl(url: string): void {
  if (!URL_PATTERN.test(url.trim())) {
    throw new Error(`invalid absolute http(s) URL (rejected ${JSON.stringify(url.slice(0, 128))})`);
  }
}

const STEPS = ["click", "fill", "press", "waitSel", "setCookie", "eval"] as const;
/** Ops that resolve `sel` (server-validated so the model gets field-named errors). */
const SEL_OPS = ["click", "fill", "waitSel"] as const;

export interface BrowserStep {
  op: string;
  sel?: string;
  value?: string;
}

export interface BrowserArgs {
  action: string;
  url?: string;
  steps?: BrowserStep[];
  code?: string;
  includeNetwork?: boolean;
  includeConsole?: boolean;
  includeCookies?: boolean;
  timeoutSec?: number;
  shutdown?: boolean;
  showUi?: boolean;
  profile?: string;
  includeScreenshot?: boolean;
  fullPage?: boolean;
}

const browserStepSchema = Type.Object({
  op: Type.Union(STEPS.map((op) => Type.Literal(op)), {
    description: "click: click sel. fill: put value into sel. press: click sel (optional) then send keyboard key value (e.g. 'Enter'). waitSel: wait until sel is attached. setCookie: value = JSON {name,value[,domain,path]} — requires a navigated page first. eval: value = JS statements (≤8000 chars; use an explicit return).",
  }),
  sel: Type.Optional(Type.String({ maxLength: 256, description: "Playwright selector; MAIN frame only." })),
  value: Type.Optional(Type.String({ maxLength: 8000, description: "Fill text, keyboard key, setCookie JSON, or eval JS (≤8000 chars)." })),
}, { additionalProperties: false });

const HARVEST_ACTIONS = ["turnstile", "clearance"] as const;
const FINGERPRINT_ACTION = "fingerprint";
const ACTIONS = ["navigate", "eval", "snapshot", "close", "turnstile", "clearance", "fingerprint"] as const;

const parameters = Type.Object({
  action: Type.Union(ACTIONS.map((action) => Type.Literal(action)), {
    description: "navigate: open url, optionally run ≤15 interaction steps, ALWAYS return a snapshot (url/title/text/inputs + network/console, cookies on request). eval: console break-in on the current page: JS code, explicit return required, result clamped. snapshot: snapshot the CURRENT page without navigating (respects the include* flags). close: close the driver's page (the persistent profile itself is kept). Every result lists the open tabs (`index*=url`, star = the tab acted on); pass `tab` to pin one — a close-and-reopen that finally passes a challenge lands as the LAST tab, which is the default. turnstile: HARVEST a Cloudflare Turnstile token — runs HEAD-OFFSCREEN (invisible; headless never starts a challenge) inside the profile and returns the resolved token (single-use, ~300s: present via bypass_fetch from the same host immediately). clearance: HARVEST a cf_clearance cookie jar — runs the full managed challenge HEAD-OFFSCREEN and returns the origin jar + engine UA for a coherent same-host bypass_fetch handoff; the jar persists in the profile. fingerprint: the engine's own UA + JA3/JA4/HTTP-2 as any target sees it.",
  }),
  url: Type.Optional(Type.String({ maxLength: 2000, description: "Absolute http(s) URL (navigate, turnstile, clearance; optional default tls.peet.ws for fingerprint)." })),
  steps: Type.Optional(Type.Array(browserStepSchema, { maxItems: 15, description: "navigate only, ≤15 sequential steps. Step failures are reported per-step and the sequence continues." })),
  code: Type.Optional(Type.String({ maxLength: 16_000, description: "eval only: JS statements executed as one function body; the result must be JSON-serializable and needs an explicit return." })),
  includeNetwork: Type.Optional(Type.Boolean({ description: "Include the script-ish resource list (defaults true for navigate, false otherwise)." })),
  includeConsole: Type.Optional(Type.Boolean({ description: "Include the last 40 console/pageerror messages (defaults true for navigate, false otherwise)." })),
  includeCookies: Type.Optional(Type.Boolean({ description: "Include this page origin's cookies in the snapshot (never default). Values appear only via the short name=value lines and details." })),
  timeoutSec: Type.Optional(Type.Number({ minimum: 5, maximum: 180, default: 60, description: "Whole-action budget (default 60, max 180). Turnstile/clearance typically need 45-90." })),
  shutdown: Type.Optional(Type.Boolean({ description: "close only: close the context now and saves the profile for the next call." })),
  showUi: Type.Optional(Type.Boolean({ default: false, description: "open a real visible browser window and keep working in it (default: headless, invisible). Harvest actions (turnstile/clearance) force a REAL window anyway, offscreen at -32000,-32000, so nothing appears on the operator's screen." })),
  tab: Type.Optional(Type.Number({ minimum: 0, maximum: 50, description: "0-based index of the open tab to act on (see the tabs list every result returns). Omit it and the LAST open tab is used — the freshly reopened one after a close-and-reopen." })),
 profile: Type.Optional(Type.String({ maxLength: 32, description: "named persistent profile: cookies + localStorage survive across calls and close (default profile name: 'default'); per-target profiles keep sites isolated" })),
  includeScreenshot: Type.Optional(Type.Boolean({ description: "save a PNG of the page and return its file path (agent can open it with the read tool)" })),
  fullPage: Type.Optional(Type.Boolean({ description: "only with includeScreenshot: capture the full scroll height instead of the viewport (viewport fallback past Chromium's ~16384px page cap)" })),
}, { additionalProperties: false });

type BrowserParams = Static<typeof parameters>;

/** Typed self-validation (the harness validates the schema too; both name fields). */
export function validateParams(params: BrowserParams): void {
  const action = String(params.action ?? "");
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`action must be one of: ${ACTIONS.join(", ")} (got ${JSON.stringify(action.slice(0, 32))}).`);
  }
  if (action === "navigate") {
    if (!params.url) throw new Error("url required for the navigate action.");
    validateUrl(params.url);
    if (params.steps !== undefined) {
      if (!Array.isArray(params.steps) || params.steps.length > 15) {
        throw new Error(`steps accepts at most 15 entries (got ${Array.isArray(params.steps) ? params.steps.length : "non-array"}).`);
      }
      params.steps.forEach((step, index) => {
        const op = String(step?.op ?? "");
        if (!(STEPS as readonly string[]).includes(op)) {
          throw new Error(`steps[${index}].op must be one of: ${STEPS.join(", ")} (got ${JSON.stringify(op.slice(0, 24))}).`);
        }
        if ((SEL_OPS as readonly string[]).includes(op) && !step.sel) {
          throw new Error(`steps[${index}].sel required for op ${op}.`);
        }
        if (typeof step.value === "string" && step.value.length > 8000) {
          throw new Error(`steps[${index}].value exceeds the 8000-character step budget.`);
        }
      });
    }
  }
  if ((HARVEST_ACTIONS as readonly string[]).includes(action) && !params.url) {
    throw new Error(`url required for the ${action} action.`);
  }
  if (action === "turnstile" || action === "clearance") {
    validateUrl(params.url!);
  }
  if (action === FINGERPRINT_ACTION && params.url) {
    validateUrl(params.url);
  }
  if (action === "eval") {
    if (!params.code || !params.code.trim()) throw new Error("code required for the eval action.");
    if (params.code.length > 16_000) throw new Error("code exceeds the 16000-character eval budget.");
  }
  if (params.shutdown === true && action !== "close") {
    throw new Error(`shutdown applies only with action "close".`);
  }
  // Harvest actions are single purpose: no steps/code mixing (screenshot fine).
  if ((HARVEST_ACTIONS as readonly string[]).includes(action) && params.steps !== undefined) {
    throw new Error(`steps do not apply to ${action}.`);
  }
  if (action === FINGERPRINT_ACTION && params.steps !== undefined) {
    throw new Error("steps do not apply to fingerprint.");
  }
  // Named profile: reuse cloak.ts's pattern validation verbatim; rethrow as
  // a typed error naming the field.
  if (params.profile !== undefined) {
    try {
      browserProfileDir(params.profile ?? "default", {});
    } catch (error) {
      throw new Error(`invalid profile: ${String((error as Error).message ?? error)}`);
    }
  }
  if (
    (action === "eval" || action === "close" || action === FINGERPRINT_ACTION) &&
    (params.includeScreenshot === true || params.fullPage === true)
  ) {
    throw new Error(
      `includeScreenshot/fullPage apply only to the navigate, turnstile and clearance actions (not ${action}).`
    );
  }
}

/** Screenshot output dir: operator root under $HOME, env-overridable. */
export function screenshotDirPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CYBER_BROWSER_SHOT_DIR?.trim() || join(env.HOME || homedir() || "", ".pi", "scanners", "browser-shots");
}

/* ---------------------------------------------------------------------- */
/* Outcome rendering                                                        */
/* ---------------------------------------------------------------------- */

export interface BrowserOutcome {
  text: string;
  meta: Record<string, string | number | boolean | null>;
  /** Set when the driver reported ok:false WITH diag (surfaced as isError). */
  isError?: boolean;
  /** Full driver diag payload (surfaced in details). */
  diag?: Record<string, unknown>;
  /** Cookie objects from includeCookies (details handoff, empty otherwise). */
  cookies?: Array<Record<string, string>>;
  error?: string;
}

/** Compact `name:Type` render for a snapshot input entry. */
function renderInput(entry: Record<string, unknown>): string {
  const name = String(entry.name ?? "");
  const id = String(entry.id ?? "");
  const type = String(entry.type ?? "");
  const label = name || (id ? `#${id}` : "?");
  return type && type !== "text" ? `${label}:${type}` : label;
}

/** Compact diag view for the error text: `inputs=3 steps=ok×1,eval-error×1 url=…`. */
export function compactDiag(diag: unknown): string {
  if (!diag || typeof diag !== "object" || Array.isArray(diag)) return "";
  const record = diag as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.url === "string" && record.url) parts.push(`url=${record.url.slice(0, 80)}`);
  if (typeof record.title === "string" && record.title) parts.push(`title=${record.title.slice(0, 60)}`);
  if (typeof record.inputCount === "number") parts.push(`inputs=${record.inputCount}`);
  if (record.turnstileGlobalLoaded !== undefined) {
    parts.push(`turnstileGlobalLoaded=${record.turnstileGlobalLoaded ? "yes" : "no"}`);
  }
  if (Array.isArray(record.steps) && record.steps.length > 0) {
    const counts = new Map<string, number>();
    for (const step of record.steps) {
      const ok = (step as Record<string, unknown>)?.ok !== false;
      const key = ok ? "ok" : `${String((step as Record<string, unknown>)?.op ?? "?").slice(0, 12)}-error`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    parts.push(`steps=${[...counts.entries()].map(([key, count]) => (count > 1 ? `${key}×${count}` : key)).join(",")}`);
  }
  if (Array.isArray(record.console) && record.console.length > 0) parts.push(`console=${record.console.length}`);
  return parts.join(" ");
}

/** Full cookie objects from a result (for the details handoff). */
function cookiesFrom(result: Record<string, unknown>): Array<Record<string, string>> {
  if (!Array.isArray(result.cookies)) return [];
  return result.cookies.filter(
    (entry): entry is Record<string, string> =>
      !!entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).name === "string"
  );
}

function networkLines(entries: unknown, total: number): string[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [`---NETWORK---`, `(no script-ish resources recorded${typeof total === "number" && total > 0 ? `, ${total} requests tracked` : ""})`];
  }
  const lines = entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    const method = String(record.method ?? "?");
    const url = String(record.url ?? "");
    const status = record.status == null ? "-" : String(record.status);
    const type = String(record.resourceType ?? "?");
    const size = record.size == null ? "?" : String(record.size);
    return `${method} ${status} ${type} ${size}b ${url}`;
  });
  if (typeof total === "number" && total > entries.length) {
    return [`---NETWORK---`, ...lines, `(${total - (entries.length as number)} more tracked, script-ish shown)`];
  }
  return [`---NETWORK---`, ...lines];
}

function consoleLines(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [`---CONSOLE---`];
  if (entries.length === 0) return [`---CONSOLE---`, `(no console messages captured)`];
  return [`---CONSOLE---`, ...entries.map((entry) => {
    const record = entry as Record<string, unknown>;
    return `[${String(record.type ?? "log").slice(0, 16)}] ${String(record.text ?? "")}`;
  })];
}

function cookieLine(cookies: Array<Record<string, string>>): string | null {
  if (cookies.length === 0) return null;
  return `cookies: ${cookies.map((cookie) => `${cookie.name}=${String(cookie.value ?? "").slice(0, 60)}`).join("; ")}`;
}

function failureSnapshotLines(diag: Record<string, unknown>): string[] {
  const lines: string[] = [];
  if (typeof diag.url === "string" && diag.url) lines.push(`url: ${diag.url}`);
  if (typeof diag.title === "string" && diag.title) lines.push(`title: ${diag.title}`);
  if (diag.sawChallenge === true) lines.push("sawChallenge: yes");
  if (Array.isArray(diag.cookieNames)) lines.push(`cookieNames: ${(diag.cookieNames as unknown[]).join(", ") || "none"}`);
  const inputs = Array.isArray(diag.inputs) ? (diag.inputs as Array<Record<string, unknown>>) : [];
  if (inputs.length > 0) {
    lines.push(`inputs(${inputs.length}): ${inputs.slice(0, 6).map(renderInput).join(" | ")}${inputs.length > 6 ? " …" : ""}`);
  }
  if (typeof diag.text === "string" && diag.text) lines.push(`---\n${clip(diag.text.slice(0, 1200))}`);
  return lines;
}

/** `0=url | 1*=url` — the star marks the tab this call acted on. */
function tabLines(result: Record<string, unknown>): string[] {
 const tabs = Array.isArray(result.tabs) ? (result.tabs as Array<Record<string, unknown>>) : [];
 if (tabs.length === 0) return [];
 const active = Number(result.tab ?? -1);
 return ["tabs: " + tabs.map((t) => `${t.index}${Number(t.index) === active ? "*" : ""}=${String(t.url ?? "").slice(0, 120)}`).join(" | ")];
}

function renderResult(action: string, result: Record<string, unknown>): BrowserOutcome {
  // Harvest actions get dedicated renderers — the token/jar contract is
  // their whole point and must not compete with the snapshot renderer.
  if (action === "turnstile") {
    const token = String(result.token ?? "");
    const meta = {
      action: "turnstile",
      url: String(result.url ?? ""),
      tokenLength: token.length,
      source: String(result.source ?? ""),
      siteKey: result.siteKey == null ? null : String(result.siteKey),
      ua: String(result.ua ?? ""),
      profile: "persistent (browser-profiles)",
    };
    const head = [
      `browser turnstile resolved (${token.length} chars)`,
      `page: ${result.url ?? ""}`,
      `source: ${result.source ?? "unknown"}`,
      `siteKey: ${result.siteKey ?? "null"}`,
      `engine ua: ${result.ua ?? "unknown"}`,
      "token: below — present it to the same target from the same egress via bypass_fetch immediately (single-use, ~300s)",
 ...tabLines(result),
      "---",
    ].join("\n");
    return { text: `${head}\n${clip(token)}`, meta, cookies: [] };
  }
  if (action === "clearance") {
    const cookieList = cookiesFrom(result);
    const clf = cookieList.find((cookie) => cookie.name === "cf_clearance");
    const meta = {
      action: "clearance",
      url: String(result.finalUrl ?? result.url ?? ""),
      title: String(result.title ?? ""),
      ua: String(result.ua ?? ""),
      cookieCount: cookieList.length,
      cfClearance: Boolean(clf),
      sawChallenge: result.sawChallenge === true,
      profile: "persistent (browser-profiles)",
    };
    const shown = cookieList.map((cookie) => `${cookie.name}=${String(cookie.value ?? "").slice(0, 60)}`).join("; ");
    const head = [
      "browser clearance harvest resolved",
      `page: ${result.finalUrl ?? result.url ?? ""}${result.title ? ` — ${String(result.title)}` : ""}`,
      `cfClearance: ${clf ? `present (${String(clf.value ?? "").length} chars)` : "MISSING"}`,
      `engine ua: ${result.ua ?? "unknown"} (present cookies with a matching UA header via bypass_fetch, same egress, immediately)`,
      `cookies(${cookieList.length}): ${shown || "none"}`,
 ...tabLines(result),
    ].join("\n");
    return { text: head, meta, cookies: cookieList };
  }
  if (action === FINGERPRINT_ACTION) {
    const meta = {
      action: "fingerprint",
      url: String(result.url ?? ""),
      ua: String(result.ua ?? ""),
      ja3: result.ja3 == null ? null : String(result.ja3),
      ja4: result.ja4 == null ? null : String(result.ja4),
      http2: result.http2 == null ? null : String(result.http2),
    };
    const head = [
      "browser fingerprint probe",
      `ua: ${result.ua ?? "unknown"}`,
      `ja3: ${result.ja3 ?? "n/a"}`,
      `ja4: ${result.ja4 ?? "n/a"}`,
      `http2 (akamai): ${result.http2 ?? "n/a"}`,
 ...tabLines(result),
      ...((result.text ? [`---\n${clip(String(result.text))}`] : []) as string[]),
    ].join("\n");
    return { text: head, meta, cookies: [] };
  }

  // navigate / eval / snapshot / close: the snapshot renderer.
  const title = String(result.title ?? "");
  const pageUrl = String(result.url ?? "");
  const head: string[] = [`browser ${action} ok`];
  if (pageUrl || title) head.push(`page: ${pageUrl}${title ? ` — ${title}` : ""}`);
 head.push(...tabLines(result));
  const inputs = Array.isArray(result.inputs) ? (result.inputs as Array<Record<string, unknown>>) : [];
  if (inputs.length > 0) {
    head.push(`inputs(${inputs.length}): ${inputs.slice(0, 8).map(renderInput).join(" | ")}${inputs.length > 8 ? " …" : ""}`);
  }
  const cookies = cookiesFrom(result);
  const cookieText = cookies.length > 0 ? cookieLine(cookies) : null;
  if (cookieText) head.push(cookieText);
  if (action === "eval") head.push(`result: ${String(result.result ?? "")}`);
  const screenshotPath = String(result.screenshotPath ?? "");
  if (screenshotPath) {
    head.push(
      `screenshot: ${screenshotPath}` +
      (typeof result.screenshotBytes === "number" ? ` (${result.screenshotBytes} bytes)` : "") +
      (result.screenshotNote ? ` — ${String(result.screenshotNote)}` : "")
    );
  }
  if (Array.isArray(result.steps) && result.steps.length > 0) {
    for (const step of result.steps as Array<Record<string, unknown>>) {
      const label = `${String(step.op ?? "?")}#${String(step.index ?? "?")}`;
      if (step.ok === false) head.push(`step ${label} FAILED: ${String(step.error ?? "").slice(0, 200)}`);
      else if (step.result !== undefined) head.push(`step ${label} → ${String(step.result).slice(0, 400)}`);
    }
  }

  const parts: string[] = [clip(head.join("\n"))];
  if (typeof result.text === "string" && result.text) parts.push(clip(`---\n${result.text}`));
  if (Array.isArray(result.xhrScripts)) {
    parts.push(...networkLines(result.xhrScripts, Number(result.networkTotal ?? 0)));
  }
  if (Array.isArray(result.console)) {
    parts.push(...consoleLines(result.console));
  } else if (Array.isArray(result.consoleDuringEval)) {
    // includeConsole off, but the eval still console-captured its own window
    parts.push(`---CONSOLE (during eval)---`);
    parts.push(...consoleLines(result.consoleDuringEval).slice(1));
  }
  const assembled = clip(parts.filter((part) => part !== "").join("\n"));
  const meta = {
    action,
    url: pageUrl,
    title,
    inputCount: inputs.length,
    steps: Array.isArray(result.steps) ? result.steps.length : 0,
    networkCount: Array.isArray(result.xhrScripts) ? (result.xhrScripts as unknown[]).length : 0,
    consoleCount: Array.isArray(result.console) ? (result.console as unknown[]).length : 0,
    captured: cookies.length,
    ...(screenshotPath
      ? {
          screenshotPath,
          ...(typeof result.screenshotBytes === "number" ? { screenshotBytes: result.screenshotBytes } : {}),
          ...(result.screenshotNote ? { screenshotNote: String(result.screenshotNote) } : {}),
        }
      : {}),
  };
  return { text: assembled, meta, cookies };
}

/* ---------------------------------------------------------------------- */
/* One driver call                                                          */
/* ---------------------------------------------------------------------- */

export async function runBrowser(params: BrowserParams, signal: AbortSignal | undefined): Promise<BrowserOutcome> {
  const env = process.env;
  const nodeBin = resolveNodeBin(env);
  const timeoutSec = Math.min(Math.max(Number(params.timeoutSec ?? 60), 5), 180);

  // Shared screenshot plumbing: dir is created up front so the driver can
  // never fail on a missing directory.
  const shotDir = screenshotDirPath(env);
  const wantsShot = params.includeScreenshot === true;
  if (wantsShot) mkdirSync(shotDir, { recursive: true });

  // ONE engine: CloakBrowser via its persistent profile. Missing install
  // surfaces as a typed resolver error here (before any exec).
  const action = params.action;
  const cloakDir = resolveCloakDir(env);
  const profile = browserProfileDir(params.profile ?? "default", env);
  const spec: Record<string, unknown> = {
    action,
    timeoutMs: timeoutSec * 1_000,
    cloakDir,
    profileDir: profile.dir,
    showUi: params.showUi === true,
  };
 if (params.tab !== undefined) spec.tab = params.tab;
  if (action === "navigate") {
    spec.url = params.url!.trim();
    spec.steps = (params.steps ?? []).slice(0, 15);
    spec.includeNetwork = params.includeNetwork ?? true;
    spec.includeConsole = params.includeConsole ?? true;
  }
  if ((HARVEST_ACTIONS as readonly string[]).includes(action) || action === FINGERPRINT_ACTION) {
    spec.url = action === FINGERPRINT_ACTION
      ? (params.url ?? "https://tls.peet.ws/api/all").trim()
      : params.url!.trim();
  }
  if (action === "eval") spec.code = params.code!;
  if (action === "snapshot") {
    spec.includeNetwork = params.includeNetwork ?? false;
    spec.includeConsole = params.includeConsole ?? false;
  }
  // includeCookies rides every snapshot-taking action that asked for it.
  if (params.includeCookies === true) spec.includeCookies = true;
  if (wantsShot) { spec.screenshot = true; spec.screenshotDir = shotDir; }
  spec.fullPage = params.fullPage === true;

  let stdout = "";
  try {
    const result = (await execFileAsync(nodeBin, [DRIVER_PATH, JSON.stringify(spec)], {
      encoding: "utf-8",
      timeout: timeoutSec * 1_000 + EXEC_BUFFER_MS,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    })) as unknown as { stdout: string };
    stdout = result.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
    throw new Error(`browser driver failed: ${stderr || (err as Error).message || "unknown"}`.slice(0, 500));
  }

  const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
  if (!line) throw new Error("browser driver produced no JSON result");
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch {
    throw new Error(`browser driver produced unparseable output: ${line.slice(0, 200)}`);
  }
  const result = parsed as Record<string, unknown>;

  // Evidence: one row per call, metadata only, secret-gated. Harvest
  // summaries never include a token or cookie values.
  const summary =
    action === "turnstile"
      ? `browser turnstile ${params.url ?? ""} ${result.ok === true ? "ok" : "fail"} source=${String(result.source ?? "?")} tokenLength=${String(result.token ?? "").length}`
      : action === "clearance"
        ? `browser clearance ${params.url ?? ""} ${result.ok === true ? "ok" : "fail"} cookies=${Array.isArray(result.cookies) ? result.cookies.length : 0}`
        : `browser ${action} ${params.url ?? "<current page>"} ${result.ok === true ? "ok" : "fail"} url=${String(result.url ?? "")} title=${String(result.title ?? "").slice(0, 80)} inputs=${Array.isArray(result.inputs) ? result.inputs.length : 0}`;
  try {
    if (!containsSecretLike(summary)) {
      openEvidence().addEvidence({
        kind: "browser",
        refs: [action, params.url ?? ""],
        text: `${summary}${result.ok === true ? "" : ` error=${String(result.error ?? "").slice(0, 200)}`}`,
        sensitivity: "internal",
      });
    }
  } catch { /* evidence is an audit trail, never the point of failure */ }

  if (result.ok !== true) {
    const errorText = `browser ${action} failed: ${String(result.error ?? "unknown driver error").slice(0, 400)}`;
    if (!result.diag || typeof result.diag !== "object") throw new Error(errorText);
    const diag = result.diag as Record<string, unknown>;
    const compact = compactDiag(diag);
    const text = clip([errorText, compact ? `; [diag] ${compact}` : "", ...failureSnapshotLines(diag)].join("\n"));
    return {
      text,
      meta: {
        action,
        url: String(result.url ?? params.url ?? ""),
        error: errorText,
        ...(compact ? { diag: compact } : {}),
      },
      isError: true,
      diag,
    };
  }

  return renderResult(action, result);
}

/* ---------------------------------------------------------------------- */
/* Tool definition                                                          */
/* ---------------------------------------------------------------------- */

const browserTool: ToolDefinition<typeof parameters> = {
  name: "browser",
  label: "browser",
  description:
    "The ONE browser tool — CloakBrowser engine (a real Chromium with C++-level fingerprint patches: WebGL present, browser-grade TLS/JA3/JA4), node subprocess with a NAMED PERSISTENT PROFILE: cookies + localStorage survive across calls and close, and a solved challenge's cf_clearance carries forward. " +
    "Session actions: navigate (url + ≤15 click/fill/press/waitSel/setCookie/eval steps on main-frame selectors, always returns a url/title/text/inputs/network/console snapshot; includeCookies on request), eval (console break-in with explicit return), snapshot (current page), close (profile kept). " +
    "Harvest actions (run HEAD-OFFSCREEN — a real invisible window; headless never starts a Cloudflare challenge): turnstile resolves a Turnstile token end-to-end (single-use, ~300s — present via bypass_fetch same-host immediately), clearance runs a full managed-challenge interstitial and returns the origin cookie jar + engine UA for a coherent bypass_fetch handoff, fingerprint reports the engine's own UA/JA3/JA4/HTTP-2 as any target sees it. " +
    "Headless and invisible by default; showUi:true opens a real visible browser window the work continues in. includeScreenshot(+fullPage) returns a PNG path you can open with read. Use per-target profiles. Authorized engagements only.",
  promptSnippet:
    "Use browser for ALL browser work on the CloakBrowser engine (named persistent profiles keep cookies/localStorage across calls and close): navigate/eval/snapshot/close for interactive sessions; browser turnstile <url> harvests a Turnstile token head-offscreen (single-use ~300s — present via bypass_fetch same-host IMMEDIATELY); browser clearance <url> runs a full Cloudflare challenge and hands back cf_clearance + UA — replay via bypass_fetch with the matching User-Agent header and same egress right away (the jar also persists in the profile); browser fingerprint reports the engine's UA/JA3/JA4/HTTP-2. showUi opens a visible window; includeScreenshot(+fullPage) returns a PNG path to open with read.",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
  async execute(
    _toolCallId: string,
    params: BrowserParams,
    signal: AbortSignal | undefined,
    _onUpdate,
    _ctx: ExtensionToolContext
  ): Promise<AgentToolResult> {
    validateParams(params);
    const { text, meta, isError, diag, cookies } = await runBrowser(params, signal);

    // close with shutdown:true: the profile dir IS the engine state and it
    // deliberately persists — only the driver's page/context is released.
    let shutdownNote = "";
    if (params.action === "close" && params.shutdown === true && !isError) {
      const profileDir = browserProfileDir(params.profile ?? "default", process.env).dir;
      shutdownNote = `cloak profile kept at ${profileDir} (cookies persist for the next call)`;
    }

    const details = {
      ...meta,
      ...(diag ? { diag } : {}),
      ...(cookies && cookies.length > 0 ? { cookies } : {}),
      ...(params.action === "close" && params.shutdown === true ? { shutdown: shutdownNote || "suppressed (call failed)" } : {}),
    };
    return {
      content: [{ type: "text", text: isError ? text : (shutdownNote ? [clip(text), shutdownNote].join("\n") : text) }],
      details: details as unknown as AgentToolResult["details"],
      ...(isError ? { isError: true } : {}),
    };
  },
};

export function registerBrowserAutoTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(browserTool);
}
