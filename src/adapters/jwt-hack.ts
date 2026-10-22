/**
 * jwt-hack — offline JWT security toolkit (hahwul/jwt-hack, MIT, single Rust
 * binary). Commands map to the toolkit's own CLI surface:
 *
 *   decode  — header/payload/claims + exp status (the "read the token" step
 *             before any tampering claim; verified:false hypotheses start here)
 *   scan    — signature/claims weakness sweep (the kit's verdict list)
 *   payload — typed attack-carrier generation (none/alg-confusion variants,
 *             jku/x5u, kid traversal, psychic CVE-2022-21449, jwk embed, …):
 *             carriers only, nothing is ever sent — replay goes through
 *             bypass_fetch on the lane that found the token
 *   verify  — signature check against an operator-supplied HMAC secret
 *   crack   — dict/brute secret recovery for HS256/384/512 tokens
 *
 * Discipline: everything is OFFLINE token math. The runner's argv secret gate
 * (assertArgvSecretFree) still sees every model-supplied argv element; actor
 * tokens and recovered secrets flow back through the standard row pipeline
 * (raw clipped at 4000 chars, evidence row withheld when secret-like, the
 * same rule as every other adapter). `--json` output is machine-pure on
 * stdout (progress chatter lives on stderr); with `--report` unused, nothing
 * touches the target — mutating:false by design.
 */
import { Type, type Static } from "typebox";
import type { AdapterDef, Normalized, ToolParams } from "./types.ts";
import { clipRaw, jsonDocument, modelString, requireModelString } from "./util.ts";

type JwtHackParams = Static<typeof jwtHackSchema>;

const MODES = ["decode", "payload", "scan", "verify", "crack"] as const;
const CRACK_MODES = ["dict", "brute"] as const;
const CRACK_PRESETS = ["az", "AZ", "aZ", "19", "aZ19", "ascii"] as const;
const JWK_PROTOCOLS = ["http", "https"] as const;

/** jwt-hack ships enough flags that the model never needs an `extra` slot. */

const jwtHackSchema = Type.Object({
  mode: Type.Union(MODES.map((mode) => Type.Literal(mode)), {
    description: "decode: header+claims+exp status. scan: weakness sweep with a severity summary. payload: generate typed attack carriers (offline). verify: signature check (HS needs secret). crack: dict/brute HMAC secret recovery.",
  }),
  token: Type.String({ minLength: 8, maxLength: 8192, description: "The actor JWT/JWE under test ( paste verbatim; it stays in argv only and is never logged again)." }),
  target: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 32 }), { maxItems: 30, description: "payload only: carrier styles, comma-joined (e.g. ['none','alg_confusion']). Unknown names surface the toolkit's own closed-list error; 'all' boxes every style." })),
  jwkAttack: Type.Optional(Type.String({ maxLength: 253, description: "payload only: attack domain for the jku/x5u carriers (e.g. attacker.example.com)." })),
  jwkTrust: Type.Optional(Type.String({ maxLength: 253, description: "payload only: trusted domain the target already accepts for jku/x5u." })),
  jwkProtocol: Type.Optional(Type.Union(JWK_PROTOCOLS.map((p) => Type.Literal(p)), { description: "payload only: protocol of the injected jku/x5u URL (default https)." })),
  secret: Type.Optional(Type.String({ maxLength: 512, description: "verify only: HMAC secret to check the signature against (HS256/384/512). Passed as argv; keep it in the call, never in prose." })),
  validateExp: Type.Optional(Type.Boolean({ description: "verify only: also validate the exp claim, not just the signature." })),
  crackMode: Type.Optional(Type.Union(CRACK_MODES.map((m) => Type.Literal(m)), { description: "crack only: dict (wordlist) or brute (charset) recovery." })),
  wordlist: Type.Optional(Type.String({ maxLength: 512, description: "crack/dict only: wordlist file path. Absent → the toolkit's built-in default dictionary." })),
  crackChars: Type.Optional(Type.String({ maxLength: 256, description: "crack/brute only: character set to compose candidates from." })),
  crackPreset: Type.Optional(Type.Union(CRACK_PRESETS.map((p) => Type.Literal(p)), { description: "crack/brute only: charset preset (az, AZ, aZ, 19, aZ19, ascii)." })),
  crackMin: Type.Optional(Type.Number({ minimum: 1, maximum: 64, description: "crack/brute only: minimum candidate length (default 1)." })),
  crackMax: Type.Optional(Type.Number({ minimum: 1, maximum: 64, description: "crack/brute only: maximum candidate length (default 4 — keep brute windows small)." })),
}, { additionalProperties: false });

/** Loose path guard for the wordlist slot: no `-`-prefix (flag-smuggling). */
export function wordlistArg(value: unknown): string | undefined {
  const item = modelString(value, "wordlist");
  if (item === undefined) return undefined;
  if (!/^[A-Za-z0-9._~/-]+$/.test(item) || !/\.[A-Za-z0-9]+$/.test(item)) {
    throw new Error("jwt-hack: wordlist must be an existing file path (letters/digits/._/-); the model cannot pass flags through it");
  }
  return item;
}

