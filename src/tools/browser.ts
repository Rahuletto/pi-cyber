import type { AgentToolResult, ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { randomBytes } from "node:crypto";
import { openEvidence, type SessionRow } from "../evidence/db.ts";
import { binReadiness } from "./adapter-tools.ts";

/**
 * `cyber_browser` — the Obscura browser LEASE lane.
 *
 * The tool does not drive a browser. It books the single-owner slot that one
 * live browser session may occupy, records that booking in the durable
 * evidence store, and hands the release back when the operator is done. The
 * actual page work happens in the Obscura MCP server (operator-registered);
 * this lane only decides WHO may hold it.
 *
 * Actions:
 * - acquire { mode, purpose } — take the exclusive lease.
 * - release { sessionId }      — give the lease back.
 * - status                     — who holds the lease right now.
 *
 * Lease discipline (docs/REA-LIGHT.md, docs/research/BROWSER-REA-TOOLS.md):
 * - Acquiring NEVER downloads a browser and NEVER launches one. Nothing in
 *   this file spawns a process. A second browser is never fetched silently;
 *   a missing browser is an operator decision (operator runs tools/install.sh).
 * - mode "read" is PASSIVE observation: it books the lease and nothing else.
 *   It performs no readiness probe, so it never turns into a launch.
 * - mode "act" means "this lease will drive the browser", so the Obscura bin
 *   must be usable before the lease is taken: the operator's state file must
 *   record the bin (installed | validated) AND the binary must resolve on
 *   disk. Otherwise the tool fails fast with the same typed readiness message
 *   the adapter tools use — `bin not available: obscura — run
 *   tools/install.sh (state: cataloged)` — instead of a confusing spawn
 *   error later.
 * - One owner per live session (REA-LIGHT "Boundaries"). The tool enforces
 *   it itself: the store has NO partial unique constraint (the schema is
 *   never rewritten), so the tool reads the active leases BEFORE it acquires
 *   and refuses with a typed conflict naming the current owner and purpose.
 *   That check-then-act pair is sound because the tool declares
 *   executionMode "sequential": Pi never runs two of these calls at once, so
 *   no second acquire can slip between the read and the write. The store's
 *   own per-sessionId check stays as a second line of defence, and the
 *   cross-process case (a second Pi process on the same engagement file) is
 *   documented as best-effort, not a hard mutex.
 * - Export before close: `close_binary` clears the retained Evidence ledger
 *   of that connection, and an exported bundle is the only durable copy
 *   afterwards. The release text repeats that rule.
 * - `-stealth` is never used by this lane: stealth deliberately changes
 *   fingerprint/tracker behavior, so it must not appear in browser-security
 *   conformance evidence. Likewise, private/loopback destinations are only
 *   in scope for owned fixtures.
 *
 * The lease is advisory bookkeeping, not a sandbox: it records an intent
 * ("one owner at a time") in the engagement's evidence file so two
 * specialists cannot silently share a mutable browser state.
 */

/** Closed purpose enum — why the browser lane is in use. */
export const BROWSER_PURPOSES = ["recon", "capture", "reproduction", "validation", "remediation-check"] as const;
export type BrowserPurpose = (typeof BROWSER_PURPOSES)[number];

/** Lease modes: "read" is passive observation, "act" drives the browser. */
export const BROWSER_MODES = ["read", "act"] as const;
export type BrowserMode = (typeof BROWSER_MODES)[number];

/** The browser binary this lane leases. */
export const BROWSER_BIN = "obscura";

/** Typed error codes — the model can branch on `error.code`, not on prose. */
export type BrowserErrorCode = "lease-conflict" | "validation-error" | "bin-not-available";

/** Every failure this tool raises on purpose carries a stable code. */
export class BrowserLeaseError extends Error {
  readonly code: BrowserErrorCode;
  constructor(code: BrowserErrorCode, message: string) {
    super(message);
    this.name = "BrowserLeaseError";
    this.code = code;
  }
}

/** The export-before-close rule, repeated on every release (REA-LIGHT). */
export const EXPORT_BEFORE_CLOSE_REMINDER =
  "export the Evidence bundle (export_evidence_bundle) before close_binary — closing clears that connection's retained Evidence ledger, and an exported bundle is the only durable copy afterwards.";

const MAX_OUTPUT_CHARS = 16 * 1024;
const MAX_LEASES = 50;
const TRUNCATED = "[truncated]";

/** Clip a result to the output budget, never splitting a surrogate pair. */
export function clipOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  let cut = text.slice(0, MAX_OUTPUT_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED;
}

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("acquire"),
    Type.Literal("release"),
    Type.Literal("status"),
  ], { description: "Lease interaction to perform: acquire, release, status." }),
  mode: Type.Optional(Type.Union([
    Type.Literal("read"),
    Type.Literal("act"),
  ], { description: "Lease mode (acquire, required): read = passive observation (no launch), act = this lease will drive the browser (needs an installed obscura). " })),
  purpose: Type.Optional(Type.Union(BROWSER_PURPOSES.map((purpose) => Type.Literal(purpose)), {
    description: "Closed purpose enum (acquire, required): recon, capture, reproduction, validation, remediation-check.",
  })),
  sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 500, description: "Lease session id returned by acquire (release, required)." })),
}, { additionalProperties: false });

