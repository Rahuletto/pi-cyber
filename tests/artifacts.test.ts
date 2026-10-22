import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { findArtifactBySource, readArtifact, resolveArtifactPath, storeArtifact } from "../src/artifacts/store.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function envRoot() {
  const root = mkdtempSync(join(tmpdir(), "cyber-artifacts-test-"));
  roots.push(root);
  return { CYBER_EVIDENCE_DIR: root, CYBER_ENGAGEMENT_ID: "engagement-a" };
}

describe("artifact store", () => {
  test("stores private binary bytes with a content hash and bounded base64 reads", () => {
    const env = envRoot();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const ref = storeArtifact(bytes, { kind: "download", contentType: "application/octet-stream" }, env);
    expect(ref.bytes).toBe(5);
    expect(ref.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(statSync(resolveArtifactPath(ref.id, env)).mode & 0o777).toBe(0o600);
    expect(readArtifact(ref.id, { offset: 1, limit: 3, encoding: "base64" }, env)).toMatchObject({
      offset: 1, nextOffset: 4, data: Buffer.from([1, 2, 250]).toString("base64"),
    });
    expect(readFileSync(resolveArtifactPath(ref.id, env))).toEqual(Buffer.from(bytes));
  });

  test("refuses secret-like text and traversal IDs before exposing a path", () => {
    const env = envRoot();
    expect(() => storeArtifact("api_key=abcdefghijklmno", { kind: "text", contentType: "text/plain" }, env))
      .toThrow("possible raw secret");
    expect(() => resolveArtifactPath("../../cyber.sqlite", env)).toThrow("invalid artifact id");
  });

  test("refuses out-of-range reads and caps requested windows", () => {
    const env = envRoot();
    const ref = storeArtifact("0123456789", { kind: "result", contentType: "text/plain" }, env);
    expect(() => readArtifact(ref.id, { offset: 11 }, env)).toThrow("offset exceeds artifact size");
    expect(() => readArtifact(ref.id, { limit: 0 }, env)).toThrow("limit must be between");
  });

  test("detects same-length tampering and advances UTF-8 windows at scalar boundaries", () => {
    const env = envRoot();
    const ref = storeArtifact("a🙂bc", { kind: "text", contentType: "text/plain" }, env);
    const first = readArtifact(ref.id, { limit: 3 }, env);
    expect(first.data).toBe("a");
    expect(first.nextOffset).toBe(1);
    const second = readArtifact(ref.id, { offset: first.nextOffset ?? 0, limit: 5 }, env);
    expect(second.data).toBe("🙂b");
    expect(second.nextOffset).toBe(6);
    writeFileSync(resolveArtifactPath(ref.id, env), "xxxxxxx");
    expect(() => resolveArtifactPath(ref.id, env)).toThrow("artifact integrity check failed");
    expect(() => readArtifact(ref.id, {}, env)).toThrow("artifact integrity check failed");
  });

  test("UTF-8 windows advance through a multibyte scalar even when limits are one or two bytes", () => {
    const env = envRoot();
    const ref = storeArtifact("🙂x", { kind: "text", contentType: "text/plain" }, env);
    for (const limit of [1, 2, 3]) {
      const page = readArtifact(ref.id, { offset: 0, limit }, env);
      expect(page.data).toBe("🙂");
      expect(page.nextOffset).toBe(4);
    }
    const tail = readArtifact(ref.id, { offset: 4, limit: 1 }, env);
    expect(tail.data).toBe("x");
    expect(tail.nextOffset).toBeNull();
  });

  test("persists a safe source-to-artifact lookup within the engagement namespace", () => {
    const env = envRoot();
    const ref = storeArtifact("{\"state\":\"succeeded\"}", { kind: "job-result", contentType: "application/json", source: "subfinder-job-1" }, env);
    expect(findArtifactBySource("subfinder-job-1", env)).toEqual(ref);
    expect(findArtifactBySource("subfinder-job-1", { ...env, CYBER_ENGAGEMENT_ID: "other" })).toBeUndefined();
  });
});
