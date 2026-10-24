import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { Value } from "typebox/value";

async function tools() {
  const loaded = await loadExtensions(
    [resolve("src/index.ts"), resolve("src/ast-extension.ts")],
    process.cwd(), undefined, createExtensionRuntime(),
  );
  expect(loaded.errors).toEqual([]);
  return new Map(loaded.extensions.flatMap((extension) =>
    [...extension.tools].map(([name, tool]) => [name, tool.definition] as const)));
}

test("every registered cyber tool sends an explicit object schema to providers", async () => {
  for (const [name, tool] of await tools()) {
    const wireSchema = JSON.parse(JSON.stringify(tool.parameters));
    expect(wireSchema.type, `${name}: provider input_schema.type`).toBe("object");
    for (const keyword of ["anyOf", "oneOf", "allOf"]) {
      expect(wireSchema, `${name}: Bedrock rejects root ${keyword}`).not.toHaveProperty(keyword);
    }
  }
});

test("state and staged edit wire schemas describe valid inputs and bound field values", async () => {
  const registered = await tools();
  const cases = [
    ["cyber_state", [
      [{ action: "get" }, true],
      [{ action: "update", patch: { objective: "local fixture" } }, true],
      [{ action: "update", patch: { unknown: true } }, false],
      [{ action: "delete" }, false],
      [[], false],
    ]],
    ["ast_edit", [
      [{ action: "preview", path: "a.ts", ops: [{ pat: "f($A)", out: "g($A)" }] }, true],
      [{ action: "apply", proposalId: "fixture" }, true],
      [{ action: "preview", path: "a.ts", ops: [] }, false],
      [null, false],
    ]],
  ] as const;
  for (const [name, fixtures] of cases) {
    const schema = JSON.parse(JSON.stringify(registered.get(name)!.parameters));
    for (const [input, valid] of fixtures) {
      expect(Value.Check(schema, input), `${name}: ${JSON.stringify(input)}`).toBe(valid);
    }
  }
});
