/**
 * Specialist task contracts (Task 10).
 *
 * The coordinator owns mode, scope and every evidence write. A specialist is
 * handed one bounded contract and returns one bounded result; this module
 * validates the contract and critiques the result before anything is merged.
 *
 * Pure functions only: no network, no filesystem, no worker spawning, no
 * provider call. Tests exercise it modelless.
 */
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { adapters } from "../adapters/index.ts";

/** Upstream pi-subagents defaults to 64 cumulative spawns per run; the harness stays far below it. */
export const MAX_CONCURRENT_CHILDREN = 2;
export const MAX_TOTAL_SPAWNS_PER_RUN = 8;

export const SPECIALIST_ROLES = [
  "recon",
  "web-api",
  "vulnerability-research",
  "validation",
  "offensive-operator",
  "source-remediation",
] as const;
export type SpecialistRole = (typeof SPECIALIST_ROLES)[number];

/** Adapter names are the scanner capability surface; the harness tools are the evidence surface. */
export const ADAPTER_NAMES: readonly string[] = adapters.map((adapter) => adapter.name);
export const HARNESS_TOOLS: readonly string[] = ["cyber_evidence", "cyber_jobs", "cyber_state", "github"];
export const CAPABILITIES: readonly string[] = [...ADAPTER_NAMES, ...HARNESS_TOOLS];

export const SpecialistMode = Type.Union([Type.Literal("offense"), Type.Literal("defense")]);
export const SpecialistRoleSchema = Type.Union(SPECIALIST_ROLES.map((role) => Type.Literal(role)));

export const SessionLease = Type.Object({
  sessionId: Type.String({ minLength: 1, maxLength: 200 }),
  owner: Type.String({ minLength: 1, maxLength: 120 }),
  purpose: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false });

export const TaskBudget = Type.Object({
  maxToolCalls: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  maxRuntimeMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })),
}, { additionalProperties: false });

/** What the coordinator hands to one specialist. */
export const TaskContract = Type.Object({
  taskId: Type.String({ minLength: 1, maxLength: 120 }),
  engagementId: Type.String({ minLength: 1, maxLength: 120 }),
  mode: SpecialistMode,
  role: SpecialistRoleSchema,
  question: Type.String({ minLength: 1, maxLength: 2000 }),
  scopeRevision: Type.Integer({ minimum: 0 }),
  assetIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 256 }),
  evidenceIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 256 }),
  allowedCapabilities: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
  credentialRefs: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 32 }),
  sessionLease: Type.Union([Type.Null(), SessionLease]),
  outputSchema: Type.String({ minLength: 1, maxLength: 64 }),
  budget: TaskBudget,
  stopConditions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 16 }),
}, { additionalProperties: false });

export type TaskContractShape = {
  taskId: string;
  engagementId: string;
  mode: "offense" | "defense";
  role: SpecialistRole;
  question: string;
  scopeRevision: number;
  assetIds: string[];
  evidenceIds: string[];
  allowedCapabilities: string[];
  credentialRefs: string[];
  sessionLease: { sessionId: string; owner: string; purpose: string } | null;
  outputSchema: string;
  budget: { maxToolCalls?: number; maxRuntimeMs?: number };
  stopConditions: string[];
};

export const CandidateFinding = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 300 }),
  severity: Type.Optional(Type.Union([
    Type.Literal("info"), Type.Literal("low"), Type.Literal("medium"),
    Type.Literal("high"), Type.Literal("critical"),
  ])),
  impact: Type.Optional(Type.String({ maxLength: 1000 })),
  confidence: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")])),
  evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 64 }),
}, { additionalProperties: false });

export const TaskUsage = Type.Object({
  toolCalls: Type.Integer({ minimum: 0, maximum: 100000 }),
  runtimeMs: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

/** What one specialist returns. */
export const TaskResult = Type.Object({
  status: Type.Union([
    Type.Literal("complete"), Type.Literal("partial"),
    Type.Literal("blocked"), Type.Literal("failed"),
  ]),
  observations: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 200 }),
  inferences: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 100 }),
  evidenceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 256 }),
  sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100 }),
  candidateFindings: Type.Array(CandidateFinding, { maxItems: 100 }),
  negativeResults: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 100 }),
  coverageLimits: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 100 }),
  proposedNextSteps: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 100 }),
  usage: TaskUsage,
  sideEffects: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 100 }),
}, { additionalProperties: false });

export type TaskResultShape = {
  status: "complete" | "partial" | "blocked" | "failed";
  observations: string[];
  inferences: string[];
  evidenceRefs: string[];
  sourceRefs: string[];
  candidateFindings: { title: string; severity?: string; impact?: string; confidence?: string; evidenceRefs: string[] }[];
  negativeResults: string[];
  coverageLimits: string[];
  proposedNextSteps: string[];
  usage: { toolCalls: number; runtimeMs?: number };
  sideEffects: string[];
};

