import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderExitCard, resumeCommand } from "../src/exit-card.ts";

describe("exit card", () => {
  const details = { sessionId: "1f3a9c2b" };

  test("renders a clean wordmark, the session id and the resume command", () => {
    const card = renderExitCard(details, false);
    expect(card).toMatch(/^PI CYBER\n/);
    expect(card).toContain("engagement closed");
    expect(card).toContain("1f3a9c2b");
    expect(card).toContain("resume");
    expect(card).toContain("--session 1f3a9c2b");
    expect(card).not.toContain("file");
    expect(card).not.toContain(".jsonl");
  });

  test("the neutral rule spans the content without an oversized block logo", () => {
    const [wordmark, rule] = renderExitCard(details, false).split("\n");
    expect(wordmark).toBe("PI CYBER");
    expect(rule.length).toBeGreaterThan(wordmark.length);
    expect(rule.length).toBeLessThan(60);
  });

  test("plain mode carries no ANSI escapes", () => {
    const card = renderExitCard(details, false);
    // eslint-disable-next-line no-control-regex
    expect(card).not.toMatch(/\x1b\[/);
  });

  test("colour mode uses the offense theme red token", () => {
    expect(renderExitCard(details, true)).toMatch(/\x1b\[38;2;238;90;137m/);
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
