import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWaitResult, mailgenTool, parseBodyJson, parseNewJson, parseWaitOutput, runMailgen, type MailBody } from "../src/tools/mailgen.ts";
import { queryCowbirdInbox } from "../src/tools/mail-inbox.ts";

/**
 * Modelless: the cowbird CLI is a fake executable placed on disk and pointed
 * at via CYBER_COWBIRD_BIN. It appends each argv element it received (one per
 * slot, ---ARG----marked) to a dump file and prints canned stdout. That proves
 * what argv reached the binary — one element per slot — and that the provider
 * `state` blob stays out of the result and the evidence store.
 */

const savedEnv = { CYBER_COWBIRD_BIN: process.env.CYBER_COWBIRD_BIN, CYBER_MAILGEN_FILE: process.env.CYBER_MAILGEN_FILE, CYBER_EVIDENCE_DIR: process.env.CYBER_EVIDENCE_DIR, CYBER_COWBIRD_PYTHON: process.env.CYBER_COWBIRD_PYTHON, PYTHONPATH: process.env.PYTHONPATH };

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

describe("mailgen doctrine in the tool text", () => {
  test("tool description carries read-now and never hand-call; provider field bans hand-polling", () => {
    const description = mailgenTool.description.toLowerCase();
    expect(description).toContain("read-now");
    expect(description).toContain("never hand-call");
    const providerDescription = (mailgenTool.parameters as unknown as { properties: { provider: { description: string } } }).properties.provider.description;
    expect(providerDescription.toLowerCase()).toContain("never hand-call");
  });
});

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

  test("a python traceback crashes into a one-line surfaced error, with no retry", async () => {
    uniqueDir();
    const runs = join(work, "runs.txt");
    const bin = join(work, "cowbird-fake");
    writeFileSync(bin, [
      "#!/bin/sh",
      `echo run >> ${JSON.stringify(runs)}`,
      "echo 'Traceback (most recent call last):' >&2",
      'echo \'  File "/site-packages/cowbird_cli/__init__.py", line 168, in run\' >&2',
      'echo \'  File "/site-packages/cowbird_mailtm/__init__.py", line 117, in list\' >&2',
      'echo \'payload = await self.http.json("GET", f"{self.api}/messages")\' >&2',
      'echo \'json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)\' >&2',
      "exit 1",
    ].join("\n"));
    chmodSync(bin, 0o755);
    process.env.CYBER_MAILGEN_FILE = join(work, "registry.json");
    process.env.CYBER_EVIDENCE_DIR = join(work, "evidence");
    process.env.CYBER_COWBIRD_BIN = bin;
    let failure: Error | undefined;
    try {
      await runMailgen({ action: "wait", address: "probe@subhosttest.org", provider: "duckmail", timeoutSec: 5 }, undefined);
    } catch (error) {
      failure = error as Error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain("JSONDecodeError");
    expect(failure?.message).toContain("crashed");
    expect(failure?.message).toContain("cowbird_cli/__init__.py:168");
    expect(failure?.message).not.toContain("Traceback (most recent call last)");
    expect(failure?.message.split("\n").length).toBe(1);
    // Crash surfaces the error; no automatic retry of the failing subprocess.
    expect(readFileSync(runs, "utf8").split("\n").filter(Boolean).length).toBe(1);
  });
});

describe("mailgen wait normalization", () => {
  test("sender/subject parsed from TSV and labeled shapes; links deduped", () => {
    const tsv = parseWaitOutput('noreply@target.test\tVerify your signup\n\nConfirm: https://ok.test/faq https://go.test/verify?token=a');
    expect(tsv.sender).toBe("noreply@target.test");
    expect(tsv.subject).toBe("Verify your signup");
    expect(tsv.links).toEqual(["https://go.test/verify?token=a", "https://ok.test/faq"]);

    const labeled = parseWaitOutput("from: noreply@x.test\nsubject: Welcome\nno urls here");
    expect(labeled.sender).toBe("noreply@x.test");
    expect(labeled.subject).toBe("Welcome");
  });

  test("links are verification-first and capped at 8, with the overflow counted", () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://t.test/p?i=${i}`);
    urls.push("https://t.test/verify?token=z");
    expect(urls.length).toBe(11);
    const raw = "noreply@t.test\tSubject\n" + urls.join(" ");
    const normalized = formatWaitResult(raw, { action: "wait", address: "a@b.test", provider: "mailtm" }, 0);
    expect(normalized).toContain("links (8 of 11):");
    const linkLines = normalized.split("\n").filter((line) => line.startsWith("  https://"));
    expect(linkLines.length).toBe(8);
    expect(linkLines[0]).toContain("/verify?token=z");
  });

  test("a body without URLs says so explicitly", () => {
    expect(formatWaitResult("noreply@t.test\tYour verification code\nplain body", { action: "wait", address: "a@b.test", provider: "mailtm" }, 0)).toContain(
      "no links found in body"
    );
  });

  test("otp single-line output is labeled as a code", () => {
    expect(formatWaitResult("  4 8 2 913 ", { action: "wait", address: "a@b.test", provider: "mailtm", otp: true }, 0)).toMatch(/^code: 4 8 2 913$/);
  });

  test("a timed-out wait become an explicit notice, not the raw timeout fragment", () => {
    const notice = formatWaitResult("timeout: no message within 45s (mailbox empty)", { action: "wait", address: "a@b.test", provider: "mailtm", timeoutSec: 45 }, 2);
    expect(notice).toContain("wait: no message within 45s");
    expect(notice).toContain("disposable domains");
    expect(notice).toContain("timeoutSec (e.g. 90s)");
    expect(notice).not.toMatch(/timeout: no message/);
  });
});

