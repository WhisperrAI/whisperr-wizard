import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunContext, type FunctionTool } from "@openai/agents";
import test from "node:test";
import { promisify } from "node:util";
import {
  createRuntimeTools,
  persistCurrentIntegrationEvidence,
  type AgentToolState,
} from "../src/core/agentTools.js";
import { takeCheckpoint } from "../src/core/git.js";
import type { WizardRunSnapshot } from "../src/core/runtime.js";

function makePlaybook(): AgentToolState["playbook"] {
  return {
    target: {
      id: "test",
      displayName: "Test",
      language: "typescript",
      availability: "available",
    },
    async detect() {
      return null;
    },
    packageRef: "test",
    systemPrompt: "test",
  };
}

test("complete_run returns verifier errors to Sol without completing runtime", async () => {
  const snapshot = makeSnapshot();
  let completions = 0;
  const runtime = {
    async updateRun() {
      return snapshot.run;
    },
    async getRun() {
      return snapshot;
    },
    async completeRun() {
      completions++;
      return snapshot;
    },
  };
  const state: AgentToolState = {
    runtime: runtime as never,
    runId: "wrun_1",
    repoPath: process.cwd(),
    checkpoint: { isRepo: false },
    playbook: {
      ...makePlaybook(),
      verifyCommand: `node -e "console.error('compile failed'); process.exit(1)"`,
    },
    ingestionKey: "ingestion-secret",
    completed: false,
    latestSnapshot: snapshot,
    wiredEvents: [],
  };
  const entry = createRuntimeTools(state).find(
    (candidate): candidate is FunctionTool =>
      candidate.type === "function" && candidate.name === "complete_run",
  );
  assert.ok(entry);

  const result = await entry.invoke(
    new RunContext(),
    JSON.stringify({ summary: "Ready" }),
  );

  assert.match(JSON.stringify(result), /compile failed/);
  assert.match(JSON.stringify(result), /repair/i);
  assert.equal(completions, 0);
  assert.equal(state.completed, false);
});

test("complete_run persists partial event evidence before rejecting missing wiring", async () => {
  const snapshot = makeSnapshot();
  snapshot.model.events = [
    {
      id: "aev_wired",
      projectId: snapshot.project.id,
      code: "booking_started",
      name: "Booking started",
      reasoning: "Concrete handler.",
    },
    {
      id: "aev_missing",
      projectId: snapshot.project.id,
      code: "booking_completed",
      name: "Booking completed",
      reasoning: "Concrete handler.",
    },
  ];
  const updates: unknown[] = [];
  let completions = 0;
  const runtime = {
    async updateRun(_runId: string, update: unknown) {
      updates.push(update);
      return snapshot.run;
    },
    async getRun() {
      return snapshot;
    },
    async completeRun() {
      completions++;
      return snapshot;
    },
  };
  const state: AgentToolState = {
    runtime: runtime as never,
    runId: "wrun_1",
    repoPath: process.cwd(),
    checkpoint: { isRepo: false },
    playbook: makePlaybook(),
    ingestionKey: "ingestion-secret",
    completed: false,
    latestSnapshot: snapshot,
    wiredEvents: [],
    inspectIntegration: async () => ({
      files: ["src/app.ts"],
      identifyWired: true,
      wiredEvents: [
        { id: "aev_wired", code: "booking_started", status: "wired", file: "src/app.ts" },
        { id: "aev_missing", code: "booking_completed", status: "skipped" },
      ],
    }),
  };
  const entry = createRuntimeTools(state).find(
    (candidate): candidate is FunctionTool =>
      candidate.type === "function" && candidate.name === "complete_run",
  );
  assert.ok(entry);

  const result = await entry.invoke(new RunContext(), JSON.stringify({ summary: "Ready" }));

  assert.match(JSON.stringify(result), /Wire every generated event/i);
  assert.equal(completions, 0);
  assert.deepEqual(updates.at(-1), {
    integrationEvidence: {
      changedFiles: ["src/app.ts"],
      identifyWired: true,
      verificationStatus: "unavailable",
      events: [
        { eventId: "aev_wired", eventCode: "booking_started", file: "src/app.ts" },
      ],
    },
  });
});

