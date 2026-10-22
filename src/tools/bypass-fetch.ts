import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { openEvidence } from "../evidence/db.ts";
import { containsSecretLike } from "../evidence/secrets.ts";
import { recoverState } from "../state.ts";

/**
 * `bypass_fetch` — raw HTTP with a real browser TLS/HTTP-2 fingerprint, backed
 * by curl-impersonate (MIT, installed as a digest-pinned bundle by
 * tools/install-curl-impersonate.sh).
 *
 * Safety contract: the model's parameters are treated strictly as data. Every
 * request goes through promisified `execFile` with an argument array — never a
 * shell string — so URLs, headers, and bodies cannot break out of their argv
 * slot, and every header stays a distinct `-H name: value` element.
 *
 * Scope contract (operator decision): when the engagement state records a
 * scope, a request whose host is outside it is refused unless the call passes
 * `outOfScope: true`; that override is recorded in the evidence store as an
 * explicit acknowledgement. Requests with NO recorded scope are not gated —
 * the harness records scope, it cannot invent it.
 *
 * Secret discipline: cookies live in a per-session curl cookie jar (mode 0600)
 * and never in the tool result; the evidence trail stores status/timing/
 * content-type metadata only, never bodies or request headers.
 */

const FETCH_TIMEOUT_MS = 180_000; /* upper bound for execFile, seconds come from params */
const MAX_OUTPUT_CHARS = 32_000;
const TRUNCATED = "[truncated]";

const execFileAsync = promisify(execFile);

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Known-good impersonation profiles for the pinned bundle (curl-impersonate 2.x). */
export const IMPERSONATE_PROFILES = ["chrome152", "chrome151", "chrome150", "chrome136", "chrome133a", "chrome131", "chrome124", "safari18", "firefox147", "none"] as const;

const MAX_BODY_CHARS_DEFAULT = 24_000;

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let cut = text.slice(0, MAX_OUTPUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

/**
 * Engine resolution order: explicit env → installed bundle → stock curl.
 * The bundle keeps curl-impersonate's wrapper tree together, so the binary
 * resolves inside its own directory, not $PI_TOOLS_DIR/bin.
 */
export function resolveFetchEngine(env: NodeJS.ProcessEnv = process.env): { kind: "impersonate" | "curl"; bin: string } | null {
  const override = env.CYBER_CURL_IMPERSONATE?.trim();
  if (override) {
    try {
      accessSync(override, constants.X_OK);
      return { kind: "impersonate", bin: override };
    } catch {
      // A broken override is an operator error, not a silent fallback.
      throw new Error(`CYBER_CURL_IMPERSONATE points at ${override}, which is not executable`);
    }
  }
  const bundle = join(homedir(), ".pi", "scanners", "curl-impersonate", "curl-impersonate");
  if (existsSync(bundle)) {
    try {
      accessSync(bundle, constants.X_OK);
      return { kind: "impersonate", bin: bundle };
    } catch { /* fall through */ }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const directory of pathEnv.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "curl");
    try {
      accessSync(candidate, constants.X_OK);
      return { kind: "curl", bin: candidate };
    } catch {
      // keep searching
    }
  }
  return null;
}

