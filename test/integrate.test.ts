import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateBindings } from "../src/engine/bindings.js";
import { runClusterIntegration, type IntegrationDeps } from "../src/engine/integrate.js";
import { createProgressSink } from "../src/engine/output.js";
import { placementsFor, type RegisteredEvent } from "../src/engine/selection.js";
import type { EngineModelConfig, EngineProvider, RoleInvocation } from "../src/engine/types.js";
import { resolveVerifySteps, runVerificationStatus, verifiedStatus } from "../src/engine/verify.js";
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
});

test("cluster integration marks overflow clusters resumable and reviews the rest", async () => {
  const worktreePath = mkdtempSync(join(tmpdir(), "integrate-"));
  const worktree: WorktreeHandle = { path: worktreePath, baseRef: "abc", repoPath: worktreePath };
  const models: EngineModelConfig = {
    survey: { model: "m", maxTurns: 5, maxMs: 1000 },
    design: { model: "m", maxTurns: 5, maxMs: 1000 },
    edit: { model: "m", maxTurns: 5, maxMs: 1000 },
    review: { model: "m", maxTurns: 5, maxMs: 1000 },
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
  assert.equal(outcome.eventStatuses.get("report_shared"), "applied");
  const failed = outcome.clusters.find((cluster) =>
    cluster.events.some((event) => event.eventCode === "trial_started"),
  );
  assert.equal(failed?.status, "failed_resumable");
  assert.ok(saved.length >= 4);
});
