/**
 * Diagrammatic reporting (Task 16) — typed, dependency-free mermaid generators.
 *
 * Every helper returns a FENCED mermaid block as a plain string: no external
 * dependency, no filesystem, no network, no side effect. The harness favors
 * diagrams over walls of text (operator rule 2026-10-21), so a dossier pairs a
 * diagram with bounded prose.
 *
 * Contract:
 * - the returned string always starts with "```mermaid" and ends with "```";
 * - the body is a `flowchart` declaration followed by node/edge statements;
 * - each block is capped at 4 KiB (plan Task 16) — an over-long body is cut at
 *   a line boundary and marked with a trailing mermaid comment;
 * - ordering is stable: findings sort by id (ascending), edges keep input
 *   order, lifecycle and coverage legends use fixed vocabularies;
 * - labels are sanitized (quotes, newlines, backticks and '#') so a hostile
 *   title cannot break out of the diagram.
 */

/** The finding lifecycle, in the order the evidence store records it. */
export const FINDING_LIFECYCLE = [
  "candidate",
  "needs-validation",
  "confirmed",
  "rejected",
  "remediated",
  "retest-passed",
] as const;
export type FindingLifecycle = (typeof FINDING_LIFECYCLE)[number];

export type EngagementMode = "offense";

/** A finding as the diagram layer needs it (structurally compatible with `FindingRow`). */
export interface DiagramFinding {
  id: number;
  state: FindingLifecycle;
  title: string;
  impact?: string;
  confidence?: number;
  evidenceIds?: readonly number[];
}

export interface DiagramNode {
  id: string;
  label: string;
  /** Optional qualifier rendered before the label, e.g. "asset" or "privilege". */
  kind?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

export const COVERAGE_STATES = [
  "discovered",
  "queued",
  "tested",
  "confirmed-issue",
  "no-issue-observed",
  "inconclusive",
  "blocked",
  "not-applicable",
] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

export interface CoverageCell {
  route: string;
  role: string;
  state: CoverageState;
}

export interface CoverageMatrix {
  cells: readonly CoverageCell[];
}

/** Hard cap for one rendered diagram (plan Task 16: "each ≤ 4 KiB"). */
export const MAX_DIAGRAM_CHARS = 4096;

const FENCE_OPEN = "```mermaid\n";
const FENCE_CLOSE = "\n```";
const FENCE_OVERHEAD = FENCE_OPEN.length + FENCE_CLOSE.length;

/** Cap the diagram BODY so the fenced block stays within the byte budget. */
function capBody(body: string, max: number): string {
  if (body.length <= max) return body;
  const marker = "\n%% truncated: diagram exceeded the 4 KiB cap";
  const keep = Math.max(0, max - marker.length);
  let cut = body.slice(0, keep);
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > 0) cut = cut.slice(0, lastNewline);
  return `${cut}${marker}`;
}

/** Wrap a mermaid body in a fenced block, respecting the 4 KiB cap. */
export function mermaidBlock(body: string, max: number = MAX_DIAGRAM_CHARS): string {
  return `${FENCE_OPEN}${capBody(body, Math.max(0, max - FENCE_OVERHEAD))}${FENCE_CLOSE}`;
}

/**
 * Make arbitrary text safe for a quoted mermaid label: no quotes, no line
 * breaks, no fence terminator, and '#' escaped as the mermaid entity '#35;'.
 */
export function mermaidLabel(text: string, max = 80): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").replace(/```/g, "...").trim();
  const escaped = flat.replace(/"/g, "'").replace(/#/g, "#35;");
  return escaped.length > max ? `${escaped.slice(0, Math.max(0, max - 3))}...` : escaped;
}

/** Mermaid-safe identifier (letters, digits, underscore). */
function safeId(prefix: string, index: number): string {
  return `${prefix}${index}`;
}

/**
 * Engagement flow: the mode node followed by the ordered steps of the loop.
 * Used for the "how the engagement runs" diagram in a status or handover note.
 */
export function engagementFlow(mode: EngagementMode, steps: readonly string[]): string {
  const lines: string[] = ["flowchart TD"];
  lines.push(`  m(["mode: ${mermaidLabel(mode, 40)}"])`);
  let previous = "m";
  steps.forEach((step, index) => {
    const id = safeId("s", index + 1);
    lines.push(`  ${previous} --> ${id}["${mermaidLabel(step)}"]`);
    previous = id;
  });
  return mermaidBlock(lines.join("\n"));
}

/**
 * Findings map: one node per finding labelled with its lifecycle state, a
 * dotted link to that state's legend node, and one node per referenced
 * evidence row. Findings sort by id so the diagram is stable across calls.
 */
