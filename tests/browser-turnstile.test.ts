import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Exercise real dispatch, polling, tab metadata, and screenshot selection.
// Only the external Chromium package is replaced by a browser fixture.
for (const { duringGoto, emitEvents } of [
  { duringGoto: false, emitEvents: true },
  { duringGoto: true, emitEvents: true },
  { duringGoto: false, emitEvents: false },
]) {
  test(`turnstile follows reopened tabs ${duringGoto ? "during navigation" : "after navigation"} using ${emitEvents ? "events" : "the 10-second fallback"}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "browser-turnstile-"));
    const pkg = join(root, "node_modules/cloakbrowser");
    const profileDir = join(root, "profile");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(profileDir);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", main: "index.mjs" }));
    writeFileSync(join(pkg, "index.mjs"), `
      import { EventEmitter } from 'node:events';
      import { writeFileSync } from 'node:fs';
      export function launch() {}
      export async function launchPersistentContext() {
        const context = new EventEmitter();
        let originalClosed = false;
        let reopened = false;
        const page = (kind, url) => Object.assign(new EventEmitter(), {
          url: () => url,
          isClosed: () => kind === 'original' && originalClosed,
          title: async () => kind,
          goto: async () => {
            setTimeout(() => {
              originalClosed = true; reopened = true;
              if (${emitEvents}) { original.emit('close'); context.emit('page', replacement); replacement.emit('domcontentloaded'); }
            }, 40);
            if (${duringGoto}) {
              originalClosed = true;
              throw new Error('Target page, context or browser has been closed');
            }
          },
          evaluate: async (fn) => {
            if (kind === 'original' && originalClosed) throw new Error('Target page has been closed');
            const code = String(fn);
            if (code.includes('navigator.userAgent')) return 'fixture-ua';
            if (code.includes('data-sitekey')) return 'fixture-key';
            if (code.includes('getAllResponses')) return kind === 'decoy' ? 'wrong-origin-token-1234567890' : kind === 'replacement' ? 'replacement-token-1234567890' : null;
            if (code.includes('typeof window.turnstile')) return true;
            return '';
          },
          frames: () => { if (kind === 'original' && originalClosed) throw new Error('Target page has been closed'); return []; },
          locator: () => ({count: async () => 0}),
          screenshot: async ({path}) => {
            if (kind !== 'replacement') throw new Error('screenshot used the old page');
            writeFileSync(path, 'fixture');
          },
        });
        const original = page('original', 'http://localhost/signup');
        const replacement = page('replacement', 'http://localhost/signup?reopened=1');
        const decoy = page('decoy', 'http://unrelated.invalid/');
        return Object.assign(context, { pages: () => reopened ? [decoy, replacement] : [original, decoy], close: async () => {} });
      }
    `);
    const driver = fileURLToPath(new URL("../src/tools/browser-driver.mjs", import.meta.url));
    const child = spawn("node", [driver, JSON.stringify({
      action: "turnstile", cloakDir: root, profileDir, tab: 0,
      url: "http://localhost/signup", timeoutMs: 12000,
      screenshot: true, screenshotDir: root,
    })]);
    const started = Date.now();
    try {
      const result = await new Promise<Record<string, any>>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error("driver did not answer")), 14000);
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk) => {
          output += chunk;
          if (!output.includes("\n")) return;
          clearTimeout(timer);
          try { resolve(JSON.parse(output.split("\n")[0]!)); } catch (error) { reject(error); }
        });
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("exit", () => {
          clearTimeout(timer);
          if (!output.includes("\n")) reject(new Error("driver exited without a result"));
        });
      });
      expect(result).toMatchObject({ ok: true, token: "replacement-token-1234567890", tab: 1,
        finalUrl: "http://localhost/signup?reopened=1", ua: "fixture-ua", siteKey: "fixture-key" });
      expect(result.tabs).toMatchObject([
        { index: 0, url: "http://unrelated.invalid/" },
        { index: 1, url: "http://localhost/signup?reopened=1" },
      ]);
      expect(result.screenshotBytes).toBe(7);
      if (emitEvents) expect(Date.now() - started).toBeLessThan(3000);
      else expect(Date.now() - started).toBeGreaterThanOrEqual(9500);
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  }, 16000);
}
