// Smoke test for the cyberbench fixture: boots the app in-process on a random
// free port, exercises every seeded fault over loopback fetch, then closes it.
// No network traffic beyond 127.0.0.1; upload writes are clamped to a temp root.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultPort, start } from "../../fixtures/cyberbench/app.ts";

let server: ReturnType<typeof start>;
let base = "";
let rootDir = "";

const root = await mkdtemp(path.join(tmpdir(), "cyberbench-smoke-"));
server = start({ port: 0, rootDir: root }); // port 0 → OS assigns a free loopback port
base = `http://127.0.0.1:${server.port}`;
rootDir = root;

afterAll(async () => {
  await server.stop(true);
  await rm(rootDir, { recursive: true, force: true });
});

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  return body.token;
}

describe("cyberbench fixture", () => {
  test("fixed port is 4747 and CYBERBENCH_PORT overrides it", () => {
    expect(defaultPort()).toBe(4747);
    expect(defaultPort({ CYBERBENCH_PORT: "5171" })).toBe(5171);
  });

  test("index lists routes and robots.txt disallows the sensitive paths", async () => {
    expect((await fetch(base)).status).toBe(200);
    const robots = await fetch(`${base}/robots.txt`);
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain("Disallow: /debug/");
  });

  test("unauthenticated /api/balance is rejected with 401", async () => {
    const res = await fetch(`${base}/api/balance?user=member`);
    expect(res.status).toBe(401);
  });

  test("authz fault observable: member token reads the admin-only user list", async () => {
    const token = await login("member", "memberpw");
    // control: the same token is valid on a normal route, so auth works and only the role check is missing
    const control = await fetch(`${base}/api/balance?user=member`, { headers: { authorization: `Bearer ${token}` } });
    expect(control.status).toBe(200);
    const res = await fetch(`${base}/api/admin/users`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ role: string }>; requestedBy: string };
    expect(body.requestedBy).toBe("member");
    expect(body.users.some((u) => u.role === "admin")).toBe(true);
  });

  test("IDOR observable: member reads admin's balance", async () => {
    const token = await login("member", "memberpw");
    const res = await fetch(`${base}/api/balance?user=admin`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: string; balance: number };
    expect(body.user).toBe("admin");
    expect(body.balance).toBe(900000);
  });

  test("tenant-boundary IDOR observable: alpha member reads a beta order", async () => {
    const token = await login("member", "memberpw");
    const res = await fetch(`${base}/api/orders?id=9001`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tenant: string; callerTenant: string; tenantMismatch: boolean };
    expect(body.tenant).toBe("beta");
    expect(body.callerTenant).toBe("alpha");
    expect(body.tenantMismatch).toBe(true);
  });

  test("path traversal observable: upload with name=../ escapes the uploads dir (inside fixture root)", async () => {
    const token = await login("member", "memberpw");
    const form = new FormData();
    form.set("name", "../traversal-escape.txt");
    form.set("file", new Blob(["harness traversal probe"]), "ignored-upload.bin");
    const res = await fetch(`${base}/api/upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
    expect(res.status).toBe(200);
    expect(existsSync(path.join(rootDir, "traversal-escape.txt"))).toBe(true);
    expect(existsSync(path.join(rootDir, "uploads", "traversal-escape.txt"))).toBe(false);
    // control: an ordinary name lands inside uploads
    const plain = new FormData();
    plain.set("name", "report.txt");
    plain.set("file", new Blob(["normal upload"]), "report.txt");
    const ok = await fetch(`${base}/api/upload`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: plain });
    expect(ok.status).toBe(200);
    expect(existsSync(path.join(rootDir, "uploads", "report.txt"))).toBe(true);
  });

  test("/debug/session leaks a raw token and API key matching realistic secret patterns", async () => {
    const token = await login("member", "memberpw");
    const res = await fetch(`${base}/debug/session`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionToken: string; apiKey: string };
    expect(body.sessionToken).toMatch(/^[0-9a-f]{64}$/); // 256-bit hex session token
    expect(body.apiKey).toMatch(/^sk-live-[0-9a-f]{40}$/); // realistic provider key pattern
  });

  test("logout invalidates the session token", async () => {
    const token = await login("admin", "adminpw");
    const before = await fetch(`${base}/api/balance?user=member`, { headers: { authorization: `Bearer ${token}` } });
    expect(before.status).toBe(200);
    await fetch(`${base}/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const after = await fetch(`${base}/api/balance?user=member`, { headers: { authorization: `Bearer ${token}` } });
    expect(after.status).toBe(401);
  });
});
