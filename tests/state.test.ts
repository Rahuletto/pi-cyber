import { describe, expect, test } from "bun:test";
import { emptyState, updateState, recoverState, brief, switchMode } from "../src/state.ts";

describe("durable engagement brief", () => {
  test("fresh sessions default to offense without inventing target authorization", () => {
    const state = emptyState();
    expect(state.mode).toBe("offense");
    expect(state.scope).toEqual([]);
    expect(brief(state)).toContain("No approved target scope recorded");
  });
  test("mode switch preserves engagement scope and separates investigative next steps", () => {
    const state = updateState(emptyState(), { scope: ["owned fixture repository"], objective: "review access control", nextSteps: ["write remediation dossier"] });
    const defense = updateState(switchMode(state, "defense"), { nextSteps: ["validate approved hypothesis"] });
    expect(defense.scope).toEqual(["owned fixture repository"]);
    expect(defense.objective).toBe("review access control");
    expect(defense.modes.offense.nextSteps).toEqual(["write remediation dossier"]);
    expect(defense.modes.defense.nextSteps).toEqual(["validate approved hypothesis"]);
    expect(state.modes.defense.nextSteps).toEqual([]);
  });
  test("recovery copies external input and refuses corrupt newest scope snapshots", () => {
    const valid = updateState(emptyState(), { evidenceRefs: ["evidence/request-01.redacted.txt"] });
    const entries = [{ type: "custom", customType: "cyber.state.v1", data: valid }];
    const state = recoverState(entries);
    expect(state.modes.offense.evidenceRefs).toEqual(["evidence/request-01.redacted.txt"]);
    valid.modes.offense.evidenceRefs.push("later");
    expect(state.modes.offense.evidenceRefs).toHaveLength(1);
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
  test("a saved checkpoint keeps its recorded mode; only a fresh start is offense", () => {
    const saved = switchMode(emptyState(), "defense");
    const state = recoverState([{ type: "custom", customType: "cyber.state.v1", data: saved }]);
    expect(state.mode).toBe("defense");
  });
});
