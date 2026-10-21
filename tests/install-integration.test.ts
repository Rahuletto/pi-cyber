import { test, expect } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadManifest } from "../src/tools/manifest.ts";
import { freezeResolved, loadResolved, pickDarwinArm64Asset, resolveLatest, type ResolvedRecord } from "../src/tools/installer.ts";
import { spawn } from "node:child_process";

/** Spawn bash (cwd = repo root), capture exit code + stdout/stderr. Args are an argv array — no shell-string surface of our own. */
function runScript(args: string[], envOverrides?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawn("bash", args, {
    cwd: resolve(import.meta.dir, ".."),
    ...(envOverrides ? { env: { ...process.env, ...envOverrides } } : {}),
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((done, reject) => {
    let out = "";
    let err = "";
    proc.stdout.on("data", (c) => { out += String(c); });
    proc.stderr.on("data", (c) => { err += String(c); });
    proc.on("error", reject);
    proc.on("close", (c) => done({ code: c ?? -1, stdout: out, stderr: err }));
  });
}

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

test(
  "toolctl list column contract — installed.sh-style parse binds the manifest sha pin to manifest_sha",
  async () => {
    // Fixture manifest with ALL five ToolEntry fields populated, in the exact columns toolctl emits.
    const work = await mkdtemp(resolve(tmpdir(), "cyber-contract-"));
    try {
      const sha = "e".repeat(64);
      const manifestPath = join(work, "manifest.json");
      await writeFile(manifestPath, JSON.stringify({
        tools: [{ name: "fixture-tool", category: "recon", repo: "example/fixture", version: "pin-at-install", disposition: "core", artifact: "fixture-tool_darwin_arm64.zip", sha256: sha, versionFlag: "-version" }],
      }));
      // Parse exactly the way tools/install.sh does: `IFS=$'\t' read -r name repo artifact versionFlag manifest_sha`.
      const script = `while IFS=$'\\t' read -r name repo artifact versionFlag manifest_sha; do
  [ -n "$name" ] || continue
  echo "parsed: name=$name repo=$repo artifact=$artifact flag=$versionFlag sha=$manifest_sha"
done < <(bun tools/toolctl.ts list core --file "${manifestPath}")`;
      const result = await runScript(["-c", script]);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      // If any column ever drifts, the bind below moves and this assert fails.
      expect(result.stdout.trim()).toBe(`parsed: name=fixture-tool repo=example/fixture artifact=fixture-tool_darwin_arm64.zip flag=-version sha=${sha}`);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

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

test.skipIf(!NET)(
  "binary_sha256 (additive installed-executable digest) round-trips through freezeResolved",
  async () => {
    const work = await mkdtemp(resolve(tmpdir(), "cyber-binsha-"));
    try {
      const resolvedPath = join(work, "manifest.resolved.json");
      const archiveSha = "a".repeat(64);
      const binarySha = "B".repeat(64); // uppercase on write; loader normalizes to lowercase
      await freezeResolved(resolvedPath, {
        name: "katana", repo: "projectdiscovery/katana", tag: "v1.4.0",
        assetUrl: "https://example.invalid/a.zip", sha256: archiveSha, resolvedAt: "2026-10-21T00:00:00Z",
        binary_sha256: binarySha,
      });
      const record = (await loadResolved(resolvedPath))["katana"];
      expect(record?.sha256).toBe(archiveSha); // archive digest, verified pin
      expect(record?.binary_sha256).toBe(binarySha.toLowerCase()); // executable digest, distinct file, normalized
      // Records without the additive field (older ledger) still load.
      await freezeResolved(resolvedPath, {
        name: "dnsx", repo: "projectdiscovery/dnsx", tag: "v1.3.1",
        assetUrl: "https://example.invalid/b.zip", sha256: "c".repeat(64), resolvedAt: "2026-10-21T00:00:01Z",
      });
      expect((await loadResolved(resolvedPath))["dnsx"]?.binary_sha256).toBeUndefined();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);

test("resolveLatest retries HTTP 403 with backoff and succeeds on a later attempt (injectable fetch, no network)", async () => {
  const release = { tag_name: "v9.8.7", assets: [{ name: "tool_9.8.7_darwin_arm64.zip", browser_download_url: "https://example.invalid/t.zip" }] };
  const statuses = [403, 403, 200];
  const seenUrls: string[] = [];
  const delays: number[] = [];
  const fakeFetch = async (url: string | URL): Promise<Response> => {
    seenUrls.push(String(url));
    const status = statuses.shift() ?? 200;
    if (status === 200) return Response.json(release, { status: 200 });
    return Response.json({ message: "API rate limit exceeded" }, { status });
  };
  const resolution = await resolveLatest("projectdiscovery/nuclei", {
    fetchImpl: fakeFetch as unknown as typeof fetch,
    delayMs: async (ms) => { delays.push(ms); },
  });
  expect(resolution.tag).toBe("v9.8.7");
  expect(seenUrls.length).toBe(3);
  expect(seenUrls.every((u) => u.startsWith("https://api.github.com/repos/projectdiscovery/nuclei/releases/latest"))).toBe(true);
  expect(delays).toEqual([2000, 5000]); // exponential backoff 2s/5s/15s up to 3 retries
});

test("resolveLatest treats 404 as permanent (single attempt, distinct message)", async () => {
  const calls: number[] = [];
  const fakeFetch = async (): Promise<Response> => {
    calls.push(1);
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  await expect(resolveLatest("example/no-such-repo", { fetchImpl: fakeFetch as unknown as typeof fetch, delayMs: async () => {} }))
    .rejects.toThrow(/HTTP 404.*no published release/);
  expect(calls.length).toBe(1);
});

test("resolveLatest sends the GitHub token as Bearer and never leaks it in errors", async () => {
  const release = { tag_name: "v1.0.0", assets: [{ name: "x_darwin_arm64.zip", browser_download_url: "https://example.invalid/x.zip" }] };
  const authHeaders: string[] = [];
  const fakeFetch = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
    authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json(release, { status: 200 });
  };
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "gh-token-for-test-only";
  try {
    const resolution = await resolveLatest("projectdiscovery/dnsx", { fetchImpl: fakeFetch as unknown as typeof fetch });
    expect(resolution.tag).toBe("v1.0.0");
    expect(authHeaders).toEqual(["Bearer gh-token-for-test-only"]);
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

test.skipIf(!NET)(
  "second run skips already-installed tools with a frozen pin — no resolve, no download, no re-freeze",
  async () => {
    const work = await mkdtemp(resolve(tmpdir(), "cyber-skip-"));
    try {
      const manifest = await loadManifest();
      const core = manifest.tools.filter((tool) => tool.disposition === "core");
      const sha = "f".repeat(64);
      // Fixture environment: every core tool marked installed, bin present+executable, pin frozen.
      const state: Record<string, unknown> = {};
      for (const tool of core) state[tool.name] = { state: "installed", version: "v9.9.9", sha256: sha };
      await writeFile(join(work, "state.json"), JSON.stringify(state, null, 2));
      await mkdir(join(work, "bin"), { recursive: true });
      for (const tool of core) {
        await writeFile(join(work, "bin", tool.name), "#!/bin/sh\nexit 0\n");
        await chmod(join(work, "bin", tool.name), 0o755);
      }
      const resolvedPath = join(work, "resolved.json");
      for (const tool of core) {
        await freezeResolved(resolvedPath, {
          name: tool.name, repo: tool.repo as string, tag: "v9.9.9",
          assetUrl: "https://example.invalid/asset", sha256: sha, resolvedAt: "2026-10-21T00:00:00Z",
        });
      }

      // If the skip logic ever regresses, this run would attempt GitHub resolve+download and fail
      // (example.invalid) — i.e. a network-free test that still proves "no re-download".
      const before = await readFile(resolvedPath);
      const result = await runScript(["tools/install.sh"], { PI_TOOLS_DIR: work, PI_RESOLVED_FILE: resolvedPath });
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      const skippedLines = result.stdout.split("\n").filter((line) => /^install: skip .* \(already installed/.test(line));
      expect(skippedLines.length).toBe(core.length);
      for (const tool of core) {
        expect(skippedLines.some((line) => line.startsWith(`install: skip ${tool.name}`))).toBe(true);
      }
      expect(result.stdout).toContain(`${core.length} skipped (already installed), 0 failed`);
      expect(result.stdout).not.toContain("[plan]");
      // No re-freeze: resolved ledger keeps its exact bytes; state file keeps its installed pins.
      expect((await readFile(resolvedPath)).equals(before)).toBe(true);
      const stateAfter = JSON.parse(await readFile(join(work, "state.json"), "utf8")) as Record<string, { state: string; sha256: string }>;
      for (const tool of core) {
        expect(stateAfter[tool.name]?.state).toBe("installed");
        expect(stateAfter[tool.name]?.sha256).toBe(sha);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
);