describe("mailgen wait via fake cowbird", () => {
  test("exit 2 with a 53-byte stderr fragment surfaces an explicit no-message notice", async () => {
    uniqueDir();
    // A >=53-byte + newline stderr fragment, exactly the incident's raw wait payload shape.
    const line = "timeout: no message within 45s (mailbox had no unread mails) ";
    expect(line.length + 1).toBeGreaterThanOrEqual(53);
    const bin = join(work, "cowbird-fake");
    writeFileSync(bin, [
      "#!/bin/sh",
      `echo ${JSON.stringify(line)} >&2`,
      "exit 2",
    ].join("\n"));
    chmodSync(bin, 0o755);
    process.env.CYBER_MAILGEN_FILE = join(work, "registry.json");
    process.env.CYBER_EVIDENCE_DIR = join(work, "evidence");
    process.env.CYBER_COWBIRD_BIN = bin;
    const { text } = await runMailgen({ action: "wait", address: "probe@subhosttest.org", provider: "mailtm", timeoutSec: 45 }, undefined);
    expect(text).toContain("wait: no message within 45s");
    expect(text).toContain("mainstream-domain provider");
    expect(text).not.toContain("timeout: no message within 45s (mailbox)");
  });

  test("a found mail keeps sender, subject, and links in the result", async () => {
    uniqueDir();
    activate("noreply@speko.test\tVerify your SpekoAI email\n\nhttps://speko.test/verify?token=abc123");
    const { text } = await runMailgen({ action: "wait", address: "probe@subhosttest.org", provider: "mailtm" }, undefined);
    expect(text).toContain("sender: noreply@speko.test");
    expect(text).toContain("subject: Verify your SpekoAI email");
    expect(text).toContain("https://speko.test/verify?token=abc123");
  });
});

