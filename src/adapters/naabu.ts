/**
 * naabu — port scanner (ProjectDiscovery).
 *
 * Target handling: upstream `-host` is a repeatable StringSlice, so the hosts
 * array joins as repeated `-host <host>` argv elements. The `-l` host-list
 * file mode is unused — buildArgs never builds temporary files.
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, intList, jsonLines, stringList } from "./util.ts";

type NaabuParams = Static<typeof naabuSchema>;

const naabuSchema = Type.Object(
  {
    hosts: Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 256 }),
    ports: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 65535 }), { maxItems: 64 })),
    scanType: Type.Optional(Type.Union([Type.Literal("connect"), Type.Literal("syn")])),
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  },
  { additionalProperties: false },
);

export const naabu: AdapterDef = {
  name: "naabu",
  bin: "naabu",
  versionFlag: "-version",
  mutating: false, // TCP probes only; SYN mode needs privileged sockets, so `connect` is the harness default
  artifactKind: "jsonl",
  schema: naabuSchema,
  buildArgs(params: ToolParams, _opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as NaabuParams;
    const args: string[] = [];
    for (const host of stringList(p.hosts)) args.push("-host", host);
    args.push("-json");
    const ports = intList(p.ports);
    if (ports.length > 0) args.push("-p", ports.join(","));
    if (p.scanType === "syn") args.push("-s", "syn"); // connect stays the default scan type
    args.push(...stringList(p.extra));
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    return jsonLines(stdout)
      .filter((line) => typeof line.port === "number" && Number.isInteger(line.port))
      .map((line) => {
        const ip = typeof line.ip === "string" ? line.ip : undefined;
        const host = typeof line.host === "string" ? line.host : undefined;
        return {
          kind: "naabu",
          key: `${ip ?? "unknown-ip"}:${line.port}`,
          raw: clipRaw(JSON.stringify(line)),
          meta: { ip, host, port: line.port, protocol: typeof line.protocol === "string" ? line.protocol : undefined },
        };
      });
  },
};
