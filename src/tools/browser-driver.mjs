#!/usr/bin/env node
/**
 * browser-driver.mjs — the general-purpose browser lane. ONE engine,
 * CloakBrowser via launchPersistentContext — a stealth Chromium whose
 * cookies + localStorage live in a persistent profile dir, so state
 * SURVIVES across driver calls AND across close (closing the persistent
 * context SAVES the profile). Headless by default; spec.showUi:true
 * launches headed — a real visible window, and the work keeps flowing in
 * it. Spec: {cloakDir, profileDir, showUi, url/steps/code, include*-flags,
 * screenshot, screenshotDir, fullPage}.
 *
 * The HARVEST actions subsume the old challenge lane (deleted in the
 * merge — cloak is the single proven engine):
 *   turnstile   — head-offscreen FORCE, poll the proven 3-channel recipe
 *                 (getResponse() > host input > widget-frame input),
 *                 return the token with source+siteKey;
 *   clearance   — head-offscreen FORCE, run the full CF challenge
 *                 interstitial and poll the context jar for cf_clearance,
 *                 returning the whole origin jar + UA for bypass_fetch;
 *   fingerprint — the engine's UA + JA3/JA4/HTTP-2 as any target sees it.
 *
 * Contract:
 *   - spawned detached as `node browser-driver.mjs <one JSON argv>`,
 *   - prints exactly ONE JSON object line to stdout,
 *   - later calls attach to the per-profile daemon; shutdown releases it,
 *   - catastrophic setup failure (bad argv, missing cloak install) writes
 *     a plain message to stderr and exits non-zero; the tool surfaces
 *     that path as "browser driver failed:".
 *
 * Cookie/token discipline: cookie objects and values ONLY ever appear in
 * the designated `cookies` field (includeCookies, or the clearance jar
 * whose whole purpose is the bypass_fetch handoff). Nothing cookie-shaped
 * is printed elsewhere; a turnstile token appears only in its own result
 * field. Nothing token/cookie-shaped is ever logged.
 *
 * State reuse: one detached daemon keeps each profile context alive and
 * later driver calls attach over localhost. The last open http(s) tab is
 * selected by default; spec.tab pins a tab. On shutdown the persistent
 * profile saves cookies/localStorage for the next launch.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serve as serveSession, readEndpoint, sendSpec } from "./browser-session.mjs";

const spec = JSON.parse(process.argv[2] ?? "{}");

const fail = (error, diag) => {
  const out = { ok: false, error: String(error).slice(0, 500) };
  if (diag && typeof diag === "object") out.diag = diag;
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(0);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clampStr = (value, n) => String(value == null ? "" : value).slice(0, n);

const ACTIONS = ["navigate", "eval", "snapshot", "close", "turnstile", "clearance", "fingerprint"];

/* ---------------------------------------------------------------------- */
/* Turnstile harvest (the proven recipe from the old challenge lane)         */
/* ---------------------------------------------------------------------- */

