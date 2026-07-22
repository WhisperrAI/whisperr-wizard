import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadResumeState,
  resumeStatePath,
  saveResumeState,
} from "../src/core/resumeState.js";

test("resume state is outside the repo, mode 0600, and stores identifiers only", async () => {
  const root = await mkdtemp(join(tmpdir(), "whisperr-state-"));
  try {
    const path = resumeStatePath(
      {
        apiBaseUrl: "https://api.test",
        appId: "app_1",
        repoFingerprint: "repo_1",
      },
      { WHISPERR_WIZARD_STATE_DIR: root },
    );
    await saveResumeState(path, { runId: "wrun_1", conversationId: "conv_1" });

    assert.equal(path.startsWith(root), true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      runId: "wrun_1",
      conversationId: "conv_1",
    });
    assert.deepEqual(await loadResumeState(path), {
      runId: "wrun_1",
      conversationId: "conv_1",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