type BrowserParams = Static<typeof parameters>;

/** Fresh lease id: timestamp + random suffix, safe for the store's id checks. */
export function newSessionId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `bs-${stamp}-${randomBytes(4).toString("hex")}`;
}

function readSessionId(ctx?: Partial<ExtensionToolContext>): string | undefined {
  try {
    const manager = ctx?.sessionManager as { getSessionId?: () => string | undefined } | undefined;
    const id = manager?.getSessionId?.();
    return typeof id === "string" && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The lease owner: the Pi session that holds it. Never model-supplied — the
 * model cannot claim to be another owner, and two sessions are two owners.
 */
export function deriveOwner(ctx?: Partial<ExtensionToolContext>): string {
  const sessionId = readSessionId(ctx);
  if (sessionId) return `pi-session:${sessionId}`;
  const engagement = process.env.CYBER_ENGAGEMENT_ID?.trim();
  if (engagement) return `engagement:${engagement}`;
  return "agent:unknown";
}

function assertMode(value: unknown): BrowserMode {
  if (typeof value !== "string" || !(BROWSER_MODES as readonly string[]).includes(value)) {
    throw new BrowserLeaseError("validation-error", `mode must be one of: ${BROWSER_MODES.join(", ")} (acquire).`);
  }
  return value as BrowserMode;
}

function assertPurpose(value: unknown): BrowserPurpose {
  if (typeof value !== "string" || !(BROWSER_PURPOSES as readonly string[]).includes(value)) {
    throw new BrowserLeaseError("validation-error", `purpose must be one of: ${BROWSER_PURPOSES.join(", ")} (acquire).`);
  }
  return value as BrowserPurpose;
}

function assertSessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BrowserLeaseError("validation-error", "sessionId required for the release action (use the id returned by acquire).");
  }
  return value.trim();
}

/**
 * Readiness gate for an interactive lease. The bin must be recorded by the
 * operator's state file (installed | validated) AND resolvable on disk; a
 * catalog-only entry is not a provisioned browser, and a missing binary is
 * never downloaded here — the operator installs it.
 */
export async function assertBrowserReady(): Promise<void> {
  const readiness = await binReadiness(BROWSER_BIN);
  if (readiness.ready && readiness.recorded) return;
  const state = readiness.recorded ?? "cataloged";
  throw new BrowserLeaseError("bin-not-available", `bin not available: ${BROWSER_BIN} — run tools/install.sh (state: ${state})`);
}

function renderLease(row: SessionRow): string {
  return `lease ${row.sessionId} · owner ${row.owner} · mode ${row.mode} · purpose ${row.purpose} · acquired ${row.acquiredAt}`;
}

