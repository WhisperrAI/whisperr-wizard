import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProgressSink } from "../src/engine/output.js";
import { runEngine, type EngineRunInput } from "../src/engine/orchestrator.js";
import type {
  EngineModelConfig,
  EngineProvider,
  RoleInvocation,
} from "../src/engine/types.js";
import type { WizardConfig, WizardSession } from "../src/types.js";

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "orch-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      scripts: {
        typecheck: "node -e \"process.exit(0)\"",
      },
    }),
  );
  writeFileSync(
    join(repo, "startup.ts"),
    [
      "export function loginSucceeded(userId: string) {}",
      "export function restoreSession(userId: string) {}",
      "export function logout() {}",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "signup.ts"),
    [
      "async function saveSignup() {}",
      "export async function completeSignup() { await saveSignup(); }",
      "",
    ].join("\n"),
  );
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return repo;
}

interface MockState {
  items: Array<Record<string, unknown>>;
  completions: Array<Record<string, unknown>>;
  patches: Array<Record<string, unknown>>;
  snapshotEvents: Array<Record<string, unknown>>;
  artifacts?: Array<Record<string, unknown>>;
  integrationEvidence?: Record<string, unknown>;
  resumed?: boolean;
  failCompletion?: boolean;
}

function startMockRuntime(state: MockState): Promise<{ server: Server; port: number }> {
  state.artifacts ??= [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const send = (payload: unknown, status = 200) => {
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(payload));
      };
      const url = request.url ?? "";
      if (request.method === "POST" && url === "/wizard/runs") {
        send({
          project: {
            id: "wproj_1",
            repoFingerprint: "fp",
            displayName: "App",
            target: "web-js",
            kind: "frontend",
          },
          run: {
            id: "wrun_1",
            status: "running",
            phase: "authorizing",
            ...(state.integrationEvidence
              ? { integrationEvidence: state.integrationEvidence }
              : {}),
          },
          resumed: state.resumed === true,
          universeMode: "wizard",
          app: {},
          snapshot: { setupStatus: "running", events: state.snapshotEvents },
          artifacts: state.artifacts,
          ingestion: { apiKey: "pk_test", baseUrl: "https://api.example.test" },
          onboardingContext: { business: "Meal tracking app" },
        });
        return;
      }
      if (
        request.method === "POST" &&
        url === "/wizard/runs/wrun_1/artifacts/survey"
      ) {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const artifact = {
          kind: "survey",
          content: parsed.content,
          contentHash: parsed.contentHash,
          model: parsed.model,
          effort: parsed.effort,
          serviceTier: parsed.serviceTier,
          fastMode: parsed.fastMode === true,
          createdAt: "2026-07-29T00:00:00Z",
        };
        state.artifacts!.push(artifact);
        send(artifact);
        return;
      }
      if (
        request.method === "POST" &&
        url === "/wizard/runs/wrun_1/design/commit"
      ) {
        const parsed = JSON.parse(body) as {
          content: Record<string, unknown>;
          contentHash: string;
          model: string;
          effort?: string;
          serviceTier?: string;
          fastMode?: boolean;
          events: Array<Record<string, unknown>>;
        };
        const artifact = {
          kind: "event_design",
          content: parsed.content,
          contentHash: parsed.contentHash,
          model: parsed.model,
          effort: parsed.effort,
          serviceTier: parsed.serviceTier,
          fastMode: parsed.fastMode === true,
          frozenAt: "2026-07-29T00:00:01Z",
          createdAt: "2026-07-29T00:00:01Z",
        };
        state.artifacts!.push(artifact);
        for (const event of parsed.events) {
          state.items.push(event);
          state.snapshotEvents.push({
            id: `aev_${state.snapshotEvents.length + 1}`,
            ...event,
            projectId: "wproj_1",
            payloadSchema: event.payloadSchema ?? {},
          });
        }
        send({ artifact, events: state.snapshotEvents, created: true });
        return;
      }
      // Retain the legacy item endpoint so this fixture also protects old
      // published wizard clients while the new engine uses design/commit.
      if (request.method === "POST" && url.endsWith("/items")) {
        const parsed = JSON.parse(body) as { payload: Record<string, unknown> };
        state.items.push(parsed.payload);
        const id = `aev_${state.items.length}`;
        state.snapshotEvents.push({
          id,
          ...parsed.payload,
          projectId: "wproj_1",
          payloadSchema: parsed.payload.payloadSchema ?? {},
        });
        send({ kind: "event", created: true, item: { id } });
        return;
      }
      if (request.method === "POST" && url.endsWith("/complete")) {
        if (state.failCompletion) {
          send({ message: "completion unavailable" }, 500);
          return;
        }
        state.completions.push(JSON.parse(body) as Record<string, unknown>);
        send({ setupStatus: "complete" });
        return;
      }
      if (request.method === "PATCH") {
        const patch = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        state.patches.push(patch);
        if (patch.integrationEvidence && typeof patch.integrationEvidence === "object") {
          state.integrationEvidence = patch.integrationEvidence as Record<string, unknown>;
        }
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
  survey: { model: "claude-opus-5", effort: "low", fastMode: true },
  design: { model: "claude-opus-5", effort: "low", fastMode: true },
  edit: { model: "gpt-5.6-sol", effort: "medium", serviceTier: "priority" },
  review: {
    model: "gpt-5.6-sol",
    effort: "medium",
    serviceTier: "priority",
  },
  cluster_edit: {
    model: "gpt-5.6-terra",
    effort: "medium",
    serviceTier: "priority",
  },
  repair: {
    model: "gpt-5.6-sol",
    effort: "medium",
    serviceTier: "priority",
  },
};

const surveyArtifact = {
  stack: {
    frameworks: ["TypeScript"],
    packageManager: "npm",
    entryPoints: ["startup.ts"],
  },
  featureAreas: [{ name: "Signup", root: "signup.ts", files: ["signup.ts"] }],
  identifyAnchors: [
    { file: "startup.ts", symbol: "loginSucceeded", description: "Login success" },
    { file: "startup.ts", symbol: "restoreSession", description: "Session restoration" },
  ],
  logoutAnchors: [
    { file: "startup.ts", symbol: "logout", description: "End-user logout" },
  ],
  existingAnalytics: [],
  integratableCallSites: [{
    file: "signup.ts",
    symbol: "completeSignup",
    description: "Signup is persisted",
    outcome: "saveSignup resolves",
    payloadFields: ["plan"],
    similarPaths: [],
  }],
};

function scriptedProvider(options: {
  finishDesign?: boolean;
  zeroEvents?: boolean;
  invoked?: string[];
} = {}): EngineProvider {
  return {
    name: "scripted",
    async invoke(invocation: RoleInvocation) {
      options.invoked?.push(`${invocation.task ?? invocation.role}:${invocation.sessionKey ?? ""}`);
      if (invocation.role === "survey") {
        const finish = invocation.tools.find((tool) => tool.name === "finish_survey")!;
        await finish.handler(surveyArtifact);
        return { kind: "completed", text: "surveyed", costUsd: 0, turns: 1 };
      }
      if (invocation.role === "design") {
        if (!options.zeroEvents) {
          const propose = invocation.tools.find((tool) => tool.name === "propose_event_batch")!;
          await propose.handler({
            events: [{
              code: "signup_completed",
              name: "Signup completed",
              reasoning: "Activation moment.",
              anchorFile: "signup.ts",
              anchorSymbol: "completeSignup",
              payloadSchema: { plan: "Chosen plan" },
            }],
          });
        }
        if (options.finishDesign !== false) {
          const finish = invocation.tools.find((tool) => tool.name === "finish_event_design")!;
          await finish.handler({ summary: options.zeroEvents ? "nothing" : "one event" });
        }
        return { kind: "completed", text: "designed", costUsd: 0, turns: 2 };
      }
      if (invocation.role === "edit" && invocation.task === "sdk_setup") {
        writeFileSync(
          join(invocation.cwd, "startup.ts"),
          [
            'import { bindWhisperr } from "./whisperr-events";',
            "const whisperrClient = {",
            "  track(_event: string) {},",
            "  identify(_userId: string) {},",
            "  reset() {},",
            "};",
            "export function configureWhisperr(userId: string) {",
            "  bindWhisperr(whisperrClient);",
            "  whisperrClient.identify(userId);",
            "}",
            "export function restoreSession(userId: string) { whisperrClient.identify(userId); }",
            "export function logout() { whisperrClient.reset(); }",
            "",
          ].join("\n"),
        );
        return { kind: "completed", text: "setup", costUsd: 0, turns: 2 };
      }
      if (invocation.role === "edit" && invocation.task === "cluster_edit") {
        writeFileSync(
          join(invocation.cwd, "signup.ts"),
          [
            'import { WhisperrEvents } from "./whisperr-events";',
            "async function saveSignup() {}",
            "export async function completeSignup() {",
            "  await saveSignup();",
            '  WhisperrEvents.signupCompleted({ plan: "pro" });',
            "}",
            "",
          ].join("\n"),
        );
        return { kind: "completed", text: "edited", costUsd: 0, turns: 2 };
      }
      if (invocation.role === "review") {
        assert.equal(invocation.repositoryAccess?.mode, "review");
        const finish = invocation.tools.find((tool) => tool.name === "finish_review")!;
        await finish.handler({ verdict: "pass", issues: [] });
        return { kind: "completed", text: "reviewed", costUsd: 0, turns: 1 };
      }
      return { kind: "failed", error: "unexpected invocation", costUsd: 0, turns: 1 };
    },
  };
}

function engineInput(
  repo: string,
  port: number,
  provider: EngineProvider,
  fingerprint: string,
): EngineRunInput {
  return {
    repoPath: repo,
    repoFingerprint: fingerprint,
    config: { apiBaseUrl: `http://127.0.0.1:${port}` } as WizardConfig,
    session: { token: "tok", appId: "app_1", expiresAt: Date.now() / 1000 + 3600 },
    provider,
    models,
    target: "web-js",
    projectKind: "frontend",
    playbookSystemPrompt: "system",
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }),
  };
}

