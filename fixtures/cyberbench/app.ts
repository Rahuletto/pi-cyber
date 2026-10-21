// cyberbench — a deliberately vulnerable local HTTP fixture for the pi-cyber
// harness. LOCAL FIXTURE ONLY — NEVER DEPLOY. Loopback-only, in-memory sqlite,
// seeded identities, no real attacker content. Every fault is tagged
// `seeded-vuln:` so the harness can trace observation to seeded cause.
//
// Start: bun fixtures/cyberbench/app.ts   (fixed port 4747, CYBERBENCH_PORT to override)

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const HOST = "127.0.0.1"; // loopback only — the fixture must never listen off-host

/** Fixed port 4747; CYBERBENCH_PORT overrides it (smoke tests boot on a free port). */
export function defaultPort(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CYBERBENCH_PORT);
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 4747;
}

// seeded-vuln: realistic secret-pattern API key, stored in plaintext constants
const SEEDED_API_KEY = "sk-live-9f3c1a7d84b2e6f05c8a31d2749bea60d5f8b2c1";

interface Row { [k: string]: string | number }
interface Session { user: Row; token: string }
interface FixtureContext { db: Database; rootDir: string; uploadsDir: string }

function seedDb(): Database {
  const db = new Database(":memory:"); // no persistence needed; state resets every boot
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
                        role TEXT NOT NULL, tenant TEXT NOT NULL, balance INTEGER NOT NULL);
    CREATE TABLE sessions (token TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, tenant TEXT NOT NULL, label TEXT NOT NULL, total INTEGER NOT NULL);
  `);
  const insUser = db.query("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)");
  // seeded-vuln: plaintext passwords persisted as-is — acceptable fixture-only
  insUser.run(1, "member", "memberpw", "member", "alpha", 4120);
  insUser.run(2, "admin", "adminpw", "admin", "beta", 900000);
  const insOrder = db.query("INSERT INTO orders VALUES (?, ?, ?, ?)");
  insOrder.run(5001, "alpha", "alpha pair purchase", 12900);
  insOrder.run(5002, "alpha", "alpha toolkit order", 34995);
  insOrder.run(9001, "beta", "beta infrastructure order", 777700);
  return db;
}

function hexToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** Resolve the caller from `Authorization: Bearer` or the `session` cookie. */
function currentSession(req: Request, db: Database): Session | null {
  const auth = req.headers.get("authorization");
  let token = auth?.startsWith("Bearer ") ? (auth.slice("Bearer ".length).trim()) : "";
  if (!token) token = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1] ?? "";
  if (!token) return null;
  const user = db.query(
    "SELECT u.*, s.token AS session_token FROM sessions s JOIN users u ON u.username = s.username WHERE s.token = ?",
  ).get(token) as Row | null;
  return user ? { user, token: String(user.session_token) } : null;
}
function requireSession(req: Request, fx: FixtureContext): { session: Session } | { error: Response } {
  const session = currentSession(req, fx.db);
  // auth gate is real: unauthenticated calls bounce with 401 before any fault applies
  return session ? { session } : { error: json(401, { error: "authentication required" }) };
}

async function login(req: Request, fx: FixtureContext): Promise<Response> {
  const body = { username: "", password: "" };
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    const parsed = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof parsed.username === "string") body.username = parsed.username;
    if (typeof parsed.password === "string") body.password = parsed.password;
  } else {
    const form = await req.formData();
    body.username = String(form.get("username") ?? "");
    body.password = String(form.get("password") ?? "");
  }
  const user = fx.db.query("SELECT * FROM users WHERE username = ? AND password = ?")
    .get(body.username, body.password) as Row | null;
  if (!user) return json(401, { error: "invalid credentials" });
  const token = hexToken();
  fx.db.query("INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)").run(token, String(user.username), Date.now());
  const cookie = `session=${token}; HttpOnly; Path=/; SameSite=Lax`;
  return json(200, {
    token,
    user: { username: user.username, role: user.role, tenant: user.tenant },
  }, { "set-cookie": cookie });
}

function balance(req: Request, fx: FixtureContext): Response {
  const gate = requireSession(req, fx);
  if ("error" in gate) return gate.error;
  const target = new URL(req.url).searchParams.get("user");
  if (!target) return json(400, { error: "query param `user` is required" });
  // seeded-vuln: no ownership check — any authenticated user reads any user's balance (IDOR)
  const row = fx.db.query("SELECT username, tenant, balance FROM users WHERE username = ?").get(target) as Row | null;
  if (!row) return json(404, { error: `unknown user ${target}` });
  return json(200, { user: row.username, tenant: row.tenant, balance: row.balance });
}

function adminUsers(req: Request, fx: FixtureContext): Response {
  const gate = requireSession(req, fx);
  if ("error" in gate) return gate.error;
  // seeded-vuln: role check missing — plain members list every account with roles/tenants
  const users = fx.db.query("SELECT username, role, tenant FROM users ORDER BY id").all() as Row[];
  return json(200, { users, requestedBy: String(gate.session.user.username) });
}

async function upload(req: Request, fx: FixtureContext): Promise<Response> {
  const gate = requireSession(req, fx);
  if ("error" in gate) return gate.error;
  const form = await req.formData();
  const file = form.get("file");
  const rawName = form.get("name");
  const name = typeof rawName === "string" && rawName.length > 0 ? rawName : file instanceof File ? file.name : "";
  if (!(file instanceof File) || name.length === 0) return json(400, { error: "expected multipart fields `file` and `name`" });
  // seeded-vuln: unvalidated filename — `name=../x` escapes the uploads dir (path traversal)
  const target = path.resolve(fx.uploadsDir, name);
  const insideRoot = target === fx.rootDir || target.startsWith(fx.rootDir + path.sep);
  // Fixture safety rail: even traversal stays inside the fixture root, never outside it.
  if (!insideRoot) return json(400, { error: "refusing write outside the fixture root" });
  const bytes = new Uint8Array(await file.arrayBuffer());
  await writeFile(target, bytes);
  return json(200, { stored: path.relative(fx.rootDir, target), bytes: bytes.length, uploader: String(gate.session.user.username) });
}

function orders(req: Request, fx: FixtureContext): Response {
  const gate = requireSession(req, fx);
  if ("error" in gate) return gate.error;
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return json(400, { error: "query param `id` must be a positive integer" });
  const row = fx.db.query("SELECT id, tenant, label, total FROM orders WHERE id = ?").get(id) as Row | null;
  if (!row) return json(404, { error: `unknown order ${id}` });
  // seeded-vuln: tenant boundary not enforced — alpha members read beta orders (tenant IDOR)
  const callerTenant = String(gate.session.user.tenant);
  return json(200, { ...row, requestedBy: String(gate.session.user.username), callerTenant, tenantMismatch: String(row.tenant) !== callerTenant });
}

function debugSession(req: Request, fx: FixtureContext): Response {
  const gate = requireSession(req, fx);
  if ("error" in gate) return gate.error;
  // seeded-vuln: full secret disclosure — raw session token + API key, zero redaction
  return json(200, {
    user: String(gate.session.user.username),
    sessionToken: gate.session.token,
    apiKey: SEEDED_API_KEY,
    note: "debug endpoint, deliberately unredacted for harness secret-pattern tests",
  });
}

const ROUTES: Array<[string, string, string]> = [
  ["POST", "/login", "auth entry (form or JSON); identity seed member/memberpw, admin/adminpw"],
  ["POST", "/logout", "invalidates the presented session token"],
  ["GET", "/api/balance?user=", "IDOR across users — no ownership check"],
  ["GET", "/api/admin/users", "broken authorization — role check missing"],
  ["POST", "/api/upload", "path traversal — unvalidated upload filename"],
  ["GET", "/api/orders?id=", "tenant-boundary IDOR — no tenant scoping"],
  ["GET", "/debug/session", "secret disclosure — raw session token + API key"],
];

function indexPage(): Response {
  const rows = ROUTES.map(([m, p, v]) => `<tr><td><code>${m} ${p}</code></td><td>${v}</td></tr>`).join("");
  const page = `<!doctype html><html><head><title>cyberbench fixture</title></head>
