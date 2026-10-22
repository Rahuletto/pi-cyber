#!/usr/bin/env node
/**
 * challenge-driver.mjs — ephemeral node subprocess driving Obscura over CDP.
 *
 * The harness (Bun) never imports playwright/patchright itself: this script is
 * spawned with `execFile`, receives ONE JSON argv element, does its work by
 * driving the CDP engine with Patchright (the patched Playwright driver), and
 * prints exactly one JSON object line to stdout:
 *
 *   {"ok":true,  ...fields}        -> the tool turns this into content text
 *   {"ok":false,"error":"..."}     -> expected failure (tool surfaces it)
 *
 * Any catastrophic failure writes a plain message to stderr and exits
 * non-zero; the tool prefixes that path with "challenge driver failed:".
 *
 * Patchright is loaded from an operator-managed directory (never from the
 * harness package), so the harness package.json stays Bun-only.
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { existsSync } from "node:fs";

const spec = JSON.parse(process.argv[2] ?? "{}");
const fail = (error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error).slice(0, 500) }) + "\n");
  process.exit(0);
};

try {
  const root = String(spec.patchrightDir ?? "");
  if (!root || !/^[~A-Za-z0-9._\-/]+$/.test(root)) fail("driver misconfigured: missing patchrightDir");
  // Two supported layouts: an operator npm root containing node_modules/, and
  // a bare node_modules directory that directly holds the package.
  const candidates = [
    join(root, "node_modules", "patchright", "package.json"),
    join(root, "patchright", "package.json"),
  ];
  if (!candidates.some((p) => existsSync(p))) fail(`patchright not installed under ${root}`);
  const loader = createRequire(join(root, "package.json"));
  const { chromium } = loader("patchright");

  const endpoint = String(spec.endpoint ?? "");
  if (!/^wss?:\/\/[A-Za-z0-9._:\-/]+$/.test(endpoint)) fail("driver misconfigured: missing CDP endpoint");
  const timeoutMs = Math.min(Number(spec.timeoutMs ?? 45_000), 120_000);

  const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    if (spec.action === "fingerprint") {
      const target = spec.url || "https://tls.peet.ws/api/all";
      await page.goto(target, { timeout: Math.min(timeoutMs, 60_000), waitUntil: "load" });
      const ua = await page.evaluate(() => navigator.userAgent);
      let json = null;
      try { json = JSON.parse(await page.evaluate(() => document.body.innerText)); } catch { /* non-JSON target */ }
      const result = {
        ok: true,
        url: target,
        ua,
        ...(json
          ? {
              ja3: (json.tls ?? {}).ja3_hash ?? null,
              ja4: (json.tls ?? {}).ja4 ?? null,
              http2: ((json.http2 ?? {}).akamai_fingerprint) ?? null,
            }
          : { text: (await page.evaluate(() => document.body.innerText)).slice(0, 8_000) }),
      };
      process.stdout.write(JSON.stringify(result) + "\n");
      process.exit(0);
    }

    // action === "turnstile": load the page and harvest the resolved
    // cf-turnstile-response token, checking every frame (the widget iframe
    // owns the input; the outer page usually mirrors it via the callback).
    const target = String(spec.url ?? "");
    if (!target) fail("driver misconfigured: missing url");
    await page.goto(target, { timeout: Math.min(timeoutMs, 60_000), waitUntil: "load" });
    const deadline = Date.now() + timeoutMs;
    let token = null;
    let tokenFrame = null;
    while (Date.now() < deadline) {
      for (const frame of page.frames()) {
        try {
          const value = await frame.evaluate(() => {
            const el = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
            return el ? String((el).value || "") : "";
          });
          if (value.length > 10) { token = value; tokenFrame = frame.url(); break; }
        } catch { /* detached frame; try the next one */ }
      }
      if (token) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const ua = await page.evaluate(() => navigator.userAgent);
    if (!token) {
      fail(`no turnstile token resolved within ${timeoutMs}ms at ${target}`);
    }
    process.stdout.write(JSON.stringify({ ok: true, url: target, ua, frame: tokenFrame, token }) + "\n");
    process.exit(0);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (error) {
  fail(error?.message ?? error);
}
