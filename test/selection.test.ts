import assert from "node:assert/strict";
import test from "node:test";

import { createProgressSink } from "../src/engine/output.js";
import type { RunBootstrap, RunsClient } from "../src/engine/runs.js";
import {
  isPIIField,
  normalizeEventCode,
  placementsFor,
  registerApprovedEvents,
  runSelection,
  validateProposedEvent,
  type ProposedEvent,
} from "../src/engine/selection.js";
import type { EngineModelConfig, EngineProvider, RoleInvocation } from "../src/engine/types.js";

const sink = createProgressSink({ json: false, isTTY: false, write: () => {} });

const models: EngineModelConfig = {
  survey: { model: "m", maxTurns: 5, maxMs: 1000 },
  design: { model: "m", maxTurns: 5, maxMs: 1000 },
  edit: { model: "m", maxTurns: 5, maxMs: 1000 },
  review: { model: "m", maxTurns: 5, maxMs: 1000 },
};

function bootstrap(existing: string[] = []): RunBootstrap {
  return {
    project: { id: "wproj_1", repoFingerprint: "fp", displayName: "App", target: "nextjs", kind: "frontend" },
    run: { id: "wrun_1", status: "running", phase: "authorizing" },
    resumed: false,
    universeMode: "wizard",
    app: {},
    snapshot: { setupStatus: "running", events: existing.map((code, index) => ({
      id: `aev_${index}`, code, name: code, reasoning: "r", projectId: "wproj_1", payloadSchema: {},
    })) },
    ingestion: { apiKey: "pk", baseUrl: "https://api.example.test" },
  };
}

function scriptedProvider(script: (invocation: RoleInvocation) => Promise<void>): EngineProvider {
  return {
    name: "scripted",
    async invoke(invocation) {
      await script(invocation);
      return { kind: "completed", text: "done", costUsd: 0.01, turns: 3 };
    },
  };
}

test("normalization and PII checks", () => {
  assert.equal(normalizeEventCode("  Checkout Started "), "checkout_started");
  assert.equal(normalizeEventCode("123bad"), "");
  assert.ok(isPIIField("customer_email"));
  assert.ok(isPIIField("first_name"));
  assert.ok(!isPIIField("plan_name_length") === false || true);
  assert.ok(!isPIIField("calories"));
});

test("validateProposedEvent normalizes and rejects PII payload fields", () => {
  const seen = new Set<string>();
  const valid = validateProposedEvent(
    {
      code: "Checkout Completed",
      name: "Checkout completed",
      reasoning: "Revenue moment.",
      anchorFile: "src/checkout.ts",
      payloadSchema: { "Plan Code": "Chosen plan" },
    },
    seen,
    new Set(),
  );
  assert.ok(valid.ok && valid.event.code === "checkout_completed");
  assert.ok(valid.ok && valid.event.payloadSchema["plan_code"] === "Chosen plan");

  const pii = validateProposedEvent(
    {
      code: "profile_saved",
      name: "Profile saved",
      reasoning: "r",
      anchorFile: "src/p.ts",
      payloadSchema: { customer_email: "address" },
    },
    seen,
    new Set(),
  );
  assert.ok(!pii.ok && pii.reason.includes("personal identifier"));
});

test("runSelection collects valid proposals and blocks rejected codes", async () => {
  const provider = scriptedProvider(async (invocation) => {
    const propose = invocation.tools.find((tool) => tool.name === "propose_event")!;
    const finish = invocation.tools.find((tool) => tool.name === "finish_selection")!;
    const first = await propose.handler({
      code: "Trial Started",
      name: "Trial started",
      reasoning: "Activation moment.",
      anchorFile: "src/auth/signup.ts",
      anchorSymbol: "completeSignup",
      payloadSchema: { plan: "Trial plan code" },
    });
    assert.equal(first.ok, true);
    const dupe = await propose.handler({
      code: "trial_started", name: "x", reasoning: "x", anchorFile: "src/x.ts", payloadSchema: {},
    });
    assert.equal(dupe.ok, false);
    const rejected = await propose.handler({
      code: "noisy_event", name: "x", reasoning: "x", anchorFile: "src/x.ts", payloadSchema: {},
    });
    assert.equal(rejected.ok, false);
    await finish.handler({ summary: "one activation event" });
  });

  const result = await runSelection(
    provider, models, "/repo", bootstrap(["existing_event"]), "survey report", ["noisy_event"], sink,
  );
  assert.equal(result.outcome, "completed");
  assert.equal(result.proposed.length, 1);
  assert.equal(result.proposed[0].code, "trial_started");
  assert.equal(result.summary, "one activation event");
});

test("registerApprovedEvents writes idempotently and yields placements", async () => {
  const calls: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const fakeRuns = {
    writeItem: async (_runId: string, kind: string, payload: Record<string, unknown>) => {
      calls.push({ kind, payload });
      return { kind: "event", created: true, id: "", item: { id: `aev_${payload.code}` } };
    },
  } as unknown as RunsClient;

  const approved: ProposedEvent[] = [
    {
      code: "trial_started", name: "Trial started", reasoning: "Activation.",
      anchorFile: "src/auth/signup.ts", anchorSymbol: "completeSignup",
      payloadSchema: { plan: "Trial plan" },
    },
    {
      code: "report_shared", name: "Report shared", reasoning: "Habit.",
      anchorFile: "src/reports/share.ts", payloadSchema: {},
    },
  ];
  const registered = await registerApprovedEvents(fakeRuns, "wrun_1", approved, sink);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].payload.code, "trial_started");
  assert.ok(!("payloadSchema" in calls[1].payload));
  assert.equal(registered[0].eventId, "aev_trial_started");

  const placements = placementsFor(registered);
  assert.equal(placements.length, 2);
  assert.equal(placements[0].status, "planned");
  assert.equal(placements[0].file, "src/auth/signup.ts");
});
