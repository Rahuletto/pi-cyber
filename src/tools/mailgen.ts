import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { openEvidence } from "../evidence/db.ts";
import { containsSecretLike } from "../evidence/secrets.ts";

/**
 * `mailgen` — disposable inboxes for signup/verification flows, backed by the
 * cowbird CLI (AGPL-3.0, invoked as an external process; no code is vendored).
 *
 * Safety contract: the model's parameters are treated strictly as data. Every
 * cowbird invocation goes through promisified `execFile` with an argument
 * array — never a shell string — so addresses, providers, and states cannot
 * break out of their argv slot.
 *
 * Secret discipline: `cowbird new --json` returns an opaque `state` blob that
 * for some providers carries provider credentials (mail.tm packs a password).
 * The provider name and tag newline-safe value is persisted locally (mode
 * 0600) and replayed through `--state` on wait, but the blob is NEVER placed
 * in the tool result and NEVER written to the evidence store.
 */

const MAILGEN_TIMEOUT_MS = 190_000; /* wait often long-polls for a message */
const MAX_OUTPUT_CHARS = 16_000;
const TRUNCATED = "[truncated]";

const execFileAsync = promisify(execFile);

/** Find an executable by name across the given search paths (defaults to process.env.PATH). */
function findExecutable(name: string, paths?: string[]): string | null {
  const directories = paths ?? (process.env.PATH ? process.env.PATH.split(delimiter) : []);
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not on this path entry; keep searching.
    }
  }
  return null;
}

/** Where the cowbird CLI is expected in the harness tooling directory. */
export function resolveCowbirdCommand(env: NodeJS.ProcessEnv = process.env): { bin: string; base: string[] } | null {
  const override = env.CYBER_COWBIRD_BIN?.trim();
  if (override || override === "") {
    return { bin: override, base: [] };
  }
  const direct = findExecutable("cowbird", [join(toolsBin(), "bin"), ...(process.env.PATH ? process.env.PATH.split(delimiter) : [])]);
  if (direct) return { bin: direct, base: [] };
  const uv = findExecutable("uv");
  if (uv) return { bin: uv, base: ["run", "--no-project", "cowbird"] };
  return null;
}

/**
 * The harness tooling directory. Mirrors resolveToolBin's layout without
 * importing paths.ts into a tool namespace that does not need the rest.
 */
function toolsBin(): string {
  const override = process.env.PI_TOOLS_DIR?.trim();
  return override || join(homedir(), ".pi", "scanners");
}

/** Local store for cowbird `state` blobs, keyed by address. Mode 0600. */
function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CYBER_MAILGEN_FILE?.trim();
  return override || join(homedir(), ".pi", "scanners", "mailgen-registry.json");
}

function readRegistry(env: NodeJS.ProcessEnv = process.env): Record<string, { provider: string; state: string }> {
  const path = registryPath(env);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, { provider: string; state: string }> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null) {
        const entry = value as Record<string, unknown>;
        if (typeof entry.provider === "string" && typeof entry.state === "string") {
          out[key] = { provider: entry.provider, state: entry.state };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeRegistry(registry: Record<string, { provider: string; state: string }>, env: NodeJS.ProcessEnv = process.env): void {
  const path = registryPath(env);
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = join(tmpdir(), `mailgen-registry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(temp, JSON.stringify(registry, null, 2), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let cut = text.slice(0, MAX_OUTPUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

async function runCowbird(
  command: { bin: string; base: string[] },
  args: string[],
  signal: AbortSignal | undefined
): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = (await execFileAsync(command.bin, [...command.base, ...args], {
      encoding: "utf-8",
      timeout: MAILGEN_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    })) as unknown as { stdout: string };
    return { stdout, code: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: string; stderr?: string | Buffer; stdout?: string; status?: number };
    if (err.code === "ENOENT") throw new Error("cowbird CLI not available — install cowbird or set CYBER_COWBIRD_BIN");
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    const stdout = typeof err.stdout === "string" ? err.stdout : "";
    const detail = (stderr.trim().split("\n")[0] || `exit ${err.status ?? "?"}`).slice(0, 500);
    const exit: { stdout: string; code: number } = { stdout, code: err.status ?? 1 };
    // `cowbird wait` prints `timeout: ...` to stderr and exits 2; `error: ...` exits 1.
    // Both are expected control flow, not crashes: surface them as normal results.
    if (exit.code === 1 && /^error:/i.test(stderr.trim()) || exit.code === 2) {
      return { stdout: `${stdout}${stdout && stderr ? "\n" : ""}${stderr.trim()}`, code: exit.code };
    }
    throw new Error(`cowbird failed: ${detail}`);
  }
}

/** Address accepts the local@domain shape only; guards argv against arbitrary editorial content. */
const ADDRESS_PATTERN = /^[^\s,;'"`<>()\\]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function validateAddress(address: string): void {
  if (!ADDRESS_PATTERN.test(address) || address.length > 254) {
    throw new Error(`invalid address (rejected ${JSON.stringify(address.slice(0, 64))})`);
  }
}

export interface NewInbox {
  address: string;
  provider: string;
  addressTtl: string | null;
  hadState: boolean;
}

/** Parse `cowbird new --json` output into a redacted inbox record. */
export function parseNewJson(stdout: string): NewInbox | null {
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const address = typeof obj.address === "string" ? obj.address : "";
  const provider = typeof obj.provider === "string" ? obj.provider : "";
  if (!address || !provider) return null;
  const ttl = typeof obj.address_ttl === "string" ? obj.address_ttl : null;
  return { address, provider, addressTtl: ttl, hadState: typeof obj.state === "string" && obj.state.length > 0 };
}

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("new"),
    Type.Literal("wait"),
    Type.Literal("providers"),
    Type.Literal("canary"),
  ], { description: "Inbox interaction: new (acquire address), wait (long-poll first mail / OTP), providers (health matrix), canary (live probe all providers)." }),
  address: Type.Optional(Type.String({ description: "Inbox address (wait only)." })),
  provider: Type.Optional(Type.String({ description: "Provider name. new: require it; wait: required (the provider that issued the address)." })),
  otp: Type.Optional(Type.Boolean({ description: "wait: return the numeric/alphanumeric OTP code instead of sender+subject." })),
  timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 180, default: 120, description: "wait: how long to long-poll (default 120)." })),
}, { additionalProperties: false });

