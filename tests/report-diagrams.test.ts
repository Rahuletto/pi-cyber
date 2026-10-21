import { describe, expect, test } from "bun:test";
import {
  COVERAGE_STATES,
  FINDING_LIFECYCLE,
  MAX_DIAGRAM_CHARS,
  attackTree,
  assetGraph,
  coverageDiagram,
  engagementFlow,
  findingChainDiagram,
  findingsMap,
  mermaidBlock,
  mermaidLabel,
  type DiagramFinding,
} from "../src/report/diagrams.ts";
import { FINDING_STATES } from "../src/evidence/db.ts";

const finding = (partial: Partial<DiagramFinding> & { id: number; state: DiagramFinding["state"] }): DiagramFinding => ({
  title: "IDOR on /api/orders",
  ...partial,
});

describe("diagram helpers", () => {
  test("engagementFlow returns a fenced mermaid flowchart with the mode node and ordered steps", () => {
    const diagram = engagementFlow("offense", ["establish scope", "map the surface", "consolidate"]);
    expect(diagram.startsWith("```mermaid\n")).toBe(true);
    expect(diagram.endsWith("\n```")).toBe(true);
    expect(diagram).toContain("flowchart TD");
    expect(diagram).toContain('m(["mode: offense"])');
    expect(diagram).toContain('s1["establish scope"]');
    expect(diagram).toContain('s1 --> s2["map the surface"]');
    expect(diagram).toContain('s2 --> s3["consolidate"]');
  });

  test("engagementFlow with no steps still renders an offense-only single-node diagram", () => {
    const diagram = engagementFlow("offense", []);
    expect(diagram.startsWith("```mermaid\n")).toBe(true);
    expect(diagram).toContain("flowchart TD");
    expect(diagram).toContain('mode: offense');
    expect(diagram).not.toContain("-->");
  });

  test("engagementFlow keeps a stable step order across calls", () => {
    const steps = ["a", "b", "c"];
    expect(engagementFlow("offense", steps)).toBe(engagementFlow("offense", steps));
  });

  test("findingsMap labels every lifecycle state and links each finding to its state", () => {
    const diagram = findingsMap([
      finding({ id: 12, state: "confirmed", evidenceIds: [3, 4] }),
      finding({ id: 11, state: "candidate" }),
    ]);
    expect(diagram.startsWith("```mermaid\n")).toBe(true);
    expect(diagram).toContain("flowchart LR");
    for (const state of FINDING_LIFECYCLE) {
      expect(diagram).toContain(`["${state}"]`);
    }
    expect(diagram).toContain('F11["candidate · ');
    expect(diagram).toContain("F11 -.-> candidate");
    expect(diagram).toContain('F12["confirmed · IDOR on /api/orders');
    expect(diagram).toContain("F12 -.-> confirmed");
    expect(diagram).toContain('E3["evidence 3"]');
    expect(diagram).toContain("F12 --> E3");
  });

  test("findingsMap sorts by id so the diagram order is stable regardless of input order", () => {
    const a = finding({ id: 7, state: "candidate" });
    const b = finding({ id: 9, state: "rejected" });
    const forward = findingsMap([a, b]);
    const reversed = findingsMap([b, a]);
    expect(forward).toBe(reversed);
    expect(forward.indexOf("F7")).toBeLessThan(forward.indexOf("F9"));
  });

  test("findingsMap renders every lifecycle transition edge", () => {
    const diagram = findingsMap([]);
    expect(diagram).toContain("candidate --> needs_validation");
    expect(diagram).toContain("needs_validation --> confirmed");
    expect(diagram).toContain("needs_validation --> rejected");
    expect(diagram).toContain("confirmed --> remediated");
    expect(diagram).toContain("remediated --> retest_passed");
  });

  test("attackTree renders node and edge syntax and keeps edge order", () => {
    const diagram = attackTree(
      [
        { id: "attacker", label: "unauthenticated user", kind: "entry" },
        { id: "api", label: "/api/orders", kind: "asset" },
        { id: "admin", label: "admin session", kind: "privilege" },
      ],
      [
        { from: "attacker", to: "api" },
        { from: "api", to: "admin", label: "id param" },
      ],
    );
    expect(diagram.startsWith("```mermaid\n")).toBe(true);
    expect(diagram).toContain("flowchart TD");
    expect(diagram).toContain('n1["entry · unauthenticated user"]');
    expect(diagram).toContain('n2["asset · /api/orders"]');
    expect(diagram).toContain('n3["privilege · admin session"]');
    expect(diagram).toContain("n1 --> n2");
    expect(diagram).toContain('n2 -->|"id param"| n3');
    expect(diagram.indexOf("n1 --> n2")).toBeLessThan(diagram.indexOf("n2 -->"));
  });

  test("attackTree creates an implicit node for an undeclared edge endpoint", () => {
    const diagram = attackTree([{ id: "a", label: "a" }], [{ from: "a", to: "ghost" }]);
    expect(diagram).toContain('n2["ghost"]');
    expect(diagram).toContain("n1 --> n2");
  });

  test("assetGraph is the plan-name alias of attackTree", () => {
    const nodes = [{ id: "a", label: "a" }];
    const edges = [{ from: "a", to: "b" }];
    expect(assetGraph(nodes, edges)).toBe(attackTree(nodes, edges));
  });

  test("coverageDiagram groups routes and labels role and state", () => {
    const diagram = coverageDiagram({
      cells: [
        { route: "GET /api/orders", role: "member", state: "tested" },
        { route: "GET /api/orders", role: "admin", state: "confirmed-issue" },
        { route: "GET /api/admin/users", role: "member", state: "blocked" },
      ],
    });
    expect(diagram.startsWith("```mermaid\n")).toBe(true);
    expect(diagram).toContain('subgraph r1["GET /api/orders"]');
    expect(diagram).toContain('subgraph r2["GET /api/admin/users"]');
    expect(diagram).toContain('c1["member · tested"]');
    expect(diagram).toContain('c2["admin · confirmed-issue"]');
    expect(diagram).toContain('c3["member · blocked"]');
  });

  test("findingChainDiagram separates proposed fix from retest", () => {
    const diagram = findingChainDiagram(finding({ id: 5, state: "confirmed", impact: "cross-tenant read" }));
    expect(diagram).toContain('F5["confirmed · IDOR on /api/orders"]');
    expect(diagram).toContain('fix["fix · proposed"]');
    expect(diagram).toContain('retest["retest · pending"]');
    expect(diagram).toContain("imp --> fix");
    expect(diagram).toContain("fix --> retest");
  });

  test("mermaidLabel neutralizes quotes, newlines, fences and hashes", () => {
    expect(mermaidLabel('a "quoted" title')).toBe("a 'quoted' title");
    expect(mermaidLabel("line one\nline two")).toBe("line one line two");
    expect(mermaidLabel("```")).toBe("...");
    expect(mermaidLabel("issue #42")).toBe("issue #35;42");
    expect(mermaidLabel("x".repeat(200)).length).toBe(80);
  });

  test("mermaidBlock caps the diagram at 4 KiB and marks the truncation", () => {
    const body = Array.from({ length: 500 }, (_, index) => `  n${index}["${"label ".repeat(20)}"]`).join("\n");
    const block = mermaidBlock(body);
    expect(block.length).toBeLessThanOrEqual(MAX_DIAGRAM_CHARS);
    expect(block.startsWith("```mermaid\n")).toBe(true);
    expect(block.endsWith("\n```")).toBe(true);
    expect(block).toContain("%% truncated");
  });

  test("every diagram stays inside the 4 KiB cap", () => {
    const many = Array.from({ length: 400 }, (_, index) => finding({ id: index, state: "candidate", title: `finding ${index}` }));
    for (const diagram of [findingsMap(many), attackTree(many.map((f) => ({ id: `n${f.id}`, label: f.title })), many.map((f) => ({ from: `n${f.id}`, to: `n${f.id + 1}` })))]) {
      expect(diagram.length).toBeLessThanOrEqual(MAX_DIAGRAM_CHARS);
    }
  });

  test("the diagram lifecycle vocabulary matches the evidence store finding states", () => {
    expect([...FINDING_LIFECYCLE]).toEqual([...FINDING_STATES]);
    expect(COVERAGE_STATES).toContain("blocked");
  });
});
