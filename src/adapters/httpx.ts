/**
 * httpx — HTTP probe / tech fingerprinting (ProjectDiscovery).
 *
 * Target handling: httpx accepts multiple positional targets (as of 1.6.x),
 * so the targets array joins as repeated positional argv elements. The `-l`
 * list-file mode is deliberately unused — buildArgs never creates temp files
 * (`-l path` stays reachable via the operator-approved `extra`, if ever).
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, intList, jsonLines, modelList, operatorExtra, requireModelList } from "./util.ts";

type HttpxParams = Static<typeof httpxSchema>;

const httpxSchema = Type.Object(
  {
    targets: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 256 }),
    ports: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), { maxItems: 16 })),
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  },
  { additionalProperties: false },
);

export const httpx: AdapterDef = {
  name: "httpx",
  bin: "httpx",
  versionFlag: "-version",
  mutating: false, // probe traffic only (GET/HEAD-shaped requests)
  artifactKind: "jsonl",
  schema: httpxSchema,
  buildArgs(params: ToolParams, _opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as HttpxParams;
    const args: string[] = [];
    for (const target of requireModelList(p.targets, "targets", "httpx")) args.push(target); // positional targets
    args.push("-json");
    const ports = intList(p.ports);
    if (ports.length > 0) args.push("-p", ports.join(","));
    args.push(...operatorExtra(p.extra));
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    return jsonLines(stdout)
      .filter((line) => typeof line.url === "string" && line.url.length > 0)
      .map((line) => ({
        kind: "httpx",
        key: String(line.url),
        raw: clipRaw(JSON.stringify(line)),
        meta: {
          status: typeof line.status_code === "number" ? line.status_code : undefined,
          title: typeof line.title === "string" ? line.title : undefined,
          webserver: typeof line.webserver === "string" ? line.webserver : undefined,
          tech: Array.isArray(line.tech) ? (line.tech as unknown[]).filter((t) => typeof t === "string") : undefined,
          host: typeof line.host === "string" ? line.host : undefined,
        },
      }));
  },
};
