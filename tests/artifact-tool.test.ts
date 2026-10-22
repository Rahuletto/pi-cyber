import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { storeArtifact } from "../src/artifacts/store.ts";
import { registerArtifactsTool } from "../src/tools/artifacts.ts";

const roots: string[] = [];
const originalEvidenceDir = process.env.CYBER_EVIDENCE_DIR;
const originalEngagementId = process.env.CYBER_ENGAGEMENT_ID;
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  if (originalEvidenceDir === undefined) delete process.env.CYBER_EVIDENCE_DIR;
  else process.env.CYBER_EVIDENCE_DIR = originalEvidenceDir;
  if (originalEngagementId === undefined) delete process.env.CYBER_ENGAGEMENT_ID;
  else process.env.CYBER_ENGAGEMENT_ID = originalEngagementId;
});

type Tool = {
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, update: unknown, ctx: ExtensionToolContext): Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: Record<string, unknown>;
  }>;
};

function loadTool(): Tool {
  const registered: unknown[] = [];
  registerArtifactsTool({ registerTool: (tool) => registered.push(tool) });
  return registered[0] as Tool;
}

describe("cyber_artifacts tool", () => {
  test("creates bounded upload artifacts and rejects noncanonical base64 or secret-like text", async () => {
    const base = mkdtempSync(join(tmpdir(), "cyber-artifact-create-"));
    roots.push(base);
    process.env.CYBER_EVIDENCE_DIR = base;
    process.env.CYBER_ENGAGEMENT_ID = "create-scope";
    const tool = loadTool();
    const ctx = {} as ExtensionToolContext;
    const created = await tool.execute("call", {
      action: "create", kind: "upload", contentType: "application/octet-stream",
      dataEncoding: "base64", data: Buffer.from([0, 255]).toString("base64"),
    }, undefined, undefined, ctx);
    expect(created.details?.artifact).toMatchObject({ kind: "upload", bytes: 2 });
    const secondCreated = await tool.execute("call", {
      action: "create", kind: "upload", contentType: "application/octet-stream",
      dataEncoding: "base64", data: Buffer.from([4, 5]).toString("base64"),
    }, undefined, undefined, ctx);
    expect(secondCreated.details?.artifact).toMatchObject({ kind: "upload", bytes: 2 });
    await expect(tool.execute("call", {
      action: "create", kind: "upload", dataEncoding: "base64", data: "AB==",
    }, undefined, undefined, ctx)).rejects.toThrow("canonical padded encoding");
    await expect(tool.execute("call", {
      action: "create", kind: "upload", data: "api_key=abcdefghijklmno",
    }, undefined, undefined, ctx)).rejects.toThrow("possible raw secret");
  });

  test("returns integrity-checked metadata and reads binary in bounded base64 windows", async () => {
    const base = mkdtempSync(join(tmpdir(), "cyber-artifact-tool-"));
    roots.push(base);
    process.env.CYBER_EVIDENCE_DIR = base;
    process.env.CYBER_ENGAGEMENT_ID = "tool-scope";
    const ref = storeArtifact(new Uint8Array([0, 1, 2, 3]), { kind: "download" });
    const tool = loadTool();
    const ctx = {} as ExtensionToolContext;
    const metadata = await tool.execute("call", { action: "metadata", id: ref.id }, undefined, undefined, ctx);
    expect(metadata.content[0].text).toContain(`sha256:${ref.sha256}`);

    const page = await tool.execute("call", { action: "read", id: ref.id, limit: 2 }, undefined, undefined, ctx);
    expect(page.content[0].text).toBe(Buffer.from([0, 1]).toString("base64"));
    expect(page.details).toMatchObject({ encoding: "base64", offset: 0, nextOffset: 2 });
  });
});