const browserTool: ToolDefinition<typeof parameters> = {
  name: "cyber_browser",
  label: "Cyber browser lease",
  description:
    "Exclusive browser lease lane (Obscura) for the engagement. " +
    "Actions: acquire (book the single-owner slot: mode read = passive observation, mode act = this lease will drive the browser), " +
    "release (hand the lease back; nothing is launched or downloaded by this tool), status (who holds the lease). " +
    "One owner at a time: a second acquire is refused with a typed conflict naming the current owner. " +
    "Export the Evidence bundle before close_binary — closing clears the retained ledger.",
  promptSnippet:
    "Use cyber_browser to take and hand back the exclusive browser lease; acquiring reserves the slot only — " +
    "it never downloads or launches a browser, and mode act needs an installed obscura.",
  parameters,
  executionMode: "sequential",
  annotations: { readOnlyHint: false, openWorldHint: false },
  async execute(
    _toolCallId: string,
    params: BrowserParams,
    _signal: AbortSignal | undefined,
    _onUpdate,
    ctx: ExtensionToolContext,
  ): Promise<AgentToolResult> {
    if (params.action === "acquire") {
      const mode = assertMode(params.mode);
      const purpose = assertPurpose(params.purpose);
      // Interactive leases need a usable browser; passive ones never probe.
      if (mode === "act") await assertBrowserReady();

      const owner = deriveOwner(ctx);
      const sessionId = newSessionId();
      const store = openEvidence();
      try {
        // Tool-level single-owner enforcement: the store has no partial unique
        // constraint, so the active lease is read BEFORE the write. Sequential
        // execution mode makes this check-then-act pair safe inside one Pi
        // process (no second acquire can interleave).
        const active = store.listSessions({ activeOnly: true, limit: 1 });
        if (active.length > 0) {
          const held = active[0];
          throw new BrowserLeaseError(
            "lease-conflict",
            `browser lease conflict: session ${held.sessionId} is already held by owner ${held.owner} (purpose: ${held.purpose}); release it with cyber_browser release before acquiring another lease.`,
          );
        }
        try {
          store.addSession({ sessionId, owner, mode, purpose });
        } catch (error) {
          // Second line of defence: the store refuses a duplicate sessionId.
          throw new BrowserLeaseError(
            "lease-conflict",
            error instanceof Error ? error.message : `could not acquire the browser lease for session ${sessionId}.`,
          );
        }
        const row = store.listSessions({ limit: MAX_LEASES }).find((entry) => entry.sessionId === sessionId);
        const acquiredAt = row?.acquiredAt ?? new Date().toISOString();
        const text = [
          `lease acquired · session ${sessionId} · owner ${owner} · mode ${mode} · purpose ${purpose} · acquiredAt ${acquiredAt}`,
          "lease only: nothing was downloaded, launched or attached — the slot is reserved for one owner.",
        ].join("\n");
        return {
          content: [{ type: "text", text: clipOutput(text) }],
          details: { action: "acquire", sessionId, owner, mode, purpose, acquiredAt, path: store.path },
        };
      } finally {
        store.close();
      }
    }

    if (params.action === "release") {
      const sessionId = assertSessionId(params.sessionId);
      const store = openEvidence();
      try {
        const held = store.listSessions({ activeOnly: true, limit: MAX_LEASES }).find((row) => row.sessionId === sessionId);
        if (!held) {
          // Idempotent no-op: releasing an unknown session is not an error.
          const text = `no active lease for session ${sessionId} — nothing to release.\n${EXPORT_BEFORE_CLOSE_REMINDER}`;
          return {
            content: [{ type: "text", text: clipOutput(text) }],
            details: { action: "release", sessionId, released: false, path: store.path },
          };
        }
        store.releaseSession(sessionId);
        const text = [
          `lease released · session ${sessionId} · owner ${held.owner} · purpose ${held.purpose}`,
          EXPORT_BEFORE_CLOSE_REMINDER,
        ].join("\n");
        return {
          content: [{ type: "text", text: clipOutput(text) }],
          details: { action: "release", sessionId, released: true, owner: held.owner, purpose: held.purpose, path: store.path },
        };
      } finally {
        store.close();
      }
    }

    const store = openEvidence();
    try {
      const active = store.listSessions({ activeOnly: true, limit: MAX_LEASES });
      if (active.length === 0) {
        return {
          content: [{ type: "text", text: "no active lease" }],
          details: { action: "status", active: 0, path: store.path },
        };
      }
      const text = active.map(renderLease).join("\n");
      return {
        content: [{ type: "text", text: clipOutput(text) }],
        details: { action: "status", active: active.length, path: store.path },
      };
    } finally {
      store.close();
    }
  },
};

export function registerBrowserTool(pi: Pick<ExtensionAPI, "registerTool">): void {
  pi.registerTool(browserTool);
}