/** Probe the widget's state honestly, one snapshot. */
async function harvestSnapshot(page) {
  const info = { globalLoaded: false, token: null, source: null, frameUrls: [] };
  // (a) HOST page: window.turnstile.getResponse() — the proven winner.
  try {
    const token = await page.evaluate(() => {
      const turnstile = window.turnstile;
      if (!turnstile || typeof turnstile.getResponse !== "function") return null;
      try {
        const list = typeof turnstile.getAllResponses === "function" ? turnstile.getAllResponses() : null;
        if (Array.isArray(list)) {
          const hit = list.find((entry) => typeof entry === "string" && entry.length > 20);
          if (hit) return hit;
        }
      } catch { /* fall through */ }
      for (const widget of document.querySelectorAll(".cf-turnstile")) {
        try {
          const response = turnstile.getResponse(widget);
          if (typeof response === "string" && response.length > 20) return response;
        } catch { /* keep probing */ }
      }
      return null;
    });
    if (typeof token === "string" && token.length > 20) {
      info.token = token;
      info.source = "getResponse";
      return info;
    }
  } catch { /* host context unavailable — keep probing */ }
  // (b) HOST hidden response input.
  try {
    const value = await page.evaluate(() => {
      const el = document.querySelector("input[name=cf-turnstile-response]");
      return el ? String(el.value ?? "") : "";
    });
    if (value.length > 20) {
      info.token = value;
      info.source = "hostInput";
      return info;
    }
  } catch { /* keep probing */ }
  // (c) widget frames (real Chromium — frame.evaluate binds correctly here).
  for (const frame of page.frames()) {
    const frameUrl = String(frame.url() ?? "");
    if (!frameUrl || frameUrl === "about:blank") continue;
    info.frameUrls.push(clampStr(frameUrl, 160));
    try {
      const value = await frame.evaluate(() => {
        const el = document.querySelector("input[name=cf-turnstile-response]");
        return el ? String(el.value ?? "") : "";
      });
      if (value.length > 20) {
        info.token = value;
        info.source = "widgetFrame";
        return info;
      }
    } catch { /* detached or execution-context race — next frame */ }
  }
  // Honest flags for diag (which stage ever happened).
  info.globalLoaded = await page.evaluate(() => typeof window.turnstile === "object" && window.turnstile !== null).catch(() => false);
  return info;
}

/** Compact diag for a failed turnstile harvest. */
async function turnstileDiag(page, timeoutMs, everLoaded) {
  const snap = everLoaded
    ? await harvestSnapshot(page).catch(() => ({ frameUrls: [] }))
    : { globalLoaded: false, frameUrls: [] };
  let siteKey = null;
  try {
    siteKey = await page.evaluate(() => {
      const el = document.querySelector(".cf-turnstile[data-sitekey], [data-sitekey]");
      return el ? String(el.getAttribute("data-sitekey") ?? "").slice(0, 64) : null;
    });
  } catch { /* best-effort */ }
  const inputCount = await page.locator("input, textarea, select, button").count().catch(() => 0);
  return {
    url: clampStr(page.url(), 500),
    title: clampStr(await page.title().catch(() => ""), 200),
    siteKey,
    inputCount,
    pollMs: timeoutMs,
    turnstileGlobalLoaded: snap.globalLoaded === true,
    frameUrls: (snap.frameUrls ?? []).slice(0, 6),
  };
}
const STEP_OPS = ["click", "fill", "press", "waitSel", "setCookie", "eval"];
/** Resource types considered "script-ish" for the xhrScripts slice.
 *  CDP delivers these capitalized ("Document", "Script"), so match
 *  case-insensitively and fall back to the mimeType when empty. */
const SCRIPTISH = new Set(["document", "script", "fetch", "xhr", "stylesheet", "manifest"]);
function isScriptish(entry) {
  const type = String(entry?.resourceType ?? "").toLowerCase();
  if (SCRIPTISH.has(type)) return true;
  return !type && /javascript/.test(String(entry?.mimeType ?? "").toLowerCase());
}

/**
 * A semantic failure raised AFTER resources are held: caught in the outer
 * flow so the recorder/CDP cleanup in the inner finally still runs before
 * the failure line is written. `diag` carries the partial snapshot.
 */
class DriverFailure extends Error {
  constructor(message, diag) {
    super(message);
    this.name = "DriverFailure";
    if (diag && typeof diag === "object") this.diag = diag;
  }
}

/**
 * Network recorder: one CDP session on the selected page, registered ONCE
 * per driver call right after page selection (before any navigation) and
 * detached in the inner finally. requestWillBeSent opens an entry keyed by
 * requestId; responseReceived fills status/type; loadingFinished fills the
 * received byte length when the engine reports it. Deterministic clamp:
 * at most 200 entries kept, oldest dropped, last 40 script-ish reported.
 */
