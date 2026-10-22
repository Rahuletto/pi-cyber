import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accessSync, constants, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { openEvidence } from "../evidence/db.ts";
import { containsSecretLike } from "../evidence/secrets.ts";
import { queryCowbirdInbox } from "./mail-inbox.ts";

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
 *
 * Full-body retrieval: the cowbird CLI prints only sender+subject (`wait` has
 * no body flag), so after a successful wait the tool replays the stored state
 * through an inline Python snippet run on the cowbird tool's own interpreter
 * (`uv` tool env), using the same `Inbox(provider, Address(...))` path the CLI
 * itself uses, and fetches the newest message's text/links/html metadata. The
 * snippet receives the state in an argv slot only and never prints it.
 */

const MAILGEN_TIMEOUT_MS = 190_000; /* wait often long-polls for a message */
const MAX_OUTPUT_CHARS = 16_000;
const TRUNCATED = "[truncated]";
const MAX_LINKS = 8;

/** URLs that look like signup confirmation targets get promoted over nav links. */
const VERIFICATION_LINK_HINT = /(verif|confirm|activat|welcome|signup|sign-up|register|token|magic|invite|validate|onboard|continue|reset)/i;

/** Deliverability guidance shared by the tool description, prompt, and timeout text. */
const DELIVERABILITY_HINT =
  "providers list marks deliverability; many targets block disposable domains (mail.tm-style) — " +
  "prefer a mainstream-domain provider (gmail-alias) or a fresh alias when nothing arrives";

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

/**
 * A cowbird crash (an unhandled Python traceback) is folded into ONE line:
 * the actual exception (last stderr line) plus the first `cowbird_*` frame in
 * site-packages, so the model sees a hint at the failing package instead of a
 * wall of Python. Never dumps the full traceback and never retries.
 */
