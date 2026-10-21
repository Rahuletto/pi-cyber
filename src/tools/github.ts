import type { Tool, ToolParams } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

const ghExec = (args: string[], cwd?: string): string => {
  try {
    return execSync(`gh ${args.join(" ")}`, {
      encoding: "utf-8",
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
    });
  } catch (e: any) {
    throw new Error(`gh failed: ${e.stderr?.trim() || e.message}`);
  }
};

export function registerGithubTool(pi: { registerTool: (tool: Tool) => void }): void {
  pi.registerTool({
    name: "github",
    label: "GitHub API",
    description:
      "Search repos, read files, list issues/PRs, look up CVEs using the gh CLI. " +
      "Actions: search (code/repos/issues), read (file from repo), cve (search advisories), issues, prs.",
    promptSnippet:
      "Use the github tool for CVE research, exploit sourcing, or examining target source code via GitHub. " +
      "It uses the authenticated gh CLI on this machine.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("search"),
        Type.Literal("read"),
        Type.Literal("cve"),
        Type.Literal("issues"),
        Type.Literal("prs"),
      ]),
      query: Type.Optional(Type.String({ description: "Search query" })),
      repo: Type.Optional(Type.String({ description: "owner/repo" })),
      path: Type.Optional(Type.String({ description: "File path in repo (for read action)" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)", default: 10 })),
    }),
    executionMode: "sequential",
    async execute(
      _id: string,
      params: ToolParams,
      _signal: AbortSignal,
      _onUpdate: any,
      _ctx: any
    ): Promise<{ content: { type: "text"; text: string }[] }> {
      const { action, query, repo, path, limit = 10 } = params as any;

      switch (action) {
        case "search": {
          if (!query) throw new Error("query required for search");
          const kind = query.includes(" ") ? "issues" : "repos";
          const out = ghExec([kind, "search", `"${query}"`, "--limit", String(limit), "--json", "url,title,repository"]);
          return { content: [{ type: "text", text: out }] };
        }
        case "read": {
          if (!repo || !path) throw new Error("repo and path required for read");
          const out = ghExec(["repo", "view", repo, "--json", "description,url"]);
          const content = ghExec(["repo", "view", repo, "--json", "files"]);
          // Use raw content via API
          const raw = execSync(`gh api repos/${repo}/contents/${path}`, {
            encoding: "utf-8", maxBuffer: 10 * 1024 * 1024, timeout: 15_000,
          });
          const parsed = JSON.parse(raw);
          const text = Buffer.from(parsed.content, "base64").toString("utf-8");
          return { content: [{ type: "text", text }] };
        }
        case "cve": {
          if (!query) throw new Error("CVE ID or search term required");
          const out = ghExec(["api", `advisories?keyword=${encodeURIComponent(query)}`, "--jq", ".[] | {id,summary,severity,published_at,url}"]);
          return { content: [{ type: "text", text: out || "No advisories found" }] };
        }
        case "issues": {
          if (!repo) throw new Error("repo required for issues");
          const out = ghExec(["issue", "list", "--repo", repo, "--limit", String(limit), "--json", "number,title,state,url,labels"]);
          return { content: [{ type: "text", text: out }] };
        }
        case "prs": {
          if (!repo) throw new Error("repo required for prs");
          const out = ghExec(["pr", "list", "--repo", repo, "--limit", String(limit), "--json", "number,title,state,url,headRefName"]);
          return { content: [{ type: "text", text: out }] };
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  });
}
