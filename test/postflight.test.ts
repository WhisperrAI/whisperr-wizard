import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  changedFiles,
  restoreToSnapshot,
  snapshotChanges,
  snapshotsEqual,
  takeCheckpoint,
} from "../src/core/git.js";
import { runVerifyCommand, verdictToVerified } from "../src/core/postflight.js";

const gitExec = promisify(execFile);
const git = (directory: string, ...args: string[]) =>
  gitExec("git", [
    "-C",
    directory,
    "-c",
    "user.email=wizard@test",
    "-c",
    "user.name=wizard",
    ...args,
  ]);
const verifyCommand =
  `node -e "process.exit(require('fs').existsSync('broken.txt') ? 1 : 0)"`;

test("verification failure restores only changes after the invocation snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whisperr-postflight-"));
  await git(directory, "init");
  await writeFile(join(directory, "app.txt"), "original\n");
  await writeFile(join(directory, "pristine.txt"), "pristine\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "base");
  const checkpoint = await takeCheckpoint(directory);

  await writeFile(join(directory, "app.txt"), "earlier wizard work\n");
  const beforeInvocation = await snapshotChanges(directory, checkpoint);
  await writeFile(join(directory, "broken.txt"), "syntax error\n");
  await writeFile(join(directory, "pristine.txt"), "current invocation\n");

  assert.equal(verdictToVerified(await runVerifyCommand(directory, verifyCommand)), false);
  assert.equal(snapshotsEqual(beforeInvocation, await snapshotChanges(directory, checkpoint)), false);
  assert.equal(await restoreToSnapshot(directory, checkpoint, beforeInvocation), true);
  assert.equal(await readFile(join(directory, "app.txt"), "utf8"), "earlier wizard work\n");
  assert.equal(await readFile(join(directory, "pristine.txt"), "utf8"), "pristine\n");
  await assert.rejects(access(join(directory, "broken.txt")));
  assert.equal(verdictToVerified(await runVerifyCommand(directory, verifyCommand)), true);
});

test("invocation snapshots preserve staged and partially staged changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "whisperr-staged-snapshot-"));
  await git(directory, "init");
  await writeFile(join(directory, "app.txt"), "original\n");
  await git(directory, "add", ".");
  await git(directory, "commit", "-m", "base");
  const checkpoint = await takeCheckpoint(directory);

  await writeFile(join(directory, "app.txt"), "staged\n");
  await git(directory, "add", "app.txt");
  await writeFile(join(directory, "app.txt"), "working tree\n");
  const beforeInvocation = await snapshotChanges(directory, checkpoint);
  assert.deepEqual(await changedFiles(directory, checkpoint), ["app.txt"]);

  await writeFile(join(directory, "app.txt"), "wizard edit\n");
  assert.equal(await restoreToSnapshot(directory, checkpoint, beforeInvocation), true);
  assert.equal(await readFile(join(directory, "app.txt"), "utf8"), "working tree\n");
  assert.match((await git(directory, "diff", "--cached")).stdout, /staged/);
});

test("verdictToVerified keeps unavailable verification distinct from failure", () => {
  assert.equal(verdictToVerified({ ran: false, ok: true, output: "" }), null);
  assert.equal(
    verdictToVerified({ ran: true, ok: false, output: "", toolMissing: true }),
    null,
  );
  assert.equal(
    verdictToVerified({ ran: true, ok: false, output: "", timedOut: true }),
    null,
  );
  assert.equal(verdictToVerified({ ran: true, ok: false, output: "" }), false);
});

test("verification subprocesses do not inherit model credentials", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-reach-child";
  try {
    const result = await runVerifyCommand(
      process.cwd(),
      `node -e "process.exit(process.env.OPENAI_API_KEY ? 1 : 0)"`,
    );
    assert.equal(result.ok, true);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
