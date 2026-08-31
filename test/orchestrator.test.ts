import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProgressSink } from "../src/engine/output.js";
import { generateBindings } from "../src/engine/bindings.js";
import { tryEngineFlow } from "../src/engine/cli.js";
import { runEngine, type EngineRunInput } from "../src/engine/orchestrator.js";
import type {
  EngineModelConfig,
  EngineProvider,
  RoleInvocation,
} from "../src/engine/types.js";
import type { Playbook, WizardConfig, WizardSession } from "../src/types.js";

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
  modelSessions?: Record<string, string>;
  modelGateways?: { anthropic: boolean; openai: boolean };
  calls?: string[];
  sharedEvents?: Array<{ code: string; name: string; reasoning?: string; payload_schema: Record<string, unknown> }>;
  failSharedStatus?: boolean;
  failSharedCommit?: boolean;
  failSharedPlacement?: boolean;
  failSharedPlacementCode?: string;
  invalidBootstrap?: boolean;
  wrongMode?: boolean;
}

function startMockRuntime(state: MockState): Promise<{ server: Server; port: number }> {
  state.artifacts ??= [];
  state.calls ??= [];
  let registrationState = "draft";
  let isolatedReceived = false;
  let requestedCodes: string[] = [];
  const revision = () => ({ contract_version: "2.0.0", revision: { revision_id: "rev_shared", state: registrationState, events: registrationState === "committed" ? state.sharedEvents ?? [] : state.sharedEvents!.filter((event) => requestedCodes.includes(event.code)) }, requested_event_codes: requestedCodes, content_hash: "hash", current_event_codes: registrationState === "committed" ? state.sharedEvents!.map((event) => event.code) : [], gaps: isolatedReceived ? [] : requestedCodes.map((code) => ({ event_code: code, reason: "isolated_test_event_not_received" })) });
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
      state.calls!.push(`${request.method} ${url}`);
      if (url.startsWith("/wizard/integration-playbook")) {
        send({ contract_version: "2.0.0", playbook_version: "1", sdk_contract: "v1_unchanged", steps: [], invariants: [] });
        return;
      }
      if (url.startsWith("/wizard/runs/wrun_1/integration/")) {
        const bodyValue = body ? JSON.parse(body) : {};
        if (url.includes("/status?")) {
          send(state.failSharedStatus ? { error: { code: "denied" } } : { contract_version: "2.0.0", required_events: state.sharedEvents ?? [], registrations: requestedCodes.length ? [revision()] : [] }, state.failSharedStatus ? 403 : 200);
        } else if (url.endsWith("/source")) send({ contract_version: "2.0.0", connection_id: "con_shared" });
        else if (url.endsWith("/drafts")) {
          requestedCodes = bodyValue.events.map((event: { code: string }) => event.code);
          state.sharedEvents = [...state.sharedEvents?.filter((event) => !requestedCodes.includes(event.code)) ?? [], ...bodyValue.events];
          registrationState = "draft";
          send(revision());
        } else if (url.endsWith("/validation")) { registrationState = "validating"; send(revision()); }
        else if (url.endsWith("/tests")) {
          assert.deepEqual(bodyValue.properties, { plan: "synthetic" });
          isolatedReceived = true;
          send({ delivery_id: "synthetic-receipt" });
        } else if (url.endsWith("/commit")) {
          assert.equal(isolatedReceived, true);
          if (state.failSharedCommit) send({ error: { code: "registration_conflict" } }, 409);
          else {
            registrationState = "committed";
            for (const code of requestedCodes) {
              if (state.snapshotEvents.some((event) => event.code === code)) continue;
              const definition = state.sharedEvents!.find((event) => event.code === code)!;
              state.snapshotEvents.push({ id: state.snapshotEvents.length ? `aev_shared_${state.snapshotEvents.length + 1}` : "aev_shared", code, name: definition.name, reasoning: definition.reasoning, payloadSchema: definition.payload_schema, projectId: "" });
            }
            send(revision());
          }
        } else if (url.endsWith("/placement")) {
          assert.equal(registrationState, "committed");
          if (state.failSharedPlacement || bodyValue.event_code === state.failSharedPlacementCode) send({ error: { code: "placement_failed" } }, 409);
          else {
            const canonical = state.snapshotEvents.find((event) => event.code === bodyValue.event_code)!;
            Object.assign(canonical, { projectId: "wproj_1", anchorFile: bodyValue.anchor_file, anchorSymbol: bodyValue.anchor_symbol });
            send({ id: canonical.id, placement_recorded: true, live_verified: false });
          }
        } else send(revision());
        return;
      }
      if (request.method === "GET" && url === "/wizard/capabilities") {
        send({
          modelGateways: state.modelGateways ?? {
            anthropic: true,
            openai: true,
          },
        });
        return;
      }
      if (request.method === "POST" && url === "/wizard/runs") {
        if (state.invalidBootstrap) { send({ run: { id: "wrun_1" } }); return; }
        if (state.wrongMode) { send({ error: { code: "wrong_universe_mode" } }, 409); return; }
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
          modelSessions: state.modelSessions ?? {},
          ingestion: { apiKey: "pk_test", baseUrl: "https://api.example.test" },
          onboardingContext: { business: "Meal tracking app" },
        });
        return;
      }
      if (
        request.method === "PUT" &&
        url === "/wizard/runs/wrun_1/model-sessions/survey"
      ) {
        const parsed = JSON.parse(body) as { task: string; conversationId: string };
        assert.equal(parsed.task, "survey");
        state.modelSessions ??= {};
        state.modelSessions.survey = parsed.conversationId;
        send({ sessionKey: "survey", conversationId: parsed.conversationId });
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
        if ("modelConversationId" in patch) {
          send({ code: "wizard_run_conflict", message: "legacy conversation patch rejected" }, 409);
          return;
        }
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
  setupError?: string;
  strictTypes?: boolean;
  twoEvents?: boolean;
} = {}): EngineProvider {
  return {
    name: "scripted",
    async invoke(invocation: RoleInvocation) {
      options.invoked?.push(`${invocation.task ?? invocation.role}:${invocation.sessionKey ?? ""}`);
      if (invocation.role === "survey") {
        const finish = invocation.tools.find((tool) => tool.name === "finish_survey")!;
        await finish.handler(surveyArtifact);
        return {
          kind: "completed",
          text: "surveyed",
          sessionId: "claude_session_1",
          costUsd: 0,
          turns: 1,
        };
      }
      if (invocation.role === "design") {
        assert.equal(invocation.resumeSessionId, "claude_session_1");
        if (!options.zeroEvents) {
          const propose = invocation.tools.find((tool) => tool.name === "propose_event_batch")!;
          await propose.handler({
            events: [{
              code: "signup_completed",
              name: "Signup completed",
              reasoning: "Activation moment.",
              anchorFile: "signup.ts",
              anchorSymbol: "completeSignup",
              payloadSchema: { plan: options.strictTypes ? "string" : "Chosen plan" },
            }, ...options.twoEvents ? [{ code: "subscription_started", name: "Subscription started", reasoning: "Subscription committed", anchorFile: "signup.ts", anchorSymbol: "completeSignup", payloadSchema: { plan: "string" } }] : []],
          });
        }
        if (options.finishDesign !== false) {
          const finish = invocation.tools.find((tool) => tool.name === "finish_event_design")!;
          await finish.handler({ summary: options.zeroEvents ? "nothing" : "one event" });
        }
        return { kind: "completed", text: "designed", costUsd: 0, turns: 2 };
      }
      if (invocation.role === "edit" && invocation.task === "sdk_setup") {
        if (options.setupError) {
          return {
            kind: "failed",
            error: options.setupError,
            costUsd: 0,
            turns: 0,
          };
        }
        writeFileSync(join(invocation.cwd, "package.json"), JSON.stringify({
          scripts: { typecheck: "node -e \"process.exit(0)\"" },
          dependencies: { "@whisperr/web": "1.0.0" },
        }));
        writeFileSync(
          join(invocation.cwd, "startup.ts"),
          [
            'import { bindWhisperr } from "./whisperr-events";',
            "const Whisperr = { init: (_options: unknown) => ({",
            "  track(_event: string) {},",
            "  identify(_userId: string) {},",
            "  reset() {},",
            "}) };",
            "const whisperrClient = Whisperr.init({ apiKey: '__WHISPERR_API_KEY__' });",
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
            ...options.twoEvents ? ['  WhisperrEvents.subscriptionStarted({ plan: "pro" });'] : [],
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

test("actual CLI engine route performs typed shared registration, placement, review and completion without legacy writes", async () => {
  const repo = initRepo();
  const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [] };
  const { server, port } = await startMockRuntime(state);
  const before = process.env.WHISPERR_SHARED_PLAYBOOK_ENABLED;
  process.env.WHISPERR_SHARED_PLAYBOOK_ENABLED = "1";
  const invoked: string[] = [];
  try {
    const input = engineInput(repo, port, scriptedProvider({ strictTypes: true, invoked }), "shared-cli");
    const result = await tryEngineFlow({ repoPath: repo, fingerprint: "shared-cli", config: input.config, session: input.session,
      playbook: { target: { id: "web-js" }, systemPrompt: "system" } as Playbook,
      theme: { bright: (value) => value, muted: (value) => value },
    }, input.provider);
    assert.deepEqual(result, { handled: true, exitCode: 0 });
    assert.deepEqual(state.sharedEvents?.map((event) => event.payload_schema), [{ plan: "string" }]);
    assert.equal(state.items.length, 0);
    assert.equal(state.completions.length, 1);
    const events = state.completions[0]!.events as Array<Record<string, unknown>>;
    assert.deepEqual(events, [{ eventId: "aev_shared", eventCode: "signup_completed", status: "build_verified", file: "signup.ts" }]);
    const paths = state.calls!.join("\n");
    assert.match(paths, /integration\/drafts\/rev_shared\/tests/);
    assert.match(paths, /integration\/drafts\/rev_shared\/commit/);
    assert.match(paths, /integration\/drafts\/rev_shared\/placement/);
    assert.doesNotMatch(paths, /\/design\/commit|\/items|\/deployment|\/first-event|\/report/);
    assert.ok(state.calls!.findIndex((path) => path.endsWith("/commit")) < state.calls!.findIndex((path) => path.endsWith("/placement")));
    assert.ok(invoked.includes("survey:survey"));
    assert.ok(invoked.includes("design:survey"));
    assert.ok(invoked.some((step) => step.startsWith("cluster_edit:")));
    assert.ok(invoked.some((step) => step.startsWith("review:")));
  } finally {
    if (before === undefined) delete process.env.WHISPERR_SHARED_PLAYBOOK_ENABLED;
    else process.env.WHISPERR_SHARED_PLAYBOOK_ENABLED = before;
    server.close();
  }
});

test("shared commit of two events cannot resume as successful after only one placement attaches", async () => {
  const repo = initRepo();
  const foreign = { code: "native_logged", name: "Other source", reasoning: "Unrelated source work", payload_schema: {} };
  const state: MockState = { items: [], completions: [], patches: [],
    sharedEvents: [foreign], snapshotEvents: [{ id: "native_event", code: foreign.code, name: foreign.name, reasoning: foreign.reasoning, payloadSchema: {}, projectId: "another_project", anchorFile: "foreign.ts" }],
    failSharedPlacementCode: "subscription_started" };
  const { server, port } = await startMockRuntime(state);
  const input = () => ({ ...engineInput(repo, port, scriptedProvider({ strictTypes: true, twoEvents: true }), "partial-placement"), sharedRegistration: true });
  try {
    const first = await runEngine(input());
    assert.equal(first.kind, "aborted");
    assert.deepEqual(state.snapshotEvents.filter((event) => event.projectId === "wproj_1").map((event) => event.code), ["signup_completed"]);
    assert.equal(state.snapshotEvents.find((event) => event.code === "subscription_started")?.projectId, "");
    assert.equal(state.completions.length, 0);

    // The server's owned revision now contains the unrelated app-wide event,
    // but requested_event_codes contains exactly this run's two-event intent.
    state.resumed = true;
    const attemptsBefore = state.calls!.filter((call) => call.endsWith("/placement")).length;
    const second = await runEngine(input());
    assert.equal(second.kind, "aborted", "a durable failed placement must not disappear from the resumed worklist");
    assert.equal(state.completions.length, 0, "no one-event completion after a two-event committed design");
    assert.equal(state.calls!.filter((call) => call.endsWith("/placement")).length, attemptsBefore + 1, "resume retries only the missing placement");

    state.failSharedPlacementCode = undefined;
    const third = await runEngine(input());
    assert.equal(third.kind, "completed", third.kind === "aborted" ? third.reason : third.kind === "partial" ? third.summary : "");
    assert.equal(state.completions.length, 1);
    const completed = state.completions[0]!.events as Array<{ eventCode: string; status: string }>;
    assert.deepEqual(completed.map((event) => event.eventCode).sort(), ["signup_completed", "subscription_started"]);
    assert.ok(completed.every((event) => event.status === "build_verified"));
    assert.equal(state.snapshotEvents.find((event) => event.code === foreign.code)?.projectId, "another_project");
    assert.equal(state.calls!.filter((call) => call.endsWith("/drafts")).length, 1, "recovery reuses the committed owned revision, without redefining or retesting");
    assert.equal(state.items.length, 0);
  } finally { server.close(); }
});

test("shared local preflight creates no remote run for non-git or dirty repositories", async () => {
  for (const kind of ["non-git", "dirty", "propose-only"]) {
    const repo = kind === "non-git" ? mkdtempSync(join(tmpdir(), "shared-no-git-")) : initRepo();
    if (kind === "dirty") writeFileSync(join(repo, "startup.ts"), "user changes");
    const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [] };
    const { server, port } = await startMockRuntime(state);
    try {
      const input = engineInput(repo, port, scriptedProvider(), kind);
      const result = await runEngine({ ...input, sharedRegistration: true, config: { ...input.config, proposeOnly: kind === "propose-only" } });
      assert.equal(result.kind, "aborted");
      assert.deepEqual(state.calls, []);
      assert.deepEqual(state.patches, []);
    } finally { server.close(); }
  }
});

test("shared post-bootstrap failures always terminate the run without legacy fallback", async () => {
  for (const failure of ["registry", "provider", "commit", "placement", "malformed", "completion"] as const) {
    const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [],
      failSharedStatus: failure === "registry", failSharedCommit: failure === "commit", failSharedPlacement: failure === "placement",
      invalidBootstrap: failure === "malformed", failCompletion: failure === "completion" };
    const { server, port } = await startMockRuntime(state);
    const provider = scriptedProvider({ strictTypes: true });
    if (failure === "provider") provider.onRunReady = () => { throw new Error("provider session failed"); };
    try {
      const result = await runEngine({ ...engineInput(initRepo(), port, provider, failure), sharedRegistration: true });
      assert.ok(result.kind === "aborted" || result.kind === "partial", `${failure}: ${result.kind}`);
      assert.ok(state.patches.some((patch) => patch.status === "failed"), `${failure} was not finalized`);
      assert.equal(state.items.length, 0);
      assert.equal(state.completions.length, 0);
      assert.doesNotMatch(state.calls!.join("\n"), /\/design\/commit|\/items|\/deployment/);
    } finally { server.close(); }
  }
});

test("shared wrong-mode refusal never falls through to legacy manifest writers", async () => {
  for (const sharedRegistration of [false, true]) {
    const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [], wrongMode: true };
    const { server, port } = await startMockRuntime(state);
    try {
      const result = await runEngine({ ...engineInput(initRepo(), port, scriptedProvider(), "mode"), sharedRegistration });
      assert.equal(result.kind, sharedRegistration ? "aborted" : "wrong_mode");
      assert.deepEqual(state.patches, []);
    } finally { server.close(); }
  }
});

test("orchestrator automatically freezes design, integrates, reviews, and verifies", async () => {
  const repo = initRepo();
  const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [] };
  const { server, port } = await startMockRuntime(state);
  const invoked: string[] = [];
  try {
    const result = await runEngine(
      engineInput(repo, port, scriptedProvider({ invoked }), "fresh-complete"),
    );

    assert.equal(result.kind, "completed", result.kind === "aborted" ? result.reason : result.kind === "partial" ? result.summary : undefined);
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
    assert.equal(state.modelSessions?.survey, "claude_session_1");
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

test("shared engine resumes current approved placements through the same verification lifecycle", async () => {
  const repo = initRepo();
  writeFileSync(
    join(repo, "whisperr-events.ts"),
    generateBindings("web-js", [{
      code: "signup_completed", name: "Signup completed", reasoning: "Activation moment.",
      eventId: "aev_1", anchorFile: "signup.ts", anchorSymbol: "completeSignup", payloadSchema: {},
    }], ["startup.ts"]).content,
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    scripts: { typecheck: "node -e \"process.exit(0)\"" },
    dependencies: { "@whisperr/web": "1.0.0" },
  }));
  writeFileSync(
    join(repo, "startup.ts"),
    [
      'import { bindWhisperr } from "./whisperr-events";',
      "const Whisperr = { init: (_options: unknown) => ({ identify(_id: string) {}, reset() {} }) };",
      "const whisperrClient = Whisperr.init({ apiKey: 'pk_test' });",
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
      changedFiles: ["package.json", "whisperr-events.ts", "startup.ts", "signup.ts"],
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
  state.sharedEvents = [{ code: "signup_completed", name: "Signup completed", reasoning: "Activation moment.", payload_schema: {} }];
  const { server, port } = await startMockRuntime(state);
  const invoked: string[] = [];
  try {
    const result = await runEngine({ ...engineInput(
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
    ), sharedRegistration: true, force: true });
    assert.equal(
      result.kind,
      "completed",
      result.kind === "aborted" ? result.reason : result.kind === "partial" ? result.summary : undefined,
    );
    assert.deepEqual(invoked, []);
    assert.equal(state.items.length, 0);
    assert.equal(state.completions.length, 1);
  } finally {
    server.close();
  }
});


test("orchestrator resumes verified server progress without survey, design, or editing", async () => {
  const repo = initRepo();
  writeFileSync(
    join(repo, "whisperr-events.ts"),
    generateBindings("web-js", [{
      code: "signup_completed", name: "Signup completed", reasoning: "Activation moment.",
      eventId: "aev_1", anchorFile: "signup.ts", anchorSymbol: "completeSignup", payloadSchema: {},
    }], ["startup.ts"]).content,
  );
  writeFileSync(join(repo, "package.json"), JSON.stringify({
    scripts: { typecheck: "node -e \"process.exit(0)\"" },
    dependencies: { "@whisperr/web": "1.0.0" },
  }));
  writeFileSync(
    join(repo, "startup.ts"),
    [
      'import { bindWhisperr } from "./whisperr-events";',
      "const Whisperr = { init: (_options: unknown) => ({ identify(_id: string) {}, reset() {} }) };",
      "const whisperrClient = Whisperr.init({ apiKey: 'pk_test' });",
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
      changedFiles: ["package.json", "whisperr-events.ts", "startup.ts", "signup.ts"],
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
      result.kind === "aborted" ? result.reason : result.kind === "partial" ? result.summary : undefined,
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

test("orchestrator reports the actual Sol SDK setup failure", async () => {
  const repo = initRepo();
  const state: MockState = { items: [], completions: [], patches: [], snapshotEvents: [] };
  const { server, port } = await startMockRuntime(state);
  try {
    const result = await runEngine(
      engineInput(
        repo,
        port,
        scriptedProvider({ setupError: "provider rejected the setup request" }),
        "setup-error",
      ),
    );
    assert.equal(result.kind, "aborted");
    if (result.kind !== "aborted") return;
    assert.match(result.reason, /provider rejected the setup request/);
    assert.doesNotMatch(result.reason, /deterministic validation/);
    assert.equal(state.items.length, 1, "successful design is committed before setup failure");
    assert.ok(
      state.artifacts?.some((artifact) => artifact.kind === "event_design"),
      "successful design artifact is retained",
    );
    assert.ok(
      state.patches.some((patch) => patch.phase === "binding"),
      "SDK setup failure is checkpointed in the binding phase",
    );
  } finally {
    server.close();
  }
});

test("orchestrator fails preflight before invoking a model when OpenAI is unavailable", async () => {
  const state: MockState = {
    items: [],
    completions: [],
    patches: [],
    snapshotEvents: [],
    modelGateways: { anthropic: true, openai: false },
  };
  const { server, port } = await startMockRuntime(state);
  const invoked: string[] = [];
  try {
    const result = await runEngine(engineInput(
      initRepo(),
      port,
      scriptedProvider({ invoked }),
      "gateway-unavailable",
    ));
    assert.equal(result.kind, "aborted");
    if (result.kind !== "aborted") return;
    assert.match(result.reason, /model gateway preflight failed/i);
    assert.match(result.reason, /OpenAI model gateway is unavailable/i);
    assert.deepEqual(invoked, []);
    assert.equal(state.items.length, 0);
    assert.equal(state.artifacts?.length, 0);
  } finally {
    server.close();
  }
});
