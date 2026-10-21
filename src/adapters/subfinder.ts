/**
 * subfinder — passive subdomain enumeration (ProjectDiscovery).
 *
 * Target handling: subfinder takes a single domain via repeatable `-d`;
 * we emit one `-d` per domain instead of a `-l` list file because
 * buildArgs never builds temporary files. Upstream also accepts stdin,
 * which the Task 6 runner can use; unchanged either way here.
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, jsonLines, modelList, operatorExtra, requireModelString } from "./util.ts";

type SubfinderParams = Static<typeof subfinderSchema>;

const subfinderSchema = Type.Object(
  {
    domain: Type.String({ minLength: 1, maxLength: 253 }),
    sources: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 12 })),
    // operator-approved only: appended verbatim as separate argv elements
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  },
  { additionalProperties: false },
);

export const subfinder: AdapterDef = {
  name: "subfinder",
  bin: "subfinder",
  versionFlag: "-version", // PD kit: `-version`
  mutating: false, // passive or pointing only at public data sources
  artifactKind: "jsonl",
  schema: subfinderSchema,
  buildArgs(params: ToolParams, _opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as SubfinderParams;
    const args = ["-json", "-d", requireModelString(p.domain, "domain", "subfinder")];
    for (const source of modelList(p.sources, "sources")) args.push("-source", source);
    args.push(...operatorExtra(p.extra));
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    return jsonLines(stdout)
      .filter((line) => typeof line.host === "string" && line.host.length > 0)
      .map((line) => ({
        kind: "subfinder",
        key: String(line.host),
        raw: clipRaw(JSON.stringify(line)),
        meta: { source: typeof line.source === "string" ? line.source : undefined },
      }));
  },
};