test("orchestrator automatically freezes design, integrates, reviews, and verifies", async () => {
  const repo = initRepo();
  const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [] };
  const { server, port } = await startMockRuntime(state);
  const invoked: string[] = [];
  try {
    const result = await runEngine(
      engineInput(repo, port, scriptedProvider({ invoked }), "fresh-complete"),
    );

    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") return;
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].code, "signup_completed");
    assert.equal(state.completions.length, 1);
    const completion = state.completions[0] as {
      events: Array<{ status: string }>;
      identifyWired: boolean;
      verificationStatus: string;
    };
    assert.equal(completion.events[0]?.status, "build_verified");
    assert.equal(completion.identifyWired, true);
    assert.equal(completion.verificationStatus, "passed");
    assert.ok(state.artifacts?.some((artifact) => artifact.kind === "survey"));
    assert.ok(state.artifacts?.some((artifact) => artifact.kind === "event_design"));
    assert.ok(state.patches.some((patch) => {
      const evidence = patch.integrationEvidence as {
        events?: Array<{ eventCode?: string; status?: string }>;
      } | undefined;
      return evidence?.events?.some(
        (event) => event.eventCode === "signup_completed" &&
          event.status === "syntax_verified",
      );
    }), "cluster progress is checkpointed before Sol review");
    assert.ok(existsSync(join(repo, "whisperr-events.ts")));
    assert.ok(invoked.includes("survey:survey"));
    assert.ok(invoked.includes("design:survey"));
    assert.ok(invoked.some((entry) => entry.startsWith("sdk_setup:sdk_setup")));
    assert.ok(invoked.some((entry) => entry.startsWith("cluster_edit:")));
    assert.ok(invoked.some((entry) => entry.startsWith("review:semantic_review")));
  } finally {
    server.close();
  }
});

