import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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

/**
 * True when `file` was already part of the repo at the checkpoint — committed
 * in baseRef, or tracked in the index for a repo with no commits yet. Lets
 * callers tell a file the wizard's agent just wrote apart from one that was
 * in the customer's tree all along.
 */
export async function wasTrackedAtCheckpoint(
  repoPath: string,
  checkpoint: GitCheckpoint,
  file: string,
): Promise<boolean> {
  if (!checkpoint.isRepo) return false;
  if (checkpoint.baseRef) {
    const res = await run(repoPath, [
      "ls-tree",
      "--name-only",
      checkpoint.baseRef,
      "--",
      file,
    ]);
    return res.ok && res.stdout.trim() !== "";
  }
  const res = await run(repoPath, ["ls-files", "--", file]);
  return res.ok && res.stdout.trim() !== "";
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
 * Exact contents of every file changed since the checkpoint at one moment in
 * time. Lets a later agent pass's edits be undone precisely — back to this
 * snapshot — without touching the (already verified) work that came before it.
 * `null` marks a file that was deleted from the working tree at snapshot time.
 */
export type ChangesSnapshot = Map<string, Buffer | null>;

export async function snapshotChanges(
  repoPath: string,
  checkpoint: GitCheckpoint,
): Promise<ChangesSnapshot> {
  const snapshot: ChangesSnapshot = new Map();
  for (const file of await changedFiles(repoPath, checkpoint)) {
    try {
      snapshot.set(file, await readFile(join(repoPath, file)));
    } catch {
      snapshot.set(file, null);
    }
  }
  return snapshot;
}

/** True when the working tree's changes are byte-identical to the snapshot. */
export function snapshotsEqual(a: ChangesSnapshot, b: ChangesSnapshot): boolean {
  if (a.size !== b.size) return false;
  for (const [file, content] of a) {
    const other = b.get(file);
    if (other === undefined) return false;
    if (content === null || other === null) {
      if (content !== other) return false;
    } else if (!content.equals(other)) {
      return false;
    }
  }
  return true;
}

/**
 * Return the working tree to a snapshot taken between the checkpoint and now.
 * Files recorded in the snapshot get their exact bytes back; files that
 * changed only after the snapshot go back to their checkpoint state (they were
 * untouched when the snapshot was taken).
 */
export async function restoreToSnapshot(
  repoPath: string,
  checkpoint: GitCheckpoint,
  snapshot: ChangesSnapshot,
): Promise<boolean> {
  try {
    const current = await changedFiles(repoPath, checkpoint);
    for (const file of new Set([...current, ...snapshot.keys()])) {
      const recorded = snapshot.get(file);
      const path = join(repoPath, file);
      if (recorded === undefined) {
        // Untouched at snapshot time, so its pre-snapshot state is the
        // checkpoint's. Tracked -> check out; brand-new file -> remove.
        if (checkpoint.baseRef) {
          const co = await run(repoPath, ["checkout", checkpoint.baseRef, "--", file]);
          if (co.ok) continue;
        }
        await rm(path, { force: true });
      } else if (recorded === null) {
        await rm(path, { force: true });
      } else {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, recorded);
      }
    }
    return true;
  } catch {
    return false;
  }
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
 * changed files for `track(... '<event_type>' ...)` calls first, then falling
 * back to exact quoted event-code literals for wrapper/constant indirection.
 * Deterministic and agent-cooperation-free — we read the result from the code,
 * not a self-report.
 *
 * The event type can be the FIRST argument (browser/Flutter SDKs:
 * `track('event', {...})`) or a LATER one (server SDKs take the user id first:
 * `track(userId, 'event', {...})`), so we match the quoted event type anywhere
 * inside the `track(` argument list — across a short, possibly multi-line span —
 * rather than only immediately after the opening paren.
 */
export async function scanWiredEvents(
  repoPath: string,
  files: string[],
  eventTypes: string[],
): Promise<Map<string, string>> {
  const wired = new Map<string, string>();
  const patterns = eventTypes.map((e) => ({
    eventType: e,
    trackRe: new RegExp(
      `\\btrack\\s*\\(\\s*[\\s\\S]{0,160}?['"\`]${escapeRegExp(e)}['"\`]`,
    ),
    literalRe: quotedLiteralRegExp(e),
  }));
  const contents: Array<{ file: string; content: string }> = [];

  for (const file of files) {
    try {
      contents.push({ file, content: await readFile(join(repoPath, file), "utf8") });
    } catch {
      continue;
    }
  }

  for (const { file, content } of contents) {
    for (const { eventType, trackRe } of patterns) {
      if (!wired.has(eventType) && trackRe.test(content)) {
        wired.set(eventType, file);
      }
    }
  }

  for (const { file, content } of contents) {
    for (const { eventType, literalRe } of patterns) {
      if (!wired.has(eventType) && literalRe.test(content)) {
        wired.set(eventType, file);
      }
    }
  }
  return wired;
}

function quotedLiteralRegExp(eventType: string): RegExp {
  const leftBoundary = /^\w/.test(eventType) ? "\\b" : "";
  const rightBoundary = /\w$/.test(eventType) ? "\\b" : "";
  return new RegExp(`(['"\`])${leftBoundary}${escapeRegExp(eventType)}${rightBoundary}\\1`);
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
