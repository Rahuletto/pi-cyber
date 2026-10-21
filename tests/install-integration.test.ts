import { test, expect } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadManifest } from "../src/tools/manifest.ts";
import { freezeResolved, loadResolved, pickDarwinArm64Asset, type ResolvedRecord } from "../src/tools/installer.ts";
import { spawn } from "node:child_process";

test("pickDarwinArm64Asset matches only darwin/arm64 install assets (pure unit — no spawn, no network)", () => {
  const assets = [
    { name: "subfinder_2.8.0_linux_amd64.zip", url: "https://x/1" },
    { name: "subfinder_2.8.0_linux_arm64.zip", url: "https://x/2" },
    { name: "trivy_0.69.0_macOS-64bit.tar.gz", url: "https://x/3" }, // intel macOS
    { name: "trivy_0.69.0_macOS-ARM64.tar.gz", url: "https://x/4" },
    { name: "osv-scanner_darwin_amd64_md5.txt", url: "https://x/5" },
    { name: "ZAP_2.16.1.dmg", url: "https://x/6" },
    { name: "ffuf_2.1.0_darwin_arm64.zip", url: "https://x/7" },
    { name: "osv-scanner_darwin_arm64", url: "https://x/8" },
  ];
  expect(pickDarwinArm64Asset(assets)?.url).toBe("https://x/4");
  expect(pickDarwinArm64Asset(assets.slice(4))?.url).toBe("https://x/7"); // dmg excluded, bare binary accepted
  expect(pickDarwinArm64Asset([{ name: "tool_darwin_amd64.zip", url: "https://x/9" }])).toBeNull();
});

const NET = process.env.PI_CYBER_NET === "1";

function fixtureRecord(name: string, sha: string, resolvedAt: string): ResolvedRecord {
  return { name, repo: `example/${name}`, tag: "v1.2.3", assetUrl: `https://example.com/${name}_darwin_arm64.tar.gz`, sha256: sha, resolvedAt };
}

test.skipIf(!NET)(
  "dry-run prints a plan of exactly the manifest core entries and touches nothing",
  async () => {
    const work = await mkdtemp(resolve(tmpdir(), "cyber-install-"));
    try {
      const proc = spawn("bash", ["tools/install.sh", "--dry-run"], {
        cwd: resolve(import.meta.dir, ".."),
        env: { ...process.env, PI_TOOLS_DIR: work },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const [code, stdout, stderr] = await new Promise<[number, string, string]>((done, reject) => {
        let out = "";
        let err = "";
        proc.stdout.on("data", (c) => { out += String(c); });
        proc.stderr.on("data", (c) => { err += String(c); });
        proc.on("error", reject);
        proc.on("close", (c) => done([c ?? -1, out, err]));
      });

      expect(stderr).toBe("");
      expect(code).toBe(0);

      const manifest = await loadManifest();
      const core = manifest.tools.filter((tool) => tool.disposition === "core").map((tool) => tool.name);
      const planned = stdout.split("\n").filter((line) => line.startsWith("[plan] ")).map((line) => line.split(/\s+/)[1]);
      expect(planned.sort()).toEqual([...core].sort());

      for (const line of stdout.split("\n").filter((line) => line.startsWith("[plan] "))) {
        const name = line.split(/\s+/)[1];
        const entry = manifest.tools.find((tool) => tool.name === name);
        expect(entry?.repo).toBeTruthy();
        expect(line).toContain(`repo=${entry?.repo}`);
        expect(line).toContain("pattern=");
        expect(line).toContain(`target=${join(work, "bin", name)}`);
      }

      // dry-run touches nothing: no bin dir, no state file, no entries created under PI_TOOLS_DIR.
      expect(await readdir(work)).toEqual([]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

test.skipIf(!NET)(
  "freezeResolved freezes fixture records without ever touching tools/manifest.json",
  async () => {
    const work = await mkdtemp(resolve(tmpdir(), "cyber-freeze-"));
    try {
      const resolvedPath = join(work, "manifest.resolved.json");
      const manifestBefore = await readFile(resolve(import.meta.dir, "..", "tools", "manifest.json"));

      await freezeResolved(resolvedPath, fixtureRecord("subfinder", "a".repeat(64), "2026-10-21T00:00:00Z"));
      expect((await loadResolved(resolvedPath))["subfinder"]?.tag).toBe("v1.2.3");

      // second tool merges; re-freezing a name replaces it
      await freezeResolved(resolvedPath, fixtureRecord("dnsx", "b".repeat(64), "2026-10-21T00:00:01Z"));
      const map = await loadResolved(resolvedPath);
      expect(Object.keys(map).sort()).toEqual(["dnsx", "subfinder"]);
      await freezeResolved(resolvedPath, fixtureRecord("subfinder", "c".repeat(64), "2026-10-21T00:00:02Z"));
      expect((await loadResolved(resolvedPath))["subfinder"]?.sha256).toBe("c".repeat(64));

      // freeze is atomic + pretty-formatted, never mutates the reviewed manifest
      const manifestAfter = await readFile(resolve(import.meta.dir, "..", "tools", "manifest.json"));
      expect(manifestAfter.equals(manifestBefore)).toBe(true);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
