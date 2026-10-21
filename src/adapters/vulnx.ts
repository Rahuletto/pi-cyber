/**
 * vulnx — ProjectDiscovery vulnerability *intelligence* client (projectdiscovery/vulnx).
 *
 * This is a CVE/advisory query CLI (search / id / analyze commands, JSON or
 * CSV output), NOT a target scanner — per the research ledger its output is
 * advisory evidence, never evidence that an asset is affected.одель
 *
 * Target handling: vulnx takes sub-command + free-form query/CVE ID operands
 * as bare data arguments (no `-l` list mode is documented upstream); the
 * batch-ID form joins as repeated positional argv elements so buildArgs never
 * needs a temp file.
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, jsonDocument, stringList } from "./util.ts";

type VulnxParams = Static<typeof vulnxSchema>;

const vulnxSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("search"),
      Type.Literal("id"),
      Type.Literal("analyze"),
    ]),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    cveIds: Type.Optional(Type.Array(Type.String({ minLength: 3, maxLength: 32 }), { maxItems: 64 })),
    extra: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })),
  },
  { additionalProperties: false },
);

export const vulnx: AdapterDef = {
  name: "vulnx",
  bin: "vulnx",
  versionFlag: "-version",
  mutating: false, // advisory database reads, with tight unauth rate limits upstream
  artifactKind: "json",
  schema: vulnxSchema,
  buildArgs(params: ToolParams, _opts: { wordlistPath?: string; templatesDir?: string }): string[] {
    const p = params as VulnxParams;
    const cveIds = stringList(p.cveIds);
    switch (p.action) {
      case "search": {
        if (typeof p.query !== "string" || p.query.length === 0) {
          throw new Error(`vulnx: action "search" requires a query string`);
        }
        return ["search", p.query, "-json", ...stringList(p.extra)];
      }
      case "id": {
        if (cveIds.length === 0) throw new Error(`vulnx: action "id" requires cveIds`);
        return ["id", ...cveIds, "-json", ...stringList(p.extra)];
      }
      case "analyze": {
        if (cveIds.length === 0) throw new Error(`vulnx: action "analyze" requires cveIds`);
        return ["analyze", ...cveIds, "-json", ...stringList(p.extra)];
      }
      default:
        throw new TypeError(`vulnx: unknown action "${String(p.action)}"`);
    }
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    // single JSON document; tolerate the array-root and {results}/{vulnerabilities}
    // wrapping shapes upstream has shown across versions — malformed docs → []
    const document = jsonDocument(stdout);
    if (!document) return [];
    const items: unknown[] = Array.isArray(document)
      ? document
      : Array.isArray(document.results)
      ? document.results
      : Array.isArray(document.vulnerabilities)
      ? document.vulnerabilities
      : [];
    return items.flatMap((item: unknown) => {
      if (typeof item !== "object" || item === null) return []; // skip malformed entries
      const entry = item as Record<string, unknown>;
      const id = entry.id ?? entry.cve ?? entry.title;
      if (typeof id !== "string" || id.length === 0) return [];
      return [{
        kind: "vulnx",
        key: id,
        raw: clipRaw(JSON.stringify(entry)),
        meta: {
          severity: typeof entry.severity === "string" ? entry.severity : undefined,
          title: typeof entry.title === "string" ? entry.title : undefined,
          published: typeof entry.published === "string" ? entry.published : undefined,
        },
      }];
    });
  },
};
