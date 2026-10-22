import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Run the actual driver; only Chromium is replaced. This catches startup and
// attach failures that canned tool output cannot exercise.
test("tool host exits while its detached driver survives, attaches later calls, and shuts down", async () => {
  const root = mkdtempSync(join(tmpdir(), "browser-driver-"));
  const pkg = join(root, "node_modules/cloakbrowser");
  const profileDir = join(root, "profiles/default");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", main: "index.mjs" }));
  writeFileSync(join(pkg, "index.mjs"), `
    import { EventEmitter } from 'node:events';
    import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    export function launch() {}
    export async function launchPersistentContext(options) {
      writeFileSync(join(options.userDataDir, "daemon.pid"), String(process.pid));
      let closed = false;
      const page = Object.assign(new EventEmitter(), {
        url: () => 'http://localhost/test', isClosed: () => closed,
        title: async () => 'fixture', close: async () => { closed = true; },
        evaluate: async (fn, arg) => arg ? Function(arg)() : 'body',
      });
      return { pages: () => [page], newPage: async () => page,
        cookies: async () => [{name: 'fixture', value: 'yes'}],
        close: async () => { closed = true; } };
    }
  `);
  const driver = fileURLToPath(new URL("../src/tools/browser-driver.mjs", import.meta.url));
  const children: ReturnType<typeof spawn>[] = [];
  let daemonPid: number | undefined;
  const call = (extra: Record<string, unknown>, toolHost = false) => new Promise<Record<string, any>>((resolve, reject) => {
    const child = toolHost
      ? spawn(process.execPath, ["-e", `
          import { runBrowser } from ${JSON.stringify(fileURLToPath(new URL("../src/tools/browser-auto.ts", import.meta.url)))};
          const result = await runBrowser({action: 'snapshot'}, undefined);
          console.log(JSON.stringify({ok: !result.isError}));
        `], { env: { ...process.env, CYBER_NODE_BIN: "node", CYBER_CLOAKBROWSER_DIR: root,
          CYBER_BROWSER_PROFILE_DIR: join(root, "profiles"), CYBER_EVIDENCE_DIR: join(root, "evidence") } })
      : spawn("node", [driver, JSON.stringify({ cloakDir: root, profileDir, action: "snapshot", ...extra })]);
    children.push(child);
    let output = "";
    const timer = setTimeout(() => reject(new Error("driver did not answer")), 2500);
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
  try {
    expect(await call({}, true)).toMatchObject({ ok: true });
    daemonPid = Number(readFileSync(join(profileDir, "daemon.pid"), "utf8"));
    const owner = children[0]!;
    await new Promise<void>((resolve, reject) => {
      if (owner.exitCode !== null) return resolve();
      const timer = setTimeout(() => reject(new Error("tool host stayed alive after its result")), 2000);
      owner.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    expect(owner.exitCode).toBe(0);
    expect(() => process.kill(daemonPid!, 0)).not.toThrow();
    const second = await call({ action: "eval", code: "return 42", includeCookies: true });
    expect(second.result).toBe("42");
    expect(second.cookies).toEqual([{ name: "fixture", domain: "", value: "yes", httpOnly: false, secure: false }]);
    const shutdown = await call({ action: "close", shutdown: true });
    expect(shutdown.ok).toBe(true);
    expect(shutdown.shutdown).toBe(true);
    expect(existsSync(join(profileDir, ".browser-session.json"))).toBe(false);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(daemonPid!, 0); } catch { daemonPid = undefined; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(daemonPid).toBeUndefined();
  } finally {
    for (const child of children) child.kill();
    if (daemonPid) { try { process.kill(daemonPid); } catch { /* already stopped */ } }
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);
