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
  const tracked = checkpoint.baseRef
    ? await run(repoPath, ["diff", "--name-only", checkpoint.baseRef])
    : await run(repoPath, ["diff", "--name-only", "--cached"]);
  const unstaged = checkpoint.baseRef
    ? { stdout: "" }
    : await run(repoPath, ["diff", "--name-only"]);
  const untracked = await run(repoPath, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ]);
  const set = new Set<string>();
  for (const f of `${tracked.stdout}\n${unstaged.stdout}\n${untracked.stdout}`.split("\n")) {
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
 * Determine which generated events the agent actually wired by scanning
 * changed files for direct string arguments to Whisperr receiver track calls.
 * This is deliberately conservative because the result gates completion.
 *
 * The event type can be the FIRST argument (browser/Flutter SDKs:
 * `track('event', {...})`) or a LATER one (server SDKs take the user id first:
 * `track(userId, 'event', {...})`), so we match the quoted event type anywhere
 * inside the top-level `track(` argument list rather than accepting inert
 * constants, examples, comments, or unrelated bare functions named track.
 */
export async function scanWiredEvents(
  repoPath: string,
  files: string[],
  eventTypes: string[],
): Promise<Map<string, string>> {
  const wired = new Map<string, string>();
  for (const file of files) {
    try {
      const content = await readFile(join(repoPath, file), "utf8");
      for (const eventType of trackStringArguments(content)) {
        if (eventTypes.includes(eventType) && !wired.has(eventType)) {
          wired.set(eventType, file);
        }
      }
    } catch {
      continue;
    }
  }
  return wired;
}

function trackStringArguments(content: string): Set<string> {
  const values = new Set<string>();
  let index = 0;
  while (index < content.length) {
    const skipped = skipCommentOrString(content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (!/[A-Za-z_$]/.test(content[index] ?? "")) {
      index++;
      continue;
    }
    const start = index;
    while (/[A-Za-z0-9_$]/.test(content[index] ?? "")) index++;
    if (content.slice(start, index) !== "track" || !hasWhisperrReceiver(content, start)) continue;
    let open = index;
    while (/\s/.test(content[open] ?? "")) open++;
    if (content[open] !== "(") continue;
    index = collectTrackStringArguments(content, open, values);
  }
  return values;
}

function hasWhisperrReceiver(content: string, start: number): boolean {
  let cursor = skipReceiverWhitespaceBackward(content, start - 1);
  while (cursor >= 0) {
    cursor = consumeReceiverOperator(content, cursor);
    if (cursor < 0) return false;
    cursor = skipReceiverWhitespaceBackward(content, cursor);
    if (content[cursor] === "?") {
      cursor = skipReceiverWhitespaceBackward(content, cursor - 1);
    }
    const identifierEnd = cursor + 1;
    while (cursor >= 0 && /[A-Za-z0-9_$]/.test(content[cursor] ?? "")) cursor--;
    const identifier = content.slice(cursor + 1, identifierEnd).replace(/^\$/, "");
    if (!identifier) return false;
    if (identifier.toLowerCase() === "whisperr") return true;
    cursor = skipReceiverWhitespaceBackward(content, cursor);
  }
  return false;
}

function consumeReceiverOperator(content: string, cursor: number): number {
  const pair = content.slice(cursor - 1, cursor + 1);
  if (pair === "?." || pair === "::" || pair === "->") return cursor - 2;
  if (content[cursor] === ".") return cursor - 1;
  return -1;
}

function skipReceiverWhitespaceBackward(content: string, cursor: number): number {
  while (cursor >= 0 && /\s/.test(content[cursor] ?? "")) cursor--;
  return cursor;
}

export function hasWhisperrMethodCall(content: string, method: string): boolean {
  let index = 0;
  while (index < content.length) {
    const skipped = skipCommentOrString(content, index);
    if (skipped !== index) {
      index = skipped;
      continue;
    }
    if (!/[A-Za-z_$]/.test(content[index] ?? "")) {
      index++;
      continue;
    }
    const start = index;
    while (/[A-Za-z0-9_$]/.test(content[index] ?? "")) index++;
    if (content.slice(start, index) !== method || !hasWhisperrReceiver(content, start)) continue;
    while (/\s/.test(content[index] ?? "")) index++;
    if (content[index] === "(") return true;
  }
  return false;
}

function collectTrackStringArguments(
  content: string,
  open: number,
  values: Set<string>,
): number {
  let parentheses = 1;
  let braces = 0;
  let brackets = 0;
  let index = open + 1;
  while (index < content.length && parentheses > 0) {
    if (startsComment(content, index)) {
      index = skipComment(content, index);
      continue;
    }
    const character = content[index]!;
    if (character === "'" || character === '"' || character === "`") {
      const parsed = readStringLiteral(content, index, character);
      if (parentheses === 1 && braces === 0 && brackets === 0) values.add(parsed.value);
      index = parsed.end;
      continue;
    }
    if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
    else if (character === "{") braces++;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "[") brackets++;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    index++;
  }
  return index;
}

function skipCommentOrString(content: string, index: number): number {
  if (startsComment(content, index)) return skipComment(content, index);
  const character = content[index];
  if (character === "'" || character === '"' || character === "`") {
    return readStringLiteral(content, index, character).end;
  }
  return index;
}

function startsComment(content: string, index: number): boolean {
  return (
    content.startsWith("//", index) ||
    content.startsWith("/*", index) ||
    content[index] === "#"
  );
}

function skipComment(content: string, index: number): number {
  if (content.startsWith("/*", index)) {
    const end = content.indexOf("*/", index + 2);
    return end === -1 ? content.length : end + 2;
  }
  const end = content.indexOf("\n", index + 1);
  return end === -1 ? content.length : end + 1;
}

function readStringLiteral(
  content: string,
  start: number,
  quote: string,
): { value: string; end: number } {
  let value = "";
  let index = start + 1;
  while (index < content.length) {
    const character = content[index]!;
    if (character === "\\") {
      if (index + 1 < content.length) value += content[index + 1];
      index += 2;
      continue;
    }
    if (character === quote) return { value, end: index + 1 };
    value += character;
    index++;
  }
  return { value, end: content.length };
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