async function attachRecorder(context, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable").catch(() => {});
  const entries = new Map();
  const order = [];
  cdp.on("Network.requestWillBeSent", (params) => {
    const url = clampStr(params?.request?.url, 300);
    if (!/^https?:/.test(url)) return;
    const entry = {
      method: clampStr(params?.request?.method, 10),
      url,
      status: null,
      size: null,
      resourceType: clampStr(params?.type, 24),
    };
    entries.set(params.requestId, entry);
    if (order.length >= 200) order.shift();
    order.push(params.requestId);
  });
  cdp.on("Network.responseReceived", (params) => {
    const entry = entries.get(params?.requestId);
    if (!entry) return;
    if (typeof params?.response?.status === "number") entry.status = params.response.status;
    if (params?.type) entry.resourceType = clampStr(params.type, 24);
    const mime = clampStr(params?.response?.mimeType, 60);
    if (mime) entry.mimeType = mime;
  });
  cdp.on("Network.loadingFinished", (params) => {
    const entry = entries.get(params?.requestId);
    if (!entry) return;
    if (typeof params?.encodedDataLength === "number") {
      entry.size = Math.max(0, Math.floor(params.encodedDataLength));
    }
  });
  return {
    cdp,
    take: () => order.map((id) => entries.get(id)).filter(Boolean),
    total: () => order.length,
    async detach() { await cdp.detach().catch(() => {}); },
  };
}

/**
 * Console/pageerror capture. Attach BEFORE any navigation; text() may be
 * unavailable for cross-origin frames on this engine — a placeholder is
 * recorded instead of losing the event. Last 40 messages, type-distinguished.
 */
function attachConsole(page, sink) {
  const onConsole = (message) => {
    let text = "";
    let type = "";
    try { text = message.text(); } catch { text = "<unavailable>"; }
    try { type = message.type(); } catch { type = ""; }
    if (sink.length >= 40) sink.shift();
    sink.push({ type: clampStr(type, 24), text: clampStr(text, 240) });
  };
  const onPageError = (error) => {
    if (sink.length >= 40) sink.shift();
    sink.push({ type: "pageerror", text: clampStr(error?.message ?? String(error), 240) });
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  return () => {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  };
}

/**
 * One defensive normalization pass over the caller's steps. Steps arrive
 * schema-validated from the tool (≤15, ops whitelisted); anything malformed
 * here becomes a per-step error record in the report, never a driver crash.
 */
function normalizeSteps(raw) {
  if (!Array.isArray(raw)) return [];
  const steps = [];
  for (const entry of raw.slice(0, 15)) {
    if (!entry || typeof entry !== "object") continue;
    const op = String(entry.op ?? "");
    if (!STEP_OPS.includes(op)) continue;
    const step = { op };
    if (entry.sel != null) step.sel = String(entry.sel).slice(0, 256);
    if (entry.value != null) step.value = String(entry.value).slice(0, 8000);
    steps.push(step);
  }
  return steps;
}

/**
 * Runner for one interaction step. MAIN-frame selectors only: on this
 * engine page.click/fill resolve to the main frame, and frame.evaluate for
 * cross-origin frames silently executes in the host context, so sub-frame
 * automation is intentionally unsupported (see the header note). Returns a
 * step-report object; per-step errors are recorded, never fatal.
 */
async function runStep(page, context, step, stepTimeout) {
  switch (step.op) {
    case "click": {
      if (!step.sel) throw new Error("sel required");
      await page.click(step.sel, { timeout: stepTimeout });
      return { ok: true };
    }
    case "fill": {
      if (!step.sel) throw new Error("sel required");
      await page.fill(step.sel, String(step.value ?? ""), { timeout: stepTimeout });
      return { ok: true };
    }
    case "press": {
      // optional sel: focus via main-frame click first, then the keyboard key
      if (step.sel) await page.click(step.sel, { timeout: stepTimeout });
      await page.keyboard.press(String(step.value ?? "Enter"));
      return { ok: true };
    }
    case "waitSel": {
      if (!step.sel) throw new Error("sel required");
      await page.waitForSelector(step.sel, { timeout: stepTimeout, state: "attached" });
      return { ok: true };
    }
    case "setCookie": {
      // requires navigating FIRST: the cookie url is the CURRENT page origin.
      // value = JSON string {name,value[,domain,path]}.
      const current = page.url();
      if (!/^https?:/.test(current)) throw new Error("setCookie requires a navigated http(s) page first");
      let parsed;
      try { parsed = JSON.parse(String(step.value ?? "")); } catch {
        throw new Error("setCookie value must be a JSON object {name,value[,domain,path]}");
      }
      const cookie = {
        name: String(parsed?.name ?? "").slice(0, 200),
        value: String(parsed?.value ?? "").slice(0, 4000),
        url: new URL(current).origin,
      };
      if (!cookie.name) throw new Error("setCookie requires a name");
      if (parsed?.domain) cookie.domain = String(parsed.domain).slice(0, 200);
      if (parsed?.path) cookie.path = String(parsed.path).slice(0, 200);
      await context.addCookies([cookie]);
      return { ok: true };
    }
    case "eval": {
      // statements executed as a function body: use an explicit return or
      // the result is undefined. The result must be JSON-serializable.
      const value = String(step.value ?? "").slice(0, 8000);
      const result = await page.evaluate((src) => { const fn = new Function(src); return fn(); }, value);
      return { ok: true, result: describeValue(result, 2000) };
    }
    default:
      throw new Error(`unknown op ${clampStr(step.op, 24)}`);
  }
}

/** JSON-safe description of an eval result, clamped to `limit` chars. */
function describeValue(value, limit) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value.slice(0, limit);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value).slice(0, limit); }
  catch { return clampStr(value, limit); }
}

