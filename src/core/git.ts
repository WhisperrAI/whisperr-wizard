import { spawn } from "node:child_process";

/**
 * The wizard auto-applies edits (user's choice). To make that safe, we take a
 * checkpoint before the agent runs so a revert is one command, and we can show
 * a clean diff of exactly what changed afterward.
 */

export interface GitCheckpoint {
  isRepo: boolean;
  /** Commit sha captured before edits (if a repo + had commits). */
  baseRef?: string;
  /** Branch the wizard is operating on. */
  branch?: string;
}

export async function takeCheckpoint(repoPath: string): Promise<GitCheckpoint> {
  const isRepo = (await run(repoPath, ["rev-parse", "--is-inside-work-tree"])).ok;
  if (!isRepo) return { isRepo: false };

  const branch = (
    await run(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])
  ).stdout.trim();
  const head = await run(repoPath, ["rev-parse", "HEAD"]);
  return {
    isRepo: true,
    baseRef: head.ok ? head.stdout.trim() : undefined,
    branch: branch || undefined,
  };
}

/** Names of files changed since the checkpoint (working tree + untracked). */
export async function changedFiles(
  repoPath: string,
  checkpoint: GitCheckpoint,
): Promise<string[]> {
  if (!checkpoint.isRepo) return [];
  const tracked = await run(repoPath, ["diff", "--name-only"]);
  const untracked = await run(repoPath, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const set = new Set<string>();
  for (const f of `${tracked.stdout}\n${untracked.stdout}`.split("\n")) {
    if (f.trim()) set.add(f.trim());
  }
  return [...set];
}

/** The exact command a user runs to undo everything the wizard did. */
export function revertHint(checkpoint: GitCheckpoint): string | undefined {
  if (!checkpoint.isRepo || !checkpoint.baseRef) return undefined;
  return `git restore . && git clean -fd   (back to ${checkpoint.baseRef.slice(0, 7)})`;
}

function run(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ ok: code === 0, stdout, stderr }));
    child.on("error", () => resolve({ ok: false, stdout, stderr }));
  });
}