function summarizeCowbirdCrash(args: string[], stderr: string): string {
  const lines = stderr.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const exception = (lines[lines.length - 1] || "unknown exception").slice(0, 160);
  let frame = "";
  for (const line of lines) {
    const match = line.match(/site-packages[/\\](cowbird(?:_[a-z0-9_]+)?[/\\][^"]+?\.py)/i);
    if (!match) continue;
    const lineNo = line.match(/line (\d+)/);
    frame = `${match[1].replace(/\\/g, "/")}${lineNo ? `:${lineNo[1]}` : ""}`;
    break;
  }
  return `cowbird provider crashed during '${args[0] ?? "run"}': ${exception}${frame ? ` [near ${frame}]` : ""}`.slice(0, 400);
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
    const err = error as NodeJS.ErrnoException & { code?: string | number; stderr?: string | Buffer; stdout?: string; status?: null | number };
    if (err.code === "ENOENT") throw new Error("cowbird CLI not available — install cowbird or set CYBER_COWBIRD_BIN");
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    const stdout = typeof err.stdout === "string" ? err.stdout : "";
    // Non-zero exits arrive as a numeric `code` in this runtime (status stays
    // null/undefined); take that number before falling back to the status field.
    const status = typeof err.status === "number" ? err.status : typeof err.code === "number" ? err.code : undefined;
    const detail = (stderr.trim().split("\n")[0] || `exit ${status ?? "?"}`).slice(0, 500);
    const exit: { stdout: string; code: number } = { stdout, code: status ?? 1 };
    // `cowbird wait` prints `timeout: ...` to stderr and exits 2; `error: ...` exits 1.
    // Both are expected control flow, not crashes: surface them as normal results.
    if ((exit.code === 1 && /^error:/i.test(stderr.trim())) || exit.code === 2) {
      return { stdout: `${stdout}${stdout && stderr ? "\n" : ""}${stderr.trim()}`, code: exit.code };
    }
    // An unhandled Python traceback is cowbird crashing, not a designed error:
    // surface the exception line + first cowbird_* frame instead of the raw dump.
    if (stderr.includes("Traceback (most recent call last)")) {
      throw new Error(summarizeCowbirdCrash(args, stderr));
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

export interface WaitSummary {
  sender: string | null;
  subject: string | null;
  links: string[];
}

/**
 * Read a `cowbird wait` listing: sender + subject (TSV header line or labeled
 * fields) plus every URL in the body, deduped and verification-first ordered.
 */
export function parseWaitOutput(raw: string): WaitSummary {
  const lines = raw.trim().split("\n");
  let sender: string | null = null;
  let subject: string | null = null;
  const first = lines[0] ?? "";
  const tabbed = first.split("\t");
  if (tabbed.length >= 2 && tabbed[0].includes("@")) {
    sender = tabbed[0].trim();
    subject = tabbed[1].trim() || null;
  } else {
    for (const line of lines) {
      if (!sender) {
        const from = line.match(/^(?:from|sender)\s*[:=]\s*(.+)$/i);
        if (from) sender = from[1].trim();
      }
      if (!subject) {
        const subj = line.match(/^subject\s*[:=]\s*(.+)$/i);
        if (subj) subject = subj[1].trim();
      }
      if (sender && subject) break;
    }
  }
  const urls = extractTextLinks(raw);
  urls.sort((a, b) => Number(VERIFICATION_LINK_HINT.test(b)) - Number(VERIFICATION_LINK_HINT.test(a)));
  return { sender, subject, links: urls };
}

/** Explicit, honest wording for a wait that saw nothing — never the raw "timeout:" fragment. */
function waitTimeoutNotice(secondsSeen: number, requestedSec: number): string {
  const retry = Math.min(Math.max(requestedSec, 45) * 2, 180);
  return [
    `wait: no message within ${secondsSeen}s (mailbox reported no new mail).`,
    `No verification mail arrived at this address: ${DELIVERABILITY_HINT}.`,
    `Next step: re-trigger the mail from the target, then re-run wait with a longer timeoutSec (e.g. ${retry}s).`,
  ].join("\n");
}

/**
 * Fold one `cowbird wait` result into the tool text: sender + subject + the
 * extracted links (verification-style first, max 8) with the raw output kept
 * verbatim after the normalized header. Timeouts and empty results become
 * explicit notices; expected `error:`/exit-2 control flow passes through.
 */
export function formatWaitResult(
  raw: string,
  params: MailgenParams,
  code: number,
  body: MailBody | null = null,
  bodyNote: string | null = null,
): string {
  const trimmed = raw.trim();
  const requestedSec = Math.min(params.timeoutSec ?? 120, 180);
  if (code === 2 || /^timeout:/i.test(trimmed)) {
    const seen = trimmed.match(/(\d+)\s*s/i);
    return waitTimeoutNotice(seen ? Number(seen[1]) : requestedSec, requestedSec);
  }
  if (!trimmed) {
    return `wait: cowbird returned no content (exit ${code}) — re-run with a longer timeoutSec or check the \`canary\` matrix.`;
  }
  const summary = parseWaitOutput(trimmed);
  if (params.otp && summary.links.length === 0 && trimmed.split("\n").length === 1) {
    return `code: ${trimmed}`;
  }
  const links = body ? mergeBodyLinks(body) : summary.links;
  const shown = links.slice(0, MAX_LINKS);
  const lines: string[] = [
    `sender: ${summary.sender ?? (body?.sender || "unknown")}`,
    `subject: ${summary.subject ?? (body?.subject || "none")}`,
  ];
  if (body && body.messages > 0) {
    if (body.text) {
      lines.push(`body (text${body.textTruncated ? ", truncated" : ""}):`);
      for (const line of body.text.split("\n").slice(0, MAX_BODY_LINES)) lines.push(`  ${line}`);
    } else {
      lines.push("body: empty text");
    }
    if (body.htmlChars > 0) lines.push(`html: ${body.htmlChars} chars (not shown)`);
  } else if (bodyNote) {
    lines.push(`body: unavailable (${bodyNote})`);
  }
  if (shown.length > 0) {
    const total = links.length;
    lines.push(`links (${shown.length}${shown.length < total ? ` of ${total}` : ""}):`);
    for (const link of shown) lines.push(`  ${link}`);
  } else {
    lines.push("no links found in body");
  }
  // With a fetched body, the body supersedes the CLI's two-line raw stdout.
  if (!body) {
    lines.push("--- cowbird output ---");
    lines.push(trimmed);
  }
  return lines.join("\n");
}

const MAX_BODY_LINES = 60;

export interface MailBody {
  messages: number;
  sender: string;
  subject: string;
  text: string;
  textTruncated: boolean;
  links: string[];
  htmlChars: number;
}

/**
 * Parse the body-fetch snippet's JSON envelope. Only content fields are
 * accepted; the state blob can never appear here because the snippet never
 * emits it.
 */
export function parseBodyJson(stdout: string): MailBody | null {
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
  if (typeof obj.messages !== "number" || obj.messages < 1) return null;
  return {
    messages: obj.messages,
    sender: typeof obj.sender === "string" ? obj.sender : "",
    subject: typeof obj.subject === "string" ? obj.subject : "",
    text: typeof obj.text === "string" ? obj.text : "",
    textTruncated: obj.text_truncated === true,
    links: Array.isArray(obj.links) ? obj.links.filter((link): link is string => typeof link === "string") : [],
    htmlChars: typeof obj.html_chars === "number" ? obj.html_chars : 0,
  };
}

/** URLs harvested from a message body: deduped, trailing punctuation stripped. */
export function extractTextLinks(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"'`)\]},]+/g) ?? []).map((url) => url.replace(/[.,;:!?]+$/, "")))];
}

/**
 * Links for a fetched body: the provider's own anchor list first, then any
 * bare URLs visible in the text, deduped and verification-first ordered
 * (the same ordering rule parseWaitOutput applies to raw output).
 */
function mergeBodyLinks(body: MailBody): string[] {
  const merged = [...new Set([...body.links, ...extractTextLinks(body.text)])];
  merged.sort((a, b) => Number(VERIFICATION_LINK_HINT.test(b)) - Number(VERIFICATION_LINK_HINT.test(a)));
  return merged;
}

/**
 * Locate a Python interpreter that has the cowbird package importable: an
 * explicit CYBER_COWBIRD_PYTHON override, or the cowbird shim's own shebang
 * (only when it names a python interpreter — a plain `#!/bin/sh` shim must
 * not be handed a Python program), falling back to the standard uv tool env
 * path. Returns null when nothing matches and the body stage is skipped.
 */
export function resolveCowbirdPython(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.CYBER_COWBIRD_PYTHON?.trim();
  if (override) return override;
  const command = resolveCowbirdCommand(env);
  if (command) {
    try {
      const firstLine = readFileSync(command.bin, "utf-8").split("\n", 1)[0] ?? "";
      const shebang = /^#!\s*(\S+)/.exec(firstLine);
      if (shebang && /python(?:[0-9.]+)?$/.test(shebang[1]) && existsSync(shebang[1])) return shebang[1];
    } catch { /* fall through to the uv tool env path */ }
  }
  const uvPython = join(homedir(), ".local", "share", "uv", "tools", "cowbird", "bin", "python");
  return existsSync(uvPython) ? uvPython : null;
}

/**
 * The inline body-fetch snippet. Runs as `python -c <script> provider address
 * state timeout` — so sys.argv[1..4]. Mirrors the CLI's `_wait` replay path
 * (default_pool().registry.get + Inbox(Address(..., state=state))) and then
 * fetches the newest message with full text/links/html. Exit codes match the
 * CLI's contract the runner already handles: 0 ok, 1 error:, 2 timeout/empty.
 */
const COWBIRD_BODY_SCRIPT = String.raw`
import asyncio, contextlib, json, re, sys

from cowbird.errors import CowbirdError
from cowbird.health import HealthStore, default_health_path
from cowbird.inbox import Inbox, aclose_default_pool, default_pool
from cowbird.models import Address

MAX_BODY = 4000
MAX_LINKS = 16

async def _fetch(provider_name, address, state):
    pool = default_pool()
    with contextlib.suppress(Exception):
        pool.health.seed(HealthStore.load(default_health_path()))
    provider = pool.registry.get(provider_name)
    box = Inbox(provider, Address(address, provider_name, state=state))
    try:
        rows = await box.messages()
        if not rows:
            return {"messages": 0}
        newest = max(rows, key=lambda r: r.received_at.timestamp() if r.received_at else 0.0)
        msg = await box.get(newest.id)
        html = msg.html or ""
        text = (msg.text or "").strip()
        if not text:
            text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).strip()
        return {
            "messages": len(rows),
            "sender": msg.sender,
            "subject": msg.subject,
            "text": text[:MAX_BODY],
            "text_truncated": len(text) > MAX_BODY,
            "links": list(msg.links or [])[:MAX_LINKS],
            "html_chars": len(html),
        }
    finally:
        await aclose_default_pool()

async def _main() -> int:
    if len(sys.argv) < 4:
        print("error: body fetch expected provider, address, state, timeout argv", file=sys.stderr)
        return 1
    provider_name, address, state = sys.argv[1], sys.argv[2], (sys.argv[3] or None)
    try:
        timeout = max(float(sys.argv[4]), 15.0) if len(sys.argv) > 4 else 60.0
    except ValueError:
        timeout = 60.0
    try:
        payload = await asyncio.wait_for(_fetch(provider_name, address, state), timeout)
        print(json.dumps(payload))
        return 0 if payload["messages"] else 2
    except asyncio.TimeoutError:
        print("timeout: body fetch exceeded %ss" % timeout, file=sys.stderr)
        return 2
    except CowbirdError as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 1
    except Exception as exc:
        print("error: %s: %s" % (type(exc).__name__, exc), file=sys.stderr)
        return 1

raise SystemExit(asyncio.run(_main()))
`;

const BODY_FETCH_TIMEOUT_MS = 90_000;

export interface BodyFetchOutcome {
  body: MailBody | null;
  note: string | null;
}

/**
 * Fetch the full message body for a waited-for address by replaying the
 * stored state through the inline snippet. Degrades to an honest note on any
 * failure — the wait result itself is never lost. The state value stays in
 * its argv slot and is never printed or persisted anywhere new.
 */
export async function runBodyFetch(params: MailgenParams, signal: AbortSignal | undefined): Promise<BodyFetchOutcome> {
  const pythonBin = resolveCowbirdPython();
  if (!pythonBin) return { body: null, note: null };
  const registry = readRegistry();
  const state = registry[params.address!]?.state ?? "";
  try {
    const { stdout } = (await execFileAsync(pythonBin, ["-c", COWBIRD_BODY_SCRIPT, params.provider!, params.address!, state, "60"], {
      encoding: "utf-8",
      timeout: BODY_FETCH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      signal,
    })) as unknown as { stdout: string };
    const body = parseBodyJson(stdout);
    if (body) return { body, note: null };
    const trimmed = stdout.trim();
    return { body: null, note: trimmed ? trimmed.slice(0, 200) : "cowbird body fetch returned no content" };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: string | number; stderr?: string | Buffer };
    if (err.code === "ENOENT") return { body: null, note: "cowbird python env not available for body fetch" };
    const stderr = typeof err.stderr === "string" ? err.stderr : "";
    // exit 2 = the mailbox listed empty; nothing to add, no note needed.
    if (typeof err.code === "number" && err.code === 2) return { body: null, note: null };
    if (stderr.includes("Traceback (most recent call last)")) {
      return { body: null, note: `crashed: ${summarizeCowbirdCrash(["body"], stderr)}` };
    }
    const detail = stderr.trim().split("\n")[0]?.slice(0, 200) || "unknown failure";
    return { body: null, note: detail };
  }
}

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("new"),
    Type.Literal("wait"),
    Type.Literal("list"),
    Type.Literal("read"),
    Type.Literal("providers"),
    Type.Literal("canary"),
  ], { description: "Inbox interaction: new (acquire address), wait (long-poll first mail / OTP — if the mail ALREADY arrived it returns immediately with the full body: it doubles as read-now), providers (health matrix), canary (live probe all providers)." }),
  address: Type.Optional(Type.String({ description: "Inbox address (wait only). Does NOT have to be one mailgen created: for stateless providers (e.g. emailnator) wait reads any address without prior state." })),
  messageId: Type.Optional(Type.String({ maxLength: 512, description: "read: provider-issued message ID returned by list." })),
  sender: Type.Optional(Type.String({ maxLength: 254, description: "list/read/wait: case-insensitive sender substring filter." })),
  subject: Type.Optional(Type.String({ maxLength: 512, description: "list/read/wait: case-insensitive subject substring filter." })),
  receivedAfter: Type.Optional(Type.String({ maxLength: 40, description: "list/wait: ISO timestamp; only newer messages match." })),
  cursor: Type.Optional(Type.String({ maxLength: 2048, description: "list: opaque continuation cursor bound to this inbox." })),
  afterMessageId: Type.Optional(Type.String({ maxLength: 512, description: "wait: match only messages received after this known message ID." })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, default: 20, description: "list: maximum returned messages (default 20)." })),
  provider: Type.Optional(Type.String({ description: "Provider name. new: require it. wait: required — must be the provider that issued the address. Polling a provider's mailbox is ALWAYS done through wait; never hand-call the provider's own web API." })),
  otp: Type.Optional(Type.Boolean({ description: "wait: return the numeric/alphanumeric OTP code instead of sender+subject." })),
  includeBody: Type.Optional(Type.Boolean({ default: true, description: "wait: also fetch the full message body (text + all links + html size) after the mail arrives, by replaying the stored state through the cowbird python env." })),
  timeoutSec: Type.Optional(Type.Number({ minimum: 1, maximum: 180, default: 120, description: "wait: how long to long-poll (default 120)." })),
}, { additionalProperties: false });

