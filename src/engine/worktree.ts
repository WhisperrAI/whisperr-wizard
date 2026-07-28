import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export async function createWorktree(repoPath: string, force = false): Promise<WorktreeHandle> {
  const inside = await git(repoPath, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok) {
    throw new WorktreeError("not_a_repo", "the target directory is not a git repository");
  }
  const status = await must(repoPath, ["status", "--porcelain"]);
  if (status.trim() !== "" && !force) {
    throw new WorktreeError(
      "dirty_repo",
      "the repository has uncommitted changes — commit or stash them, or rerun with --force",
    );
  }
  const baseRef = (await must(repoPath, ["rev-parse", "HEAD"])).trim();
  const path = await mkdtemp(join(tmpdir(), "whisperr-worktree-"));
  await must(repoPath, ["worktree", "add", "--detach", "--force", path, "HEAD"]);
  return { path, baseRef, repoPath };
}

export async function worktreePatch(handle: WorktreeHandle): Promise<string> {
  await must(handle.path, ["add", "-A"]);
  return must(handle.path, ["diff", "--cached", "--binary", handle.baseRef]);
}

export async function applyPatchToRepo(handle: WorktreeHandle, patch: string): Promise<void> {
  if (patch.trim() === "") {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["apply", "--whitespace=nowarn"], {
      cwd: handle.repoPath,
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
