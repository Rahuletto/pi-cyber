import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { Lang, parse, pattern, type Edit, type SgNode } from "@ast-grep/napi";

const MAX_FILE = 256 * 1024, MAX_TOTAL = 2 * 1024 * 1024, MAX_MATCHES = 100, MAX_OUTPUT = 64 * 1024;
const languages = { javascript: Lang.JavaScript, typescript: Lang.TypeScript, tsx: Lang.Tsx, css: Lang.Css, html: Lang.Html };
export type Language = keyof typeof languages;
const extensions: Record<string, Language> = { ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx", ".css": "css", ".html": "html", ".htm": "html" };
export interface Binding { sessionId: string; branch: string[] }
export interface Operation { pat: string; out: string }
interface Change { line: number; column: number; before: string; after: string }
interface Proposal {
  path: string; language: Language; originalHash: string; nextHash: string; sessionId: string;
  anchor: string | undefined; source: string; mode: number; dev: number; ino: number;
  changes: Change[];
}
const hash = (source: string) => createHash("sha256").update(source).digest("hex");
function text(value: unknown, label: string, max = 4096, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || value.includes("\0")) throw new Error(`Invalid ${label}; maximum ${max} characters`);
}
function languageFor(path: string, language?: Language): Language | undefined {
  if (language !== undefined && !Object.hasOwn(languages, language)) throw new Error(`Unsupported language; choose ${Object.keys(languages).join(", ")}`);
  return language ?? extensions[extname(path).toLowerCase()];
}
// The engine exposes missing tokens as zero-width leaves, but has no isMissing API.
// Conservatively refuse these as well as explicit ERROR nodes before mutating.
function parseDiagnostics(root: SgNode) {
  const found: { line: number; column: number; kind: string }[] = [], stack = [root];
  while (stack.length) {
    const node = stack.pop()!, children = node.children(), range = node.range();
    if (node.kind() === "ERROR" || (node !== root && children.length === 0 && range.start.index === range.end.index)) {
      if (found.length < 20) found.push({ line: range.start.line + 1, column: range.start.column + 1, kind: String(node.kind()) });
    }
    stack.push(...children);
  }
  return found;
}
function variables(pat: string) {
  return [...pat.matchAll(/\$\$\$([A-Z_][A-Z_0-9]*)|(?<!\$)\$([A-Z_][A-Z_0-9]*)/g)].map((m) => ({ name: m[1] ?? m[2], multiple: Boolean(m[1]) }));
}
function capture(node: SgNode, name: string, multiple: boolean, source: string): string {
  if (!multiple) {
    const matched = node.getMatch(name);
    if (!matched) throw new Error(`Unbound capture $${name}`);
    return matched.text();
  }
  const matched = node.getMultipleMatches(name);
  // Use the captured span to retain commas, comments, whitespace and Unicode.
  return matched.length ? source.slice(matched[0].range().start.index, matched.at(-1)!.range().end.index) : "";
}
function replacement(node: SgNode, op: Operation, source: string): string {
  const declared = variables(op.pat);
  return op.out.replace(/\$\$\$([A-Z_][A-Z_0-9]*)|(?<!\$)\$([A-Z_][A-Z_0-9]*)/g, (_token, multi: string | undefined, single: string | undefined) => {
    const name = (multi ?? single)!;
    if (!declared.some((v) => v.name === name && v.multiple === Boolean(multi)) || name.startsWith("_")) throw new Error(`Unknown or anonymous capture ${name}`);
    return capture(node, name, Boolean(multi), source);
  });
}
function bounded<T>(result: T): T {
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT) throw new Error("Output limit exceeded; narrow the query or edit");
  return result;
}

/** Single-workspace proposals live only in this explicitly loaded extension instance. */
export class AstWorkspace {
  private proposals = new Map<string, Proposal>();
  private root: Promise<string>;
  constructor(cwd: string) { this.root = realpath(cwd); }

