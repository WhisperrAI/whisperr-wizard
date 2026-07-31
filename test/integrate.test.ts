import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateBindings } from "../src/engine/bindings.js";
import { sdkSetupFor } from "../src/core/playbooks/sdk-setup.js";
import {
  runClusterIntegration,
  runSdkSetupPass,
  type IntegrationDeps,
  sdkSetupFiles,
} from "../src/engine/integrate.js";
import { assessSdkSetup, type SetupValidationResult } from "../src/engine/setup-validation.js";
import { createProgressSink } from "../src/engine/output.js";
import { placementsFor, type RegisteredEvent } from "../src/engine/selection.js";
import type { EngineModelConfig, EngineProvider, RoleInvocation } from "../src/engine/types.js";
import {
  resolveVerifySteps,
  runVerificationStatus,
  verificationCommand,
  verifiedStatus,
} from "../src/engine/verify.js";
import type { WorktreeHandle } from "../src/engine/worktree.js";

const registered: RegisteredEvent[] = [
  {
    code: "trial_started", name: "Trial started", reasoning: "Activation.", eventId: "aev_1",
    anchorFile: "src/auth/signup.ts", anchorSymbol: "completeSignup",
    payloadSchema: { plan: "Trial plan code", seat_count: "Seats purchased" },
  },
  {
    code: "report_shared", name: "Report shared", reasoning: "Habit loop.", eventId: "aev_2",
    anchorFile: "src/reports/share.ts", payloadSchema: {},
  },
];

test("bindings goldens carry wrappers, queue adapter, and payload docs", () => {
  const ts = generateBindings("nextjs", registered);
  assert.equal(ts.relativePath, "whisperr-events.ts");
  assert.ok(ts.content.includes("export function bindWhisperr"));
  assert.ok(ts.content.includes("trialStarted(payload: { plan: WhisperrPayloadValue; seatCount: WhisperrPayloadValue })"));
  assert.ok(ts.content.includes('"seat_count": seatCount'));
  assert.ok(ts.content.includes("reportShared(): void"));

  const swift = generateBindings("swift", registered);
  assert.equal(swift.relativePath, "WhisperrEvents.swift");
  assert.ok(swift.content.includes("static func trialStarted(plan: String, seatCount: String)"));
  assert.ok(swift.content.includes("queued.append((event, payload))"));

  const dart = generateBindings("flutter", registered);
  assert.equal(dart.relativePath, "whisperr_events.dart");
  assert.ok(dart.content.includes("static void trialStarted({required Object plan, required Object seatCount})"));

  const js = generateBindings("web-js", registered, ["src/index.js"]);
  assert.equal(js.relativePath, "whisperr-events.js");
  assert.ok(!js.content.includes("type WhisperrPayloadValue"));

  const nodeTs = generateBindings("node", registered, ["src/server.ts"]);
  assert.match(nodeTs.content, /trialStarted\(externalUserId: string/);
  assert.equal(nodeTs.lifecycleMode, "per-user");
  const nodeJs = generateBindings("node", registered, ["server.js"]);
  assert.match(nodeJs.content, /trialStarted\(externalUserId, payload\)/);

  const python = generateBindings("python", registered);
  assert.equal(python.relativePath, "whisperr_events.py");
  assert.match(python.content, /def trial_started\(external_user_id/);
  const php = generateBindings("php", registered);
  assert.equal(php.relativePath, "WhisperrEvents.php");
  assert.match(php.content, /trialStarted\(\$externalUserId/);
});

const passing = (id: string): SetupValidationResult => ({
  ok: true,
  passed: [{ id, message: id, files: [] }],
  failed: [], warnings: [], evidenceFiles: [], manualConfigurationWarnings: [],
});

const failing = (id: string, file: string): SetupValidationResult => ({
  ok: false, passed: [{ id: "scope", message: "scope passed", files: [] }],
  failed: [{ id, message: `${id} is missing`, files: [file] }],
  warnings: [], evidenceFiles: [file], manualConfigurationWarnings: [],
});

test("verify steps resolve from the repository honestly", () => {
  const withScript = mkdtempSync(join(tmpdir(), "verify-a-"));
  writeFileSync(join(withScript, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }));
  const scripted = resolveVerifySteps(withScript, "nextjs");
  assert.equal(scripted.length, 1);
  assert.deepEqual(scripted[0].args, ["run", "typecheck"]);

  const bare = mkdtempSync(join(tmpdir(), "verify-b-"));
  assert.equal(resolveVerifySteps(bare, "swift").length, 0);
  assert.equal(resolveVerifySteps(bare, "nextjs").length, 0);

  assert.equal(resolveVerifySteps(bare, "flutter")[0].command, "flutter");

  assert.equal(verifiedStatus([]), "applied");
  assert.equal(verifiedStatus([{ kind: "typecheck", command: "npm", args: [], ok: true, output: "" }]), "type_verified");
  assert.equal(verifiedStatus([{ kind: "typecheck", command: "npm", args: [], ok: false, output: "boom" }]), "applied");
  assert.equal(runVerificationStatus([]), "unavailable");
  assert.equal(
    verificationCommand([
      { kind: "typecheck", command: "npm", args: ["run", "typecheck"], ok: false, output: "boom" },
      { kind: "build", command: "npm", args: ["run", "build"], ok: true, output: "" },
    ]),
    "npm run typecheck",
  );
});

test("SDK setup accepts deterministically valid changes from its fixed Sol owner", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "setup-turn-limit-"));
  writeFileSync(join(worktreePath, "package.json"), "{}");
  const worktree: WorktreeHandle = { kind: "snapshot", path: worktreePath, baseRef: "abc", repoPath: worktreePath };
  const models: EngineModelConfig = {
    survey: { model: "m" },
    design: { model: "m" },
    edit: { model: "m" },
    review: { model: "m" },
    sdk_setup: { model: "sol" },
    repair: { model: "sol" },
  };
  const provider: EngineProvider = {
    name: "hybrid",
    async invoke() {
      return { kind: "completed", text: "done", costUsd: 0, turns: 1 };
    },
  };
  const deps: IntegrationDeps = {
    provider,
    models,
    worktree,
    target: "nextjs",
    playbookSystemPrompt: "system",
    registered,
    ingestion: { apiKey: "pk", baseUrl: "https://api.example.test" },
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }),
    saveClusters: () => {},
    discardChanges: async () => {},
    onClusterIntegrated: async () => {},
  };

  assert.deepEqual(
    await runSdkSetupPass(deps, generateBindings("nextjs", registered), async () => true),
    { completed: true },
  );
});

