import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerGithubTool, resolveGhPath } from "../src/tools/github.ts";

/**
 * Modelless tests: a fake `gh` executable is placed on an injected PATH. The fake
 * appends each argv element it received, followed by an ---ARG--- marker line, to
 * a dump file and prints canned stdout. That proves both what argv reached the
 * binary (one element per slot, newlines inside values stay inside values) and
 * what came back out.
 */

const ARG_MARKER = "\n---ARG---\n";
const directories: string[] = [];
const savedEnv: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  GH_ARGV_DUMP: process.env.GH_ARGV_DUMP,
  GH_CANNED_OUTPUT: process.env.GH_CANNED_OUTPUT,
};

let github: ToolDefinition<any, any, any> | undefined;
registerGithubTool({ registerTool: (tool) => { github = tool as ToolDefinition<any, any, any>; } } as Pick<ExtensionAPI, "registerTool">);

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cyber-gh-"));
  directories.push(dir);
  return dir;
}

async function writeFakeGh(dir: string): Promise<void> {
  const script = join(dir, "gh");
  await writeFile(script, [
    "#!/bin/bash",
    'if [ -n "${GH_ARGV_DUMP:-}" ]; then',
    '  printf \'%s\\n---ARG---\\n\' "$@" >> "$GH_ARGV_DUMP"',
    "fi",
    'printf \'%s\' "${GH_CANNED_OUTPUT:-}"',
    "",
  ].join("\n"));
  await chmod(script, 0o755);
}

async function emptyDir(): Promise<string> {
  const dir = await tempDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

function parseArgv(raw: string): string[] {
  if (raw === "") return [];
  const parts = raw.split(ARG_MARKER);
  // The trailing element after the final marker is always empty.
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

async function invoke(params: unknown, signal?: AbortSignal): Promise<AgentToolResult<any>> {
  const result = await github!.execute!("fixture-call", params as never, signal, undefined, undefined as never);
  return result as AgentToolResult<any>;
}

async function readArgv(dump: string): Promise<string[]> {
  return parseArgv(await readFile(dump, "utf-8"));
}

describe("resolveGhPath", () => {
  test("returns null when no candidate directory holds an executable gh", async () => {
    expect(resolveGhPath([join(await tempDir(), "does-not-exist")])).toBeNull();
    expect(resolveGhPath([await emptyDir()])).toBeNull();
    expect(resolveGhPath([])).toBeNull();
  });

  test("defaults to process.env.PATH and returns null on a fake missing PATH", async () => {
    process.env.PATH = await emptyDir();
    expect(resolveGhPath()).toBeNull();
  });

  test("accepts an explicit search path list", async () => {
    const dir = await emptyDir();
    await writeFakeGh(dir);
    expect(resolveGhPath([await emptyDir(), dir])).toBe(join(dir, "gh"));
  });
});

describe("github tool", () => {
  test("passes hostile repo/path as single argv elements, never shell-interpreted", async () => {
    const dir = await tempDir();
    const dump = join(dir, "argv.dump");
    await writeFakeGh(dir);
    await rm(dump, { force: true });
    const repo = "x\nrm -rf /";
    const path = "docs/a b\nc\nd.md";
    process.env.PATH = dir;
    process.env.GH_ARGV_DUMP = dump;
    process.env.GH_CANNED_OUTPUT = "";
    const result = await invoke({ action: "read", repo, path });
    const argv = await readArgv(dump);
    expect(argv).toEqual([
      "api",
      `repos/${repo}/contents/${path}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
    // Every received piece stayed inside its own argv slot.
    expect(argv.some((arg) => arg === "rm -rf /" || arg === "-rf")).toBe(false);
    expect(result.isError ?? false).toBe(false);
  });

  test("runs gh from the injected PATH, prints canned stdout and traces correct argv", async () => {
    const dir = await tempDir();
    const dump = join(dir, "argv.dump");
    await writeFakeGh(dir);
    const canned = '[{"number":2,"title":"traversal in upload","state":"open"}]';
    process.env.PATH = dir;
    process.env.GH_ARGV_DUMP = dump;
    process.env.GH_CANNED_OUTPUT = canned;
    const result = await invoke({ action: "issues", repo: "own er/repo", limit: 10 });
    expect(result.content).toEqual([{ type: "text", text: canned }]);
    expect(await readArgv(dump)).toEqual([
      "issue", "list", "--repo", "own er/repo", "--limit", "10", "--json", "number,title,state,url,labels",
    ]);
    expect(result.details).toEqual({
      action: "issues",
      argv: [join(dir, "gh"), "issue", "list", "--repo", "own er/repo", "--limit", "10", "--json", "number,title,state,url,labels"],
    });
  });

  test("clips output beyond 32000 chars, appending [truncated]", async () => {
    const dir = await tempDir();
    const dump = join(dir, "argv.dump");
    await writeFakeGh(dir);
    process.env.PATH = dir;
    process.env.GH_ARGV_DUMP = dump;
    const oversized = "x".repeat(40_000);
    process.env.GH_CANNED_OUTPUT = oversized;
    const clipped = await invoke({ action: "cve", query: "CVE-2024-1234" });
    expect(clipped.content[0]).toEqual({ type: "text", text: `${oversized.slice(0, 32_000)}[truncated]` });
    // Output at or below the limit is passed through untouched.
    const exact = "y".repeat(32_000);
    process.env.GH_CANNED_OUTPUT = exact;
    const untouched = await invoke({ action: "cve", query: "CVE-2024-1234" });
    expect(untouched.content[0]).toEqual({ type: "text", text: exact });
  });

  test("resolves gh lazily per call, so PATH is honoured at execute time", async () => {
    const dir = await tempDir();
    await writeFakeGh(dir);
    process.env.PATH = dir;
    process.env.GH_ARGV_DUMP = join(dir, "argv.dump");
    process.env.GH_CANNED_OUTPUT = '{"search":[]}';
    const result = await invoke({ action: "search", query: "upload traversal" });
    expect(result.content[0]).toEqual({ type: "text", text: '{"search":[]}' });
    expect(await readArgv(process.env.GH_ARGV_DUMP!)).toEqual([
      "search", "issues", "upload traversal", "--limit", "10", "--json", "title,url,repository",
    ]);
    expect(existsSync(process.env.GH_ARGV_DUMP!)).toBe(true);
  });

  test("fails with a clear error when gh is not available", async () => {
    process.env.PATH = await emptyDir();
    await expect(invoke({ action: "issues", repo: "owner/repo" })).rejects.toThrow("gh CLI not available");
  });

  test("rejects malformed parameters before any process starts", async () => {
    process.env.PATH = await emptyDir();
    await expect(invoke({ action: "read", repo: "owner/repo" })).rejects.toThrow(/repo and path required/);
    await expect(invoke({ action: "search" })).rejects.toThrow(/query required/);
  });
});