  private async path(input: string) {
    text(input, "path", 1024);
    const root = await this.root, path = resolve(root, input), rel = relative(root, path);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Path must name a file inside the workspace");
    let cursor = root;
    for (const component of rel.split(sep)) {
      cursor = resolve(cursor, component);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Symlink paths are refused");
    }
    if (!(await lstat(path)).isFile()) throw new Error("Explicit regular files only");
    const canonical = await realpath(path);
    if (canonical !== path) throw new Error("Canonical workspace path changed");
    return { path, rel };
  }

  private async snapshot(input: string, edit: boolean, allowance = MAX_FILE) {
    const located = await this.path(input);
    const file = await open(located.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new Error("Explicit regular files only");
      if (edit && metadata.nlink !== 1) throw new Error("Hardlink edits are refused");
      const limit = Math.min(MAX_FILE, allowance);
      const sizeError = () => new Error(limit < MAX_FILE ? "Total input size limit exceeded (2 MiB)" : "File size limit exceeded (256 KiB)");
      if (metadata.size > limit) throw sizeError();
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) throw sizeError();
      const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      // Do not silently strip a BOM or normalize bytes in proposals.
      if (!Buffer.from(source).equals(buffer.subarray(0, length))) throw new Error("Source must be plain UTF-8 without a BOM");
      return { ...located, source, metadata, hash: hash(source), bytes: length };
    } finally { await file.close(); }
  }

  async grep(input: { paths: string[]; pat: string; language?: Language; limit?: number }) {
    if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 32) throw new Error("Explicit file limit: 1 to 32 paths");
    text(input.pat, "pattern");
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MATCHES) throw new Error("Match limit must be between 1 and 100");
    const matches: { path: string; line: number; column: number; text: string; captures: Record<string, string>; truncated: boolean }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const diagnostics: { path: string; errors: ReturnType<typeof parseDiagnostics> }[] = [];
    let truncated = false, total = 0;
    for (const path of input.paths) {
      text(path, "path", 1024);
      const language = languageFor(path, input.language);
      if (!language) { skipped.push({ path, reason: "Unsupported language" }); continue; }
      const matcher = pattern(languages[language], input.pat);
      let snapshot: Awaited<ReturnType<AstWorkspace["snapshot"]>>;
      if (total >= MAX_TOTAL) { skipped.push({ path, reason: "Total input size limit exceeded (2 MiB)" }); truncated = true; continue; }
      try { snapshot = await this.snapshot(path, false, MAX_TOTAL - total); }
      catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 256) : "File read refused";
        skipped.push({ path, reason }); truncated ||= reason.startsWith("Total input"); continue;
      }
      total += snapshot.bytes;
      const root = parse(languages[language], snapshot.source).root(), errors = parseDiagnostics(root);
      if (errors.length) diagnostics.push({ path: snapshot.rel, errors });
      for (const node of root.findAll(matcher)) {
        if (matches.length >= limit) { truncated = true; break; }
        const captures: Record<string, string> = Object.create(null);
        let clipped = node.text().length > 1000;
        for (const variable of variables(input.pat)) {
          if (variable.name.startsWith("_")) continue;
          const value = capture(node, variable.name, variable.multiple, snapshot.source);
          captures[variable.name] = value.slice(0, 1000); clipped ||= value.length > 1000;
        }
        const range = node.range();
        const match = { path: snapshot.rel, line: range.start.line + 1, column: range.start.column + 1, text: node.text().slice(0, 1000), captures, truncated: clipped };
        if (Buffer.byteLength(JSON.stringify({ matches: [...matches, match], skipped, diagnostics })) > MAX_OUTPUT - 4096) { truncated = true; break; }
        matches.push(match); truncated ||= clipped;
      }
    }
    const result = { engine: "@ast-grep/napi@0.51.0", query: input.pat, supportedLanguages: Object.keys(languages), matches, skipped, diagnostics, truncated };
    // Query, paths and diagnostics also consume the response budget.
    while (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT) {
      result.truncated = true;
      if (matches.length) matches.pop();
      else if (diagnostics.length) diagnostics.pop();
      else if (skipped.length) skipped.pop();
      else break;
    }
    return bounded(result);
  }

  async preview(input: { path: string; language?: Language; ops: Operation[] }, binding: Binding) {
    const language = languageFor(input.path, input.language);
    if (!language) throw new Error(`Unsupported language; choose ${Object.keys(languages).join(", ")}`);
    if (!Array.isArray(input.ops) || !input.ops.length || input.ops.length > 8) throw new Error("Edit limit: 1 to 8 operations");
    const seen = new Set<string>();
    for (const op of input.ops) {
      text(op.pat, "pattern"); text(op.out, "replacement", 4096, true);
      if (seen.has(op.pat)) throw new Error("Duplicate edit patterns are refused");
      seen.add(op.pat);
    }
    const snapshot = await this.snapshot(input.path, true), root = parse(languages[language], snapshot.source).root();
    if (parseDiagnostics(root).length) throw new Error("Source parse errors; preview refused");
    const edits: Edit[] = [], changes: Change[] = [];
    for (const op of input.ops) {
      const matcher = pattern(languages[language], op.pat);
      for (const node of root.findAll(matcher)) {
        if (edits.length >= MAX_MATCHES) throw new Error("Edit match limit exceeded (100); narrow the pattern");
        const after = replacement(node, op, snapshot.source), range = node.range();
        edits.push(node.replace(after));
        changes.push({ line: range.start.line + 1, column: range.start.column + 1, before: node.text(), after });
        bounded(changes);
      }
    }
    if (!edits.length) throw new Error("No structural matches; no proposal created");
    const sorted = [...edits].sort((a, b) => a.startPos - b.startPos || a.endPos - b.endPos);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].startPos < sorted[i - 1].endPos || sorted[i].startPos === sorted[i - 1].startPos) throw new Error("Overlapping structural edits are refused");
    const source = root.commitEdits(edits);
    if (Buffer.byteLength(source) > MAX_FILE) throw new Error("Result file size limit exceeded (256 KiB)");
    if (parseDiagnostics(parse(languages[language], source).root()).length) throw new Error("Replacement creates parse errors; no proposal created");
    if (source === snapshot.source) throw new Error("Replacement is unchanged; no proposal created");
    const proposalId = randomUUID(), nextHash = hash(source);
    const result = bounded({ proposalId, applied: false, path: snapshot.rel, language, originalHash: snapshot.hash, nextHash, changes });
    if (this.proposals.size >= 8) this.proposals.delete(this.proposals.keys().next().value!);
    this.proposals.set(proposalId, { path: snapshot.rel, language, originalHash: snapshot.hash, nextHash, sessionId: binding.sessionId, anchor: binding.branch.at(-1), source, mode: snapshot.metadata.mode, dev: snapshot.metadata.dev, ino: snapshot.metadata.ino, changes });
    return result;
  }

  async apply(proposalId: string, binding: Binding) {
    text(proposalId, "proposal ID", 64);
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error("Unknown or expired proposal; preview again");
    if (proposal.sessionId !== binding.sessionId || (proposal.anchor && !binding.branch.includes(proposal.anchor))) throw new Error("Proposal belongs to another session or branch");
    const check = async () => {
      const snapshot = await this.snapshot(proposal.path, true);
      if (snapshot.hash !== proposal.originalHash || snapshot.metadata.mode !== proposal.mode || snapshot.metadata.dev !== proposal.dev || snapshot.metadata.ino !== proposal.ino) throw new Error("Stale proposal: file content or metadata changed; preview again");
      return snapshot;
    };
    const snapshot = await check();
    if (parseDiagnostics(parse(languages[proposal.language], proposal.source).root()).length) throw new Error("Proposal parse errors");
    const temp = resolve(dirname(snapshot.path), `.pi-ast-${randomUUID()}.tmp`);
    let created = false;
    try {
      const file = await open(temp, "wx", proposal.mode & 0o7777); created = true;
      try { await file.writeFile(proposal.source, "utf8"); await file.chmod(proposal.mode & 0o7777); await file.sync(); }
      finally { await file.close(); }
      await check();
      await rename(temp, snapshot.path); created = false;
      this.proposals.delete(proposalId);
      return bounded({ proposalId, applied: true, path: proposal.path, originalHash: proposal.originalHash, nextHash: proposal.nextHash, changes: proposal.changes });
    } finally { if (created) await unlink(temp).catch(() => {}); }
  }
}
