import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export class WorktreeError extends Error {
  constructor(
    readonly code: "not_a_repo" | "dirty_repo" | "git_failed",
    message: string,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface WorktreeHandle {
  path: string;
  baseRef: string;
  repoPath: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", () => resolve({ ok: false, stdout, stderr: "git is not available" }));
    child.on("close", (exitCode) => resolve({ ok: exitCode === 0, stdout, stderr }));
  });
}

async function must(cwd: string, args: string[]): Promise<string> {
  const result = await git(cwd, args);
  if (!result.ok) {
    throw new WorktreeError("git_failed", `git ${args.join(" ")}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function safeRepoFile(repoPath: string, file: string): string {
  const path = resolve(repoPath, file);
  if (path === repoPath || !path.startsWith(repoPath + sep) || relative(repoPath, path).startsWith("..")) {
    throw new WorktreeError("git_failed", `unsafe progress file path: ${file}`);
  }
  return path;
}

async function dirtyFiles(repoPath: string): Promise<string[]> {
  const tracked = await must(repoPath, ["diff", "--name-only", "-z", "HEAD"]);
  const untracked = await must(repoPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [...new Set((tracked + untracked).split("\0").filter(Boolean))];
}

async function seedWorktree(
  repoPath: string,
  worktreePath: string,
  files: string[],
): Promise<void> {
  for (const file of files) {
    const source = safeRepoFile(repoPath, file);
    const destination = safeRepoFile(worktreePath, file);
    try {
      await lstat(source);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true, force: true });
    } catch {
      await rm(destination, { recursive: true, force: true });
    }
  }
}

export async function createWorktree(
  repoPath: string,
  force = false,
  allowedDirtyFiles: string[] = [],
): Promise<WorktreeHandle> {
  const inside = await git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) {
    throw new WorktreeError("not_a_repo", "the target directory is not a git repository");
  }
  const dirty = await dirtyFiles(repoPath);
  const allowed = new Set(allowedDirtyFiles);
  const unexpected = dirty.filter((file) => !allowed.has(file));
  if (unexpected.length > 0 && !force) {
    throw new WorktreeError(
      "dirty_repo",
      `the repository has unrelated uncommitted changes (${unexpected.slice(0, 3).join(", ")}) — commit or stash them, or rerun with --force`,
    );
  }
  let baseRef = (await must(repoPath, ["rev-parse", "HEAD"])).trim();
  const path = await mkdtemp(join(tmpdir(), "whisperr-worktree-"));
  await must(repoPath, ["worktree", "add", "--detach", "--force", path, "HEAD"]);
  const seedFiles = force ? dirty : dirty.filter((file) => allowed.has(file));
  if (seedFiles.length > 0) {
    await seedWorktree(repoPath, path, seedFiles);
    await must(path, ["add", "-A"]);
    await must(path, [
      "-c", "user.name=Whisperr Wizard",
      "-c", "user.email=wizard@whisperr.net",
      "commit", "--no-gpg-sign", "-m", "Whisperr resume checkpoint",
    ]);
    baseRef = (await must(path, ["rev-parse", "HEAD"])).trim();
  }
  return { path, baseRef, repoPath };
}

export async function worktreePatch(handle: WorktreeHandle): Promise<string> {
  await must(handle.path, ["add", "-A"]);
  return must(handle.path, ["diff", "--cached", "--binary", handle.baseRef]);
}

export async function applyPatchToRepo(handle: WorktreeHandle, patch: string): Promise<void> {
  return applyPatch(handle.repoPath, patch, false);
}

export async function reversePatchInRepo(repoPath: string, patch: string): Promise<void> {
  return applyPatch(repoPath, patch, true);
}

async function applyPatch(repoPath: string, patch: string, reverse: boolean): Promise<void> {
  if (patch.trim() === "") {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["apply", ...(reverse ? ["--reverse"] : []), "--whitespace=nowarn"], {
      cwd: repoPath,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => reject(new WorktreeError("git_failed", String(error))));
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new WorktreeError("git_failed", `git apply failed: ${stderr.trim()}`));
      }
    });
    child.stdin.end(patch);
  });
}

export async function commitWorktreeCheckpoint(handle: WorktreeHandle): Promise<void> {
  await must(handle.path, ["add", "-A"]);
  const patch = await must(handle.path, ["diff", "--cached", "--binary", handle.baseRef]);
  if (patch.trim() === "") {
    return;
  }
  await must(handle.path, [
    "-c", "user.name=Whisperr Wizard",
    "-c", "user.email=wizard@whisperr.net",
    "commit", "--no-gpg-sign", "-m", "Whisperr integration checkpoint",
  ]);
  handle.baseRef = (await must(handle.path, ["rev-parse", "HEAD"])).trim();
}

export async function discardWorktreeChanges(handle: WorktreeHandle): Promise<void> {
  await must(handle.path, ["reset", "--hard", handle.baseRef]);
  await must(handle.path, ["clean", "-fd"]);
}

export async function savePartialPatch(handle: WorktreeHandle, destination: string): Promise<string | undefined> {
  const patch = await worktreePatch(handle);
  if (patch.trim() === "") {
    return undefined;
  }
  await writeFile(destination, patch, { mode: 0o600 });
  return destination;
}

export async function removeWorktree(handle: WorktreeHandle): Promise<void> {
  await git(handle.repoPath, ["worktree", "remove", "--force", handle.path]);
  await git(handle.repoPath, ["worktree", "prune"]);
}
