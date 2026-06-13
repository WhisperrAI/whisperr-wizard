import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

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

/** True if the repo has no uncommitted/untracked changes. */
export async function isWorkingTreeClean(repoPath: string): Promise<boolean> {
  const status = await run(repoPath, ["status", "--porcelain"]);
  return status.ok && status.stdout.trim() === "";
}

/**
 * Undo everything the wizard did, back to the checkpoint. Because the wizard
 * requires a clean tree before running, `reset --hard <baseRef>` + `clean -fd`
 * restores the exact pre-wizard state.
 */
export async function revertToCheckpoint(
  repoPath: string,
  checkpoint: GitCheckpoint,
): Promise<boolean> {
  if (!checkpoint.isRepo) return false;
  if (checkpoint.baseRef) {
    const reset = await run(repoPath, ["reset", "--hard", checkpoint.baseRef]);
    const clean = await run(repoPath, ["clean", "-fd"]);
    return reset.ok && clean.ok;
  }
  // Repo with no commits yet: just drop tracked edits + untracked files.
  const restore = await run(repoPath, ["restore", "."]);
  const clean = await run(repoPath, ["clean", "-fd"]);
  return restore.ok && clean.ok;
}

/**
 * A stable fingerprint for this repo, so the coverage ledger can tell apart
 * multiple codebases that belong to one Whisperr app (e.g. a Flutter app and a
 * Go backend). Prefers the git remote URL; falls back to the folder name.
 */
export async function repoFingerprint(repoPath: string): Promise<string> {
  const remote = await run(repoPath, ["remote", "get-url", "origin"]);
  const seed =
    remote.ok && remote.stdout.trim()
      ? normalizeRemote(remote.stdout.trim())
      : `dir:${basename(repoPath)}`;
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function normalizeRemote(url: string): string {
  // Normalize git@host:org/repo.git and https://host/org/repo(.git) to host/org/repo.
  return url
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Determine which manifest events the agent actually wired, by scanning the
 * changed files for `track('<event_type>')` calls. Deterministic and
 * agent-cooperation-free — we read the result from the code, not a self-report.
 */
export async function scanWiredEvents(
  repoPath: string,
  files: string[],
  eventTypes: string[],
): Promise<Map<string, string>> {
  const wired = new Map<string, string>();
  const patterns = eventTypes.map((e) => ({
    eventType: e,
    re: new RegExp(`track\\s*\\(\\s*['"\`]${escapeRegExp(e)}['"\`]`),
  }));

  for (const file of files) {
    let content = "";
    try {
      content = await readFile(join(repoPath, file), "utf8");
    } catch {
      continue;
    }
    for (const { eventType, re } of patterns) {
      if (!wired.has(eventType) && re.test(content)) {
        wired.set(eventType, file);
      }
    }
  }
  return wired;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
