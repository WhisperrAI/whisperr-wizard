import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProgressSink } from "../src/engine/output.js";
import { runEngine, type EngineRunInput } from "../src/engine/orchestrator.js";
import type { EngineModelConfig, EngineProvider, RoleInvocation } from "../src/engine/types.js";
import type { WizardConfig, WizardSession } from "../src/types.js";

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "orch-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(join(repo, "signup.swift"), "func completeSignup() {}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return repo;
}

interface MockState {
  items: Array<Record<string, unknown>>;
  completions: Array<Record<string, unknown>>;
  patches: Array<Record<string, unknown>>;
  snapshotEvents: Array<Record<string, unknown>>;
  failCompletion?: boolean;
}

function startMockRuntime(state: MockState): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const send = (payload: unknown) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(payload));
      };
      const url = request.url ?? "";
      if (request.method === "POST" && url === "/wizard/runs") {
        send({
          project: { id: "wproj_1", repoFingerprint: "fp", displayName: "App", target: "swift", kind: "frontend" },
          run: { id: "wrun_1", status: "running", phase: "authorizing" },
          resumed: false,
          universeMode: "wizard",
          app: {},
          snapshot: { setupStatus: "running", events: state.snapshotEvents },
          ingestion: { apiKey: "pk_test", baseUrl: "https://api.example.test" },
          onboardingContext: { business: "Meal tracking app" },
        });
        return;
      }
      if (request.method === "POST" && url.endsWith("/items")) {
        const parsed = JSON.parse(body) as { payload: Record<string, unknown> };
        state.items.push(parsed.payload);
        const id = `aev_${state.items.length}`;
        state.snapshotEvents.push({
          id, code: parsed.payload.code, name: parsed.payload.name,
          reasoning: parsed.payload.reasoning, projectId: "wproj_1",
          payloadSchema: parsed.payload.payloadSchema ?? {},
        });
        send({ kind: "event", created: true, item: { id } });
        return;
      }
      if (request.method === "POST" && url.endsWith("/complete")) {
        if (state.failCompletion) {
          response.statusCode = 500;
          send({ message: "completion unavailable" });
          return;
        }
        state.completions.push(JSON.parse(body) as Record<string, unknown>);
        send({ setupStatus: "complete" });
        return;
      }
      if (request.method === "PATCH") {
        state.patches.push(body ? (JSON.parse(body) as Record<string, unknown>) : {});
        send({ id: "wrun_1", status: "running", phase: "surveying" });
        return;
      }
      send({});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

const models: EngineModelConfig = {
  survey: { model: "m", maxTurns: 5, maxMs: 60_000 },
  design: { model: "m", maxTurns: 5, maxMs: 60_000 },
  edit: { model: "m", maxTurns: 5, maxMs: 60_000 },
  review: { model: "m", maxTurns: 5, maxMs: 60_000 },
};