/** URL parsing without new dependencies: scheme://host[:port]/path?query. */
const URL_PATTERN = /^(https?):\/\/([A-Za-z0-9._-]+(?::\d+)?)([/?#].*)?$/;

export function requestHost(url: string): string | null {
  const match = URL_PATTERN.exec(url.trim());
  return match ? (match[2].split(":")[0].toLowerCase()) : null;
}

/** Only the hostname of each scope entry is used for matching (suffix match). */
function hostInScope(host: string, scope: string[]): boolean {
  return scope.some((entry) => {
    const trimmed = entry.trim().toLowerCase().replace(/^\w+:\/\//, "").replace(/\/.*$/, "");
    if (!trimmed) return false;
    return host === trimmed || host.endsWith(`.${trimmed}`);
  });
}

/** Build the curl argv for one request. Every user value stays one argv element. */
export function buildCurlArgs(
  params: { method: HttpMethod; url: string; headers?: Record<string, string>; body?: string; profile?: string; timeoutSec?: number; followRedirects?: boolean; session?: string },
  engine: "impersonate" | "curl"
): { argv: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const argv: string[] = [];

  if (engine === "impersonate") {
    const profile = params.profile && params.profile !== "none" ? params.profile : "";
    if (profile) argv.push("--impersonate", profile);
  } else if (params.profile && params.profile !== "none") {
    warnings.push("engine is stock curl: no TLS impersonation available — responses may be fingerprinted as non-browser traffic");
  }

  if (params.followRedirects ?? true) argv.push("--location", "--max-redirs", "8");
  argv.push("--compressed", "--silent", "--show-error", "--fail-with-body", "--connect-timeout", "10", "--max-time", String(params.timeoutSec ?? 60));

  for (const [name, value] of Object.entries(params.headers ?? {})) {
    if (!/^[!#$%&'*+\-.^_`A-Za-z0-9~]+$/.test(name)) throw new Error(`invalid header name ${JSON.stringify(name.slice(0, 64))}`);
    if (name.toLowerCase() === "user-agent") warnings.push("explicit User-Agent overrides the impersonation profile's UA — an inconsistent UA/TLS pair is itself a detection signal");
    argv.push("--header", `${name}: ${value}`);
  }

  if (params.session) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(params.session)) throw new Error(`invalid session name ${JSON.stringify(params.session.slice(0, 64))}`);
    const jarDir = process.env.CYBER_COOKIE_DIR?.trim() || join(homedir(), ".pi", "scanners", "cookies");
    mkdirSync(jarDir, { recursive: true });
    const jar = join(jarDir, `${params.session}.txt`);
    argv.push("--cookie", jar, "--cookie-jar", jar);
  }

  if (params.body !== undefined) {
    if (params.method === "GET") throw new Error("GET takes no body; use POST/PUT/PATCH or move the payload into headers.");
    argv.push("--data-raw", params.body);
  }

  argv.push("--method", params.method, params.url, "--write-out", "\t%{http_code}\t%{time_total}\t%{size_download}\t%{content_type}\t%{url_effective}\n");
  return { argv, warnings };
}

export interface FetchOutcome {
  status: string;
  elapsed: string;
  size: string;
  contentType: string;
  url: string;
  body: string;
  warnings: string[];
  engine: string;
  profile: string | undefined;
  outOfScope: boolean;
}

/** Split curl's body + write-out tail into a structured response. */
export function parseCurlOutput(stdout: string, fallbackProfile?: string, engine = "impersonate", outOfScope = false): FetchOutcome | null {
  // The write-out format starts with a tab and ends with \n; find its LAST
  // occurrence so a response body containing the marker never splits wrong.
  const tailPattern = /(\t\d{3}\t[0-9.]+\t[0-9]+\t[^\t\n]*\t[^\t\n]*)\n?\s*$/;
  const match = tailPattern.exec(stdout);
  if (!match) return null;
  const tail = match[1];
  const body = stdout.slice(0, match.index);
  // The write-out format leads with a tab, so slot 0 is empty; skipping it
  // also keeps %{content_type} positionally intact when it is empty (double tab).
  const [, status, elapsed, size, contentType, url] = tail.split("\t");
  return { status, elapsed, size, contentType: contentType || "none", url, body, warnings: [], engine, profile: fallbackProfile, outOfScope };
}

const parameters = Type.Object({
  method: Type.Union(HTTP_METHODS.map((m) => Type.Literal(m)), { description: "HTTP method." }),
  url: Type.Optional(Type.String({ description: "Absolute http(s) URL." })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 8192 }), { description: "Request headers. Avoid overriding User-Agent (the profile's UA is part of the fingerprint)." })),
  body: Type.Optional(Type.String({ maxLength: 1_000_000, description: "Raw request body (integer/POST etc.); sent as --data-raw." })),
  profile: Type.Optional(Type.String({ description: `Impersonation profile for the curl-impersonate engine: ${IMPERSONATE_PROFILES.join(", ")}. Default chrome152. "none" skips impersonation.` })),
  session: Type.Optional(Type.String({ maxLength: 64, description: "Named cookie jar (shared across calls) — required for login flows where Set-Cookie must persist." })),
  timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 120, default: 60, description: "Total request timeout (default 60)." })),
  followRedirects: Type.Optional(Type.Boolean({ default: true, description: "Follow 3xx redirects (default true)." })),
  outOfScope: Type.Optional(Type.Boolean({ description: "Explicit acknowledgement that the host is outside the recorded engagement scope; recorded in evidence." })),
}, { additionalProperties: false });

type BypassFetchParams = Static<typeof parameters>;