type MailgenParams = Static<typeof parameters>;

function requireFields(params: MailgenParams): void {
  if (params.action === "wait" && !params.address) throw new Error("address required for the wait action.");
  if ((params.action === "list" || params.action === "read") && !params.address) throw new Error(`address required for the ${params.action} action.`);
  if (params.action === "wait" && !params.provider) throw new Error("provider required for the wait action.");
  if ((params.action === "list" || params.action === "read") && !params.provider) throw new Error(`provider required for the ${params.action} action.`);
  if (params.action === "read" && !params.messageId) throw new Error("messageId required for read.");
  if (params.action === "read" && (params.sender || params.subject || params.receivedAfter || params.cursor)) throw new Error("read accepts only messageId, address, and provider.");
  if (params.action === "wait" && params.cursor) throw new Error("cursor is for list pagination; use afterMessageId for a newer-message wait.");
  if (params.action !== "wait" && params.afterMessageId) throw new Error("afterMessageId applies to wait only.");
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
    case "list":
    case "read":
      throw new Error(`${params.action} uses the cowbird Inbox API, not CLI arguments.`);
  }
}

export async function runMailgen(params: MailgenParams, signal: AbortSignal | undefined): Promise<{ text: string; argv: string[] }> {
  if (params.action === "list" || params.action === "read" || (params.action === "wait" && (params.sender || params.subject || params.receivedAfter || params.afterMessageId))) {
    const action = params.action === "wait" ? "wait" : params.action;
    const raw = await queryCowbirdInbox({ action, address: params.address!, provider: params.provider!, messageId: params.messageId, sender: params.sender, subject: params.subject, receivedAfter: params.receivedAfter, cursor: params.cursor, afterMessageId: params.afterMessageId, limit: params.limit, timeoutSec: params.action === "wait" ? Math.min(params.timeoutSec ?? 120, 180) : 0 }, signal);
    let text = raw;
    if (params.action === "wait") {
      const parsed = JSON.parse(raw) as { id?: unknown; messages?: unknown[]; text?: string };
      const matched = typeof parsed.id === "string" || Boolean(parsed.messages?.length);
      if (!matched) text = waitTimeoutNotice(params.timeoutSec ?? 120, params.timeoutSec ?? 120);
      else if (params.otp) {
        const code = parsed.text?.match(/\b\d{4,8}\b/)?.[0] ?? parsed.text?.match(/(?:code|otp|verification)[^\w]{0,16}([A-Z0-9]{4,10})/i)?.[1];
        text = code ? `code: ${code}` : "matching message arrived, but no code was found in its text";
      }
    }
    return { text: clip(text), argv: ["Inbox.messages/get", action] };
  }
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
  } else if (params.action === "wait") {
    // Waited-for mail is the actionable payload: normalized sender/subject/
    // links plus the fetched body, an explicit no-message notice, or the
    // provider's error verbatim. The body fetch is a second replay of the
    // stored state (argv-only) and degrades to a note, never to tool failure.
    let body: MailBody | null = null;
    let bodyNote: string | null = null;
    if (!params.otp && code === 0 && (params.includeBody ?? true)) {
      const outcome = await runBodyFetch(params, signal);
      body = outcome.body;
      bodyNote = outcome.note;
    }
    text = clip(formatWaitResult(stdout, params, code, body, bodyNote));
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

export const mailgenTool: ToolDefinition<typeof parameters> = {
  name: "mailgen",
  label: "mailgen",
  description:
    "Disposable inbox via the cowbird CLI for signup/verification flows. " +
    "Actions: new (acquire an address), list (bounded provider message IDs with filters/cursor), read (read-now by listed message ID), wait (long-poll; optional sender/subject/time filters prevent unrelated old mail from matching), providers (health matrix), canary (live probe all providers). Some providers do not support list/get and return an explicit capability error. " +
    "Never hand-call a cowbird provider's own API (e.g. emailnator.com/api/message-list via bypass_fetch) to poll a mailbox — wait does that in-band with the provider's exact headers, and a raw call just burns an out-of-scope override. " +
    "providers list marks deliverability; many targets block disposable domains (mail.tm-style) — prefer a mainstream-domain provider (gmail-alias) or a fresh alias when nothing arrives. " +
    "Use in authorized engagements only.",
  promptSnippet:
    "Use mailgen for disposable signup emails: new gives an address; list/read expose provider message IDs when supported; wait can filter by sender, subject, and receivedAfter. " +
    "wait doubles as a read-now (it returns immediately with the full body for mail that already arrived) and accepts any address for a stateless provider — poll mailboxes only through wait, never hand-call a provider's own API. " +
    "providers list marks deliverability; many targets block disposable domains (mail.tm-style) — prefer a mainstream-domain provider (gmail-alias) or a fresh alias when nothing arrives.",
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