/** Same shape as state.ts: a credential reference is a pointer, never the secret itself. */
const knownSecrets = /(?:sk-(?:proj-)?[a-zA-Z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[a-zA-Z0-9._~+/-]{12,}|\b(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+|https?:\/\/[^\s/:]+:[^\s@]+@)/i;

function fieldErrors(value: unknown, schema: TSchema): string[] {
  if (Value.Check(schema, value)) return [];
  const properties = (schema as { properties?: Record<string, TSchema> }).properties ?? {};
  const problems: string[] = [];
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  for (const [key, property] of Object.entries(properties)) {
    if (!Value.Check(property, record?.[key])) problems.push(key);
  }
  if (record) {
    for (const key of Object.keys(record)) {
      if (!(key in properties)) problems.push(key);
    }
  }
  if (problems.length === 0) problems.push("(root)");
  return problems;
}

/**
 * Validate a task contract. Throws an Error naming the exact offending field;
 * the coordinator must not launch a specialist with an invalid contract.
 */
export function assertContract(input: unknown): TaskContractShape {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Task contract must be an object.");
  const bad = fieldErrors(input, TaskContract);
  if (bad.length > 0) throw new Error(`Task contract invalid at field(s): ${bad.join(", ")}.`);
  const contract = input as TaskContractShape;
  const unknownCapabilities = contract.allowedCapabilities.filter((capability) => !CAPABILITIES.includes(capability));
  if (unknownCapabilities.length > 0) {
    throw new Error(`Task contract invalid at field allowedCapabilities: unknown capability ${unknownCapabilities.join(", ")}.`);
  }
  const secretRef = contract.credentialRefs.find((ref) => knownSecrets.test(ref));
  if (secretRef) throw new Error("Task contract invalid at field credentialRefs: possible raw secret, reference a stored credential instead.");
  const secretStop = contract.stopConditions.find((condition) => knownSecrets.test(condition));
  if (secretStop) throw new Error("Task contract invalid at field stopConditions: possible raw secret in a stop condition.");
  return contract;
}

/**
 * Critique a specialist result before the coordinator merges it. Never throws:
 * the returned problems are the reviewer's objections, not a hard failure.
 */
export function critiqueResult(input: unknown, contract?: TaskContractShape): { problems: string[] } {
  const problems: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { problems: ["result must be an object."] };
  const bad = fieldErrors(input, TaskResult);
  if (bad.length > 0) {
    problems.push(`result invalid at field(s): ${bad.join(", ")}.`);
    return { problems };
  }
  const result = input as TaskResultShape;
  if (result.status === "complete" && result.observations.length === 0) problems.push("complete result carries no observations.");
  if (result.status === "complete" && result.candidateFindings.length === 0 && result.negativeResults.length === 0) {
    problems.push("complete result claims no finding and no negative result; record what was ruled out.");
  }
  for (const finding of result.candidateFindings) {
    if (finding.evidenceRefs.length === 0) problems.push(`candidate finding "${finding.title}" cites no evidence reference.`);
    if (finding.confidence === "high" && finding.evidenceRefs.length === 0) problems.push(`candidate finding "${finding.title}" claims high confidence without evidence.`);
  }
  if (result.status !== "complete" && result.coverageLimits.length === 0) problems.push("incomplete result must state its coverage limits.");
  if (result.status === "blocked" && result.proposedNextSteps.length === 0) problems.push("blocked result must name the next step that unblocks it.");
  if (result.sideEffects.some((effect) => knownSecrets.test(effect))) problems.push("sideEffects mention something that looks like a raw secret.");
  const listed = new Set(result.evidenceRefs);
  for (const finding of result.candidateFindings) {
    const unlisted = finding.evidenceRefs.filter((ref) => !listed.has(ref));
    if (unlisted.length > 0) problems.push(`candidate finding "${finding.title}" cites evidence the result does not list.`);
  }
  if (contract) {
    if (contract.budget.maxToolCalls !== undefined && result.usage.toolCalls > contract.budget.maxToolCalls) {
      problems.push(`usage ${result.usage.toolCalls} exceeds the contract budget of ${contract.budget.maxToolCalls} tool calls.`);
    }
    if (contract.budget.maxRuntimeMs !== undefined && result.usage.runtimeMs !== undefined && result.usage.runtimeMs > contract.budget.maxRuntimeMs) {
      problems.push(`runtime ${result.usage.runtimeMs}ms exceeds the contract budget of ${contract.budget.maxRuntimeMs}ms.`);
    }
    if (contract.allowedCapabilities.length === 0 && result.usage.toolCalls > 0) problems.push("contract grants no capability but the result reports tool calls.");
  }
  return { problems };
}