const bypassFetchTool: ToolDefinition<typeof parameters> = {
  name: "bypass_fetch",
  label: "bypass_fetch",
  description:
    "Raw HTTP requests with a real browser TLS/HTTP-2 fingerprint via curl-impersonate (JA3/JA4 + Akamai h2 impersonation), for bot-protected APIs in authorized engagements. " +
    "Not a header-spoof: the TLS ClientHello and HTTP/2 SETTINGS match Chrome/Safari/Firefox profiles. Falls back to stock curl (with a warning) when impersonation is not installed.",
  promptSnippet:
    "Use bypass_fetch (not raw curl/python) for sign-up/login/API calls against bot-protected targets; it presents Chrome-grade TLS+HTTP/2 fingerprints and keeps cookies per session.",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
  async execute(
    _toolCallId: string,
    params: BypassFetchParams,
    signal: AbortSignal | undefined,
    _onUpdate,
    ctx: ExtensionToolContext
  ): Promise<AgentToolResult> {
    if (!params.url) throw new Error("url required.");
    const url = params.url.trim();
    if (!URL_PATTERN.test(url)) throw new Error(`invalid absolute http(s) URL (rejected ${JSON.stringify(url.slice(0, 128))})`);
    const host = requestHost(url)!;
    const parsedUrl = new URL(url);

    // Scope gate: read the engagement state from this session's cyber checkpoint.
    let scope: string[] = [];
    try {
      scope = recoverState(ctx.sessionManager.getBranch()).scope ?? [];
    } catch { /* no scope recorded */ }

    let outOfScope = false;
    if (scope.length > 0 && !hostInScope(host, scope)) {
      if (!params.outOfScope) {
        throw new Error(
          `host ${host} is outside the recorded engagement scope (${scope.join(", ")}). ` +
          "Re-check the URL, update the scope with /cyber scope, or pass outOfScope:true to acknowledge."
        );
      }
      outOfScope = true;
    }

    const engine = resolveFetchEngine();
    if (!engine) throw new Error("no curl available — install curl-impersonate (tools/install-curl-impersonate.sh) or curl");

    let profile = params.profile;
    if (engine.kind === "impersonate") {
      profile = profile && profile !== "none" ? profile : "chrome152";
      if (!(IMPERSONATE_PROFILES as readonly string[]).includes(profile)) {
        throw new Error(`unknown impersonation profile ${JSON.stringify(profile)} — one of: ${IMPERSONATE_PROFILES.join(", ")}`);
      }
    }

    const { argv, warnings } = buildCurlArgs({ ...params, url, method: params.method }, engine.kind);
    const started = Date.now();
    let stdout = "";
    try {
      const result = (await execFileAsync(engine.bin, argv, {
        encoding: "utf-8",
        timeout: FETCH_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        signal,
      })) as unknown as { stdout: string };
      stdout = result.stdout;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
      if (err.code === "ENOENT") throw new Error(`fetch engine vanished: ${engine.bin}`);
      const stderr = typeof err.stderr === "string" ? err.stderr.trim().split("\n")[0] : "";
      throw new Error(`curl failed: ${stderr || (err as Error).message || "unknown"}`.slice(0, 500));
    }

    const outcome = parseCurlOutput(stdout, profile, engine.kind, outOfScope);
    if (!outcome) throw new Error("curl returned no parseable response (connection failure or timeout before a status line)");
    outcome.warnings = warnings;
    const elapsedMs = Date.now() - started;

    // Evidence: metadata only — no bodies, no request headers, no cookie values.
    try {
      const text =
        `${params.method} ${url} → ${outcome.status} ${outcome.elapsed}s size=${outcome.size} type=${outcome.contentType} ` +
        `engine=${engine.kind} profile=${profile ?? "none"}${outOfScope ? " outOfScope=acknowledged" : ""}`;
      if (!containsSecretLike(text)) {
        openEvidence().addEvidence({ kind: "bypass_fetch", refs: [params.method, url], text, sensitivity: outOfScope ? "restricted" : "internal" });
      }
    } catch { /* evidence is an audit trail, never the point of failure */ }

    const bodyClipped = clip(outcome.body);
    const head = [
      `status: ${outcome.status} (${elapsedMs}ms total, ${outcome.size} bytes)`,
      `content-type: ${outcome.contentType}`,
      `url: ${outcome.url}`,
      `engine: ${engine.kind === "impersonate" ? `curl-impersonate (${profile})` : "stock curl (no TLS impersonation)"}`,
      ...(outcome.warnings.length ? [`warnings: ${outcome.warnings.join("; ")}`] : []),
      ...(outOfScope ? ["scope: out-of-scope acknowledged"] : []),
      "---",
    ].join("\n");

    const details = {
      method: params.method,
      host,
      status: Number(outcome.status) || 0,
      engine: engine.kind,
      profile: profile ?? "none",
      outOfScope,
      elapsedMs,
    };
    return { content: [{ type: "text", text: `${head}\n${bodyClipped}` }], details };
  },
};

export function registerBypassFetchTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(bypassFetchTool);
}