test("SDK setup preserves the fixed Sol owner's terminal error", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "setup-error-"));
  writeFileSync(join(worktreePath, "package.json"), "{}");
  const deps: IntegrationDeps = {
    provider: {
      name: "sol",
      async invoke() {
        return {
          kind: "failed",
          error: "conversation binding was rejected",
          costUsd: 0,
          turns: 0,
        };
      },
    },
    models: {
      survey: { model: "m" },
      design: { model: "m" },
      edit: { model: "sol" },
      review: { model: "sol" },
      sdk_setup: { model: "sol" },
    },
    worktree: {
      kind: "snapshot",
      path: worktreePath,
      baseRef: "abc",
      repoPath: worktreePath,
    },
    target: "nextjs",
    playbookSystemPrompt: "system",
    registered,
    ingestion: { apiKey: "pk", baseUrl: "https://api.example.test" },
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }),
    saveClusters: () => {},
    discardChanges: async () => {},
    onClusterIntegrated: async () => {},
  };

  const result = await runSdkSetupPass(
    deps,
    generateBindings("nextjs", registered),
    async () => true,
  );
  assert.equal(result.completed, false);
  assert.match(result.error ?? "", /conversation binding was rejected/);
});

test("SDK setup uses at most one targeted follow-up in the returned Sol session", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "setup-followup-"));
  writeFileSync(join(worktreePath, "package.json"), "{}");
  const invocations: RoleInvocation[] = [];
  const deps: IntegrationDeps = {
    provider: { name: "sol", async invoke(invocation) { invocations.push(invocation); return { kind: "completed", text: "done", sessionId: "sol-session", costUsd: 0, turns: 1 }; } },
    models: { survey: { model: "m" }, design: { model: "m" }, edit: { model: "sol" }, review: { model: "sol" }, sdk_setup: { model: "sol" } },
    worktree: { kind: "snapshot", path: worktreePath, baseRef: "abc", repoPath: worktreePath },
    target: "nextjs", playbookSystemPrompt: "ignored", registered,
    ingestion: { apiKey: "pk", baseUrl: "https://api.example.test" },
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }), saveClusters: () => {}, discardChanges: async () => {}, onClusterIntegrated: async () => {},
  };
  let validations = 0;
  const result = await runSdkSetupPass(deps, generateBindings("nextjs", registered), async () => {
    validations += 1;
    return validations === 1 ? failing("reset", "src/authService.ts") : passing("reset");
  });
  assert.equal(result.completed, true);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1]?.resumeSessionId, "sol-session");
  assert.match(invocations[1]?.userPrompt ?? "", /reset is missing \[src\/authService\.ts\]/);
  assert.match(invocations[1]?.userPrompt ?? "", /scope/);

  invocations.length = 0;
  const failed = await runSdkSetupPass(deps, generateBindings("nextjs", registered), async () => failing("binding", "src/whisperr.ts"));
  assert.equal(invocations.length, 2);
  assert.equal(failed.completed, false);
  assert.match(failed.error ?? "", /binding is missing \[src\/whisperr\.ts\]/);
});

