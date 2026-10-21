import { describe, expect, test } from "bun:test";
import { critiqueResult, maxConcurrentChildren, maxTotalSpawnsPerRun, validateWorkerTask } from "../src/specialists/contracts.ts";

const task = {
  taskId: "task-1", engagementId: "engagement-1", mode: "defense", role: "reviewer",
  question: "Does this route enforce tenant ownership?", scopeRevision: 2,
  assetIds: ["app-local"], evidenceIds: ["evidence-4"], allowedCapabilities: ["cyber_evidence", "read"],
  credentialRefs: [], sessionLease: null, outputSchema: { required: ["observations"] },
  budget: { maxSeconds: 120, maxRequests: 20, maxOutputBytes: 8192 }, stopConditions: ["stop at the supplied loopback origin"],
};

const result = {
  taskId: "task-1", status: "complete", observations: ["Member can read a beta tenant order."],
  inferences: ["The handler may omit tenant ownership validation."], evidenceRefs: ["evidence-4"],
  sourceRefs: ["src/orders.ts:42"], candidateFindings: ["Tenant ownership check missing"], negativeResults: [],
  coverageLimits: [], proposedNextSteps: ["Review alternate order lookup routes."],
  usage: { elapsedSeconds: 5, requests: 2, outputBytes: 1200 }, sideEffects: [],
};

describe("specialist contracts", () => {
  test("task contracts accept bounded, scoped work", () => {
    expect(() => validateWorkerTask(task)).not.toThrow();
    expect(maxConcurrentChildren).toBe(2);
    expect(maxTotalSpawnsPerRun).toBe(8);
  });

  test("task validation names the exact invalid field", () => {
    expect(() => validateWorkerTask({ ...task, budget: { ...task.budget, maxRequests: 501 } }))
      .toThrow(/\/budget\/maxRequests/);
    expect(() => validateWorkerTask({ ...task, extra: true })).toThrow(/\/extra/);
  });

  test("result critique rejects unsupported complete results and missing blocked limits", () => {
    expect(critiqueResult({ ...result, observations: [], negativeResults: [] }).problems[0]).toContain("complete results need");
    expect(critiqueResult({ ...result, status: "blocked", coverageLimits: [] }).problems[0]).toContain("must state their coverage limits");
  });

  test("valid results keep observations and inferences separate", () => {
    expect(critiqueResult(result).problems).toEqual([]);
  });
});
