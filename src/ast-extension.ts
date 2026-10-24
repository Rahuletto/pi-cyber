import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Assert } from "typebox/value";
import type { AstWorkspace, Binding } from "./ast.ts";

const language = Type.Optional(Type.Union(["javascript", "typescript", "tsx", "css", "html"].map((name) => Type.Literal(name))));
const path = Type.String({ minLength: 1, maxLength: 1024 });
const pat = Type.String({ minLength: 1, maxLength: 4096 });
const ops = Type.Array(Type.Object({ pat, out: Type.String({ maxLength: 4096 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 8 });
const proposalId = Type.String({ minLength: 1, maxLength: 64 });
// Keep action-specific validation local: Bedrock rejects root schema unions.
const editInputSchema = Type.Union([
  Type.Object({ action: Type.Literal("preview"), path, language, ops }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("apply"), proposalId }, { additionalProperties: false }),
]);

/** Intentionally absent from the package's default pi.extensions entry list. */
export default function astExtension(pi: ExtensionAPI): void {
  let active: { cwd: string; sessionId: string; workspace: Promise<AstWorkspace> } | undefined;
  const reset = () => { active = undefined; };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  const workspace = (ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!active || active.cwd !== ctx.cwd || active.sessionId !== sessionId) {
      active = { cwd: ctx.cwd, sessionId, workspace: import("./ast.ts").then(({ AstWorkspace }) => new AstWorkspace(ctx.cwd)).catch(() => { active = undefined; throw new Error("Optional AST engine could not load. Install the pinned optional dependency with bun install; no parser is downloaded at tool execution."); }) };
    }
    return active.workspace;
  };
  const binding = (ctx: ExtensionContext): Binding => ({ sessionId: ctx.sessionManager.getSessionId(), branch: ctx.sessionManager.getBranch().map((entry) => entry.id) });
  const result = <T>(details: T) => ({ content: [{ type: "text" as const, text: JSON.stringify(details) }], details });
  pi.registerTool({
    name: "ast_grep", label: "AST search",
    description: "Read-only structural source search using ast-grep patterns and $NAME/$$$NAME captures. Supply 1-32 explicit workspace files; no glob or directory traversal. Supported: javascript, typescript, tsx, css, html. Maximum 256 KiB/file, 2 MiB/search, 100 matches, 64 KiB output. Reports parse diagnostics, skipped files and truncation. Syntax matches are leads, not semantic/security proof. Source snippets enter the normal tool result; select sanitized files.",
    parameters: Type.Object({ paths: Type.Array(path, { minItems: 1, maxItems: 32 }), pat, language, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) { return result(await (await workspace(ctx)).grep(params)); },
  });
  pi.registerTool({
    name: "ast_edit", label: "AST staged edit",
    description: "Explicitly requested implementation only: preview structural replacements in one workspace file without writing, then apply its opaque proposalId separately. Preview returns before/after changes; apply rechecks session/branch, original hash, canonical path, symlinks/hardlinks, overlap and parser errors. Proposals expire on session/tree changes or after eight newer previews. Limits: 8 operations, 100 matches, 256 KiB file, 64 KiB result. Empty out deletes matched syntax. No multi-file transaction or semantic refactoring guarantee; review and run compiler/tests. Mode prompts do not authorize edits. No automatic evidence/session copies beyond the ordinary tool result.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("preview"), Type.Literal("apply")], { description: "preview requires path and ops; apply takes only proposalId." }),
      path: Type.Optional(path), language, ops: Type.Optional(ops), proposalId: Type.Optional(proposalId),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      Assert(editInputSchema, params);
      const tools = await workspace(ctx), identity = binding(ctx);
      return result(params.action === "preview" ? await tools.preview(params, identity) : await tools.apply(params.proposalId, identity));
    },
  });
}
