import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNewJson, runMailgen } from "../src/tools/mailgen.ts";

/**
 * Modelless: the cowbird CLI is a fake executable placed on disk and pointed
 * at via CYBER_COWBIRD_BIN. It appends each argv element it received (one per
 * slot, ---ARG----marked) to a dump file and prints canned stdout. That proves
 * what argv reached the binary — one element per slot — and that the provider
 * `state` blob stays out of the result and the evidence store.
 */

const savedEnv = { CYBER_COWBIRD_BIN: process.env.CYBER_COWBIRD_BIN, CYBER_MAILGEN_FILE: process.env.CYBER_MAILGEN_FILE, CYBER_EVIDENCE_DIR: process.env.CYBER_EVIDENCE_DIR };

let work = "";

function uniqueDir(): string {
  work = join(tmpdir(), `cyber-mailgen-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(work, { recursive: true });
  return work;
}

function fakeCowbird(canned: string, exit = 0): string {
  const dump = join(work, "argv.txt");
  const bin = join(work, "cowbird-fake");
  // Real bytes only: write the canned stdout to a file and cat it — printf
  // via JSON.stringify would escape \t into literal backslash-t text.
  writeFileSync(join(work, "canned-out.txt"), canned);
  writeFileSync(bin, [
    "#!/bin/sh",
    `DUMP="${dump}"`,
    'rm -f "$DUMP"',
    'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$DUMP"; printf \'%s\\n\' "---ARG---" >> "$DUMP"; done',
    `cat ${JSON.stringify(join(work, "canned-out.txt"))}`,
    `exit ${exit}`,
  ].join("\n"));
  chmodSync(bin, 0o755);
  process.env.CYBER_COWBIRD_BIN = bin;
  process.env.CYBER_MAILGEN_FILE = join(work, "mailgen-registry.json");
  process.env.CYBER_EVIDENCE_DIR = join(work, "evidence");
  return bin;
}

function argvSlots(): string[] {
  const raw = readFileSync(join(work, "argv.txt"), "utf8");
  return raw.split("\n---ARG---\n").slice(0, -1);
}

function activate(canned: string, stdouts: (string | null)[] = [], exit = 0): void {
  fakeCowbird(canned, exit);
  void stdouts;
}

describe("mailgen parseNewJson", () => {
  test("parses the new --json envelope, tolerating prefix noise", () => {
    expect(parseNewJson('hint\n{"address":"a@b.co","provider":"mail.tm","address_ttl":"5m","state":"S"}')).toEqual({
      address: "a@b.co",
      provider: "mail.tm",
      addressTtl: "5m",
      hadState: true,
    });
  });

  test("returns null without a parsable envelope", () => {
    expect(parseNewJson("a@b.co\tmail.tm\tttl forevever")).toBeNull();
  });
});

describe("mailgen runMailgen argv and state discipline", () => {
  test("new --json lands in argv slots and the state blob never reaches the result", async () => {
    uniqueDir();
    activate('{"address":"probe@subhosttest.org","provider":"mail.tm","address_ttl":"5m","state":"PROVIDER-STATE-199"}');
    const { text, argv } = await runMailgen({ action: "new" }, undefined);
    expect(argv).toEqual(["new", "--json"]);
    expect(argvSlots()).toEqual(["new", "--json"]);
    expect(text).toContain("probe@subhosttest.org");
    expect(text).toContain("provider:");
    expect(text).toContain("ttl: 5m");
    expect(text).not.toContain("PROVIDER-STATE-199");
    expect(text).toContain("stored locally");
  });

  test("a provider override goes into its own argv slot", async () => {
    uniqueDir();
    activate('{"address":"probe@subhosttest.org","provider":"inboxkitten","address_ttl":"10m"}');
    const { argv } = await runMailgen({ action: "new", provider: "inboxkitten" }, undefined);
    expect(argv).toEqual(["new", "--provider", "inboxkitten", "--json"]);
  });

  test("wait replays the stored state through --state and supports --otp", async () => {
    uniqueDir();
    activate('{"address":"probe@subhosttest.org","provider":"mail.tm","state":"PROVIDER-STATE-199"}');
    await runMailgen({ action: "new" }, undefined);
    activate("noreply@target.test\tYour verification code");
    const { text, argv } = await runMailgen({ action: "wait", address: "probe@subhosttest.org", provider: "mail.tm", otp: true, timeoutSec: 30 }, undefined);
    expect(argv).toEqual(["wait", "probe@subhosttest.org", "--provider", "mail.tm", "--timeout", "30", "--otp", "--state", "PROVIDER-STATE-199"]);
    expect(argvSlots()).toEqual(argv);
    expect(text).toContain("noreply@target.test");
    expect(text).toContain("Your verification code");
    expect(text).not.toContain("PROVIDER-STATE-199");
  });

  test("wait without a registry entry never invents a state argument", async () => {
    uniqueDir();
    activate("sender\tsubject");
    const { argv } = await runMailgen({ action: "wait", address: "probe@subhosttest.org", provider: "inboxes", timeoutSec: 45 }, undefined);
    expect(argv).toEqual(["wait", "probe@subhosttest.org", "--provider", "inboxes", "--timeout", "45"]);
  });

  test("providers and canary pass through verbatim", async () => {
    uniqueDir();
    activate("PROVIDER STATUS P50 KIND SITES");
    const providers = await runMailgen({ action: "providers" }, undefined);
    expect(providers.argv).toEqual(["providers"]);
    activate('[{"name":"mail.tm"}]');
    const canary = await runMailgen({ action: "canary" }, undefined);
    expect(canary.argv).toEqual(["canary", "--json"]);
  });

  test("validation rejects a malformed address and stray otp on new", async () => {
    uniqueDir();
    activate('');
    await expect(runMailgen({ action: "wait", address: "a b@c.//", provider: "mail.tm" }, undefined)).rejects.toThrow(/invalid address/);
    await expect(runMailgen({ action: "new", otp: true }, undefined)).rejects.toThrow(/otp field applies/);
    await expect(runMailgen({ action: "providers", provider: "mail.tm" }, undefined)).rejects.toThrow(/takes no extra arguments/);
  });

  test("cowbird's expected exits (error/timeout) surface as text, not crashes", async () => {
    uniqueDir();
    const dump = join(work, "argv.txt");
    const bin = join(work, "cowbird-fake");
    writeFileSync(bin, [
      "#!/bin/sh",
      `DUMP="${dump}"`,
      'for arg in "$@"; do printf \'%s\\n\' "$arg" >> "$DUMP"; printf \'%s\\n\' "---ARG---" >> "$DUMP"; done',
      "echo 'error: provider mail.tm requires the --state value printed by `cowbird new --json`' >&2",
      "exit 1",
    ].join("\n"));
    chmodSync(bin, 0o755);
    process.env.CYBER_MAILGEN_FILE = join(work, "registry.json");
    process.env.CYBER_EVIDENCE_DIR = join(work, "evidence");
    process.env.CYBER_COWBIRD_BIN = bin;
    const { text } = await runMailgen({ action: "wait", address: "probe@subhosttest.org", provider: "mail.tm" }, undefined);
    expect(text).toContain("error: provider mail.tm requires the --state value");
  });
});

afterAll(() => {
  if (savedEnv.CYBER_COWBIRD_BIN === undefined) delete process.env.CYBER_COWBIRD_BIN;
  if (savedEnv.CYBER_MAILGEN_FILE === undefined) delete process.env.CYBER_MAILGEN_FILE;
  if (savedEnv.CYBER_EVIDENCE_DIR === undefined) delete process.env.CYBER_EVIDENCE_DIR;
});

void existsSync;
void rmSync;
