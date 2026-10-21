import { describe, expect, test } from "bun:test";
import { emptyState, updateState, recoverState, brief } from "../src/state.ts";

describe("durable engagement brief", () => {
  test("fresh sessions default to offense without inventing target authorization", () => {
    const state = emptyState();
    expect(state.mode).toBe("offense");
    expect(state.scope).toEqual([]);
    expect(brief(state)).toContain("No approved target scope recorded");
  });
  test("state exposes one offense brief and never accepts a mode patch", () => {
    const state = updateState(emptyState(), { scope: ["owned fixture repository"], objective: "review access control", nextSteps: ["write remediation dossier"] });
    expect(state.mode).toBe("offense");
    expect(state.modes.offense.nextSteps).toEqual(["write remediation dossier"]);
    expect(Object.keys(state.modes)).toEqual(["offense"]);
    expect(() => updateState(state, { mode: "defense" } as never)).toThrow(/unknown patch field/i);
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
  test("legacy defense checkpoints migrate all brief fields into the offense-only state", () => {
    const legacy = {
      version: 1, revision: 4, mode: "defense", scope: ["owned fixture"], objective: "verify fixes",
      modes: {
        offense: { coverage: ["route A"], evidenceRefs: ["evidence/a"], nextSteps: ["map route B"] },
        defense: { coverage: ["route B"], evidenceRefs: ["evidence/b"], nextSteps: ["retest route A"] },
      },
    };
    const state = recoverState([{ type: "custom", customType: "cyber.state.v1", data: legacy }]);
    expect(state.mode).toBe("offense");
    expect(state.modes.offense).toEqual({
      coverage: ["route A", "route B"], evidenceRefs: ["evidence/a", "evidence/b"],
      nextSteps: ["map route B", "retest route A"],
    });
    expect(Object.keys(state.modes)).toEqual(["offense"]);
  });
});
