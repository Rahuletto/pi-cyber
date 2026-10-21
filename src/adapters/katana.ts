/**
 * katana — JS-aware crawler (ProjectDiscovery).
 *
 * Target handling: katana accepts a positional target list upstream, so the
 * targets array joins as repeated positional argv elements; the `-l` list
 * file mode stays available to the operator via `extra` only, since
 * buildArgs never builds temporary files.
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, jsonLines, modelList, operatorExtra, requireModelList } from "./util.ts";

type KatanaParams = Static<typeof katanaSchema>;

const katanaSchema = Type.Object(
  {
    targets: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 256 }),
    depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  },
  { additionalProperties: false },
);

export const katana: AdapterDef = {
  name: "katana",
  bin: "katana",
  versionFlag: "-version",
  mutating: false, // crawls, never submits state-changing forms by design
  artifactKind: "jsonl",
  schema: katanaSchema,
  buildArgs(params: ToolParams, _opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as KatanaParams;
    const args: string[] = [];
    for (const target of requireModelList(p.targets, "targets", "katana")) args.push(target); // positional targets
    args.push("-jsonl");
    if (typeof p.depth === "number" && Number.isInteger(p.depth)) args.push("-d", String(p.depth));
    args.push(...operatorExtra(p.extra));
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    return jsonLines(stdout).flatMap((line) => {
      const request = typeof line.request === "object" && line.request !== null
        ? (line.request as Record<string, unknown>)
        : undefined;
      const response = typeof line.response === "object" && line.response !== null
        ? (line.response as Record<string, unknown>)
        : undefined;
      const endpoint = request && typeof request.endpoint === "string" ? request.endpoint : line.url;
      if (typeof endpoint !== "string" || endpoint.length === 0) return []; // skip malformed records
      return [{
        kind: "katana",
        key: endpoint,
        raw: clipRaw(JSON.stringify(line)),
        meta: {
          method: request && typeof request.method === "string" ? request.method : undefined,
          status: response && typeof response.status_code === "number" ? response.status_code : undefined,
          event: typeof line.event === "string" ? line.event : undefined,
        },
      }];
    });
  },
};
