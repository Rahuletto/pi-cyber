import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { inventory, report } from "../src/doctor.ts";
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
test("doctor report emits { name, category, disposition, state } for every manifest entry, read-only", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "cyber-doctor-v2-")); directories.push(dir);
  await writeFile(resolve(dir, "subfinder"), "#!/bin/sh\ntouch executed\n");
  await chmod(resolve(dir, "subfinder"), 0o755);
  await writeFile(resolve(dir, "state.json"), JSON.stringify({ httpx: { state: "validated" } }));
  const missingState = resolve(dir, "none.json");
  const untouched = await report({ envPath: "", statePath: missingState });
  expect(untouched.platform).toEqual(process.platform);
  expect(untouched.architecture).toEqual(process.arch);
  for (const row of untouched.tools) {
    expect(Object.keys(row).sort()).toEqual(["category", "disposition", "name", "state"]);
    expect(row.state).toBe("cataloged"); // missing state file = all cataloged, even httpx
  }
  const rows = await report({ envPath: dir, statePath: resolve(dir, "state.json") }).then((r) => r.tools);
  expect(rows.find((row) => row.name === "subfinder")).toEqual({ name: "subfinder", category: "recon", disposition: "core", state: "available" });
  expect(rows.find((row) => row.name === "httpx")).toEqual({ name: "httpx", category: "web", disposition: "core", state: "validated" });
  expect(rows.find((row) => row.name === "obscura")?.state).toBe("cataloged");
  expect(rows.find((row) => row.name === "nmap")?.disposition).toBe("on-demand");
  await expect(stat(resolve(dir, "executed"))).rejects.toThrow(); // doctor never executes tools
});
