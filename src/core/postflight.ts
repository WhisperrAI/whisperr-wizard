import { spawn } from "node:child_process";

/**
 * Deterministic postflight: after the coding agent finishes, WE run the
 * playbook's verify command (e.g. `flutter analyze`, `npm run typecheck`) and
 * read the exit code ourselves. The agent is told not to build/lint — this is
 * the guardrail that turns "the agent says it's done" into "the project still
 * compiles". It never trusts the agent's self-report.
 */

export interface VerifyResult {
  /** False when the playbook defines no verify command (nothing to do). */
  ran: boolean;
  /** True when the command exited 0. */
  ok: boolean;
  /** The command that was run, for display. */
  command?: string;
  exitCode?: number | null;
  /** Combined stdout+stderr, tail-trimmed for the terminal. */
  output: string;
  /** The verify tool isn't installed here (exit 127) — can't conclude either way. */
  toolMissing?: boolean;
  /** The command ran past its time budget and was killed. */
  timedOut?: boolean;
}

const MAX_OUTPUT = 4000;
const DEFAULT_TIMEOUT_MS = 180_000;

export function runVerifyCommand(
  repoPath: string,
  command: string | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<VerifyResult> {
  if (!command || !command.trim()) {
    return Promise.resolve({ ran: false, ok: true, output: "" });
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    // Playbook verify commands are static, trusted strings (e.g. "flutter
    // analyze"), so a shell invocation is safe and handles `npm run x` forms.
    const child = spawn(command, { cwd: repoPath, shell: true, env: process.env });
    let out = "";
    const append = (d: Buffer) => {
      out += d.toString();
      // Keep memory bounded on chatty tools; we only show the tail anyway.
      if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ran: true, ok: false, command, output: tail(out), timedOut: true });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ran: true,
        ok: code === 0,
        command,
        exitCode: code,
        output: tail(out),
        // 127 = "command not found": the verify tool isn't on PATH here.
        toolMissing: code === 127,
      });
    });
    child.on("error", () => {
      // spawn itself failed (e.g. shell missing) — treat as unable to verify.
      clearTimeout(timer);
      resolve({ ran: true, ok: false, command, output: tail(out), toolMissing: true });
    });
  });
}

function tail(s: string): string {
  const t = s.trim();
  return t.length > MAX_OUTPUT ? `…${t.slice(-MAX_OUTPUT)}` : t;
}
