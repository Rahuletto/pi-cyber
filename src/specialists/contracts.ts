import { Type, type Static } from "typebox";
import Value from "typebox/value";

export const maxConcurrentChildren = 2;
export const maxTotalSpawnsPerRun = 8;

const shortText = Type.String({ minLength: 1, maxLength: 2000 });
const idList = Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 });

export const WorkerTaskSchema = Type.Object({
  taskId: shortText,
  engagementId: shortText,
  mode: Type.Union([Type.Literal("offense"), Type.Literal("defense")]),
  role: Type.Union([Type.Literal("recon"), Type.Literal("web"), Type.Literal("auth"), Type.Literal("reverse"), Type.Literal("reviewer"), Type.Literal("remediation")]),
  question: shortText,
  scopeRevision: Type.Integer({ minimum: 0 }),
  assetIds: idList,
  evidenceIds: idList,
  allowedCapabilities: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 32 }),
  credentialRefs: idList,
  sessionLease: Type.Union([Type.Null(), shortText]),
  outputSchema: Type.Record(Type.String(), Type.Unknown()),
  budget: Type.Object({
    maxSeconds: Type.Integer({ minimum: 1, maximum: 1800 }),
    maxRequests: Type.Integer({ minimum: 1, maximum: 500 }),
    maxOutputBytes: Type.Integer({ minimum: 1024, maximum: 65536 }),
  }, { additionalProperties: false }),
  stopConditions: Type.Array(shortText, { minItems: 1, maxItems: 16 }),
}, { additionalProperties: false });

export const WorkerResultSchema = Type.Object({
  taskId: shortText,
  status: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("blocked"), Type.Literal("failed")]),
  observations: idList,
  inferences: idList,
  evidenceRefs: idList,
  sourceRefs: idList,
  candidateFindings: idList,
  negativeResults: idList,
  coverageLimits: idList,
  proposedNextSteps: idList,
  usage: Type.Object({
    elapsedSeconds: Type.Number({ minimum: 0 }),
    requests: Type.Integer({ minimum: 0 }),
    outputBytes: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  sideEffects: idList,
}, { additionalProperties: false });

export type WorkerTask = Static<typeof WorkerTaskSchema>;
export type WorkerResult = Static<typeof WorkerResultSchema>;
export type ContractKind = "task" | "result";

function errors(kind: ContractKind, value: unknown): string[] {
  const schema = kind === "task" ? WorkerTaskSchema : WorkerResultSchema;
  return [...Value.Errors(schema, value)].map((error) => {
    const path = error.instancePath;
    return `${path || "/"}: ${error.message}`;
  });
}

/** Validate before dispatch and identify the exact contract field that failed. */
export function assertContract(kind: ContractKind, value: unknown): asserts value is WorkerTask | WorkerResult {
  const problems = errors(kind, value);
  if (problems.length) throw new Error(`invalid ${kind} contract at ${problems[0]}`);
}

export function validateWorkerTask(value: unknown): asserts value is WorkerTask {
  assertContract("task", value);
}

/** Return structural and useful semantic concerns for a worker handoff. */
export function critiqueResult(value: unknown): { problems: string[] } {
  const problems = errors("result", value);
  if (problems.length) return { problems };
  const result = value as WorkerResult;
  if (result.status === "complete" && result.observations.length === 0 && result.negativeResults.length === 0) {
    problems.push("/observations: complete results need an observation or a recorded negative result");
  }
  if ((result.status === "partial" || result.status === "blocked") && result.coverageLimits.length === 0) {
    problems.push("/coverageLimits: partial or blocked results must state their coverage limits");
  }
  for (const [index, text] of result.candidateFindings.entries()) {
    if (text.length < 8) problems.push(`/candidateFindings/${index}: provide a concise finding claim or use an evidence reference`);
  }
  return { problems };
}

export function validateResult(value: unknown): { problems: string[] } {
  return critiqueResult(value);
}
