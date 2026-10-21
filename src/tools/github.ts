import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * GitHub tool backed by the local `gh` CLI.
 *
 * Safety contract: the model's parameters are treated strictly as data. Every gh
 * invocation goes through promisified `execFile` with an argument array — never a
 * shell string — so metacharacters, spaces and newlines inside parameters cannot
 * break out of their argv slot. Output is clipped to a bounded size before it
 * re-enters the model context.
 */

const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 32_000;
const TRUNCATED = "[truncated]";

const execFileAsync = promisify(execFile);

/** Find an executable `gh` in the given search paths (defaults to process.env.PATH). */
export function resolveGhPath(paths?: string[]): string | null {
  const directories = paths ?? (process.env.PATH ? process.env.PATH.split(delimiter) : []);
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = join(directory, "gh");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not on this path entry; keep searching.
    }
  }
  return null;
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let cut = text.slice(0, MAX_OUTPUT_CHARS);
  // Never emit a lone surrogate: drop a trailing half of a split pair.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

/** owner/name with a conservative character set; guards the read endpoint against traversal. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Read targets interpolate into the authenticated GitHub API path: validate them before any call. */
function validateReadTarget(repo: string, path: string): void {
  if (!REPO_PATTERN.test(repo)) throw new Error(`Invalid repo for the read action: expected owner/name of [A-Za-z0-9_.-] only (rejected ${JSON.stringify(repo.slice(0, 64))}).`);
  if (path.startsWith("/")) throw new Error(`Invalid path for the read action: path must be relative to the repo root (rejected ${JSON.stringify(path.slice(0, 64))}).`);
  if (path.split("/").some((segment) => segment === "..")) throw new Error(`Invalid path for the read action: path must not contain '..' segments (rejected ${JSON.stringify(path.slice(0, 64))}).`);
}


async function runGh(ghPath: string, args: string[], signal: AbortSignal | undefined): Promise<string> {
  try {
    const { stdout } = (await execFileAsync(ghPath, args, {
      encoding: "utf-8",
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER_BYTES,
      signal,
    })) as unknown as { stdout: string };
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (err.code === "ENOENT") throw new Error("gh CLI not available");
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    const detail = (stderr.trim() || err.message || "").split("\n")[0].slice(0, 500);
    throw new Error(`gh failed: ${detail}`);
  }
}

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("search"),
    Type.Literal("read"),
    Type.Literal("cve"),
    Type.Literal("issues"),
    Type.Literal("prs"),
  ], { description: "GitHub interaction to perform." }),
  query: Type.Optional(Type.String({ description: "Search query (search), or CVE id/keyword (cve)." })),
  repo: Type.Optional(Type.String({ description: "owner/repo for read, issues and prs." })),
  path: Type.Optional(Type.String({ description: "File path inside repo (read)." })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 10, description: "Max results; default 10." })),
}, { additionalProperties: false });

type GithubParams = Static<typeof parameters>;

/** Map actions to gh argv arrays. Every parameter stays inside a single argv element. */
function buildArgs(params: GithubParams): string[] {
  const limit = String(params.limit ?? 10);
  switch (params.action) {
    case "search": {
      const kind = params.query!.includes(" ") ? "issues" : "repos";
      return kind === "issues"
        ? ["search", "issues", params.query!, "--limit", limit, "--json", "title,url,repository"]
        : ["search", "repos", params.query!, "--limit", limit, "--json", "fullName,description,url,stargazersCount"];
    }
    case "read":
      return ["api", `repos/${params.repo}/contents/${params.path}`, "-H", "Accept: application/vnd.github.raw"];
    case "cve":
      return ["api", `advisories?keyword=${encodeURIComponent(params.query!)}`, "--jq", ".[] | {ghsaId, summary, severity, published_at, url}"];
    case "issues":
      return ["issue", "list", "--repo", params.repo!, "--limit", limit, "--json", "number,title,state,url,labels"];
    case "prs":
      return ["pr", "list", "--repo", params.repo!, "--limit", limit, "--json", "number,title,state,url,headRefName"];
  }
}

function requireFields(params: GithubParams): void {
  const { action, query, repo, path } = params;
  if ((action === "search" || action === "cve") && !query) throw new Error(`query required for the ${action} action.`);
  if (action === "read" && (!repo || !path)) throw new Error("repo and path required for the read action.");
  if ((action === "issues" || action === "prs") && !repo) throw new Error(`repo required for the ${action} action.`);
}

const githubTool: ToolDefinition<typeof parameters> = {
  name: "github",
  label: "GitHub API",
  description:
    "Search repos, read files, list issues/PRs, look up CVEs using the gh CLI. " +
    "Actions: search (code/repos/issues), read (file from repo), cve (search advisories), issues, prs.",
  promptSnippet:
    "Use the github tool for CVE research, exploit sourcing, or examining target source code via GitHub. " +
    "It uses the authenticated gh CLI on this machine.",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
  async execute(
    _toolCallId: string,
    params: GithubParams,
    signal: AbortSignal | undefined,
    _onUpdate,
    _ctx: ExtensionToolContext
  ): Promise<AgentToolResult> {
    requireFields(params);
    if (params.action === "read") validateReadTarget(params.repo!, params.path!);
    const ghPath = resolveGhPath();
    if (!ghPath) throw new Error("gh CLI not available");
    const argv = buildArgs(params);
    const stdout = await runGh(ghPath, argv, signal);
    let text = clip(stdout);
    if (params.action === "cve" && text.trim().length === 0) text = "No advisories found";
    return {
      content: [{ type: "text", text }],
      details: { action: params.action, argv: [ghPath, ...argv] },
    };
  },
};

export function registerGithubTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(githubTool);
}
