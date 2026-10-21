import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderExitCard, resumeCommand } from "../src/exit-card.ts";

describe("exit card", () => {
  const details = { sessionId: "1f3a9c2b", sessionFile: "/tmp/sessions/1f3a9c2b.jsonl", sessionDir: "/tmp/sessions" };

  test("renders the banner, the session id and the resume command", () => {
    const card = renderExitCard(details, false);
    expect(card).toContain("engagement closed");
    expect(card).toContain("1f3a9c2b");
    expect(card).toContain("resume");
    expect(card).toContain("--session 1f3a9c2b");
    expect(card).toContain("/tmp/sessions/1f3a9c2b.jsonl");
  });

  test("every banner row is the same width so the block stays aligned", () => {
    const rows = renderExitCard(details, false).split("\n").slice(0, 6);
    const widths = new Set(rows.map((row) => row.length));
    expect(widths.size).toBe(1);
    expect(rows[0].length).toBeGreaterThan(40);
  });

  test("plain mode carries no ANSI escapes", () => {
    const card = renderExitCard(details, false);
    // eslint-disable-next-line no-control-regex
    expect(card).not.toMatch(/\x1b\[/);
  });

  test("colour mode wraps the banner in the escape sequence", () => {
    expect(renderExitCard(details, true)).toMatch(/\x1b\[38;5;196m/);
  });

  test("the resume command carries --session-dir only outside the default directory", () => {
    const defaultDir = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "sessions");
    expect(resumeCommand({ sessionId: "abc", sessionDir: defaultDir })).toBe("pi --session abc");
    // Matches the host's own quoting: a path of safe characters is left bare.
    expect(resumeCommand({ sessionId: "abc", sessionDir: "/somewhere/else" })).toBe("pi --session-dir /somewhere/else --session abc");
  });

  test("a path with a space is quoted so the command stays copy-pasteable", () => {
    const command = resumeCommand({ sessionId: "abc", sessionDir: "/with space/sessions" });
    expect(command).toContain("'/with space/sessions'");
  });
});
