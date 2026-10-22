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
  test("passes a hostile file path as a single argv element, never shell-interpreted", async () => {
    const dir = await tempDir();
    const dump = join(dir, "argv.dump");
    await writeFakeGh(dir);
    await rm(dump, { force: true });
    const repo = "own.er/re-po";
    const path = "docs/a b.md";
    process.env.PATH = dir;
    process.env.GH_ARGV_DUMP = dump;
    process.env.GH_CANNED_OUTPUT = "";
    const result = await invoke({ action: "read", repo, path });
    const argv = await readArgv(dump);
    expect(argv).toEqual([
      "api",
      `repos/${repo}/contents/docs/a%20b.md`,
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
    // Every received piece stayed inside its own argv slot.
    expect(argv.some((arg) => arg === "rm -rf /" || arg === "-rf" || arg === "..")).toBe(false);
    expect(result.isError ?? false).toBe(false);
  });

  test("rejects traversal/metacharacter read targets before any process starts", async () => {
    const dir = await tempDir();
    const dump = join(dir, "argv.dump");
    await writeFakeGh(dir);
    process.env.PATH = dir;
    process.env.GH_ARGV_DUMP = dump;
    process.env.GH_CANNED_OUTPUT = '{"pwned":true}';
    for (const repo of ["owner/../evil", "own er/repo", "owner/re#po", "..", "owner/sub/repo"]) {
      await expect(invoke({ action: "read", repo, path: "a.md" })).rejects.toThrow(/repo/);
    }
    for (const path of ["../secrets", "/etc/hosts", "a/../../b", ".."]) {
      await expect(invoke({ action: "read", repo: "owner/re-po", path })).rejects.toThrow(/path/);
    }
    // The fake gh must never have been invoked for any rejection.
    expect(existsSync(dump)).toBe(false);
  });

  test("runs gh from the injected PATH, prints canned stdout and traces correct argv", async () => {
    const dir = await tempDir();
    const dump = join(dir, "argv.dump");
    await writeFakeGh(dir);
    const canned = '[{"number":2,"title":"traversal in upload","state":"open"}]';
    process.env.PATH = dir;
    process.env.GH_ARGV_DUMP = dump;
    process.env.GH_CANNED_OUTPUT = canned;
    const result = await invoke({ action: "issues", repo: "owner/repo", limit: 10 });
    expect(result.content).toEqual([{ type: "text", text: canned }]);
    expect(await readArgv(dump)).toEqual([
      "issue", "list", "--repo", "owner/repo", "--limit", "10", "--json", "number,title,state,url,labels",
    ]);
    expect(result.details).toEqual({
      action: "issues",
      argv: [join(dir, "gh"), "issue", "list", "--repo", "owner/repo", "--limit", "10", "--json", "number,title,state,url,labels"],
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
    // A truncated slice never ends in a lone high surrogate.
    const split = `${"a".repeat(31_999)}\ud83d\ude00`;
    process.env.GH_CANNED_OUTPUT = split;
    const surrogateSafe = await invoke({ action: "cve", query: "CVE-2024-1234" });
    expect(surrogateSafe.content[0]).toEqual({ type: "text", text: `${"a".repeat(31_999)}[truncated]` });
  });

  test("empty cve output falls back to an explicit no-advisories message", async () => {
    const dir = await tempDir();
    await writeFakeGh(dir);
    process.env.PATH = dir;
    process.env.GH_ARGV_DUMP = join(dir, "argv.dump");
    process.env.GH_CANNED_OUTPUT = "";
    const result = await invoke({ action: "cve", query: "CVE-2024-9999" });
    expect(result.content[0]).toEqual({ type: "text", text: "No advisories found" });
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
      "api", "-X", "GET", "search/repositories", "-f", "q=upload traversal", "-F", "per_page=10", "-F", "page=1", "--jq",
      "[.items[] | {fullName: .full_name, description: .description, url: .html_url, stargazersCount: .stargazers_count}]",
    ]);
    expect(existsSync(process.env.GH_ARGV_DUMP!)).toBe(true);
  });

  test("fails with a clear error when gh is not available", async () => {
    process.env.PATH = await emptyDir();
    await expect(invoke({ action: "issues", repo: "owner/repo" })).rejects.toThrow("gh CLI not available");
  });

  test("uses explicit search kind and supports bounded result counts", async () => {
    const dir = await tempDir();
    const dump = join(dir, "argv.dump");
    await writeFakeGh(dir);
    process.env.PATH = dir;
    process.env.GH_ARGV_DUMP = dump;
    process.env.GH_CANNED_OUTPUT = "[]";
    await invoke({ action: "search", searchKind: "code", query: "buffer overflow", limit: 23, page: 3 });
    expect(await readArgv(dump)).toEqual(["api", "-X", "GET", "search/code", "-f", "q=buffer overflow", "-F", "per_page=23", "-F", "page=3", "--jq", "[.items[] | {path: .path, repository: .repository.full_name, sha: .sha, url: .html_url}]"]);
    await writeFile(dump, "", "utf8");
    await invoke({ action: "search", searchKind: "issues", query: "buffer overflow", page: 2 });
    expect(await readArgv(dump)).toEqual(["api", "-X", "GET", "search/issues", "-f", "q=buffer overflow", "-F", "per_page=10", "-F", "page=2", "--jq", "[.items[] | select(.pull_request == null) | {title: .title, url: .html_url, repository: .repository.full_name}]"]);
    await expect(invoke({ action: "search", searchKind: "issues", query: "x", limit: 51 })).rejects.toThrow(/limit/);
    await expect(invoke({ action: "search", searchKind: "repos", query: "x", page: 21 })).rejects.toThrow(/page/);
  });

  test("read accepts a ref and diff requires a validated repo and PR number", async () => {
    const dir = await tempDir();
    const dump = join(dir, "argv.dump");
    await writeFakeGh(dir);
    process.env.PATH = dir;
    process.env.GH_ARGV_DUMP = dump;
    process.env.GH_CANNED_OUTPUT = "diff";
    await invoke({ action: "read", repo: "owner/repo", path: "src/a.ts", ref: "feature/name" });
    expect(await readArgv(dump)).toEqual(["api", "repos/owner/repo/contents/src/a.ts?ref=feature%2Fname", "-H", "Accept: application/vnd.github.raw"]);
    await writeFile(dump, "", "utf8");
    await invoke({ action: "diff", repo: "owner/repo", pullRequest: 42 });
    expect(await readArgv(dump)).toEqual(["pr", "diff", "42", "--repo", "owner/repo"]);
    await expect(invoke({ action: "diff", repo: "owner/../repo", pullRequest: 42 })).rejects.toThrow(/repo/);
    await expect(invoke({ action: "diff", repo: "owner/repo" })).rejects.toThrow(/pullRequest/);
  });

  test("rejects malformed parameters before any process starts", async () => {
    process.env.PATH = await emptyDir();
    await expect(invoke({ action: "read", repo: "owner/repo" })).rejects.toThrow(/repo and path required/);
    await expect(invoke({ action: "search" })).rejects.toThrow(/query required/);
  });
});
