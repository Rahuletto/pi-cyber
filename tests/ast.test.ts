import { afterEach, expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createExtensionRuntime, SessionManager, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function host() {
  const cwd = await mkdtemp(resolve(tmpdir(), "ast-fixture-")); dirs.push(cwd);
  let session = SessionManager.create(cwd, cwd);
  session.appendMessage({ role: "user", content: "local AST fixture", timestamp: 1 });
  const loaded = await loadExtensions([resolve("src/ast-extension.ts")], cwd, undefined, createExtensionRuntime());
  expect(loaded.errors).toEqual([]);
  const extension = loaded.extensions[0];
  const ctx = { cwd, get sessionManager() { return session; } } as unknown as ExtensionToolContext;
  const call = async (name: string, params: unknown) => {
    const result = await extension.tools.get(name)!.definition.execute("ast-fixture", params, undefined, undefined, ctx);
    return result.details as any;
  };
  const emit = async (name: string) => { for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name } as never, ctx); };
  return { cwd, extension, call, emit, session: () => session, switchSession: () => { session = SessionManager.create(cwd, cwd); } };
}

test("optional SDK extension finds structural captures and reports bounded unsupported inputs", async () => {
  const h = await host();
  await writeFile(resolve(h.cwd, "a.ts"), 'const s = "console.log(fake)";\nconsole.log (first);\nconsole.log(second);\n');
  await writeFile(resolve(h.cwd, "a.py"), "print(1)");
  const found = await h.call("ast_grep", { paths: ["a.ts", "a.py"], pat: "console.log($A)", limit: 1 });
  expect(found.matches).toHaveLength(1);
  expect(found.matches[0]).toMatchObject({ path: "a.ts", line: 2, text: "console.log (first)", captures: { A: "first" } });
  expect(found.truncated).toBe(true);
  expect(found.skipped).toEqual([{ path: "a.py", reason: "Unsupported language" }]);
  expect(found.supportedLanguages).toContain("typescript");
  expect(h.extension.tools.size).toBe(2);
});

test("preview preserves Unicode and capture spelling then apply atomically preserves mode", async () => {
  const h = await host(), file = resolve(h.cwd, "unicode.ts");
  const before = 'const emoji = "😀é"; console.log(emoji, /* keep */ "世界");\n';
  await writeFile(file, before); await chmod(file, 0o751);
  const proposal = await h.call("ast_edit", { action: "preview", path: "unicode.ts", ops: [{ pat: "console.log($$$ARGS)", out: "logger($$$ARGS)" }] });
  expect(await readFile(file, "utf8")).toBe(before);
  expect(proposal.changes[0]).toMatchObject({ before: 'console.log(emoji, /* keep */ "世界")', after: 'logger(emoji, /* keep */ "世界")' });
  expect(proposal.proposalId).toMatch(/^[0-9a-f-]{36}$/);
  const applied = await h.call("ast_edit", { action: "apply", proposalId: proposal.proposalId });
  expect(applied.applied).toBe(true);
  expect(await readFile(file, "utf8")).toBe('const emoji = "😀é"; logger(emoji, /* keep */ "世界");\n');
  expect((await stat(file)).mode & 0o777).toBe(0o751);
  await expect(h.call("ast_edit", { action: "apply", proposalId: proposal.proposalId })).rejects.toThrow(/proposal/i);
});

test("refuses parser errors including missing tokens and invalid replacement without writes", async () => {
  const h = await host(), file = resolve(h.cwd, "bad.ts");
  for (const source of ["console.log(x); const x = ;", "function f() { console.log(x);"]) {
    await writeFile(file, source);
    const search = await h.call("ast_grep", { paths: ["bad.ts"], pat: "console.log($A)" });
    expect(search.diagnostics.length).toBeGreaterThan(0);
    await expect(h.call("ast_edit", { action: "preview", path: "bad.ts", ops: [{ pat: "console.log($A)", out: "logger($A)" }] })).rejects.toThrow(/parse/i);
    expect(await readFile(file, "utf8")).toBe(source);
  }
  await writeFile(file, "console.log(x);");
  await expect(h.call("ast_edit", { action: "preview", path: "bad.ts", ops: [{ pat: "console.log($A)", out: "logger(" }] })).rejects.toThrow(/parse/i);
  expect(await readFile(file, "utf8")).toBe("console.log(x);");
});