type MailgenParams = Static<typeof parameters>;

function requireFields(params: MailgenParams): void {
  if (params.action === "wait" && !params.address) throw new Error("address required for the wait action.");
  if (params.action === "wait" && !params.provider) throw new Error("provider required for the wait action.");
}

function buildCowbirdArgs(params: MailgenParams): string[] {
  switch (params.action) {
    case "new":
      if (params.otp) throw new Error("otp field applies to the wait action only.");
      return params.provider ? ["new", "--provider", params.provider, "--json"] : ["new", "--json"];
    case "wait": {
      validateAddress(params.address!);
      const argv = ["wait", params.address!, "--provider", params.provider!, "--timeout", String(Math.min(params.timeoutSec ?? 120, 180))];
      if (params.otp) argv.push("--otp");
      const registry = readRegistry();
      const saved = registry[params.address!];
      if (saved && saved.state) argv.push("--state", saved.state);
      return argv;
    }
    case "providers":
      if (params.address || params.provider) throw new Error("providers takes no extra arguments.");
      return ["providers"];
    case "canary":
      if (params.address || params.provider) throw new Error("canary takes no extra arguments.");
      return ["canary", "--json"];
  }
}

export async function runMailgen(params: MailgenParams, signal: AbortSignal | undefined): Promise<{ text: string; argv: string[] }> {
  const command = resolveCowbirdCommand();
  if (!command) throw new Error("cowbird CLI not available — install cowbird (uv tool) or set CYBER_COWBIRD_BIN");
  const argv = buildCowbirdArgs(params);
  const { stdout, code } = await runCowbird(command, argv, signal);

  let text: string;
  if (params.action === "new") {
    const parsed = parseNewJson(stdout);
    if (!parsed) throw new Error(`cowbird new returned no parsable address (exit ${code}).`);
    const registry = readRegistry();
    const fresh = stdout.slice(stdout.indexOf("{"));
    let state = "";
    try {
      const obj = JSON.parse(fresh) as Record<string, unknown>;
      if (typeof obj.state === "string") state = obj.state;
    } catch { /* state stays empty; wait will then use --provider only */ }
    if (state) registry[parsed.address] = { provider: parsed.provider, state };
    if (state) writeRegistry(registry);
    text = [
      `address: ${parsed.address}`,
      `provider: ${parsed.provider}`,
      `ttl: ${parsed.addressTtl ?? "forever"}`,
      state ? "state: stored locally (never shown; replayed automatically on wait)" : "state: none",
    ].join("\n");
  } else if (code !== 0) {
    text = clip(stdout.trim());
  } else {
    text = clip(stdout.trim());
  }

  // Evidence: a sanitized trail only. The registry file, provider credentials,
  // and message bodies never touch the store.
  try {
    const summary = `mailgen ${params.action} ok provider=${params.provider ?? "default"}${
      params.action === "wait" ? ` address=${params.address}` : ""
    }`;
    if (!containsSecretLike(summary)) {
      openEvidence().addEvidence({ kind: "mailgen", refs: [params.action], text: summary, sensitivity: "internal" });
    }
  } catch { /* evidence is an audit trail, never the point of failure */ }

  const safeArgv = [...command.base, ...argv];
  return { text, argv: safeArgv };
}

const mailgenTool: ToolDefinition<typeof parameters> = {
  name: "mailgen",
  label: "mailgen",
  description:
    "Disposable inbox via the cowbird CLI for signup/verification flows. " +
    "Actions: new (acquire an address), wait (long-poll the first mail; optional otp), providers (health matrix), canary (live probe all providers). " +
    "Use in authorized engagements only.",
  promptSnippet:
    "Use mailgen for disposable signup emails: new gives a deliverable address, wait long-polls for the verification mail (or --otp for the code).",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
  async execute(
    _toolCallId: string,
    params: MailgenParams,
    signal: AbortSignal | undefined,
    _onUpdate,
    _ctx
  ): Promise<AgentToolResult> {
    requireFields(params);
    const { text, argv } = await runMailgen(params, signal);
    const details = { action: params.action, argv };
    return { content: [{ type: "text", text }], details };
  },
};

export function registerMailgenTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(mailgenTool);
}

