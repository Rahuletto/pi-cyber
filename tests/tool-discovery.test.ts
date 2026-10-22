import { expect, test } from "bun:test";
import { registerCyberToolsTool } from "../src/tools/cyber-tools.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function getTool() {
  let registered: any;
  registerCyberToolsTool({ registerTool: (tool: any) => { registered = tool; } } as any);
  return registered;
}

async function call(params: unknown, tools: any[]) {
  const tool = getTool();
  return tool.execute("test", params, undefined, undefined, { tools } as unknown as ExtensionToolContext);
}

test("lists all registered tools with name and capability filters", async () => {
  const tools = [
    { name: "read", description: "Read local files", parameters: Type.Object({ path: Type.String() }) },
    { name: "cyber_http", description: "Make HTTP requests", parameters: Type.Object({ url: Type.String() }) },
  ];
  const result = await call({ action: "list", capability: "HTTP" }, tools);
  const text = String(result.content[0].text);
  expect(text).toContain("cyber_http");
  expect(text).not.toContain("read:");
  expect(result.details).toMatchObject({ action: "list", count: 1 });
});

test("describe returns the registered description and parameter schema", async () => {
  const tool = { name: "lookup", description: "Search indexed notes.", parameters: Type.Object({ query: Type.String({ description: "Search phrase" }) }) };
  const result = await call({ action: "describe", name: "lookup" }, [tool]);
  const text = String(result.content[0].text);
  expect(text).toContain("Search indexed notes.");
  expect(text).toContain("query");
  expect(text).toContain("Search phrase");
});

test("list and describe outputs are bounded and unknown describe names are explicit", async () => {
  const large = { name: "huge", description: "d".repeat(20_000), parameters: Type.Object({ value: Type.String() }) };
  const result = await call({ action: "describe", name: "huge" }, [large]);
  expect(String(result.content[0].text).length).toBeLessThanOrEqual(16_020);
  await expect(call({ action: "describe", name: "missing" }, [large])).rejects.toThrow(/not registered/i);
});