/** Per-action output flags: navigate always reports network+console. */
function optionFlags(spec) {
  const navDefault = String(spec.action ?? "") === "navigate";
  return {
    network: spec.includeNetwork === undefined ? navDefault : spec.includeNetwork === true,
    console: spec.includeConsole === undefined ? navDefault : spec.includeConsole === true,
    cookies: spec.includeCookies === true,
  };
}

/**
 * The snapshot: lightweight, always built on success AND on failure (as
 * diag). Cookie objects appear only when requested, only here.
 */
async function buildSnapshot(page, context, recorder, consoleMsgs, spec) {
  const flags = optionFlags(spec);
  const out = {};
  try { out.url = page.url().slice(0, 500); } catch { out.url = ""; }
  try { out.title = (await page.title()).slice(0, 200); } catch { out.title = ""; }
  try {
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
    out.text = clampStr(text, 6000);
  } catch { out.text = ""; }
  try {
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input, textarea, select"), (el) => {
        const row = {
          name: String(el.getAttribute("name") ?? "").slice(0, 100),
          id: String(el.id ?? "").slice(0, 100),
          type: String(
            el.getAttribute("type") ??
            (el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : "text")
          ).slice(0, 20),
        };
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) row.placeholder = String(placeholder).slice(0, 120);
        return row;
      })
    );
    out.inputs = inputs.slice(0, 30);
    out.inputCount = out.inputs.length;
  } catch { out.inputs = []; out.inputCount = 0; }
  if (flags.network && recorder) {
    const all = recorder.take();
    out.xhrScripts = all
      .filter(isScriptish)
      .slice(-40)
      .map((entry) => ({
        method: entry.method,
        url: entry.url,
        ...(entry.status == null ? {} : { status: entry.status }),
        ...(entry.resourceType ? { resourceType: entry.resourceType } : {}),
        ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
        ...(entry.size == null ? {} : { size: entry.size }),
      }));
    out.networkTotal = recorder.total();
  }
  if (flags.console) {
    out.console = consoleMsgs.map((m) => ({ type: m.type, text: m.text }));
  }
  if (flags.cookies) {
    try {
      const origin = /^https?:/.test(out.url) ? new URL(out.url).origin : "";
      const cookies = origin ? await context.cookies(origin) : [];
      out.cookies = cookies.slice(0, 60).map((cookie) => ({
        name: String(cookie.name ?? "").slice(0, 100),
        domain: String(cookie.domain ?? "").slice(0, 100),
        value: String(cookie.value ?? "").slice(0, 120), // cookie values go NOWHERE else
        httpOnly: cookie.httpOnly === true,
        secure: cookie.secure === true,
      }));
    } catch { out.cookies = []; }
  }
  return out;
}