test("orchestrator falls back on wrong universe mode", async () => {
  const server = createServer((_request, response) => {
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
  try {
    const result = await runEngine(
      engineInput(initRepo(), port, scriptedProvider(), "wrong-mode"),
    );
    assert.equal(result.kind, "wrong_mode");
  } finally {
    server.close();
  }
});

test("orchestrator resumes verified server progress without survey, design, or editing", async () => {
  const repo = initRepo();
  writeFileSync(
    join(repo, "whisperr-events.ts"),
    [
      "// Generated by @whisperr/wizard — do not edit by hand.",
      "export function bindWhisperr(_client: unknown) {}",
      "export const WhisperrEvents = { signupCompleted() {} };",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "startup.ts"),
    [
      'import { bindWhisperr } from "./whisperr-events";',
      "const whisperrClient = { identify(_id: string) {}, reset() {} };",
      "export function configureWhisperr(userId: string) {",
      "  bindWhisperr(whisperrClient);",
      "  whisperrClient.identify(userId);",
      "}",
      "export function restoreSession(userId: string) { whisperrClient.identify(userId); }",
      "export function logout() { whisperrClient.reset(); }",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(repo, "signup.ts"),
    [
      'import { WhisperrEvents } from "./whisperr-events";',
      "export async function completeSignup() { WhisperrEvents.signupCompleted(); }",
      "",
    ].join("\n"),
  );
  const state: MockState = {
    items: [],
    completions: [],
    patches: [],
    resumed: true,
    snapshotEvents: [{
      id: "aev_1",
      code: "signup_completed",
      name: "Signup completed",
      reasoning: "Activation moment.",
      projectId: "wproj_1",
      anchorFile: "signup.ts",
      anchorSymbol: "completeSignup",
      payloadSchema: {},
    }],
    integrationEvidence: {
      changedFiles: ["whisperr-events.ts", "startup.ts", "signup.ts"],
      identifyWired: true,
      verificationStatus: "pending",
      events: [{
        eventId: "aev_1",
        eventCode: "signup_completed",
        file: "signup.ts",
        status: "reviewed",
      }],
    },
  };
  const { server, port } = await startMockRuntime(state);
  const invoked: string[] = [];
  try {
    const result = await runEngine(engineInput(
      repo,
      port,
      {
        name: "unexpected",
        async invoke(invocation) {
          invoked.push(invocation.role);
          return { kind: "failed", error: "provider should not be called", costUsd: 0, turns: 0 };
        },
      },
      "resume-progress",
    ));
    assert.equal(
      result.kind,
      "completed",
      result.kind === "partial" ? result.summary : undefined,
    );
    assert.deepEqual(invoked, []);
    assert.equal(state.items.length, 0);
    assert.equal(state.completions.length, 1);
  } finally {
    server.close();
  }
});

test("orchestrator reports a partial run when completion is rejected", async () => {
  const repo = initRepo();
  const state: MockState = {
    items: [],
    completions: [],
    patches: [],
    snapshotEvents: [],
    failCompletion: true,
  };
  const { server, port } = await startMockRuntime(state);
  try {
    const result = await runEngine(
      engineInput(repo, port, scriptedProvider(), "completion-failure"),
    );
    assert.equal(result.kind, "partial");
    assert.equal(state.completions.length, 0);
    assert.ok(state.patches.some((patch) => patch.status === "failed"));
  } finally {
    server.close();
  }
});

test("orchestrator fails design when finish_event_design never runs", async () => {
  const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [] };
  const { server, port } = await startMockRuntime(state);
  try {
    const result = await runEngine(engineInput(
      initRepo(),
      port,
      scriptedProvider({ finishDesign: false }),
      "missing-finish",
    ));
    assert.equal(result.kind, "aborted");
    if (result.kind === "aborted") {
      assert.match(result.reason, /finish_event_design/);
    }
    assert.equal(state.items.length, 0);
    assert.equal(state.completions.length, 0);
  } finally {
    server.close();
  }
});

test("orchestrator fails design when it freezes zero events", async () => {
  const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [] };
  const { server, port } = await startMockRuntime(state);
  try {
    const result = await runEngine(engineInput(
      initRepo(),
      port,
      scriptedProvider({ zeroEvents: true }),
      "zero-events",
    ));
    assert.equal(result.kind, "aborted");
    if (result.kind === "aborted") {
      assert.match(result.reason, /no accepted events/);
    }
    assert.equal(state.items.length, 0);
    assert.equal(state.completions.length, 0);
  } finally {
    server.close();
  }
});
