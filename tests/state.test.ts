import { describe, expect, test } from "bun:test";
import { emptyState, updateState, recoverState, brief, switchMode } from "../src/state.ts";

describe("durable engagement brief", () => {
  test("starts without inventing target authorization", () => {
    const state = emptyState();
    expect(state.mode).toBe("defense");
    expect(state.scope).toEqual([]);
    expect(brief(state)).toContain("No approved target scope recorded");
  });
  test("mode switch preserves engagement scope and separates investigative next steps", () => {
    const state = updateState(emptyState(), { scope: ["owned fixture repository"], objective: "review access control", nextSteps: ["write remediation dossier"] });
    const offense = updateState(switchMode(state, "offense"), { nextSteps: ["validate approved hypothesis"] });
    expect(offense.scope).toEqual(["owned fixture repository"]);
    expect(offense.objective).toBe("review access control");
    expect(offense.modes.defense.nextSteps).toEqual(["write remediation dossier"]);
    expect(offense.modes.offense.nextSteps).toEqual(["validate approved hypothesis"]);
    expect(state.modes.offense.nextSteps).toEqual([]);
  });
  test("recovery copies external input and refuses corrupt newest scope snapshots", () => {
    const valid = updateState(emptyState(), { evidenceRefs: ["evidence/request-01.redacted.txt"] });
    const entries = [{ type: "custom", customType: "cyber.state.v1", data: valid }];
    const state = recoverState(entries);
    expect(state.modes.defense.evidenceRefs).toEqual(["evidence/request-01.redacted.txt"]);
    valid.modes.defense.evidenceRefs.push("later");
    expect(state.modes.defense.evidenceRefs).toHaveLength(1);
    expect(() => recoverState([...entries, { type: "custom", customType: "cyber.state.v1", data: { version: 99 } }])).toThrow(/checkpoint/i);
  });
  test("rejects obvious secret values and oversized context instead of persisting them", () => {
    expect(() => updateState(emptyState(), { objective: "token sk-proj-abcdefghijklmnopqrstuvwxyz" })).toThrow(/secret/i);
    expect(() => updateState(emptyState(), { coverage: ["x".repeat(2001)] })).toThrow(/length/i);
    expect(() => updateState(emptyState(), { evidenceRefs: ["https://user:password@example.com/log"] })).toThrow(/secret/i);
  });
  test("structured scope rejects empty values and unknown patch fields", () => {
    expect(() => updateState(emptyState(), { scope: [""] })).toThrow();
    expect(() => updateState(emptyState(), { mode: "offense" } as never)).toThrow();
  });
});