test("production-shaped callers pass through one canonical Next.js auth service", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "setup-assess-"));
  mkdirSync(join(repoPath, "src"), { recursive: true });
  const bindings = generateBindings("nextjs", registered, ["src/main.tsx"]);
  writeFileSync(join(repoPath, bindings.relativePath), bindings.content);
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({ dependencies: { "@whisperr/next": "1", "@whisperr/web": "1" } }));
  writeFileSync(join(repoPath, "src/main.tsx"), "export { authService } from './authService';\n");
  writeFileSync(join(repoPath, "src/loginCaller.ts"), "export const login = () => authService.me();\n");
  writeFileSync(join(repoPath, "src/logoutCaller.ts"), "export const logout = () => authService.logOut();\n");
  writeFileSync(join(repoPath, "src/authService.ts"), [
    "import { Whisperr } from '@whisperr/web';",
    "import { bindWhisperr } from '../whisperr-events';",
    "const whisperr = Whisperr.init({ apiKey: 'pk' });",
    "bindWhisperr(whisperr);",
    "export const authService = { me(user) { whisperr.identify(user.id); }, logOut() { whisperr.reset(); } };",
  ].join("\n"));
  const survey = {
    stack: { frameworks: ["nextjs"], entryPoints: ["src/main.tsx"] }, featureAreas: [], existingAnalytics: [], integratableCallSites: [],
    identifyAnchors: [{ file: "src/authService.ts", description: "canonical" }, { file: "src/loginCaller.ts", description: "caller" }],
    logoutAnchors: [{ file: "src/authService.ts", description: "canonical" }, { file: "src/logoutCaller.ts", description: "caller" }],
  };
  const metadata = sdkSetupFor("nextjs");
  const allowedFiles = await sdkSetupFiles(repoPath, survey, bindings.relativePath, metadata);
  const result = await assessSdkSetup({ repoPath, target: "nextjs", metadata, bindings, allowedFiles, editedFiles: [bindings.relativePath, "package.json", "src/authService.ts"], registered: [], survey });
  assert.equal(result.ok, true, result.failed.map((check) => check.message).join("; "));
  assert.ok(result.warnings.some((warning) => warning.id === "caller-anchor" && warning.files.includes("src/loginCaller.ts")));
});

test("setup assessment keeps hard safety failures and makes reset target-aware", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "setup-hard-"));
  mkdirSync(join(repoPath, "src"), { recursive: true });
  const bindings = generateBindings("node", registered, ["src/server.ts"]);
  writeFileSync(join(repoPath, bindings.relativePath), bindings.content);
  writeFileSync(join(repoPath, "package.json"), JSON.stringify({ dependencies: { "@whisperr/node": "1" } }));
  writeFileSync(join(repoPath, "src/server.ts"), "const client = new Whisperr({ apiKey: process.env.WHISPERR_API_KEY }); bindWhisperr(client); client.identify(user.id); WhisperrEvents.trialStarted(user.id, payload);\n");
  const survey = { stack: { frameworks: ["node"], entryPoints: ["src/server.ts"] }, featureAreas: [], identifyAnchors: [], logoutAnchors: [], existingAnalytics: [], integratableCallSites: [] };
  const metadata = sdkSetupFor("node");
  const allowedFiles = await sdkSetupFiles(repoPath, survey, bindings.relativePath, metadata);
  const result = await assessSdkSetup({ repoPath, target: "node", metadata, bindings, allowedFiles, editedFiles: [bindings.relativePath, "src/server.ts", "outside.ts"], registered, survey });
  assert.equal(result.failed.some((check) => check.id === "reset"), false);
  assert.ok(result.failed.some((check) => check.id === "scope"));
  assert.ok(result.failed.some((check) => check.id === "no-product-events"));
  writeFileSync(join(repoPath, bindings.relativePath), `${bindings.content}\n// changed`);
  const changed = await assessSdkSetup({ repoPath, target: "node", metadata, bindings, allowedFiles, editedFiles: [], registered: [], survey });
  assert.ok(changed.failed.some((check) => check.id === "generated-binding"));
});

