import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManagedJobResult, startManagedJob, type ManagedJob } from "../src/jobs/controller.ts";

const stubBin = join(import.meta.dir, "fixtures", "jobs", "bin");
const originalPath = process.env.PATH;
const originalEvidenceDir = process.env.CYBER_EVIDENCE_DIR;
const roots: string[] = [];
beforeAll(() => {
  process.env.PATH = `${stubBin}:${process.env.PATH ?? ""}`;
  process.env.CYBER_EVIDENCE_DIR = mkdtempSync(join(tmpdir(), "cyber-async-jobs-"));
  roots.push(process.env.CYBER_EVIDENCE_DIR);
});
afterAll(() => {
  process.env.PATH = originalPath;
  if (originalEvidenceDir === undefined) delete process.env.CYBER_EVIDENCE_DIR;
  else process.env.CYBER_EVIDENCE_DIR = originalEvidenceDir;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

async function waitFor(job: ManagedJob, predicate: (state: string) => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !predicate(job.get().state)) await Bun.sleep(10);
  expect(predicate(job.get().state)).toBe(true);
}

describe("manageable jobs", () => {
  test("cancelling a running job kills its child and keeps an explicit terminal result", async () => {
    const job = startManagedJob({ tool: "nuclei", params: { targets: ["fixture.local"], extra: ["--silent-linger"] } });
    await waitFor(job, (state) => state === "running");
    const started = Date.now();
    expect(job.cancel()).toBe(true);
    const result = await job.completion;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({ jobId: job.jobId, state: "cancelled", cancelled: true });
    expect(job.get().state).toBe("cancelled");
    expect(job.get().resultArtifact).toMatchObject({ kind: "job-result", contentType: "application/json" });
    const first = readManagedJobResult(job.jobId, { limit: 16 });
    expect(first.data).toContain('"jobId"');
    expect(first.nextOffset).toBeGreaterThan(0);
    expect(() => readManagedJobResult(job.jobId, {}, { CYBER_ENGAGEMENT_ID: "another-engagement" }))
      .toThrow("unknown or out-of-scope runtime job id");
  });

  test("queued cancellation prevents execution, while result windows remain bounded", async () => {
    const first = startManagedJob({ tool: "nuclei", params: { targets: ["fixture.local"], extra: ["--silent-linger"] } });
    await waitFor(first, (state) => state === "running");
    const queued = startManagedJob({ tool: "subfinder", params: { domain: "must-not-run.local" } });
    expect(queued.get().state).toBe("queued");
    expect(queued.cancel()).toBe(true);
    expect((await queued.completion).state).toBe("cancelled");
    expect(queued.get().resultArtifact).toMatchObject({ kind: "job-result", contentType: "application/json" });
    expect(readManagedJobResult(queued.jobId).data).toContain('"state":"cancelled"');
    first.cancel();
    await first.completion;
  });

  test("queued cancellation survives a process restart with its normalized result", async () => {
    const controllerUrl = import.meta.resolve("../src/jobs/controller.ts");
    const createCode = `
      const { startManagedJob } = await import(${JSON.stringify(controllerUrl)});
      const first = startManagedJob({ tool: "nuclei", params: { targets: ["fixture.local"], extra: ["--silent-linger"] } });
      while (first.get().state !== "running") await Bun.sleep(10);
      const queued = startManagedJob({ tool: "subfinder", params: { domain: "must-not-run.local" } });
      queued.cancel();
      first.cancel();
      await Promise.all([first.completion, queued.completion]);
      console.log(queued.jobId);
    `;
    const create = Bun.spawn([process.execPath, "-e", createCode], {
      env: { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ""}` },
      stdout: "pipe", stderr: "pipe",
    });
    const createdId = (await new Response(create.stdout).text()).trim();
    expect(await create.exited).toBe(0);
    expect(createdId).toMatch(/^subfinder-/);

    const recoverCode = `
      const { getManagedJob, readManagedJobResult } = await import(${JSON.stringify(controllerUrl)});
      console.log(JSON.stringify({ job: getManagedJob(process.env.CYBER_RECOVER_JOB), result: readManagedJobResult(process.env.CYBER_RECOVER_JOB).data }));
    `;
    const recover = Bun.spawn([process.execPath, "-e", recoverCode], {
      env: { ...process.env, CYBER_RECOVER_JOB: createdId },
      stdout: "pipe", stderr: "pipe",
    });
    const recovered = JSON.parse((await new Response(recover.stdout).text()).trim());
    expect(await recover.exited).toBe(0);
    expect(recovered.job).toMatchObject({ jobId: createdId, adapter: "subfinder", state: "cancelled", phase: "completed" });
    expect(recovered.result).toContain('"cancelled":true');
  });
});
