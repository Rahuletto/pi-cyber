/**
 * Exit card — printed once when the engagement session quits.
 *
 * The banner is written from the `session_shutdown` handler, which the host
 * emits from `runtimeHost.dispose()`. On the interactive quit path the host
 * stops the TUI *before* disposing the runtime, so this write lands in the
 * restored terminal rather than the discarded alternate screen. That ordering
 * is the whole reason the card lives here instead of in the transcript.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** ANSI 256-colour. Kept raw so the card needs no dependency on the host theme. */
const RESET = "\x1b[0m";
const BANNER_COLOR = "\x1b[38;5;196m";
const RULE_COLOR = "\x1b[38;5;160m";
const LABEL_COLOR = "\x1b[38;5;244m";
const VALUE_COLOR = "\x1b[38;5;215m";
const COMMAND_COLOR = "\x1b[1m\x1b[38;5;196m";

const BANNER = [
  " ██████╗ ██╗      ██████╗██╗   ██╗██████╗ ███████╗██████╗ ",
  " ██╔══██╗╚██╗    ██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝██╔══██╗",
  " ██████╔╝ ╚██╗   ██║      ╚████╔╝ ██████╔╝█████╗  ██████╔╝",
  " ██╔═══╝   ██║   ██║       ██╔╝   ██╔══██╗██╔══╝  ██╔══██╗",
  " ██║       ██║   ╚██████╗  ██║    ██████╔╝███████╗██║  ██║",
  " ╚═╝      ╚═╝     ╚═════╝ ╚═╝     ╚═════╝ ╚══════╝╚═╝  ╚═╝",
];

export interface ExitCardDetails {
  /** Session identifier Pi uses to resume this conversation. */
  sessionId: string;
  /** Absolute path of the persisted session file, when it exists. */
  sessionFile?: string;
  /** Directory holding the session files. */
  sessionDir?: string;
  /** Working directory the session ran in. */
  cwd?: string;
}

/** Quote a path only when a shell would otherwise split it. */
function quote(value: string): string {
  return value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the resume command the same way the host does: the session id, plus
 * `--session-dir` only when the session lives outside the default directory.
 */
export function resumeCommand(details: ExitCardDetails): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  const defaultSessions = join(agentDir, "sessions");
  const args = ["pi"];
  if (details.sessionDir && !details.sessionDir.startsWith(defaultSessions)) {
    args.push("--session-dir", quote(details.sessionDir));
  }
  args.push("--session", details.sessionId);
  return args.join(" ");
}

/** Render the card. `color` false yields plain text for logs and pipes. */
export function renderExitCard(details: ExitCardDetails, color = true): string {
  const paint = (text: string, code: string) => (color ? `${code}${text}${RESET}` : text);
  const width = BANNER[0].length;
  const rule = "─".repeat(width);
  const lines: string[] = [];
  lines.push(BANNER.map((row) => paint(row, BANNER_COLOR)).join("\n"));
  lines.push(paint(rule, RULE_COLOR));
  lines.push(`  ${paint("engagement closed", LABEL_COLOR)} ${paint("·", LABEL_COLOR)} ${paint(details.sessionId, VALUE_COLOR)}`);
  lines.push(`  ${paint("resume  ", LABEL_COLOR)} ${paint(resumeCommand(details), COMMAND_COLOR)}`);
  if (details.sessionFile) lines.push(`  ${paint("file    ", LABEL_COLOR)} ${paint(details.sessionFile, LABEL_COLOR)}`);
  return lines.join("\n");
}

/**
 * Print the card to stdout. Returns false when nothing was written, so the
 * caller can stay quiet in non-interactive modes.
 */
export function writeExitCard(details: ExitCardDetails): boolean {
  if (!process.stdout.isTTY) return false;
  try {
    process.stdout.write(`${renderExitCard(details)}\n\n`);
    return true;
  } catch {
    // A closed or broken stdout must never turn a clean exit into a crash.
    return false;
  }
}
