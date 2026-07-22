import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resumeStatePath, saveResumeState } from "../src/core/resumeState.js";
import { projectKindForTarget, selectOrCreateRun } from "../src/core/workflow.js";
import type { WizardRunSnapshot } from "../src/core/runtime.js";
import type { Playbook, WizardSession } from "../src/types.js";

const session: WizardSession = { token: "token", appId: "app_1", expiresAt: 0 };
const playbook = {
  target: {
    id: "web-js",
    displayName: "Web",
    language: "typescript",
    availability: "available",
  },
} as Playbook;

test("selectOrCreateRun prefers runtime conversation state for a matching local run", async () => {
  const root = await mkdtemp(join(tmpdir(), "whisperr-workflow-"));
  const env = { WHISPERR_WIZARD_STATE_DIR: root };
  const path = resumeStatePath(
    { apiBaseUrl: "https://api.test", appId: "app_1", repoFingerprint: "repo_1" },
    env,
  );
  await saveResumeState(path, { runId: "wrun_existing", conversationId: "conv_existing" });
  let creates = 0;
  const snapshot = makeSnapshot();
  snapshot.run.id = "wrun_existing";
  snapshot.run.modelConversationId = "conv_runtime";
  const runtime = {
    async getRun() {
      return snapshot;
    },
    async createOrResumeRun() {
      creates++;
      return snapshot;
    },
  };
  try {
    const selected = await selectOrCreateRun({
      apiBaseUrl: "https://api.test",
      repoPath: "/tmp/demo",
      repoFingerprint: "repo_1",
      session,
      playbook,
      runtime: runtime as never,
      env,
    });
    assert.equal(selected.resumed, true);
    assert.equal(selected.snapshot.run.id, "wrun_existing");
    assert.equal(selected.snapshot.run.modelConversationId, "conv_runtime");
    assert.equal(creates, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selectOrCreateRun resumes failed runs through the explicit runtime transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "whisperr-workflow-failed-"));
  const env = { WHISPERR_WIZARD_STATE_DIR: root };
  const path = resumeStatePath(
    { apiBaseUrl: "https://api.test", appId: "app_1", repoFingerprint: "repo_1" },
    env,
  );
  await saveResumeState(path, { runId: "wrun_failed", conversationId: "conv_existing" });
  const failed = makeSnapshot();
  failed.run.id = "wrun_failed";
  failed.run.status = "failed";
  let creates = 0;
  const runtime = {
    async getRun() {
      return failed;
    },
    async createOrResumeRun() {
      creates++;
      failed.run.status = "running";
      failed.resumed = true;
      return failed;
    },
  };
  try {
    const selected = await selectOrCreateRun({
      apiBaseUrl: "https://api.test",
      repoPath: "/tmp/demo",
      repoFingerprint: "repo_1",
      session,
      playbook,
      runtime: runtime as never,
      env,
    });
    assert.equal(creates, 1);
    assert.equal(selected.resumed, true);
    assert.equal(selected.snapshot.run.status, "running");
    assert.equal(selected.snapshot.run.modelConversationId, "conv_existing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("selectOrCreateRun fails a newly active run when local resume state cannot be saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "whisperr-workflow-state-failure-"));
  const blockedStateRoot = join(root, "not-a-directory");
  await writeFile(blockedStateRoot, "blocked\n", "utf8");
  const updates: Array<Record<string, unknown>> = [];
  const snapshot = makeSnapshot();
  const runtime = {
    async createOrResumeRun() {
      return snapshot;
    },
    async updateRun(_runId: string, update: Record<string, unknown>) {
      updates.push(update);
      return snapshot.run;
    },
  };
  try {
    await assert.rejects(() =>
      selectOrCreateRun({
        apiBaseUrl: "https://api.test",
        repoPath: "/tmp/demo",
        repoFingerprint: "repo_1",
        session,
        playbook,
        runtime: runtime as never,
        env: { WHISPERR_WIZARD_STATE_DIR: blockedStateRoot },
      }),
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project kinds put Next.js fullstack and server SDKs on the backend", () => {
  assert.equal(projectKindForTarget("nextjs"), "fullstack");
  assert.equal(projectKindForTarget("node"), "backend");
  assert.equal(projectKindForTarget("flutter"), "frontend");
});

function makeSnapshot(): WizardRunSnapshot {
  return {
    app: { id: "app_1" },
    project: {
      id: "wpr_1",
      appId: "app_1",
      repoFingerprint: "repo_1",
      displayName: "demo",
      target: "web-js",
      kind: "frontend",
    },
    run: { id: "wrun_1", projectId: "wpr_1", status: "running", phase: "analyzing" },
    model: { groups: [], interventions: [], events: [], links: [] },
    ingestion: { apiKey: "key", baseUrl: "https://ingest.test" },
  };
}
