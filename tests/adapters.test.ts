import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { adapters, byName } from "../src/adapters/index.ts";
import type { AdapterDef } from "../src/adapters/types.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "adapters");

/** Load a fixture and append a malformed line: parse() must skip it. */
function fixtureWithJunk(name: string): string {
  const lines = readFileSync(join(FIXTURES, name), "utf-8").trimEnd().split("\n");
  return [...lines, "not-json-at-all + [truncation]", ""].join("\n");
}

function fixtureDocument(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

const MALFORMED_DOCUMENT = "prosemessages from a progress bar"; // no parseable document at all

describe("adapter registry", () => {
  test("registers exactly the 11 planned adapters with unique names", () => {
    const names = adapters.map((a) => a.name);
    expect(names.length).toBe(11);
    expect(new Set(names).size).toBe(11);
    expect(names).toEqual([
      "subfinder", "httpx", "dnsx", "katana", "ffuf", "naabu",
      "nuclei", "uncover", "vulnx", "interactsh", "semgrep",
    ]);
  });

  test("byName resolves registry entries and returns undefined for unknown", () => {
    expect(byName("nuclei")?.bin).toBe("nuclei");
    expect(byName("interactsh")?.bin).toBe("interactsh-client"); // binary name differs
    expect(byName("ffuf")).toBeDefined();
    expect(byName("evil-tool")).toBeUndefined();
  });

  test("every schema is a Typebox object with additionalProperties:false", () => {
    for (const adapter of adapters) {
      const schema = adapter.schema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(typeof adapter.buildArgs).toBe("function");
      expect(typeof adapter.parse).toBe("function");
    }
  });

  test("versionFlag matches the Task-3 override map", () => {
    for (const adapter of adapters) {
      if (adapter.name === "ffuf") expect(adapter.versionFlag).toBe("-V");
      else if (adapter.name === "semgrep") expect(adapter.versionFlag).toBe("--version");
      else expect(adapter.versionFlag).toBe("-version"); // PD kit
    }
  });

  test("all adapters are non-mutating, i.e. no target-state writes by design", () => {
    for (const adapter of adapters) expect(adapter.mutating).toBe(false);
  });

  test("every array param carries an explicit maxItems cap (binding, pinned against drift)", () => {
    for (const adapter of adapters) {
      const schema = adapter.schema as { properties: Record<string, Record<string, unknown>> };
      for (const [name, property] of Object.entries(schema.properties)) {
        if (property.type !== "array") continue;
        expect([adapter.name, name, property.maxItems]).toStrictEqual([adapter.name, name, expect.any(Number)]);
        expect(property.maxItems).toBeGreaterThan(0);
      }
    }
  });
});

describe("subfinder", () => {
  const adapter: AdapterDef = byName("subfinder")!;

  test("parse tolerates a malformed line and keeps the valid hit", () => {
    const findings = adapter.parse(fixtureWithJunk("subfinder.jsonl"), "");
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("subfinder");
    expect(findings[0].key).toBe("api.example.com");
    expect(findings[0].meta?.source).toBe("crtsh");
    expect(findings[0].raw.length).toBeLessThanOrEqual(4000);
  });

  test("buildArgs emits -d/-json argv in order", () => {
    expect(adapter.buildArgs({ domain: "example.com" }, {})).toEqual([
      "-json", "-d", "example.com",
    ]);
    expect(adapter.buildArgs({ domain: "example.com", sources: ["crtsh", "dnsdumpster"] }, {})).toEqual([
      "-json", "-d", "example.com", "-source", "crtsh", "-source", "dnsdumpster",
    ]);
  });
});

describe("httpx", () => {
  const adapter: AdapterDef = byName("httpx")!;

  test("parse maps the jsonl probe record and skips junk", () => {
    const findings = adapter.parse(fixtureWithJunk("httpx.jsonl"), "");
    expect(findings.length).toBe(1);
    expect(findings[0].key).toBe("https://api.example.com/login");
    expect(findings[0].meta?.status).toBe(200);
    expect(findings[0].meta?.webserver).toBe("nginx");
    expect(findings[0].meta?.tech).toEqual(["HSTS", "Bootstrap"]);
  });

  test("buildArgs joins targets positionally (no -l list file, no temp files)", () => {
    expect(adapter.buildArgs({ targets: ["https://a.example.com", "https://b.example.com"], ports: [80, 8443] }, {}))
      .toEqual(["https://a.example.com", "https://b.example.com", "-json", "-p", "80,8443"]);
  });
});

describe("dnsx", () => {
  const adapter: AdapterDef = byName("dnsx")!;

  test("parse maps the answer record and skips junk", () => {
    const findings = adapter.parse(fixtureWithJunk("dnsx.jsonl"), "");
    expect(findings.length).toBe(1);
    expect(findings[0].key).toBe("api.example.com");
    expect(findings[0].meta?.status).toBe("NOERROR");
    expect(findings[0].meta?.a).toEqual(["203.0.113.7"]);
  });

  test("buildArgs repeats -d per domain instead of -l", () => {
    expect(adapter.buildArgs({ domains: ["a.example.com", "b.example.com"], recordType: "mx" }, {}))
      .toEqual(["-d", "a.example.com", "-d", "b.example.com", "-json", "-mx"]);
  });
});

describe("katana", () => {
  const adapter: AdapterDef = byName("katana")!;

  test("parse extracts request endpoints and skips junk/malformed", () => {
    const findings = adapter.parse(fixtureWithJunk("katana.jsonl"), "");
    expect(findings.length).toBe(1);
    expect(findings[0].key).toBe("https://api.example.com/admin");
    expect(findings[0].meta?.method).toBe("GET");
    expect(findings[0].meta?.status).toBe(200);
  });

  test("buildArgs emits positional targets with -jsonl and bounded depth", () => {
    expect(adapter.buildArgs({ targets: ["https://api.example.com"], depth: 3 }, {}))
      .toEqual(["https://api.example.com", "-jsonl", "-d", "3"]);
  });
});

describe("ffuf", () => {
  const adapter: AdapterDef = byName("ffuf")!;

  test("buildArgs throws exactly 'operator wordlist required' without opts.wordlistPath", () => {
    expect(() => adapter.buildArgs({ target: "https://api.example.com/FUZZ" }, {})).toThrow(
      "operator wordlist required",
    );
  });

  test("buildArgs uses the operator wordlist and enumerables for -mc/-e", () => {
    const argv = adapter.buildArgs(
      { target: "https://api.example.com/FUZZ", method: "POST", statusCodes: [200, 301], extensions: ["php"] },
      { wordlistPath: "/operator/wordlists/common.txt" },
    );
    expect(argv).toEqual([
      "-json", "-u", "https://api.example.com/FUZZ", "-w", "/operator/wordlists/common.txt",
      "-X", "POST", "-mc", "200,301", "-e", "php",
    ]);
  });

  test("parse flattens the result document and tolerates a malformed one", () => {
    const findings = adapter.parse(fixtureDocument("ffuf.json"), "");
    expect(findings.length).toBe(1);
    expect(findings[0].key).toBe("https://api.example.com/admin");
    expect(findings[0].meta?.fuzz).toBe("admin");
    expect(adapter.parse(MALFORMED_DOCUMENT, "")).toEqual([]);
  });
});

describe("naabu", () => {
  const adapter: AdapterDef = byName("naabu")!;

  test("parse maps host/ip/port and skips junk", () => {
    const findings = adapter.parse(fixtureWithJunk("naabu.jsonl"), "");
    expect(findings.length).toBe(1);
    expect(findings[0].key).toBe("203.0.113.7:8443");
    expect(findings[0].meta?.port).toBe(8443);
  });

  test("buildArgs repeats -host per host; syn only when requested", () => {
    expect(adapter.buildArgs({ hosts: ["api.example.com"] }, {})).toEqual([
      "-host", "api.example.com", "-json",
    ]);
    expect(adapter.buildArgs({ hosts: ["api.example.com"], ports: [80, 443], scanType: "syn" }, {})).toEqual([
      "-host", "api.example.com", "-json", "-p", "80,443", "-s", "syn",
    ]);
  });
});

describe("nuclei", () => {
  const adapter: AdapterDef = byName("nuclei")!;

  test("parse maps url:templateID keys with severity meta and skips junk", () => {
    const findings = adapter.parse(fixtureWithJunk("nuclei.jsonl"), "");
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("nuclei");
    expect(findings[0].key).toBe("https://api.example.com/admin:CVE-2024-1234");
    expect(findings[0].meta?.sev).toBe("high");
    expect(findings[0].meta?.name).toBe("Example Admin Panel Exposure");
  });

  test("buildArgs repeats -u targets, -severity per value, -id per template; -t only via opts", () => {
    expect(adapter.buildArgs({ targets: ["https://a.example.com", "https://b.example.com"] }, {})).toEqual([
      "-u", "https://a.example.com", "-u", "https://b.example.com", "-json",
    ]);
    expect(
      adapter.buildArgs(
        { targets: ["https://a.example.com"], severity: ["high", "critical"], templates: ["CVE-2024-1234"] },
        { templatesDir: "/operator/templates" },
      ),
    ).toEqual([
      "-u", "https://a.example.com", "-json",
      "-severity", "high", "-severity", "critical", "-id", "CVE-2024-1234",
      "-t", "/operator/templates",
    ]);
  });
});

describe("uncover", () => {
  const adapter: AdapterDef = byName("uncover")!;

  test("parse unwraps the event wrapper and skips junk", () => {
    const findings = adapter.parse(fixtureWithJunk("uncover.jsonl"), "");
    expect(findings.length).toBe(1);
    expect(findings[0].key).toBe("api.example.com:8443");
    expect(findings[0].meta?.source).toBe("censys");
  });

  test("buildArgs maps query/engines/limit; -l is the result-count limit", () => {
    expect(
      adapter.buildArgs({ query: "ssl.cert.subject.CN:api.example.com", engines: ["censys", "shodan"], limit: 5 }, {}),
    ).toEqual([
      "-json", "-q", "ssl.cert.subject.CN:api.example.com", "-e", "censys", "-e", "shodan", "-l", "5",
    ]);
  });
});

describe("vulnx", () => {
  const adapter: AdapterDef = byName("vulnx")!;

  test("parse reads advisory records (document + results array) and skips junk", () => {
    expect(adapter.parse(fixtureDocument("vulnx.json"), "")).toEqual([
      {
        kind: "vulnx",
        key: "CVE-2025-24990",
        raw: expect.any(String),
        meta: { severity: "high", title: "Example buffer overflow", published: "2025-03-01" },
      },
    ]);
    expect(adapter.parse(MALFORMED_DOCUMENT, "")).toEqual([]);
  });

  test("buildArgs routes sub-commands; search requires query, id/analyze require cveIds", () => {
    expect(adapter.buildArgs({ action: "search", query: "jira" }, {})).toEqual(["search", "jira", "-json"]);
    expect(adapter.buildArgs({ action: "id", cveIds: ["CVE-2025-24990", "CVE-2024-1234"] }, {}))
      .toEqual(["id", "CVE-2025-24990", "CVE-2024-1234", "-json"]);
    expect(() => adapter.buildArgs({ action: "search" }, {})).toThrow(`vulnx: action "search" requires a query string`);
    expect(() => adapter.buildArgs({ action: "analyze" }, {})).toThrow(`vulnx: action "analyze" requires cveIds`);
  });
});

describe("interactsh", () => {
  const adapter: AdapterDef = byName("interactsh")!;

  test("parse maps OOB interaction events to full_id keys and skips junk", () => {
    const findings = adapter.parse(fixtureWithJunk("interactsh.jsonl"), "");
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("interactsh");
    expect(findings[0].key).toBe("abc123.oast.example");
    expect(findings[0].meta?.protocol).toBe("dns");
    expect(findings[0].meta?.remoteIp).toBe("198.51.100.2");
  });

  test("buildArgs binds -server and poll interval as separate argv elements", () => {
    expect(adapter.buildArgs({ server: "https://oast.example", pollIntervalSec: 10 }, {})).toEqual([
      "-json", "-server", "https://oast.example", "-i", "10",
    ]);
  });
});

describe("semgrep", () => {
  const adapter: AdapterDef = byName("semgrep")!;

  test("parse flattens SARIF runs[].results[] and tolerates a malformed document", () => {
    const findings = adapter.parse(fixtureDocument("semgrep.sarif"), "");
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("semgrep");
    expect(findings[0].key).toBe("typescript.security.example:src/app.ts:42");
    expect(findings[0].meta?.level).toBe("error");
    expect(adapter.parse(MALFORMED_DOCUMENT, "")).toEqual([]);
  });

  test("buildArgs emits canonical order (subcommand + flags first, paths last)", () => {
    expect(adapter.buildArgs({ paths: ["src/", "fixtures/"], ruleSet: "p/owasp-top-ten" }, {})).toEqual([
      "scan", "--sarif", "--config", "p/owasp-top-ten", "src/", "fixtures/",
    ]);
    expect(adapter.buildArgs({ paths: ["src/"], ruleSet: "auto" }, {})).toEqual([
      "scan", "--sarif", "--config", "auto", "src/",
    ]);
  });

  test("paths are scan targets, not options — flags and missing input are rejected", () => {
    // the reviewer's smuggling example: paths must never reach the --config slot
    expect(() => adapter.buildArgs({ paths: ["--config", "p/exploit-pack"], ruleSet: "auto" }, {})).toThrow(
      'field-param "paths" must not start with "-"',
    );
    expect(() => adapter.buildArgs({ paths: ["scan", "--sarif"], ruleSet: "auto" }, {})).toThrow(
      'field-param "paths" must not start with "-"',
    );
    expect(() => adapter.buildArgs({ ruleSet: "auto" }, {})).toThrow('semgrep: missing required param "paths"');
  });
});

const FLAG_LIKE_FIELDS: Array<{ adapter: string; params: Record<string, unknown>; message: string }> = [
  { adapter: "httpx", params: { targets: ["https://a.example.com", "-l", "/etc/passwd"] }, message: "targets" },
  { adapter: "katana", params: { targets: ["-l", "/etc/hosts"] }, message: "targets" },
  { adapter: "dnsx", params: { domains: ["-l", "/etc/hosts"] }, message: "domains" },
  { adapter: "naabu", params: { hosts: ["-host", "evil"] }, message: "hosts" },
  { adapter: "nuclei", params: { targets: ["-l", "/etc/passwd"] }, message: "targets" },
  { adapter: "subfinder", params: { domain: "-d", sources: [] }, message: "domain" },
  { adapter: "subfinder", params: { domain: "example.com", sources: ["crtsh", "-d"] }, message: "sources" },
  { adapter: "ffuf", params: { target: "-w /etc/passwd" }, message: "target" },
  { adapter: "uncover", params: { query: "-help" }, message: "query" },
  { adapter: "vulnx", params: { action: "search", query: "-h" }, message: "query" },
  { adapter: "vulnx", params: { action: "id", cveIds: ["CVE-2025-24990", "--json"] }, message: "cveIds" },
  { adapter: "interactsh", params: { server: "-foo" }, message: "server" },
];

function adapterByName(name: string): AdapterDef {
  const adapter = byName(name);
  if (!adapter) throw new Error(`test setup: missing adapter ${name}`);
  return adapter;
}

describe("flag-injection guards (F1)", () => {
  for (const { adapter: name, params, message } of FLAG_LIKE_FIELDS) {
    test(`${name}: a "-${message}"-like value in "${message}" is rejected before argv`, () => {
      expect(() => adapterByName(name).buildArgs(params, { wordlistPath: "/operator/wordlists/common.txt" })).toThrow(
        `field-param "${message}" must not start with "-"`,
      );
    });
  }

  test("operator-approved extra stays verbatim (flag-capable, never model-authored)", () => {
    expect(byName("httpx")!.buildArgs({ targets: ["https://a.example.com"], extra: ["-file", "list.txt"] }, {})).toEqual([
      "https://a.example.com", "-json", "-file", "list.txt",
    ]);
  });

  test("operator extra is capped locally at 4 items even without schema validation (M4)", () => {
    expect(
      byName("httpx")!.buildArgs({ targets: ["https://a.example.com"], extra: ["-a", "-b", "-c", "-d", "-e"] }, {}),
    ).toEqual(["https://a.example.com", "-json", "-a", "-b", "-c", "-d"]);
  });
  test("interactsh extra is capped locally at 4 items too (M4 residual)", () => {
    expect(
      byName("interactsh")!.buildArgs({ extra: ["-a", "-b", "-c", "-d", "-e"] }, {}),
    ).toEqual(["-json", "-a", "-b", "-c", "-d"]);
  });});

describe("degenerate argv guards (M3): missing required input throws instead of junk argv", () => {
  const CASES: Array<[string, Record<string, unknown>, string]> = [
    ["subfinder", {}, "subfinder: missing required param \"domain\""],
    ["httpx", { targets: [] }, "httpx: missing required param \"targets\""],
    ["dnsx", { domains: [] }, "dnsx: missing required param \"domains\""],
    ["katana", { targets: [] }, "katana: missing required param \"targets\""],
    ["ffuf", {}, "ffuf: missing required param \"target\""],
    ["naabu", { hosts: [] }, "naabu: missing required param \"hosts\""],
    ["nuclei", { targets: [] }, "nuclei: missing required param \"targets\""],
    ["uncover", { engines: [] }, "uncover: missing required param \"query\""],
    ["vulnx", { action: "search", query: "" }, "vulnx: action \"search\" requires a query string"],
  ];
  for (const [name, params, expected] of CASES) {
    test(`${name}: missing required input → ${expected}`, () => {
      expect(() => adapterByName(name).buildArgs(params, {})).toThrow(expected);
    });
  }
});
