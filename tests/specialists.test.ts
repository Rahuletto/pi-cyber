import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertContract,
  critiqueResult,
  CAPABILITIES,
  MAX_CONCURRENT_CHILDREN,
  MAX_TOTAL_SPAWNS_PER_RUN,
  SPECIALIST_ROLES,
  type TaskContractShape,
  type TaskResultShape,
} from "../src/specialists/contracts.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_DIR = join(ROOT, "config", "cyber", "agents");

const contract = (overrides: Partial<TaskContractShape> = {}): TaskContractShape => ({
  taskId: "task-001",
  engagementId: "eng-local",
  mode: "offense",
  role: "recon",
  question: "Which hosts in the approved scope answer on 443?",
  scopeRevision: 3,
  assetIds: ["fixture.local"],
  evidenceIds: [],
  allowedCapabilities: ["httpx", "cyber_evidence"],
  credentialRefs: ["credential://fixture-member"],
  sessionLease: null,
  outputSchema: "task-result.v1",
  budget: { maxToolCalls: 20, maxRuntimeMs: 600000 },
  stopConditions: ["scope revision changed"],
  ...overrides,
});

const result = (overrides: Partial<TaskResultShape> = {}): TaskResultShape => ({
  status: "complete",
  observations: ["httpx reported one host answering on 443"],
  inferences: ["the service is reachable"],
  evidenceRefs: ["ev-1"],
  sourceRefs: [],
  candidateFindings: [],
  negativeResults: ["no DNS records outside the approved scope"],
  coverageLimits: ["no IPv6 sweep"],
  proposedNextSteps: [],
  usage: { toolCalls: 2 },
  sideEffects: [],
  ...overrides,
});

describe("specialist task contract", () => {
  test("accepts a bounded contract and returns it unchanged", () => {
    const input = contract();
    expect(assertContract(input)).toEqual(input);
  });

  test("names the exact field that broke the contract", () => {
    expect(() => assertContract({ ...contract(), question: "" })).toThrow(/question/);
    expect(() => assertContract({ ...contract(), scopeRevision: -1 })).toThrow(/scopeRevision/);
    expect(() => assertContract({ ...contract(), role: "root" })).toThrow(/role/);
    expect(() => assertContract({ ...contract(), extra: "field" })).toThrow(/extra/);
    expect(() => assertContract({ ...contract(), mode: "defense" })).toThrow(/mode/);
  });

  test("refuses capabilities outside the adapter and harness surface", () => {
    expect(() => assertContract({ ...contract(), allowedCapabilities: ["shell"] })).toThrow(/allowedCapabilities/);
    expect(CAPABILITIES).toContain("httpx");
    expect(CAPABILITIES).toContain("cyber_evidence");
    expect(CAPABILITIES).not.toContain("shell");
  });

  test("refuses raw secrets in credential references", () => {
    expect(() => assertContract({ ...contract(), credentialRefs: ["token sk-proj-abcdefghijklmnopqrstuvwxyz"] })).toThrow(/credentialRefs/);
    expect(() => assertContract({ ...contract(), credentialRefs: ["https://user:password@example.com/"] })).toThrow(/credentialRefs/);
  });
});

describe("specialist result critique", () => {
  test("a complete, evidenced result raises no objection", () => {
    expect(critiqueResult(result(), contract()).problems).toEqual([]);
  });

  test("objects to a complete result with nothing observed", () => {
    expect(critiqueResult(result({ observations: [] }), contract()).problems.join(" ")).toMatch(/observations/);
  });

  test("objects to a candidate finding without evidence", () => {
    const findings = [{ title: "traversal", evidenceRefs: [] as string[] }];
    expect(critiqueResult(result({ candidateFindings: findings, negativeResults: [] }), contract()).problems.join(" ")).toMatch(/evidence/);
  });

  test("objects to a complete result that neither confirms nor rules anything out", () => {
    expect(critiqueResult(result({ candidateFindings: [], negativeResults: [] }), contract()).problems.join(" ")).toMatch(/negative result/);
  });

  test("requires coverage limits when the result is not complete", () => {
    expect(critiqueResult(result({ status: "partial", coverageLimits: [] }), contract()).problems.join(" ")).toMatch(/coverage limits/);
  });

  test("requires an unblocking step when the result is blocked", () => {
    expect(critiqueResult(result({ status: "blocked", proposedNextSteps: [] }), contract()).problems.join(" ")).toMatch(/unblocks/);
  });

  test("reports a budget overrun against the contract", () => {
    const overrun = result({ usage: { toolCalls: 99 } });
    expect(critiqueResult(overrun, contract({ budget: { maxToolCalls: 5 } })).problems.join(" ")).toMatch(/budget/);
  });

  test("rejects a malformed result instead of throwing", () => {
    expect(critiqueResult({ status: "nope" }).problems.join(" ")).toMatch(/invalid/);
    expect(critiqueResult(null).problems.length).toBeGreaterThan(0);
  });
});

describe("specialist role files", () => {
  test("one role file per planned role, each within the 60 line budget", () => {
    expect(SPECIALIST_ROLES.length).toBe(12);
    for (const role of SPECIALIST_ROLES) {
      const path = join(AGENTS_DIR, `${role}.md`);
      expect(existsSync(path)).toBe(true);
      const body = readFileSync(path, "utf8");
      expect(body.split("\n").length).toBeLessThanOrEqual(60);
      expect(body).toContain(`name: ${role}`);
      expect(body).toContain("description:");
      expect(body).toContain("tools:");
      expect(body).toContain("extensions: ../../../src/index.ts");
      expect(body).toContain("contracts.ts");
      expect(body).toContain("Stop conditions");
    }
  });

  test("the extension each role loads resolves to the harness extension on disk", () => {
    for (const role of SPECIALIST_ROLES) {
      const body = readFileSync(join(AGENTS_DIR, `${role}.md`), "utf8");
      const declared = /extensions:\s*(\S+)/.exec(body)?.[1] ?? "";
      const resolved = resolve(AGENTS_DIR, declared);
      expect(existsSync(resolved)).toBe(true);
      expect(resolved.endsWith("src/index.ts")).toBe(true);
    }
  });

  test("no role grants nested delegation", () => {
    for (const role of SPECIALIST_ROLES) {
      const body = readFileSync(join(AGENTS_DIR, `${role}.md`), "utf8");
      expect(body).not.toContain("allowNestedSubagents: true");
      expect(body).toContain("maxSubagentDepth: 0");
    }
  });

  test("the harness spawn caps stay well below the upstream default of 64", () => {
    expect(MAX_TOTAL_SPAWNS_PER_RUN).toBe(8);
    expect(MAX_CONCURRENT_CHILDREN).toBe(2);
  });
});