function targetList(params: ToolParams): string | undefined {
  const target = (params as JwtHackParams).target;
  if (!target || !Array.isArray(target)) return undefined;
  const items = target
    .filter((item: unknown): item is string => typeof item === "string" && item.length > 0)
    .map((item: string) => {
      if (!/^[a-zA-Z0-9_]{1,32}$/.test(item)) {
        throw new Error(`jwt-hack: target entry rejected (got ${JSON.stringify(item.slice(0, 24))}); carrier styles are bare words like "none", "alg_confusion", "jku"`);
      }
      return item;
    });
  return items.length > 0 ? items.join(",") : undefined;
}

export const jwtHack: AdapterDef = {
  name: "jwt-hack",
  bin: "jwt-hack",
  versionFlag: "-V",
  mutating: false, // offline token math: carriers are generated, never sent
  artifactKind: "json",
  schema: jwtHackSchema,
  buildArgs(params: ToolParams): string[] {
    const p = params as JwtHackParams;
    const mode = requireModelString(p.mode, "mode", "jwt-hack");
    const token = requireModelString(p.token, "token", "jwt-hack");
    const args: string[] = ["--json", mode];
    if (mode === "payload") {
      const targets = targetList(params);
      if (targets) args.push("--target", targets);
      if (p.jwkAttack) args.push("--jwk-attack", modelString(p.jwkAttack, "jwkAttack")!);
      if (p.jwkTrust) args.push("--jwk-trust", modelString(p.jwkTrust, "jwkTrust")!);
      if (p.jwkProtocol) args.push("--jwk-protocol", String(p.jwkProtocol));
    }
    args.push(token);
    if (mode === "verify") {
      if (p.secret) args.push("--secret", rejectDash(String(p.secret), "secret"));
      if (p.validateExp === true) args.push("--validate-exp");
    }
    if (mode === "crack") {
      const crackMode = String(p.crackMode ?? "dict");
      if (!(CRACK_MODES as readonly string[]).includes(crackMode)) {
        throw new Error(`jwt-hack: crackMode must be "dict" or "brute" (got ${JSON.stringify(crackMode.slice(0, 16))})`);
      }
      args.push("-m", crackMode);
      const wordlist = wordlistArg(p.wordlist);
      if (wordlist) args.push("-w", wordlist);
      if (p.crackChars) args.push("--chars", rejectDash(p.crackChars, "crackChars"));
      if (p.crackPreset) args.push("--preset", String(p.crackPreset));
      if (Number.isInteger(p.crackMin)) args.push("--min", String(p.crackMin));
      if (Number.isInteger(p.crackMax)) args.push("--max", String(p.crackMax));
    }
    return args;
  },
  parse(stdout: string, _stderr: string): Normalized[] {
    const document = jsonDocument(stdout);
    if (!document || document.success === false) return [];
    const raw = clipRaw(JSON.stringify(document));
    // decode: one row keyed by algorithm/typ; the claims stay in raw (they are
    // target data, and the evidence gate still runs over every row).
    const decodePayload = (typeof document.payload === "object" && document.payload !== null)
      ? (document.payload as Record<string, unknown>) : null;
    if (typeof document.algorithm === "string" && decodePayload) {
      return [{ kind: "jwt-hack-decode", key: String(document.algorithm), raw, meta: {
        typ: typeof document.typ === "string" ? document.typ : undefined,
        expStatus: typeof decodePayload.exp_status === "string" ? decodePayload.exp_status : undefined,
      } }];
    }
    // scan: one row per finding + a tally row; findings carry the verdict list.
    const findings = Array.isArray(document.results) ? document.results : [];
    if (findings.length > 0) {
      const rows: Normalized[] = [];
      for (const finding of findings) {
        if (typeof finding !== "object" || finding === null) continue;
        const record = finding as Record<string, unknown>;
        if (typeof record.name !== "string") continue;
        rows.push({
          kind: "jwt-hack-scan",
          key: `${record.name}${record.vulnerable === true ? " [VULNERABLE]" : ""}`,
          raw: clipRaw(JSON.stringify(record)),
          meta: {
            vulnerable: record.vulnerable === true,
            severity: typeof record.severity === "string" ? record.severity : undefined,
          },
        });
      }
      return rows;
    }
    // payload: one row per carrier token.
    const payloads = Array.isArray(document.payloads) ? document.payloads : [];
    if (payloads.length > 0) {
      return payloads
        .filter((item): item is string => typeof item === "string")
        .map((carrier, index) => ({
          kind: "jwt-hack-payload",
          key: `candidate #${index + 1}`,
          raw: clipRaw(carrier),
          meta: { count: payloads.length },
        }));
    }
    // crack: the recovered secret IS the finding.
    if (typeof document.value === "string") {
      return [{
        kind: "jwt-hack-crack",
        key: "secret recovered",
        raw,
        meta: {
          attempts: typeof document.attempts === "number" ? document.attempts : undefined,
          elapsedMs: typeof document.elapsed_ms === "number" ? document.elapsed_ms : undefined,
        },
      }];
    }
    // verify: validity row.
    if (typeof document.valid === "boolean") {
      return [{
        kind: "jwt-hack-verify",
        key: document.valid ? "signature VALID" : "signature INVALID",
        raw,
        meta: { valid: document.valid, validateExp: document.validate_exp === true },
      }];
    }
    return [];
  },
};

function rejectDash(value: string, paramName: string): string {
  if (value.startsWith("-")) throw new TypeError(`field-param "${paramName}" must not start with "-"`);
  return value;
}
