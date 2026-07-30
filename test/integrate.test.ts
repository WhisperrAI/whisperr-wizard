import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateBindings } from "../src/engine/bindings.js";
import {
  runClusterIntegration,
  runSdkSetupPass,
  type IntegrationDeps,
} from "../src/engine/integrate.js";
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