describe("mailgen body fetch (full message body)", () => {
  test("parseBodyJson accepts the snippet envelope and rejects junk", () => {
    expect(parseBodyJson('{"messages":1,"sender":"noreply@t.test","subject":"Verify","text":"click token=abc","text_truncated":false,"links":["https://t.test/verify?token=abc"],"html_chars":900}')).toEqual({
      messages: 1,
      sender: "noreply@t.test",
      subject: "Verify",
      text: "click token=abc",
      textTruncated: false,
      links: ["https://t.test/verify?token=abc"],
      htmlChars: 900,
    });
    expect(parseBodyJson('{"messages":0}')).toBeNull();
    expect(parseBodyJson("no json")).toBeNull();
    expect(parseBodyJson('{"messages":1,"text":7,"links":"nope"}')).toEqual({
      messages: 1,
      sender: "",
      subject: "",
      text: "",
      textTruncated: false,
      links: [],
      htmlChars: 0,
    });
  });

  test("formatWaitResult with a fetched body renders text + provider links and drops the raw block", () => {
    const body: MailBody = {
      messages: 2,
      sender: "noreply@t.test",
      subject: "Verify",
      text: "Please confirm: https://go.test/verify?token=abc — or browse https://t.test/pricing.",
      textTruncated: false,
      links: ["https://t.test/verify?token=abc", "https://t.test/unsubscribe"],
      htmlChars: 5400,
    };
    const out = formatWaitResult("noreply@t.test\tVerify", { action: "wait", address: "a@b.test", provider: "mailtm" }, 0, body);
    expect(out).toContain("sender: noreply@t.test");
    expect(out).toContain("body (text):");
    expect(out).toContain("Please confirm");
    expect(out).toContain("html: 5400 chars (not shown)");
    // provider anchor list wins; bare text URLs merged in; verification first
    expect(out).toContain("https://t.test/verify?token=abc");
    expect(out).toContain("https://go.test/verify?token=abc");
    expect(out).not.toContain("--- cowbird output ---");
    // unsub link not duplicated by the bare-text merge
    expect(out.match(/https:\/\/t\.test\/unsubscribe/g)?.length).toBe(1);
  });

  test("a body-fetch note surfaces honestly without failing the wait", () => {
    const out = formatWaitResult("noreply@t.test\tVerify", { action: "wait", address: "a@b.test", provider: "mailtm" }, 0, null, "cowbird body fetch returned no content");
    expect(out).toContain("body: unavailable (cowbird body fetch returned no content)");
    expect(out).toContain("--- cowbird output ---");
  });

  test("integration: wait + body fetch through fake cowbird and fake python, state in argv only", async () => {
    uniqueDir();
    fakeCowbird('{"address":"probe@subhosttest.org","provider":"mailtm","address_ttl":"5m","state":"PROVIDER-STATE-199"}');
    await runMailgen({ action: "new" }, undefined);
    activate("noreply@speko.test\tVerify your SpekoAI email");
    // Fake python: dumps argv to its own file, emits a canned body envelope.
    const bodyBin = join(work, "python-fake");
    const bodyDump = join(work, "python-argv.txt");
    writeFileSync(join(work, "body.json"), JSON.stringify({
      messages: 1,
      sender: "noreply@speko.test",
      subject: "Verify your SpekoAI email",
      text: "Verify your email: https://speko.test/verify?token=cafe12 click within 24h.",
      text_truncated: false,
      links: ["https://speko.test/verify?token=cafe12"],
      html_chars: 1234,
    }));
    writeFileSync(bodyBin, [
      "#!/bin/sh",
      `for arg in "$@"; do printf '%s\\n' "$arg" >> "${bodyDump}"; printf '%s\\n' "---ARG---" >> "${bodyDump}"; done`,
      `cat ${JSON.stringify(join(work, "body.json"))}`,
    ].join("\n"));
    chmodSync(bodyBin, 0o755);
    process.env.CYBER_COWBIRD_PYTHON = bodyBin;
    const { text } = await runMailgen({ action: "wait", address: "probe@subhosttest.org", provider: "mailtm" }, undefined);
    expect(text).toContain("sender: noreply@speko.test");
    expect(text).toContain("body (text):");
    expect(text).toContain("https://speko.test/verify?token=cafe12");
    expect(text).toContain("html: 1234 chars (not shown)");
    expect(text).not.toContain("PROVIDER-STATE-199");
    // The state blob reached its argv slot, never stdout of either process.
    const pySlots = readFileSync(bodyDump, "utf8").split("\n---ARG---\n").slice(0, -1);
    expect(pySlots[0]).toBe("-c");
    expect(pySlots[1]).toContain("import asyncio");
    expect(pySlots.slice(2, 5)).toEqual(["mailtm", "probe@subhosttest.org", "PROVIDER-STATE-199"]);
  });

  test("integration: otp waits skip the body stage entirely", async () => {
    uniqueDir();
    fakeCowbird("4 8 2 913");
    const bodyBin = join(work, "python-fake");
    writeFileSync(bodyBin, "#!/bin/sh\necho '{\"messages\":99}' >&1\n");
    chmodSync(bodyBin, 0o755);
    process.env.CYBER_COWBIRD_PYTHON = bodyBin;
    const { text } = await runMailgen({ action: "wait", address: "probe@subhosttest.org", provider: "mailtm", otp: true }, undefined);
    expect(text).toMatch(/^code: 4 8 2 913$/);
  });

  test("integration: a failing body fetch degrades to a note, wait result intact", async () => {
    uniqueDir();
    fakeCowbird("noreply@t.test\tVerify");
    const bodyBin = join(work, "python-fake");
    writeFileSync(bodyBin, "#!/bin/sh\necho 'error: provider crashed' >&2\nexit 1\n");
    chmodSync(bodyBin, 0o755);
    process.env.CYBER_COWBIRD_PYTHON = bodyBin;
    const { text } = await runMailgen({ action: "wait", address: "probe@subhosttest.org", provider: "mailtm" }, undefined);
    expect(text).toContain("sender: noreply@t.test");
    expect(text).toContain("body: unavailable (error: provider crashed)");
  });
});