/**
 * Locate and load the cloakbrowser package from the operator root
 * (the proven loader: package.json candidates → pkg.main →
 * pathToFileURL import — import("pkg") by bare name would resolve inside
 * THIS package, not the operator's npm root).
 */
async function loadCloak(root) {
  if (!root || !/^[~A-Za-z0-9._\-/]+$/.test(root)) fail("driver misconfigured: missing cloakDir");
  const candidates = [join(root, "node_modules", "cloakbrowser"), join(root, "cloakbrowser")];
  const pkgDir = candidates.find((dir) => existsSync(join(dir, "package.json")));
  if (!pkgDir) fail(`cloakbrowser not installed under ${root}`);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  } catch (error) {
    fail(`cloakbrowser package.json unreadable under ${pkgDir}: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  const entry = typeof pkg?.main === "string" && pkg.main ? pkg.main : "index.js";
  try {
    const mod = await import(pathToFileURL(join(pkgDir, entry)).href);
    if (typeof mod?.launch !== "function") fail(`cloakbrowser loaded from ${pkgDir} but exports no launch()`);
    return mod;
  } catch (error) {
    fail(`cloakbrowser failed to load from ${pkgDir}: ${String(error?.message ?? error).slice(0, 200)}`);
  }
}

/**
 * Screenshot support (any action but close via the same spec fields):
 * PNG straight to disk — the result carries the absolute path + byte size,
 * NEVER an inline base64 blob (output stays small). fullPage wants the full
 * scroll height; Chromium caps page height ~16384px and playwright throws
 * past it — that error falls back to a viewport shot with a `note`.
 */
async function takeScreenshot(page, spec) {
  const dir = String(spec.screenshotDir ?? "") || "/tmp";
  mkdirSync(dir, { recursive: true }); // idempotent; the TS side pre-creates it
  const path = join(dir, `browser-shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    await page.screenshot({ path, fullPage: spec.fullPage === true, timeout: 15_000 });
  } catch (error) {
    if (spec.fullPage !== true) {
      throw new Error(`screenshot failed: ${clampStr(error?.message ?? String(error), 200)}`);
    }
    // full-page capture exceeded the height cap (or raced a detach): retry
    // viewport and note the fallback honestly.
    await page.screenshot({ path, fullPage: false, timeout: 15_000 });
    return {
      screenshotPath: path,
      screenshotBytes: shotBytes(path),
      screenshotNote: "fullPage capture failed (page too tall for Chromium's ~16384px cap); saved a viewport shot instead",
    };
  }
  return { screenshotPath: path, screenshotBytes: shotBytes(path) };
}

function shotBytes(path) {
  try { return statSync(path).size; } catch { return null; }
}

/**
 * Shared action dispatch — IDENTICAL semantics on both engines (cloak hands
 * the context the driver runs on). `base` is
 * the any earlier degrade payload (e.g. recorderError). Throws DriverFailure
 * carrying the diag snapshot for the ok:false path; the caller decides.
 */
