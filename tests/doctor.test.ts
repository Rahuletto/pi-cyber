import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { inventory } from "../src/doctor.ts";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
test("doctor locates executables without running them or claiming validation", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "cyber-doctor-")); directories.push(dir);
  const sentinel = resolve(dir, "executed");
  await writeFile(resolve(dir, "nmap"), `#!/bin/sh\ntouch '${sentinel}'\n`);
  await chmod(resolve(dir, "nmap"), 0o755);
  const rows = await inventory(dir, ["nmap", "missing-fixture"]);
  expect(rows[0]).toEqual({ name: "nmap", available: true, path: resolve(dir, "nmap"), validated: false });
  expect(rows[1]).toEqual({ name: "missing-fixture", available: false, path: null, validated: false });
  await expect(stat(sentinel)).rejects.toThrow();
});