test("orchestrator runs select -> register -> integrate -> apply end to end", async () => {
  const repo = initRepo();
  process.env.WHISPERR_WIZARD_STATE_DIR = mkdtempSync(join(tmpdir(), "orch-state-"));
  const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [] };
  const { server, port } = await startMockRuntime(state);

  const invokedRoles: string[] = [];
  const provider: EngineProvider = {
    name: "scripted",
    async invoke(invocation: RoleInvocation) {
      invokedRoles.push(invocation.role);
      if (invocation.role === "survey") {
        return { kind: "completed", text: "signup.swift has completeSignup()", costUsd: 0, turns: 1 };
      }
      if (invocation.role === "design") {
        const propose = invocation.tools.find((tool) => tool.name === "propose_event")!;
        await propose.handler({
          code: "signup_completed", name: "Signup completed", reasoning: "Activation moment.",
          anchorFile: "signup.swift", anchorSymbol: "completeSignup",
          payloadSchema: { plan: "Chosen plan" },
        });
        const finish = invocation.tools.find((tool) => tool.name === "finish_selection")!;
        await finish.handler({ summary: "one event" });
        return { kind: "completed", text: "done", costUsd: 0, turns: 2 };
      }
      if (invocation.role === "edit") {
        writeFileSync(join(invocation.cwd, "signup.swift"),
          "func completeSignup() { WhisperrEvents.signupCompleted(plan: plan) }\n");
        return { kind: "completed", text: "edited", costUsd: 0, turns: 2 };
      }
      return { kind: "completed", text: "VERDICT: pass", costUsd: 0, turns: 1 };
    },
  };

  const config = { apiBaseUrl: `http://127.0.0.1:${port}` } as WizardConfig;
  const session: WizardSession = { token: "tok", appId: "app_1", expiresAt: Date.now() / 1000 + 3600 };
  const input: EngineRunInput = {
    repoPath: repo,
    repoFingerprint: "fp",
    config,
    session,
    provider,
    models,
    target: "swift",
    projectKind: "frontend",
    playbookSystemPrompt: "system",
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }),
    callbacks: {
      reviewEvents: async (proposed) => proposed,
      confirmApply: async () => true,
    },
  };

  const result = await runEngine(input);
  server.close();

  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].code, "signup_completed");
  assert.equal(state.completions.length, 1);
  const completion = state.completions[0] as { events: Array<{ status: string }>; identifyWired: boolean };
  assert.equal(completion.events.length, 1);
  assert.equal(completion.events[0].status, "applied");
  assert.equal(result.applied, true);
  assert.ok(existsSync(join(repo, "WhisperrEvents.swift")));
  assert.ok(invokedRoles.includes("survey") && invokedRoles.includes("design") && invokedRoles.includes("review"));
});

test("orchestrator falls back on wrong universe mode", async () => {
  const server = createServer((request, response) => {
    response.statusCode = 409;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ code: "wrong_universe_mode", message: "generated app" }));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const repo = initRepo();
  process.env.WHISPERR_WIZARD_STATE_DIR = mkdtempSync(join(tmpdir(), "orch-state-"));
  const result = await runEngine({
    repoPath: repo,
    repoFingerprint: "fp2",
    config: { apiBaseUrl: `http://127.0.0.1:${port}` } as WizardConfig,
    session: { token: "tok", appId: "app_2", expiresAt: 0 },
    provider: { name: "none", invoke: async () => ({ kind: "failed", error: "never", costUsd: 0, turns: 0 }) },
    models,
    target: "swift",
    projectKind: "frontend",
    playbookSystemPrompt: "system",
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }),
    callbacks: { reviewEvents: async (p) => p, confirmApply: async () => false },
  });
  server.close();
  assert.equal(result.kind, "wrong_mode");
});

test("orchestrator marks the run failed when completion is rejected", async () => {
  const repo = initRepo();
  process.env.WHISPERR_WIZARD_STATE_DIR = mkdtempSync(join(tmpdir(), "orch-state-"));
  const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [], failCompletion: true };
  const { server, port } = await startMockRuntime(state);
  const result = await runEngine({
    repoPath: repo,
    repoFingerprint: "completion-failure",
    config: { apiBaseUrl: `http://127.0.0.1:${port}` } as WizardConfig,
    session: { token: "tok", appId: "app_completion", expiresAt: 0 },
    provider: {
      name: "empty",
      async invoke(invocation) {
        return invocation.role === "survey"
          ? { kind: "completed", text: "survey", costUsd: 0, turns: 1 }
          : { kind: "completed", text: "no events", costUsd: 0, turns: 1 };
      },
    },
    models,
    target: "swift",
    projectKind: "frontend",
    playbookSystemPrompt: "system",
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }),
    callbacks: { reviewEvents: async (proposed) => proposed, confirmApply: async () => false },
  });
  server.close();
  assert.equal(result.kind, "aborted");
  assert.ok(state.patches.some((patch) => patch.status === "failed"));
});