describe("mailgen Inbox API fixture", () => {
  test("uses installed Inbox list/get contract, keeps registry state, separates list cursors from newer waits", async () => {
    uniqueDir();
    fakeCowbird("", 0);
    const python = Bun.which("python3");
    if (!python) throw new Error("python3 required for local Inbox fixture");
    process.env.CYBER_COWBIRD_PYTHON = python;
    const packageDir = join(work, "python", "cowbird");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "__init__.py"), "");
    writeFileSync(join(packageDir, "errors.py"), "class NotSupported(Exception): pass\n");
    writeFileSync(join(packageDir, "models.py"), "class Address:\n def __init__(self, value, provider, state=None): self.value=value; self.provider=provider; self.state=state\n");
    writeFileSync(join(packageDir, "health.py"), "class HealthStore:\n @staticmethod\n def load(path): return None\ndef default_health_path(): return ''\n");
    writeFileSync(join(packageDir, "inbox.py"), [
      "from datetime import datetime, timezone",
      "from types import SimpleNamespace",
      "class Provider:",
      " async def list(self, address):",
      "  assert address.state == 'STATE_OK'",
      "  return [SimpleNamespace(id='new-1', sender='target@example.test', subject='Verify', received_at=datetime(2026,1,2,tzinfo=timezone.utc)), SimpleNamespace(id='old-1', sender='other@example.test', subject='Old', received_at=datetime(2026,1,1,tzinfo=timezone.utc))]",
      " async def get(self, address, ident): return SimpleNamespace(id=ident, text='Your code is 123456', links=())",
      "class Registry:",
      " def get(self, name): return Provider()",
      "class Pool:",
      " def __init__(self): self.health=SimpleNamespace(seed=lambda x: None); self.registry=Registry()",
      "class Inbox:",
      " def __init__(self, provider, address): self.provider=provider; self.address=address",
      " async def messages(self): return await self.provider.list(self.address)",
      " async def get(self, ident): return await self.provider.get(self.address, ident)",
      "_pool=None",
      "def default_pool():",
      " global _pool",
      " if _pool is None: _pool=Pool()",
      " return _pool",
      "async def aclose_default_pool(): pass",
    ].join("\n"));
    process.env.PYTHONPATH = join(work, "python");
    writeFileSync(process.env.CYBER_MAILGEN_FILE!, JSON.stringify({ "a@example.test": { provider: "fixture", state: "STATE_OK" } }));

    process.env.CYBER_COWBIRD_PYTHON = join(work, "must-not-run-python");
    writeFileSync(process.env.CYBER_MAILGEN_FILE!, JSON.stringify({ "a@example.test": { provider: "other-provider", state: "STATE_PRIVATE" } }));
    await expect(queryCowbirdInbox({ action: "list", provider: "fixture", address: "a@example.test" }))
      .rejects.toThrow(/registered to provider other-provider; refusing provider fixture/);
    process.env.CYBER_COWBIRD_PYTHON = python;
    writeFileSync(process.env.CYBER_MAILGEN_FILE!, JSON.stringify({ "a@example.test": { provider: "fixture", state: "STATE_OK" } }));

    const first = JSON.parse(await queryCowbirdInbox({ action: "list", provider: "fixture", address: "a@example.test", limit: 1 }));
    expect(first.messages[0].id).toBe("new-1");
    expect(first.nextCursor).toBeTruthy();
    const second = JSON.parse(await queryCowbirdInbox({ action: "list", provider: "fixture", address: "a@example.test", cursor: first.nextCursor, limit: 1 }));
    expect(second.messages[0].id).toBe("old-1");
    const { text: waited } = await runMailgen({ action: "wait", provider: "fixture", address: "a@example.test", afterMessageId: "old-1", sender: "target@", subject: "verify", receivedAfter: "2026-01-01T00:00:00Z", otp: true, timeoutSec: 1 }, undefined);
    expect(waited).toBe("code: 123456");
  });
});

afterAll(() => {
  if (savedEnv.CYBER_COWBIRD_BIN === undefined) delete process.env.CYBER_COWBIRD_BIN;
  if (savedEnv.CYBER_MAILGEN_FILE === undefined) delete process.env.CYBER_MAILGEN_FILE;
  if (savedEnv.CYBER_EVIDENCE_DIR === undefined) delete process.env.CYBER_EVIDENCE_DIR;
  if (savedEnv.CYBER_COWBIRD_PYTHON === undefined) delete process.env.CYBER_COWBIRD_PYTHON;
  if (savedEnv.PYTHONPATH === undefined) delete process.env.PYTHONPATH;
  else process.env.PYTHONPATH = savedEnv.PYTHONPATH;
});

void existsSync;
void rmSync;
