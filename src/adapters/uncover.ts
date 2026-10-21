/**
 * uncover — multi-provider external-asset discovery (ProjectDiscovery).
 *
 * Target handling: uncover takes the search query via `-q` (one query per
 * run). There is no meaningful `-l` target-list mode here — `-l` upstream
 * means "limit result count", so the optional `limit` param maps to that;
 * no temporary files are built in buildArgs.
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, jsonLines, modelString, operatorExtra, requireModelString, stringList } from "./util.ts";

type UncoverParams = Static<typeof uncoverSchema>;

const uncoverSchema = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 1000 }),
    engines: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("shodan"), Type.Literal("censys"), Type.Literal("fofa"),
          Type.Literal("quake"), Type.Literal("hunter"), Type.Literal("netlas"),
          Type.Literal("zoomeye"), Type.Literal("criminalip"),
        ]),
        { maxItems: 8 },
      ),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  },
  { additionalProperties: false },
);

export const uncover: AdapterDef = {
  name: "uncover",
  bin: "uncover",
  versionFlag: "-version",
  mutating: false, // search-API reads only
  artifactKind: "jsonl",
  schema: uncoverSchema,
  buildArgs(params: ToolParams, _opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as UncoverParams;
    const args = ["-json", "-q", requireModelString(p.query, "query", "uncover")];
    for (const engine of stringList(p.engines)) args.push("-e", engine); // closed enum, literal-validated
    if (typeof p.limit === "number" && Number.isInteger(p.limit)) args.push("-l", String(p.limit)); // result-count limit, NOT a list file
    args.push(...operatorExtra(p.extra));
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    return jsonLines(stdout).flatMap((line) => {
      // upstream wraps the hit in {"event": {...}} (older builds emitted flat);
      // accept both shapes, skip anything without a usable host/ip identity
      const event = typeof line.event === "object" && line.event !== null
        ? (line.event as Record<string, unknown>)
        : line;
      const host = typeof event.host === "string" ? event.host : undefined;
      const ip = typeof event.ip === "string" ? event.ip : undefined;
      if (!host && !ip) return []; // malformed hit
      return [{
        kind: "uncover",
        key: `${host || ip}:${event.port ?? ""}`,
        raw: clipRaw(JSON.stringify(line)),
        meta: {
          source: typeof event.source === "string" ? event.source : undefined,
          host,
          ip,
          port: typeof event.port === "number" || typeof event.port === "string" ? event.port : undefined,
        },
      }];
    });
  },
};
