import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveToolBin } from "./paths.ts";
import { openEvidence } from "../evidence/db.ts";
import { containsSecretLike } from "../evidence/secrets.ts";

/**
 * `challenge` — the bypass browser lane: drive Obscura (stealth transport) via
 * Patchright and harvest what a fingerprint-gated page emits, e.g. a resolved
 * Cloudflare Turnstile token.
 *
 * Why this shape: the turnstile token cannot be fabricated — it is minted by
 * the challenge widget running in a real rendering engine, and it is bound to
 * that engine's IP + fingerprint. The harness therefore drives a browser on
 * the same host, and the token is presented to the same target from the same
 * egress (typically via bypass_fetch immediately after).
 *
 * Process topology per call:
 *   Bun tool -> (execFile) -> node challenge-driver.mjs (single JSON argv)
 *   driver -> Patchright -> CDP WebSocket -> obscura serve --stealth
 *
 * Obscura lifecycle: when CYBER_OBSCURA_CDP is set, that endpoint is used as
 * the operator-managed engine and nothing is launched here. Otherwise the
 * tool spawns `obscura serve --port <free> --stealth` for the duration of the
 * call and kills it afterwards; one owner per call, no cross-call browser
 * state (mirrors the cyber_browser lease discipline without renegotiating it:
 * this lane books nothing, it owns its engine for exactly one call).
 *
 * Bun-only harness: Patchright is never installed into this package. It is
 * loaded by the node driver from an operator-managed directory (default
 * ~/.pi/scanners/patchright), so a missing patchright install is a typed,
 * resolvable readiness failure — never a silent degrade.
 */

const CHALLENGE_EXEC_MS = 180_000; /* execFile watchdog >= driver timeout */
const MAX_OUTPUT_CHARS = 8_000;
const TRUNCATED = "[truncated]";

const execFileAsync = promisify(execFile);

const DRIVER_PATH = fileURLToPath(new URL("./challenge-driver.mjs", import.meta.url));

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("turnstile"),
    Type.Literal("fingerprint"),
  ], { description: "turnstile: load url and harvest the resolved cf-turnstile-response token. fingerprint: report the engine's own JA3/JA4/HTTP-2/UA as the target network sees it." }),
  url: Type.Optional(Type.String({ description: "Page hosting the Turnstile widget (turnstile), or any page to fetch with the browser stack (fingerprint; default tls.peet.ws/api/all)." })),
  timeoutSec: Type.Optional(Type.Number({ minimum: 5, maximum: 120, default: 60, description: "How long to wait for the token (turnstile) or the page (fingerprint); default 60." })),
}, { additionalProperties: false });

type ChallengeParams = Static<typeof parameters>;

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let cut = text.slice(0, MAX_OUTPUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

/** An installed node (>=20 required by patchright); env override first. */
export function resolveNodeBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CYBER_NODE_BIN?.trim();
  if (override) return override;
  const pathEnv = env.PATH ?? "";
  for (const directory of pathEnv.split(":")) {
    if (!directory) continue;
    const candidate = join(directory, "node");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("node not available — patchright driving needs node >= 20 on PATH or CYBER_NODE_BIN");
}

/**
 * Operator-managed patchright root. Accepts an npm root (contains
 * node_modules/patchright) or a bare node_modules tree that directly holds it.
 */
export function resolvePatchrightDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CYBER_PATCHRIGHT_DIR?.trim();
  const roots = override
    ? [override, join(override, "node_modules")]
    : [join(homedir(), ".pi", "scanners", "patchright"), join(homedir(), ".pi", "scanners", "patchright", "node_modules")];
  for (const root of roots) {
    if (existsSync(join(root, "patchright", "package.json"))) return root;
  }
  throw new Error(
    `patchright not installed (${roots[0]}) — run tools/install-patchright.sh or set CYBER_PATCHRIGHT_DIR to its npm root`
  );
}

const URL_PATTERN = /^(https?):\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

