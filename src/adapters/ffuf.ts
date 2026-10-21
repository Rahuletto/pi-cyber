/**
 * ffuf — content enumeration with an operator-provided wordlist.
 *
 * FFUF is listed as mutating:false: fuzz requests are reads by design; the
 * wordlist and any recursive flags live operator-side, never model-side.
 * The wordlist is NOT a model parameter — it arrives through `opts.wordlistPath`
 * (operator-injected by the harness); when it is missing, buildArgs throws
 * "operator wordlist required" rather than silently fuzzing without input.
 *
 * Target handling: ffuf fuzzes one `-u` target per run; multi-target sweeps
 * are several jobs (one argv per target), not a `-l`-style list file, and
 * buildArgs never builds temp files.
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, intList, jsonDocument, modelList, operatorExtra, requireModelString } from "./util.ts";

type FfufParams = Static<typeof ffufSchema>;

const ffufSchema = Type.Object(
  {
    target: Type.String({ minLength: 1, maxLength: 2048 }),
    method: Type.Optional(
      Type.Union([
        Type.Literal("GET"), Type.Literal("POST"), Type.Literal("HEAD"),
        Type.Literal("PUT"), Type.Literal("PATCH"), Type.Literal("DELETE"),
        Type.Literal("OPTIONS"),
      ]),
    ),
    statusCodes: Type.Optional(Type.Array(Type.Integer({ minimum: 100, maximum: 599 }), { maxItems: 32 })),
    extensions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 16 })),
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  },
  { additionalProperties: false },
);

export const ffuf: AdapterDef = {
  name: "ffuf",
  bin: "ffuf",
  versionFlag: "-V", // ffuf upstream uses `-V` (capital)
  mutating: false, // see header; wordlist + recursion stay operator-side
  artifactKind: "json",
  schema: ffufSchema,
  buildArgs(params: ToolParams, opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as FfufParams;
    const target = requireModelString(p.target, "target", "ffuf"); // never String(undefined)
    if (!opts.wordlistPath) throw new Error("operator wordlist required");
    const args = ["-json", "-u", target, "-w", opts.wordlistPath];
    if (typeof p.method === "string") args.push("-X", p.method);
    const statusCodes = intList(p.statusCodes);
    if (statusCodes.length > 0) args.push("-mc", statusCodes.join(","));
    const extensions = modelList(p.extensions, "extensions");
    if (extensions.length > 0) args.push("-e", extensions.join(","));
    args.push(...operatorExtra(p.extra));
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    // ffuf emits one JSON result document (stdout `-json`, ffuf ≥ 2.1);
    // progress chatter goes to stderr and is ignored here.
    const document = jsonDocument(stdout);
    const results = document?.results;
    if (!Array.isArray(results)) return [];
    return results.flatMap((result: unknown) => {
      if (typeof result !== "object" || result === null) return []; // skip malformed entries
      const entry = result as Record<string, unknown>;
      const url = entry.url;
      if (typeof url !== "string" || url.length === 0) return [];
      const input = typeof entry.input === "object" && entry.input !== null
        ? (entry.input as Record<string, unknown>)
        : undefined;
      return [{
        kind: "ffuf",
        key: url,
        raw: clipRaw(JSON.stringify(entry)),
        meta: {
          status: typeof entry.status === "number" ? entry.status : undefined,
          length: typeof entry.length === "number" ? entry.length : undefined,
          words: typeof entry.words === "number" ? entry.words : undefined,
          fuzz: input && typeof input.FUZZ === "string" ? input.FUZZ : undefined,
        },
      }];
    });
  },
};
