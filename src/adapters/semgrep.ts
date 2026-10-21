/**
 * semgrep — static analysis, SARIF output (defense baseline).
 *
 * Target handling: semgrep takes scan paths as positional argv elements in
 * ascending order; there is no meaningful list-file mode (`-l` upstream).
 * Rule packs come from the enumerated `ruleSet` union only — raw rule pack
 * strings would be a config-injection surface, so they stay enumerable.
 * `extra` items are appended verbatim as separate argv elements and are
 * documented as operator-approved only (never model-authored).
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, jsonDocument, modelList, operatorExtra, requireModelList } from "./util.ts";

type SemgrepParams = Static<typeof semgrepSchema>;

const semgrepSchema = Type.Object(
  {
    paths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 64 }),
    ruleSet: Type.Union([
      Type.Literal("auto"),
      Type.Literal("p/owasp-top-ten"),
      Type.Literal("p/typescript"),
    ]),
    // operator-approved only: appended verbatim as separate argv elements
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  },
  { additionalProperties: false },
);

export const semgrep: AdapterDef = {
  name: "semgrep",
  bin: "semgrep",
  versionFlag: "--version", // semgrep CLI uses `--version`
  mutating: false, // static analysis only
  artifactKind: "sarif",
  schema: semgrepSchema,
  buildArgs(params: ToolParams, _opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as SemgrepParams;
    // canonical order: `semgrep scan --sarif --config <ruleSet> <paths>` —
    // subcommand + flags first, model paths LAST (never before `scan`).
    const args = ["scan", "--sarif", "--config", typeof p.ruleSet === "string" ? p.ruleSet : "auto"];
    for (const path of requireModelList(p.paths, "paths", "semgrep")) args.push(path);
    args.push(...operatorExtra(p.extra)); // operator-approved extra always last
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    // SARIF 2.1.0: runs[].results[] with ruleId / level / message / physicalLocation
    const document = jsonDocument(stdout);
    const runs = document?.runs;
    if (!Array.isArray(runs)) return [];
    return runs.flatMap((run: unknown) => {
      if (typeof run !== "object" || run === null) return []; // skip malformed runs
      const results = (run as Record<string, unknown>).results;
      if (!Array.isArray(results)) return [];
      return results.flatMap((result: unknown) => {
        if (typeof result !== "object" || result === null) return [];
        const finding = result as Record<string, unknown>;
        const ruleId = typeof finding.ruleId === "string" ? finding.ruleId : "unknown-rule";
        const locations = Array.isArray(finding.locations) ? finding.locations : [];
        const primary = typeof locations[0] === "object" && locations[0] !== null
          ? (locations[0] as Record<string, unknown>)
          : undefined;
        const physical = primary && typeof primary.physicalLocation === "object" && primary.physicalLocation !== null
          ? (primary.physicalLocation as Record<string, unknown>)
          : undefined;
        const artifact = physical && typeof physical.artifactLocation === "object" &&
            physical.artifactLocation !== null
          ? (physical.artifactLocation as Record<string, unknown>)
          : undefined;
        const region = physical && typeof physical.region === "object" && physical.region !== null
          ? (physical.region as Record<string, unknown>)
          : undefined;
        const uri = artifact && typeof artifact.uri === "string" ? artifact.uri : "unknown-uri";
        const startLine = region && typeof region.startLine === "number" ? region.startLine : 0;
        const message = typeof finding.message === "object" && finding.message !== null
          ? (finding.message as Record<string, unknown>)
          : undefined;
        return [{
          kind: "semgrep",
          key: `${ruleId}:${uri}:${startLine}`,
          raw: clipRaw(JSON.stringify(finding)),
          meta: {
            ruleId,
            level: typeof finding.level === "string" ? finding.level : undefined,
            uri,
            startLine,
            message: message && typeof message.text === "string" ? message.text : undefined,
          },
        }];
      });
    });
  },
};