function validateUrl(url: string): void {
  if (!URL_PATTERN.test(url.trim())) {
    throw new Error(`invalid absolute http(s) URL (rejected ${JSON.stringify(url.slice(0, 128))})`);
  }
}

/** Grab a free TCP port, release it immediately, and hand it to obscura. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("cannot allocate a free port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** Wait until the CDP server answers on this loopback port (short-poll). */
async function waitCdpReady(port: number, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
      if (response.status < 500) return; // any crisp HTTP answer means the server is up
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`obscura serve did not answer on port ${port} within ${Math.round(budgetMs / 1000)}s`);
}

export interface ChallengeArgs {
  action: string;
  url?: string;
  timeoutSec?: number;
}

/** Spawn-or-reuse the engine, run the node driver once, return the driver's JSON. */
export async function runChallenge(params: ChallengeParams, signal: AbortSignal | undefined): Promise<{
  text: string;
  meta: Record<string, string | number | boolean | null>;
}> {
  const env = process.env;
  const nodeBin = resolveNodeBin(env);
  const patchrightDir = resolvePatchrightDir(env);
  const timeoutSec = Math.min(params.timeoutSec ?? 60, 120);

  const fixedEndpoint = env.CYBER_OBSCURA_CDP?.trim();
  if (!fixedEndpoint) {
    const obscuraBin = resolveToolBin("obscura");
    if (!existsSync(obscuraBin)) {
      throw new Error("bin not available: obscura — run tools/install.sh (state: cataloged)");
    }
  }
  const endpoint = fixedEndpoint || "";

  // Token/action JSON handed to the node driver as ONE argv element.
  const spec: Record<string, unknown> = {
    action: params.action,
    timeoutMs: timeoutSec * 1_000,
    patchrightDir,
  };
  if (fixedEndpoint) spec.endpoint = fixedEndpoint;

  // Ephemeral engine: start after resolving the port, exercised below by waitCdpReady.
  let serverPid: number | null = null;
  let port = 0;
  if (!fixedEndpoint) {
    port = await freePort();
    const obscuraBin = resolveToolBin("obscura");
    spec.endpoint = `ws://127.0.0.1:${port}`;
    const child = spawn(obscuraBin, ["serve", "--port", String(port), "--stealth", "--quiet"], {
      stdio: "ignore",
      detached: true,
    });
    serverPid = typeof child.pid === "number" ? child.pid : null;
    child.unref();
    try {
      await waitCdpReady(port, 15_000);
    } catch (error) {
      if (serverPid) { try { process.kill(serverPid); } catch { /* already gone */ } }
      throw error;
    }
  } else {
    if (!/^wss?:\/\/[A-Za-z0-9._:\-/]+$/.test(endpoint)) {
      throw new Error(`CYBER_OBSCURA_CDP must be a ws(s):// endpoint (rejected ${JSON.stringify(endpoint.slice(0, 64))})`);
    }
  }

  try {
    if (params.action === "fingerprint") {
      if (params.url) validateUrl(params.url);
    } else {
      if (!params.url) throw new Error("url required for the turnstile action.");
      validateUrl(params.url);
      spec.url = params.url.trim();
    }

    let stdout = "";
    try {
      const result = (await execFileAsync(nodeBin, [DRIVER_PATH, JSON.stringify(spec)], {
        encoding: "utf-8",
        timeout: CHALLENGE_EXEC_MS,
        maxBuffer: 8 * 1024 * 1024,
        signal,
      })) as unknown as { stdout: string };
      stdout = result.stdout;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
      const stderr = typeof err.stderr === "string" ? err.stderr.trim() : "";
      throw new Error(`challenge driver failed: ${stderr || (err as Error).message || "unknown"}`.slice(0, 500));
    }

    const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
    if (!line) throw new Error("challenge driver produced no JSON result");
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { throw new Error(`challenge driver produced unparseable output: ${line.slice(0, 200)}`); }
    const result = parsed as Record<string, unknown>;
    if (result.ok !== true) {
      throw new Error(`challenge ${params.action} failed: ${String(result.error ?? "unknown driver error").slice(0, 400)}`);
    }

    // Evidence: outcome metadata only. The token NEVER lands in the store.
    const summary = `challenge ${params.action} ${params.url ?? "(default)"} ok engine=obscura+patchright ua=${String(result.ua ?? "?").slice(0, 120)}`;
    if (!containsSecretLike(summary)) {
      openEvidence().addEvidence({ kind: "challenge", refs: [params.action, params.url ?? "tls.peet.ws/api/all"], text: summary, sensitivity: "internal" });
    }

    if (params.action === "turnstile") {
      const token = String(result.token ?? "");
      const meta = { action: params.action, url: String(result.url ?? ""), tokenLength: token.length, frame: String(result.frame ?? ""), ua: String(result.ua ?? "") };
      const head = [
        `action: turnstile token resolved (${token.length} chars, ${elapsedSec(params, timeoutSec)}s budget)`,
        `page: ${result.url ?? params.url}`,
        `frame: ${result.frame ?? "(main)"}`,
        `engine ua: ${result.ua ?? "unknown"}`,
        "token: below — present it to the same target from the same egress immediately (explicit per-call scope override if outside scope)",
        "---",
      ].join("\n");
      return { text: `${head}\n${clip(token)}`, meta };
    }
    // fingerprint: present the engine's own network fingerprints.
    const meta = {
      action: params.action,
      url: String(result.url ?? ""),
      ua: String(result.ua ?? ""),
      ja3: result.ja3 === null || result.ja3 === undefined ? null : String(result.ja3),
      ja4: result.ja4 === null || result.ja4 === undefined ? null : String(result.ja4),
      http2: result.http2 === null || result.http2 === undefined ? null : String(result.http2),
    };
    const head = [
      `action: fingerprint probe`,
      `page: ${result.url ?? params.url}`,
      `ua: ${result.ua ?? "unknown"}`,
      `ja3: ${result.ja3 ?? "n/a"}`,
      `ja4: ${result.ja4 ?? "n/a"}`,
      `http2 (akamai): ${result.http2 ?? "n/a"}`,
      ...((result.text ? [`---\n${clip(String(result.text))}`] : []) as string[]),
    ].join("\n");
    return { text: head, meta };
  } finally {
    if (serverPid) {
      try { process.kill(serverPid); } catch { /* already gone */ }
      serverPid = null;
    }
  }
}