export function findingsMap(findings: readonly DiagramFinding[]): string {
  const lines: string[] = ["flowchart LR"];
  lines.push('  subgraph lifecycle["finding lifecycle"]');
  for (const state of FINDING_LIFECYCLE) {
    lines.push(`    ${state.replace(/-/g, "_")}["${state}"]`);
  }
  lines.push("    candidate --> needs_validation");
  lines.push("    needs_validation --> confirmed");
  lines.push("    needs_validation --> rejected");
  lines.push("    confirmed --> remediated");
  lines.push("    remediated --> retest_passed");
  lines.push("  end");

  const ordered = [...findings].sort((a, b) => a.id - b.id);
  const evidenceSeen = new Set<number>();
  for (const finding of ordered) {
    const id = safeId("F", finding.id);
    const confidence = typeof finding.confidence === "number" ? ` (confidence ${finding.confidence})` : "";
    lines.push(`  ${id}["${finding.state} · ${mermaidLabel(finding.title)}${confidence}"]`);
    lines.push(`  ${id} -.-> ${finding.state.replace(/-/g, "_")}`);
    for (const evidenceId of finding.evidenceIds ?? []) {
      if (evidenceSeen.has(evidenceId)) continue;
      evidenceSeen.add(evidenceId);
      const evidenceNode = safeId("E", evidenceId);
      lines.push(`  ${evidenceNode}["evidence ${evidenceId}"]`);
      lines.push(`  ${id} --> ${evidenceNode}`);
    }
  }
  return mermaidBlock(lines.join("\n"));
}

/**
 * Attack tree / asset graph: the nodes and edges of a demonstrated path.
 * Node ids are rewritten to positional identifiers so arbitrary ids stay
 * mermaid-safe; edges keep input order, and an edge endpoint that was not
 * declared becomes an implicit node so no transition is silently dropped.
 */
export function attackTree(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): string {
  const ids = new Map<string, string>();
  const nodeLines: string[] = [];
  const register = (rawId: string, label: string, kind?: string): string => {
    const existing = ids.get(rawId);
    if (existing) return existing;
    const id = safeId("n", ids.size + 1);
    ids.set(rawId, id);
    const prefix = kind ? `${mermaidLabel(kind, 32)} · ` : "";
    nodeLines.push(`  ${id}["${prefix}${mermaidLabel(label)}"]`);
    return id;
  };

  for (const node of nodes) register(node.id, node.label, node.kind);

  const edgeLines: string[] = [];
  for (const edge of edges) {
    const from = register(edge.from, edge.from);
    const to = register(edge.to, edge.to);
    const edgeLabel = edge.label ? `|"${mermaidLabel(edge.label, 48)}"|` : "";
    edgeLines.push(`  ${from} -->${edgeLabel} ${to}`);
  }
  return mermaidBlock(["flowchart TD", ...nodeLines, ...edgeLines].join("\n"));
}

/** Plan Task 16 alias: the asset graph is the attack tree over the same data. */
export function assetGraph(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): string {
  return attackTree(nodes, edges);
}

/**
 * Coverage matrix: routes as subgraphs, role/state cells as nodes. Routes keep
 * first-appearance order; cells keep matrix order inside a route.
 */
export function coverageDiagram(matrix: CoverageMatrix): string {
  const lines: string[] = ["flowchart LR"];
  const routes: Array<{ route: string; cells: CoverageCell[] }> = [];
  let cellCounter = 0;
  for (const cell of matrix.cells) {
    const bucket = routes.find((entry) => entry.route === cell.route);
    if (bucket) bucket.cells.push(cell);
    else routes.push({ route: cell.route, cells: [cell] });
  }
  routes.forEach((bucket, index) => {
    const groupId = safeId("r", index + 1);
    lines.push(`  subgraph ${groupId}["${mermaidLabel(bucket.route)}"]`);
    for (const cell of bucket.cells) {
      // Cell ids are globally unique: mermaid rejects a repeated node id.
      cellCounter += 1;
      const id = safeId("c", cellCounter);
      lines.push(`    ${id}["${mermaidLabel(cell.role, 32)} · ${mermaidLabel(cell.state, 32)}"]`);
    }
    lines.push("  end");
  });
  return mermaidBlock(lines.join("\n"));
}

/**
 * Finding chain: one finding traced through its evidence, impact, proposed fix
 * and retest. Fix classes stay explicit — "proposed" is not "applied" and
 * "applied" is not "verified".
 */
export function findingChainDiagram(finding: DiagramFinding): string {
  const lines: string[] = ["flowchart TD"];
  const id = safeId("F", finding.id);
  lines.push(`  ${id}["${finding.state} · ${mermaidLabel(finding.title)}"]`);
  for (const evidenceId of finding.evidenceIds ?? []) {
    const evidenceNode = safeId("E", evidenceId);
    lines.push(`  ${evidenceNode}["evidence ${evidenceId}"]`);
    lines.push(`  ${id} --> ${evidenceNode}`);
  }
  lines.push(`  imp["impact · ${mermaidLabel(finding.impact ?? "not established", 64)}"]`);
  lines.push(`  ${id} --> imp`);
  lines.push('  fix["fix · proposed"]');
  lines.push("  imp --> fix");
  lines.push('  retest["retest · pending"]');
  lines.push("  fix --> retest");
  return mermaidBlock(lines.join("\n"));
}
