/**
 * interactsh-client — out-of-band interaction collector (ProjectDiscovery).
 *
 * The client polls the OOB server and prints one JSON event per interaction.
 * Callbacks are EVENT evidence only (a payload firing proves reachability,
 * their absence proves nothing) — findings downstream must label them that way.
 *
 * Target handling: no target-list mode exists (the session is server-bound);
 * `-server` binds upstream, `-i <sec>` sets the poll interval, and the
 * Task 6 runner terminates the client by cancel rather than by exit. No temp
 * files are built in buildArgs; the upstream default session-file write stays
 * an operator decision (via `extra`) because it is a filesystem side effect.
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, jsonLines, stringList } from "./util.ts";

type InteractshParams = Static<typeof interactshSchema>;

const interactshSchema = Type.Object(
  {
    server: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    pollIntervalSec: Type.Optional(Type.Integer({ minimum: 5, maximum: 120 })),
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  },
  { additionalProperties: false },
);

export const interactsh: AdapterDef = {
  name: "interactsh",
  bin: "interactsh-client", // binary name differs from the adapter/registry name
  versionFlag: "-version",
  mutating: false, // only observes; the OOB server is external
  artifactKind: "jsonl",
  schema: interactshSchema,
  buildArgs(params: ToolParams, _opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as InteractshParams;
    const args: string[] = ["-json"];
    if (typeof p.server === "string" && p.server.length > 0) args.push("-server", p.server);
    if (typeof p.pollIntervalSec === "number" && Number.isInteger(p.pollIntervalSec)) {
      args.push("-i", String(p.pollIntervalSec));
    }
    args.push(...stringList(p.extra));
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    return jsonLines(stdout).flatMap((line) => {
      const fullId = typeof line.full_id === "string" ? line.full_id : line.unique_id;
      if (typeof fullId !== "string" || fullId.length === 0) return []; // skip malformed events
      const remote = typeof line["remote-address"] === "object" && line["remote-address"] !== null
        ? (line["remote-address"] as Record<string, unknown>)
        : undefined;
      return [{
        kind: "interactsh",
        key: fullId,
        raw: clipRaw(JSON.stringify(line)),
        meta: {
          protocol: typeof line.protocol === "string" ? line.protocol : undefined,
          uniqueId: typeof line.unique_id === "string" ? line.unique_id : undefined,
          remoteIp: remote && typeof remote.ip === "string" ? remote.ip : undefined,
          remotePort: remote && typeof remote.port === "number" ? remote.port : undefined,
          timestamp: typeof line.timestamp === "string" ? line.timestamp : undefined,
        },
      }];
    });
  },
};