function elapsedSec(params: ChallengeParams, fallback: number): string {
  return String(params.timeoutSec ?? fallback);
}

const challengeTool: ToolDefinition<typeof parameters> = {
  name: "challenge",
  label: "challenge",
  description:
    "Solve page-gated challenges with a real browser stack: drives Obscura (stealth) over CDP via Patchright and returns the resolved Cloudflare Turnstile token (single-use, minutes TTL — use it with bypass_fetch immediately) " +
    "or the engine's own TLS/HTTP-2 fingerprint as seen by any target. Same-host egress only. Authorized engagements.",
  promptSnippet:
    "Use challenge (not captcha APIs) to obtain Turnstile tokens from the engine itself: challenge turnstile <url> -> token -> present via bypass_fetch from the same host.",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
  async execute(
    _toolCallId: string,
    params: ChallengeParams,
    signal: AbortSignal | undefined,
    _onUpdate,
    _ctx: ExtensionToolContext
  ): Promise<AgentToolResult> {
    if (params.action === "turnstile" && !params.url) throw new Error("url required for the turnstile action.");
    if (params.action === "fingerprint" && params.url) validateUrl(params.url);
    const { text, meta } = await runChallenge(params, signal);
    return { content: [{ type: "text", text }], details: meta };
  },
};

export function registerChallengeTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(challengeTool);
}

/** Test hookup: drop a stray temp artifact if any (none today, reserved). */
export function cleanupChallengeTemp(): void {
  rmSync(join(homedir(), ".pi", "scanners", "challenge-tmp"), { recursive: true, force: true });
}