<body><h1>cyberbench</h1><p>local fixture only — never deploy</p>
<table border="1"><tr><th>route</th><th>seeded fault</th></tr>${rows}</table></body></html>`;
  return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function route(req: Request, fx: FixtureContext): Promise<Response> {
  const url = new URL(req.url);
  switch (`${req.method} ${url.pathname}`) {
    case "GET /": return indexPage();
    case "GET /robots.txt": return text(200, `User-agent: *\nDisallow: /api/\nDisallow: /debug/\n`);
    case "POST /login": return login(req, fx);
    case "POST /logout": {
      const session = currentSession(req, fx.db);
      if (session) fx.db.query("DELETE FROM sessions WHERE token = ?").run(session.token);
      return json(200, { loggedOut: true });
    }
    case "GET /api/balance": return balance(req, fx);
    case "GET /api/admin/users": return adminUsers(req, fx);
    case "POST /api/upload": return upload(req, fx);
    case "GET /api/orders": return orders(req, fx);
    case "GET /debug/session": return debugSession(req, fx);
    default: return json(404, { error: `no route: ${req.method} ${url.pathname}` });
  }
}

export interface FixtureOptions { port?: number; rootDir?: string }

/** Boot the fixture. Returns the Bun server so tests can `stop()` it cleanly. */
export function start(options: FixtureOptions = {}): Bun.Server<undefined> {
  const rootDir = path.resolve(options.rootDir ?? import.meta.dir);
  const uploadsDir = path.join(rootDir, "uploads");
  if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true });
  const fx: FixtureContext = { db: seedDb(), rootDir, uploadsDir };
  return Bun.serve({
    hostname: HOST,
    port: options.port ?? defaultPort(),
    idleTimeout: 30,
    fetch: (req) => route(req, fx),
  });
}

if (import.meta.main) {
  const server = start();
  console.log(`cyberbench: http://${HOST}:${server.port} (local fixture only — never deploy)`);
}