async function performAction(action, spec, page, context, recorder, consoleMsgs, timeoutMs, connectDeadline, base) {
  if (action === "turnstile") {
    // Proven recipe: goto, then poll the three channels every ~750ms.
    // NO init-script trap — a get-only accessor on window.turnstile makes
    // api.js silently bail ("already loaded") and the widget never boots.
    const target = String(spec.url ?? "");
    if (!/^https?:\/\//.test(target)) throw new DriverFailure("driver misconfigured: turnstile needs an http(s) url");
    let everLoaded = false;
    try {
      await page.goto(target, { timeout: Math.min(timeoutMs, 60_000), waitUntil: "load" });
    } catch (error) {
      const message = clampStr(error?.message ?? String(error), 160).replace(/\s+/g, " ");
      throw new DriverFailure(`goto failed at ${target}: ${message}`, await turnstileDiag(page, timeoutMs, false));
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = await harvestSnapshot(page);
      everLoaded = everLoaded || snap.globalLoaded;
      if (snap.token && snap.token.length > 20) {
        let siteKey = null;
        try {
          siteKey = await page.evaluate(() => {
            const el = document.querySelector(".cf-turnstile[data-sitekey], [data-sitekey]");
            return el ? String(el.getAttribute("data-sitekey") ?? "").slice(0, 64) : null;
          });
        } catch { /* best-effort */ }
        let ua = "";
        try { ua = await page.evaluate(() => navigator.userAgent); } catch { /* keep empty */ }
        return {
          ok: true,
          url: target,
          ua,
          token: snap.token,
          source: snap.source,
          siteKey,
          ...(base ?? {}),
        };
      }
      await sleep(750);
    }
    throw new DriverFailure(`no turnstile token resolved within ${timeoutMs}ms at ${target}`, await turnstileDiag(page, timeoutMs, everLoaded));
  }
  if (action === "clearance") {
    // Full CF challenge interstitial: run headed-offscreen, poll the context
    // jar for cf_clearance, then hand the whole origin jar + UA back. The
    // jar also PERSISTS in the profile, so later calls reuse it directly.
    const target = String(spec.url ?? "");
    if (!/^https?:\/\//.test(target)) throw new DriverFailure("driver misconfigured: clearance needs an http(s) url");
    try {
      await page.goto(target, { timeout: Math.min(timeoutMs, 60_000), waitUntil: "load" });
    } catch (error) {
      const message = clampStr(error?.message ?? String(error), 160).replace(/\s+/g, " ");
      throw new DriverFailure(`goto failed at ${target}: ${message}`, { url: clampStr(page.url(), 500) });
    }
    const origin = new URL(target).origin;
    const deadline = Date.now() + timeoutMs;
    let sawChallenge = false;
    let title = "";
    while (Date.now() < deadline) {
      const jar = await context.cookies(origin).catch(() => []);
      if (jar.some((cookie) => cookie.name === "cf_clearance")) break;
      const titleNow = clampStr(await page.title().catch(() => ""), 200);
      if (!sawChallenge) {
        sawChallenge = /just a moment|checking your browser|attention required/i.test(titleNow)
          || jar.some((cookie) => /^cf_chl/.test(cookie.name));
      }
      title = titleNow;
      await sleep(1_500);
    }
    const jar = await context.cookies(origin).catch(() => []);
    const clearance = jar.find((cookie) => cookie.name === "cf_clearance");
    let ua = "";
    try { ua = await page.evaluate(() => navigator.userAgent); } catch { /* keep empty */ }
    const cookies = jar.map((cookie) => ({
      name: clampStr(cookie.name, 64),
      value: clampStr(String(cookie.value ?? ""), 4_096),
      domain: clampStr(cookie.domain, 128),
      path: clampStr(cookie.path, 128),
      expiresSec: typeof cookie.expires === "number" ? Math.min(Math.round(cookie.expires), 4_102_444_800) : null,
    }));
    if (!clearance) {
      throw new DriverFailure(`no cf_clearance after ${timeoutMs}ms at ${target}`, {
        ok: false,
        url: clampStr(page.url(), 500),
        title,
        sawChallenge,
        cookieNames: jar.map((cookie) => cookie.name),
        ua: clampStr(ua, 300),
      });
    }
    return {
      ok: true,
      url: target,
      finalUrl: clampStr(page.url(), 500),
      title: clampStr(await page.title().catch(() => ""), 200),
      ua,
      sawChallenge,
      cookies,
      ...(base ?? {}),
    };
  }
  if (action === "fingerprint") {
    // The engine's own network fingerprints as any target sees them; no-tls
    // service fallback keeps an honest text body on hand.
    let target = String(spec.url ?? "") || "https://tls.peet.ws/api/all";
    if (!/^https?:\/\//.test(target)) throw new DriverFailure("driver misconfigured: fingerprint needs an http(s) url");
    await page.goto(target, { timeout: Math.min(timeoutMs, 60_000), waitUntil: "load" });
    let ua = "";
    try { ua = await page.evaluate(() => navigator.userAgent); } catch { /* keep empty */ }
    const result = { ok: true, url: target, ua, ...(base ?? {}) };
    try {
      const parsed = JSON.parse(await page.evaluate(() => document.body.innerText));
      result.ja3 = parsed.tls?.ja3_hash ?? null;
      result.ja4 = parsed.tls?.ja4 ?? null;
      result.http2 = parsed.http2?.akamai_fingerprint ?? null;
    } catch {
      result.text = clampStr(await page.evaluate(() => document.body.innerText), 8_000);
    }
    return result;
  }
  if (action === "close") {
    // closes ONLY this driver's page; the persistent profile itself stays
    // on disk — that reuse is the lane's whole purpose.
    let closedUrl = "";
    try { closedUrl = page.url().slice(0, 500); } catch { closedUrl = ""; }
    await page.close().catch(() => {});
    return { ok: true, closed: true, ...(base ?? {}), url: closedUrl };
  }
  if (action === "navigate") {
    const target = String(spec.url ?? "");
    if (!/^https?:\/\//.test(target)) throw new DriverFailure("driver misconfigured: navigate needs an http(s) url");
    let navError = null;
    try {
      await page.goto(target, { timeout: Math.min(timeoutMs, 60_000), waitUntil: "load" });
    } catch (error) {
      navError = clampStr(error?.message ?? String(error), 300);
    }
    // Steps run sequentially within the remaining budget; every step
    // reports its own outcome and the sequence CONTINUES past errors.
    const startedAt = Date.now();
    const steps = normalizeSteps(spec.steps);
    const stepsReport = [];
    for (let index = 0; index < steps.length; index++) {
      const step = steps[index];
      const remaining = Math.max(1, timeoutMs - (Date.now() - startedAt));
      try {
        const report = { index, op: step.op, ...(await runStep(page, context, step, Math.min(10_000, remaining))) };
        stepsReport.push(report);
      } catch (error) {
        stepsReport.push({
          index,
          op: step.op,
          ok: false,
          error: clampStr(error?.message ?? String(error), 200).replace(/\s+/g, " "),
        });
      }
    }
    const snapshot = await buildSnapshot(page, context, recorder, consoleMsgs, spec);
    if (navError) {
      throw new DriverFailure(`navigation failed: ${navError}`, { ...snapshot, steps: stepsReport });
    }
    return { ok: true, ...snapshot, ...(base ?? {}), steps: stepsReport };
  }
  if (action === "eval") {
    const code = String(spec.code ?? "").slice(0, 16_000);
    if (!code) throw new DriverFailure("driver misconfigured: eval needs code");
    const consoleStart = consoleMsgs.length;
    const remaining = Math.max(1, timeoutMs - (Date.now() - connectDeadline));
    let result;
    let evalTimer;
    try {
      result = await Promise.race([
        page.evaluate((src) => { const fn = new Function(src); return fn(); }, code),
        new Promise((_, reject) => {
          evalTimer = setTimeout(() => reject(new Error(`eval exceeded its ${remaining}ms budget`)), remaining);
        }),
      ]);
    } catch (error) {
      const snapshot = await buildSnapshot(page, context, recorder, consoleMsgs, spec);
      throw new DriverFailure(`eval failed: ${clampStr(error?.message ?? String(error), 300).replace(/\s+/g, " ")}`, snapshot);
    } finally {
      clearTimeout(evalTimer);
    }
    const snapshot = await buildSnapshot(page, context, recorder, consoleMsgs, spec);
    return {
      ok: true,
      ...snapshot,
      ...(base ?? {}),
      result: describeValue(result, 16_000),
      resultType: result === null ? "null" : typeof result,
      consoleDuringEval: consoleMsgs.slice(consoleStart).map((m) => ({ type: m.type, text: m.text })),
    };
  }
  // action snapshot: no navigation, current page state only.
  const snapshot = await buildSnapshot(page, context, recorder, consoleMsgs, spec);
  return { ok: true, ...snapshot, ...(base ?? {}) };
}

/** Screenshot on success (never the close action — the page is gone). */
async function withScreenshot(result, page, spec, action) {
  if (spec.screenshot === true && action !== "close") {
    return { ...(await takeScreenshot(page, spec)), ...result };
  }
  return result;
}

/* ---------------------------------------------------------------------- */
/* Main flow                                                                */
/* ---------------------------------------------------------------------- */
async function launchContext(spec) {
  const cloak = await loadCloak(String(spec.cloakDir));
  if (typeof cloak.launchPersistentContext !== "function") {
    throw new Error("cloakbrowser exports no launchPersistentContext()");
  }
  const harvest = spec.action === "turnstile" || spec.action === "clearance";
  const showUi = spec.showUi === true;
  const args = harvest && !showUi ? ["--window-position=-32000,-32000", "--window-size=1280,900"] : [];
  if (!spec.profileDir) throw new Error("driver misconfigured: cloak mode needs profileDir");
  return cloak.launchPersistentContext({
    userDataDir: String(spec.profileDir), headless: harvest ? false : !showUi,
    viewport: { width: 1280, height: 900 }, ...(args.length ? { args } : {}),
  });
}

async function runOnce(spec, context) {
  const timeoutMs = Math.min(Math.max(Number(spec.timeoutMs ?? 60_000), 1_000), 180_000);
  const action = String(spec.action ?? "");
  let recorder = null;
  let page;
  let detachConsole;
  try {
    if (!ACTIONS.includes(action)) throw new DriverFailure(`unknown action "${clampStr(action, 32)}"`);
    const connectDeadline = Date.now();
    const pages = context.pages().filter((p) => !p.isClosed() && /^https?:/.test(p.url()));
    const tabs = pages.map((p, index) => ({ index, url: clampStr(p.url(), 300) }));
    if (spec.tab === undefined || spec.tab === null) {
      page = pages.length ? pages[pages.length - 1] : await context.newPage();
    } else {
      const index = Number(spec.tab);
      if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
        throw new DriverFailure(`tab ${clampStr(String(spec.tab), 12)} is not an open tab (open: ${pages.length})`, { tabs });
      }
      page = pages[index];
    }
    const tabIndex = Math.max(0, pages.indexOf(page));
    const consoleMsgs = [];
    detachConsole = attachConsole(page, consoleMsgs);
    let base = null;
    try { recorder = await attachRecorder(context, page); }
    catch (error) { base = { recorderError: clampStr(error?.message ?? String(error), 200) }; }
    let result = await performAction(action, spec, page, context, recorder, consoleMsgs, timeoutMs, connectDeadline, base);
    result = await withScreenshot({ ...result, tab: tabIndex, tabs }, page, spec, action);
    return { ...result, ...(action === "close" && spec.shutdown === true ? { shutdown: true } : {}) };
  } catch (error) {
    return { ok: false, error: clampStr(error?.message ?? String(error), 500),
      ...(error instanceof DriverFailure && error.diag ? { diag: error.diag } : {}) };
  } finally {
    try { if (recorder) await recorder.detach(); } catch { /* already detached */ }
    detachConsole?.();
  }
}

try {
  const profileDir = String(spec.profileDir ?? "");
  const live = profileDir ? readEndpoint(profileDir) : null;
  if (live) {
    try {
      const attached = await sendSpec(live.port, live.token, spec);
      process.stdout.write(JSON.stringify(attached) + "\n");
      process.exit(0);
    } catch (error) {
      // Only a refused connection proves the old daemon is gone. A slow or
      // disconnected response must never replay a potentially mutating action.
      if (error.code !== "ECONNREFUSED" && error.code !== "ENOENT") throw error;
    }
  }
  const context = await launchContext(spec);
  const first = await runOnce(spec, context);
  if (spec.action === "close" && spec.shutdown === true) {
    await context.close();
    process.stdout.write(JSON.stringify(first) + "\n");
  } else {
    // Publish the endpoint before acknowledging the first call.
    const session = await serveSession(profileDir, context, (next) => runOnce(next, context));
    process.stdout.write(JSON.stringify(first) + "\n");
    await session.closed;
  }
} catch (error) {
  if (error instanceof DriverFailure) fail(error.message, error.diag);
  fail(error?.message ?? String(error));
}