test("cluster integration marks overflow clusters resumable and structurally verifies the rest", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "integrate-"));
  const worktree: WorktreeHandle = { kind: "snapshot", path: worktreePath, baseRef: "abc", repoPath: worktreePath };
  const models: EngineModelConfig = {
    survey: { model: "m" },
    design: { model: "m" },
    edit: { model: "m" },
    review: { model: "m" },
  };
  let editCalls = 0;
  const provider: EngineProvider = {
    name: "scripted",
    async invoke(invocation: RoleInvocation) {
      if (invocation.role === "edit") {
        editCalls += 1;
        if (invocation.userPrompt.includes("trial_started")) {
          return { kind: "context_overflow", costUsd: 0, turns: 1 };
        }
        mkdirSync(join(invocation.cwd, "src/reports"), { recursive: true });
        writeFileSync(
          join(invocation.cwd, "src/reports/share.ts"),
          'import { WhisperrEvents } from "../../whisperr-events";\n' +
            "export function share() { WhisperrEvents.reportShared() }\n",
        );
        return { kind: "completed", text: "edited", costUsd: 0.01, turns: 2 };
      }
      return { kind: "completed", text: "VERDICT: pass", costUsd: 0.001, turns: 1 };
    },
  };
  const saved: number[] = [];
  const deps: IntegrationDeps = {
    provider,
    models,
    worktree,
    target: "swift",
    playbookSystemPrompt: "system",
    registered,
    ingestion: { apiKey: "pk", baseUrl: "https://api.example.test" },
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }),
    saveClusters: (clusters) => saved.push(clusters.length),
    discardChanges: async () => {},
    onClusterIntegrated: async () => {},
  };
  const placements = placementsFor(registered);
  const clusters = placements.map((placement, index) => ({
    id: `cluster_${index}`,
    files: [placement.file],
    events: [placement],
    status: "pending" as const,
    attempts: 0,
  }));
  const outcome = await runClusterIntegration(deps, clusters, async () => "diff");
  assert.ok(editCalls >= 2);
  assert.equal(outcome.eventStatuses.get("trial_started"), "failed");
  assert.equal(outcome.eventStatuses.get("report_shared"), "syntax_verified");
  const failed = outcome.clusters.find((cluster) =>
    cluster.events.some((event) => event.eventCode === "trial_started"),
  );
  assert.equal(failed?.status, "failed_resumable");
  assert.ok(saved.length >= 4);
});

test("invalid Terra work is returned to the same Terra conversation until valid", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "integrate-fallback-"));
  mkdirSync(join(worktreePath, "src/auth"), { recursive: true });
  writeFileSync(join(worktreePath, "src/auth/signup.ts"), "export function signup() {}\n");
  const worktree: WorktreeHandle = { kind: "snapshot", path: worktreePath, baseRef: "abc", repoPath: worktreePath };
  const models: EngineModelConfig = {
    survey: { model: "terra" },
    design: { model: "opus" },
    edit: { model: "sol" },
    review: { model: "sol" },
    cluster_edit: { model: "terra" },
    sdk_setup: { model: "sol" },
    repair: { model: "sol" },
  };
  let terraCalls = 0;
  const sessionKeys: string[] = [];
  const provider: EngineProvider = {
    name: "hybrid",
    async invoke(invocation) {
      if (invocation.task === "cluster_edit") {
        terraCalls += 1;
        sessionKeys.push(invocation.sessionKey ?? "");
        if (terraCalls === 1) {
          writeFileSync(join(invocation.cwd, "src/auth/signup.ts"), "export function signup() { /* incomplete */ }\n");
          return { kind: "completed", text: "incomplete", costUsd: 0, turns: 1 };
        }
        writeFileSync(
          join(invocation.cwd, "src/auth/signup.ts"),
          'import { WhisperrEvents } from "../../whisperr-events";\n' +
            "export function signup() { WhisperrEvents.trialStarted({ plan, seatCount }); }\n",
        );
        return { kind: "completed", text: "fixed", costUsd: 0, turns: 1 };
      }
      return { kind: "completed", text: "VERDICT: pass", costUsd: 0, turns: 1 };
    },
  };
  const cluster = {
    id: "cluster_fallback",
    files: ["src/auth/signup.ts"],
    events: [placementsFor(registered)[0]!],
    status: "pending" as const,
    attempts: 0,
  };
  const outcome = await runClusterIntegration({
    provider,
    models,
    worktree,
    target: "nextjs",
    playbookSystemPrompt: "system",
    registered,
    ingestion: { apiKey: "pk", baseUrl: "https://api.example.test" },
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }),
    saveClusters: () => {},
    discardChanges: async () => {},
    onClusterIntegrated: async () => {},
  }, [cluster], async () => "diff");
  assert.equal(terraCalls, 2);
  assert.deepEqual(sessionKeys, ["event_insertion", "event_insertion"]);
  assert.equal(outcome.eventStatuses.get("trial_started"), "syntax_verified");
});