test("staged edit rejects fields from the other action before applying a proposal", async () => {
  const h = await host(), file = resolve(h.cwd, "a.ts");
  await writeFile(file, "console.log(x);");
  const proposal = await h.call("ast_edit", { action: "preview", path: "a.ts", ops: [{ pat: "console.log($A)", out: "logger($A)" }] });
  await expect(h.call("ast_edit", { action: "apply", proposalId: proposal.proposalId, path: "a.ts" })).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("console.log(x);");
  await expect(h.call("ast_edit", { action: "preview", path: "a.ts", ops: [{ pat: "console.log($A)", out: "logger($A)" }], proposalId: proposal.proposalId })).rejects.toThrow();
  await h.call("ast_edit", { action: "apply", proposalId: proposal.proposalId });
  expect(await readFile(file, "utf8")).toBe("logger(x);");
});

test("refuses stale files, replaced sessions and navigated branches", async () => {
  const h = await host(), file = resolve(h.cwd, "a.ts");
  await writeFile(file, "console.log(x);");
  const preview = () => h.call("ast_edit", { action: "preview", path: "a.ts", ops: [{ pat: "console.log($A)", out: "logger($A)" }] });
  let p = await preview(); await writeFile(file, "console.log(y);");
  await expect(h.call("ast_edit", { action: "apply", proposalId: p.proposalId })).rejects.toThrow(/stale/i);
  p = await preview(); h.switchSession();
  await expect(h.call("ast_edit", { action: "apply", proposalId: p.proposalId })).rejects.toThrow(/proposal|session/i);
  p = await preview(); await h.emit("session_tree");
  await expect(h.call("ast_edit", { action: "apply", proposalId: p.proposalId })).rejects.toThrow(/proposal/i);
  expect(await readFile(file, "utf8")).toBe("console.log(y);");
});

test("refuses path escapes, symlink components and hardlinks before editing", async () => {
  const h = await host(), outside = await mkdtemp(resolve(tmpdir(), "ast-outside-")); dirs.push(outside);
  await writeFile(resolve(outside, "a.ts"), "console.log(x);");
  await symlink(outside, resolve(h.cwd, "alias"));
  await symlink(resolve(outside, "a.ts"), resolve(h.cwd, "link.ts"));
  await link(resolve(outside, "a.ts"), resolve(h.cwd, "hard.ts"));
  for (const path of [resolve(outside, "a.ts"), "alias/a.ts", "link.ts", "hard.ts"]) {
    await expect(h.call("ast_edit", { action: "preview", path, ops: [{ pat: "console.log($A)", out: "logger($A)" }] })).rejects.toThrow(/workspace|symlink|hardlink/i);
  }
  expect(await readFile(resolve(outside, "a.ts"), "utf8")).toBe("console.log(x);");
});

test("refuses overlapping edits, unmatched captures and unbounded requests", async () => {
  const h = await host(); await writeFile(resolve(h.cwd, "a.ts"), "console.log(console.log(x));");
  await expect(h.call("ast_edit", { action: "preview", path: "a.ts", ops: [{ pat: "console.log($A)", out: "logger($A)" }] })).rejects.toThrow(/overlap/i);
  await writeFile(resolve(h.cwd, "a.ts"), "console.log(x);");
  await expect(h.call("ast_edit", { action: "preview", path: "a.ts", ops: [{ pat: "console.log($A)", out: "logger($MISSING)" }] })).rejects.toThrow(/capture/i);
  await expect(h.call("ast_grep", { paths: Array(33).fill("a.ts"), pat: "console.log($A)" })).rejects.toThrow(/32|limit/i);
  await writeFile(resolve(h.cwd, "large.ts"), " ".repeat(262145));
  const found = await h.call("ast_grep", { paths: ["large.ts"], pat: "$A" });
  expect(found.skipped[0].reason).toMatch(/size|large/i);
  expect(await readFile(resolve(h.cwd, "a.ts"), "utf8")).toBe("console.log(x);");
});

test("search includes query and diagnostics in its output budget and bounds total source", async () => {
  const h = await host();
  for (const size of [304, 320]) {
    await writeFile(resolve(h.cwd, "a.ts"), Array(100).fill(`console.log("${"x".repeat(size)}");`).join("\n"));
    const found = await h.call("ast_grep", { paths: ["a.ts"], pat: "console.log($A)" + " ".repeat(4000), limit: 100 });
    expect(found.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(found))).toBeLessThanOrEqual(65536);
  }
  const source = "/*" + " ".repeat(262120) + "*/ console.log(x);";
  const paths = Array.from({ length: 10 }, (_, i) => `file${i}.ts`);
  await Promise.all(paths.map((path) => writeFile(resolve(h.cwd, path), source)));
  const found = await h.call("ast_grep", { paths, pat: "console.log($A)" });
  expect(found.matches).toHaveLength(8);
  expect(found.skipped).toHaveLength(2);
  expect(found.truncated).toBe(true);
});
