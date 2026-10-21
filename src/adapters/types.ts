// Module augmentation: the pinned @earendil-works/pi-coding-agent 1.3.0 has no
// `ToolParams` export (verified against dist/index.d.ts; flagged in the Task 2
// report as a pre-existing gap). Augmenting the package module keeps the
// AdapterDef contract below literal instead of inventing a local param type.
// Job wiring (Task 6) validates model input against `schema` (Typebox) before
// buildArgs ever sees it, so buildArgs additionally narrows defensively.
declare module "@earendil-works/pi-coding-agent" {
  export interface ToolParams {
    [typeboxKey: string]: unknown;
  }
}
import type { ToolParams } from "@earendil-works/pi-coding-agent";
export type { ToolParams }; // re-export so per-adapter modules type buildArgs against the same shape
export interface Normalized { kind: string; key: string; raw: string; meta?: Record<string, unknown>; }
export interface AdapterDef {
  name: string; bin: string; versionFlag: string;
  mutating: boolean; // false unless the tool mutates target state by design
  schema: unknown; // Typebox schema with additionalProperties:false
  buildArgs(params: ToolParams, opts: { wordlistPath?: string; templatesDir?: string }): string[];
  parse(stdout: string, stderr: string): Normalized[]; // tolerate malformed lines: skip them
  artifactKind: "raw" | "json" | "jsonl" | "sarif";
}
