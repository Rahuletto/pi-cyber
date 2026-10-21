import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, chmod, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadManifest, toolStates, TOOL_CATEGORIES, type ToolEntry } from "../src/tools/manifest.ts";

const directories: string[] = [];
beforeEach(async () => { directories.push(await mkdtemp(resolve(tmpdir(), "cyber-manifest-"))); });
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function entry(partial: Partial<ToolEntry>): Record<string, unknown> {
  return { name: partial.name ?? "probe", category: partial.category ?? "recon", version: "pin-at-install", disposition: partial.disposition ?? "core", ...partial };
}

test("loadManifest reads the real catalog with required fields and no duplicates", async () => {
  const manifest = await loadManifest();
  const names = manifest.tools.map((tool) => tool.name);
  expect(names).toContain("subfinder");
  expect(names).toContain("obscura");
  expect(names).toContain("nmap");
  expect(names).toContain("understand-anything");
  for (const tool of manifest.tools) {
    expect(tool.name.length).toBeGreaterThan(0);
    expect(TOOL_CATEGORIES).toContain(tool.category);
    expect(["core", "on-demand", "reference", "platform-limited", "deferred"]).toContain(tool.disposition);
    expect(tool.version).toEqual("pin-at-install");
  }
  expect(new Set(names).size).toBe(names.length);
  const deferred = manifest.tools.filter((tool) => tool.disposition === "deferred").map((tool) => tool.name);
  expect(deferred).toEqual(expect.arrayContaining(["ghidra", "jdk21"]));
  const nmap = manifest.tools.find((tool) => tool.name === "nmap");
  expect(nmap?.note).toContain("x86_64-only");
});

test("loadManifest rejects an unknown category", async () => {
  const path = resolve(directories[0], "bad-category.json");
  await writeFile(path, JSON.stringify({ tools: [entry({ category: "hax" as never })] }));
  await expect(loadManifest(path)).rejects.toThrow(/unknown category "hax"/);
});

test("loadManifest rejects an unknown disposition", async () => {
  const path = resolve(directories[0], "bad-disposition.json");
  await writeFile(path, JSON.stringify({ tools: [entry({ disposition: "validated" as never })] }));
  await expect(loadManifest(path)).rejects.toThrow(/unknown disposition "validated"/);
});

test("loadManifest rejects a duplicate name", async () => {
  const path = resolve(directories[0], "duplicate.json");
  await writeFile(path, JSON.stringify({ tools: [entry({ name: "ffuf" }), entry({ name: "ffuf", category: "web" })] }));
  await expect(loadManifest(path)).rejects.toThrow(/duplicate tool name.*ffuf/);
});

test("loadManifest is strict about unknown keys (ledgered Task-2 deferral resolved)", async () => {
  const path = resolve(directories[0], "unknown-key.json");
  const row = entry({ name: "probe" }) as Record<string, unknown>;
  row.veresion = "9.9.9"; // deliberately misspelled to prove silent-drop is gone
  await writeFile(path, JSON.stringify({ tools: [row] }));
  await expect(loadManifest(path)).rejects.toThrow(/unknown key "veresion"/);
});

test("loadManifest parses the typed installer fields and rejects a malformed sha256", async () => {
  const good = resolve(directories[0], "fields.json");
  await writeFile(good, JSON.stringify({
    tools: [entry({ name: "httpx", sha256: null }), { ...entry({ name: "subfinder" }), sha256: "A".repeat(64), versionFlag: "-version" }],
  }));
  const manifest = await loadManifest(good);
  const tool = manifest.tools.find((t) => t.name === "subfinder");
  expect(tool?.versionFlag).toBe("-version");
  expect(tool?.sha256?.length).toBe(64);
  expect(manifest.tools.find((t) => t.name === "httpx")?.sha256).toBeNull();

  const bad = resolve(directories[0], "bad-sha.json");
  await writeFile(bad, JSON.stringify({ tools: [{ ...entry({ name: "ffuf" }), sha256: "deadbeef" }] }));
  await expect(loadManifest(bad)).rejects.toThrow(/sha256.*64-hex/);
});

test("toolStates stays cataloged with no state file and an empty PATH", async () => {
  const manifest = await loadManifest();
  const states = await toolStates(manifest, resolve(directories[0], "missing.json"), "");
  for (const tool of manifest.tools) expect(states[tool.name]).toBe("cataloged");
});

test("toolStates escalates to available for executables found on an injected PATH", async () => {
  await writeFile(resolve(directories[0], "httpx"), "#!/bin/sh\nexit 0\n");
  await chmod(resolve(directories[0], "httpx"), 0o755);
  await writeFile(resolve(directories[0], "not-a-bin"), "plain file");
  const manifest = await loadManifest();
  const states = await toolStates(manifest, resolve(directories[0], "missing-path.json"), directories[0]);
  expect(states["httpx"]).toBe("available");
  expect(states["subfinder"]).toBe("cataloged");
  await expect(stat(resolve(directories[0], "executed"))).rejects.toThrow(); // never executed anything
});

test("toolStates reads installed/validated marks from the state file; validated wins over PATH", async () => {
  const dir = directories[0];
  await writeFile(resolve(dir, "subfinder"), "#!/bin/sh\nexit 0\n");
  await chmod(resolve(dir, "subfinder"), 0o755);
  const stateFile = resolve(dir, "state.json");
  await writeFile(stateFile, JSON.stringify({
    subfinder: { state: "installed", version: "1.0.0" },
    httpx: { state: "validated", version: "1.1.0", validatedAt: "2026-10-21" },
    gitleaks: { state: "validated" },
  }));
  const manifest = await loadManifest();
  const states = await toolStates(manifest, stateFile, dir);
  expect(states["subfinder"]).toBe("available"); // state file installed, binary on PATH → available
  expect(states["httpx"]).toBe("validated"); // state file pass mark wins even off PATH
  expect(states["gitleaks"]).toBe("validated");
  expect(states["obscura"]).toBe("cataloged");
});

test("toolStates throws on a malformed state file instead of silently ignoring it", async () => {
  const manifest = await loadManifest();
  const stateFile = resolve(directories[0], "broken.json");
  await writeFile(stateFile, "{ not json");
  await expect(toolStates(manifest, stateFile, "")).rejects.toThrow(/unreadable state file/);
});
