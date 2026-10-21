/**
 * nuclei — template-based vulnerability scanner (ProjectDiscovery).
 * REFERENCE IMPLEMENTATION for the whole registry (plan Task 5 Step 1);
 * other adapters follow this shape with distinct schemas.
 *
 * Target handling: nuclei treats multiple `-u` values as a target list
 * (projectdiscovery StringSlice), so join as repeated `-u <target>` argv
 * elements. The `-l` target-list file mode is unused — buildArgs never
 * builds temp files (`-l` stays reachable via operator-approved `extra`).
 *
 * `templates` are template IDs only, never local paths from the model; a
 * custom template directory arrives via `opts.templatesDir` (operator-provided,
 * never model-provided) and is appended verbatim after `-t`.
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, jsonLines, stringList } from "./util.ts";

type NucleiParams = Static<typeof nucleiSchema>;

const nucleiSchema = Type.Object(
  {
    targets: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), { maxItems: 256 }),
    templates: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 })), // template IDs only, never paths from model
    severity: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("info"), Type.Literal("low"), Type.Literal("medium"),
          Type.Literal("high"), Type.Literal("critical"),
        ]),
        { maxItems: 5 },
      ),
    ),
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })), // operator-approved emulator args
  },
  { additionalProperties: false },
);

export const nuclei: AdapterDef = {
  name: "nuclei",
  bin: "nuclei",
  versionFlag: "-version",
  mutating: false, // probes include templates only, never exploit payload state changes
  artifactKind: "jsonl",
  schema: nucleiSchema,
  buildArgs(params: ToolParams, opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as NucleiParams;
    const args: string[] = [];
    for (const target of stringList(p.targets)) args.push("-u", target);
    args.push("-json");
    for (const sev of stringList(p.severity)) args.push("-severity", sev);
    for (const template of stringList(p.templates)) args.push("-id", template);
    if (opts.templatesDir) args.push("-t", opts.templatesDir); // operator-side, task 6 wiring
    args.push(...stringList(p.extra));
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    // tolerate malformed lines (progress bars, truncation): skip them
    return jsonLines(stdout).flatMap((line) => {
      const hostOrUrl = typeof line.url === "string" && line.url ? line.url : line.host;
      if (typeof hostOrUrl !== "string") return [];
      const templateId = typeof line.templateID === "string" && line.templateID ? line.templateID : "unknown";
      const info = typeof line.info === "object" && line.info !== null
        ? (line.info as Record<string, unknown>)
        : undefined;
      return [{
        kind: "nuclei",
        key: `${hostOrUrl}:${templateId}`,
        raw: clipRaw(JSON.stringify(line)),
        meta: {
          sev: info && typeof info.severity === "string" ? info.severity : undefined,
          name: info && typeof info.name === "string" ? info.name : undefined,
        },
      }];
    });
  },
};
