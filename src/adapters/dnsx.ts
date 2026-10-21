/**
 * dnsx — DNS resolution and record querying (ProjectDiscovery).
 *
 * Target handling: upstream `-d` is a repeatable StringSlice, so the domains
 * array joins as repeated `-d <domain>` argv elements. We do NOT use `-l`,
 * which would need a domains list file, and buildArgs never builds temp files.
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, jsonLines, modelList, operatorExtra, requireModelList, stringList } from "./util.ts";

type DnsxParams = Static<typeof dnsxSchema>;

const dnsxSchema = Type.Object(
  {
    domains: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 256 }),
    recordType: Type.Optional(
      Type.Union(
        [
          Type.Literal("a"), Type.Literal("aaaa"), Type.Literal("cname"), Type.Literal("mx"),
          Type.Literal("ns"), Type.Literal("txt"), Type.Literal("soa"), Type.Literal("ptr"),
          Type.Literal("any"),
        ],
      ),
    ),
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  },
  { additionalProperties: false },
);

// Enumerable recordType → upstream flag (one flag per DNS record class).
const RECORD_TYPE_FLAGS: Record<string, string> = {
  a: "-a",
  aaaa: "-aaaa",
  cname: "-cname",
  mx: "-mx",
  ns: "-ns",
  txt: "-txt",
  soa: "-soa",
  ptr: "-ptr",
  any: "-any",
};

export const dnsx: AdapterDef = {
  name: "dnsx",
  bin: "dnsx",
  versionFlag: "-version",
  mutating: false, // DNS reads only
  artifactKind: "jsonl",
  schema: dnsxSchema,
  buildArgs(params: ToolParams, _opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as DnsxParams;
    const args: string[] = [];
    for (const domain of requireModelList(p.domains, "domains", "dnsx")) args.push("-d", domain);
    args.push("-json");
    if (typeof p.recordType === "string") {
      const flag = RECORD_TYPE_FLAGS[p.recordType];
      if (flag) args.push(flag);
    }
    args.push(...operatorExtra(p.extra));
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    return jsonLines(stdout)
      .filter((line) => typeof line.host === "string" && line.host.length > 0)
      .map((line) => ({
        kind: "dnsx",
        key: String(line.host),
        raw: clipRaw(JSON.stringify(line)),
        meta: {
          status: typeof line.status === "string" ? line.status : undefined,
          a: Array.isArray(line.a) ? (line.a as unknown[]).filter((v) => typeof v === "string") : undefined,
          resolver: Array.isArray(line.resolver)
            ? (line.resolver as unknown[]).filter((v) => typeof v === "string")
            : undefined,
        },
      }));
  },
};