test("complete_run accepts unavailable verification when integration evidence is complete", async () => {
  const snapshot = makeSnapshot();
  snapshot.model.events = [
    {
      id: "aev_wired",
      projectId: snapshot.project.id,
      code: "booking_started",
      name: "Booking started",
      reasoning: "Concrete handler.",
    },
  ];
  let completion: Record<string, unknown> | undefined;
  const runtime = {
    async updateRun() {
      return snapshot.run;
    },
    async getRun() {
      return snapshot;
    },
    async completeRun(_runId: string, input: Record<string, unknown>) {
      completion = input;
      return snapshot;
    },
  };
  const state: AgentToolState = {
    runtime: runtime as never,
    runId: "wrun_1",
    repoPath: process.cwd(),
    checkpoint: { isRepo: false },
    playbook: { ...makePlaybook(), verifyCommand: "whisperr-verifier-does-not-exist" },
    ingestionKey: "ingestion-secret",
    completed: false,
    latestSnapshot: snapshot,
    wiredEvents: [],
    inspectIntegration: async () => ({
      files: ["src/app.ts"],
      identifyWired: true,
      wiredEvents: [
        { id: "aev_wired", code: "booking_started", status: "wired", file: "src/app.ts" },
      ],
    }),
  };
  const entry = createRuntimeTools(state).find(
    (candidate): candidate is FunctionTool =>
      candidate.type === "function" && candidate.name === "complete_run",
  );
  assert.ok(entry);

  const result = await entry.invoke(new RunContext(), JSON.stringify({ summary: "Ready" }));

  assert.match(JSON.stringify(result), /"ok":true/);
  assert.equal(completion?.verificationStatus, "unavailable");
  assert.equal(state.completed, true);
});

test("resume revalidates evidence files even after prior wizard work was committed", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "whisperr-evidence-resume-"));
  const git = (...args: string[]) =>
    promisify(execFile)("git", [
      "-C",
      repoPath,
      "-c",
      "user.email=wizard@test",
      "-c",
      "user.name=wizard",
      ...args,
    ]);
  try {
    await git("init");
    await mkdir(join(repoPath, "src"));
    await writeFile(
      join(repoPath, "src/app.ts"),
      "whisperr.identify(user.id);\nwhisperr.track('booking_started');\n",
    );
    await writeFile(join(repoPath, ".env.local"), "EXISTING=value\n");
    await git("add", "-f", ".");
    await git("commit", "-m", "wizard work");
    const snapshot = makeSnapshot();
    snapshot.model.events = [{
      id: "aev_wired",
      projectId: snapshot.project.id,
      code: "booking_started",
      name: "Booking started",
      reasoning: "Concrete handler.",
    }];
    snapshot.run.integrationEvidence = {
      changedFiles: ["src/app.ts"],
      identifyWired: true,
      verificationStatus: "pending",
      events: [{ eventId: "aev_wired", eventCode: "booking_started", file: "src/app.ts" }],
    };
    let update: Record<string, unknown> | undefined;
    const state: AgentToolState = {
      runtime: {
        async getRun() {
          return snapshot;
        },
        async updateRun(_runId: string, input: Record<string, unknown>) {
          update = input;
          return snapshot.run;
        },
      } as never,
      runId: snapshot.run.id,
      repoPath,
      checkpoint: await takeCheckpoint(repoPath),
      playbook: makePlaybook(),
      ingestionKey: "ingestion-secret",
      completed: false,
      latestSnapshot: snapshot,
      wiredEvents: [],
    };

    await persistCurrentIntegrationEvidence(state);

    assert.deepEqual(update, { integrationEvidence: snapshot.run.integrationEvidence });
    await writeFile(join(repoPath, ".env.local"), "WHISPERR_KEY=visible\n");
    await assert.rejects(
      persistCurrentIntegrationEvidence(state),
      /credential file is visible to Git/,
    );
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

function makeSnapshot(): WizardRunSnapshot {
  return {
    app: { id: "app_1" },
    project: {
      id: "wpr_1",
      appId: "app_1",
      repoFingerprint: "repo_1",
      displayName: "demo",
      target: "test",
      kind: "frontend",
    },
    run: { id: "wrun_1", projectId: "wpr_1", status: "running", phase: "verifying" },
    model: { groups: [], interventions: [], events: [], links: [] },
    ingestion: { apiKey: "ingestion-secret", baseUrl: "https://ingest.test" },
  };
}
