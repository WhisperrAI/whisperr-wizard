import assert from "node:assert/strict";
import { RunContext, tool, type Agent, type FunctionTool, type Tool } from "@openai/agents";
import test from "node:test";
import { z } from "zod";
import {
  createAgentTopology,
  isConversationUnavailable,
  openAIProviderOptions,
  runIntegrationAgent,
  type AgentExecutor,
} from "../src/core/agent.js";
import type { WizardItemInput, WizardRunSnapshot } from "../src/core/runtime.js";
import type { Playbook, WizardConfig, WizardSession } from "../src/types.js";

const config: WizardConfig = {
  apiBaseUrl: "https://api.test",
  openAIBaseUrl: "https://api.test/wizard/openai",
  primaryModel: "gpt-5.6-sol",
  primaryEffort: "high",
  primaryServiceTier: "priority",
  explorerModel: "gpt-5.6-terra",
  explorerEffort: "xhigh",
  maxTurns: 200,
};
const session: WizardSession = {
  token: "wizard-session-token",
  appId: "app_1",
  expiresAt: 2_000_000_000,
};
const playbook: Playbook = {
  target: {
    id: "web-js",
    displayName: "Web",
    language: "typescript",
    availability: "available",
  },
  async detect() {
    return null;
  },
  packageRef: "@whisperr/web",
  systemPrompt: "Use __WHISPERR_INGESTION_KEY__ and instrument generated events.",
};

test("agent topology pins Sol and Terra settings and keeps Terra read-only", () => {
  const primaryTools = [dummyTool("create_event"), dummyTool("edit_file")];
  const explorerTools = [
    dummyTool("read_repository_file"),
    dummyTool("list_repository_files"),
    dummyTool("search_repository"),
  ];
  const topology = createAgentTopology({ config, playbook, primaryTools, explorerTools });

  assert.equal(topology.primary.model, "gpt-5.6-sol");
  assert.equal(topology.primary.modelSettings.reasoning?.effort, "high");
  assert.equal(topology.primary.modelSettings.providerData?.service_tier, "priority");
  assert.equal(topology.explorer.model, "gpt-5.6-terra");
  assert.equal(topology.explorer.modelSettings.reasoning?.effort, "xhigh");
  assert.deepEqual(topology.explorer.tools.map((entry) => entry.name), [
    "read_repository_file",
    "list_repository_files",
    "search_repository",
  ]);
  assert.equal(topology.primary.tools[0]?.name, "explore_repository");
  assert.equal(topology.explorer.tools.some((entry) => entry.name === "edit_file"), false);
  assert.equal(topology.explorer.tools.some((entry) => entry.name === "create_event"), false);
});

test("provider uses the wizard bearer at the gateway and direct key only when configured", () => {
  assert.deepEqual(openAIProviderOptions(config, session), {
    apiKey: "wizard-session-token",
    baseURL: "https://api.test/wizard/openai",
    useResponses: true,
  });
  assert.equal(
    openAIProviderOptions(config, session, "wrun_1")?.baseURL,
    "https://api.test/wizard/openai/runs/wrun_1/v1",
  );
  assert.equal(
    openAIProviderOptions({ ...config, directOpenAIKey: "direct-key" }, session)?.apiKey,
    "direct-key",
  );
});

test("one agent run writes group, intervention, event, and link before completion", async () => {
  const snapshot = makeSnapshot();
  const runtime = new FakeRuntime(snapshot);
  const modelInputs: string[] = [];
  const executor: AgentExecutor = {
    async createConversation() {
      return "conv_1";
    },
    async run({ agent, prompt }) {
      modelInputs.push(prompt);
      await invoke(agent, "create_intervention_group", {
        code: "retention",
        name: "Retention",
        reasoning: "The product has an explicit cancellation flow.",
      });
      await invoke(agent, "create_intervention", {
        groupCode: "retention",
        code: "save_subscription",
        name: "Save subscription",
        reasoning: "Whisperr can offer help before cancellation is confirmed.",
        enabled: false,
      });
      await invoke(agent, "create_event", {
        code: "cancellation_started",
        name: "Cancellation started",
        reasoning: "src/cancel.ts has the customer cancellation handler.",
      });
      await invoke(agent, "create_link", {
        interventionCode: "save_subscription",
        eventCode: "cancellation_started",
        reasoning: "Starting cancellation is direct evidence for a save action.",
      });
      await invoke(agent, "complete_run", { summary: "Created and integrated the model." });
      return { finalOutput: "Created and integrated the model." };
    },
  };

  const outcome = await runIntegrationAgent({
    repoPath: process.cwd(),
    config,
    session,
    playbook,
    snapshot,
    runtime: runtime as never,
    checkpoint: { isRepo: false },
    inspectIntegration: async (current) => ({
      files: ["src/cancel.ts"],
      identifyWired: true,
      wiredEvents: current.model.events.map((event) => ({
        id: event.id,
        code: event.code,
        status: "wired" as const,
        file: "src/cancel.ts",
      })),
    }),
    executor,
  });

  assert.deepEqual(
    runtime.calls.filter((call) => call.kind === "item").map((call) => call.input.kind),
    ["group", "intervention", "event", "link"],
  );
  const keys = runtime.calls
    .filter((call) => call.kind === "item")
    .map((call) => call.input.idempotencyKey);
  assert.match(keys[0]!, /^group:retention:[0-9a-f]{16}$/);
  assert.match(keys[1]!, /^intervention:save_subscription:[0-9a-f]{16}$/);
  assert.match(keys[2]!, /^event:cancellation_started:[0-9a-f]{16}$/);
  assert.match(keys[3]!, /^link:cancellation_started:save_subscription:[0-9a-f]{16}$/);
  assert.ok(
    runtime.calls.findIndex((call) => call.kind === "complete") >
      runtime.calls.findLastIndex((call) => call.kind === "item"),
  );
  assert.equal(outcome.conversationId, "conv_1");
  assert.equal(outcome.snapshot.run.status, "completed");
  assert.equal(JSON.stringify(modelInputs).includes(snapshot.ingestion.apiKey), false);
});

test("an unavailable conversation starts fresh from runtime state without duplicate writes", async () => {
  const snapshot = makeSnapshot();
  snapshot.run.modelConversationId = "conv_missing";
  snapshot.model.groups.push({
    id: "aig_existing",
    code: "retention",
    name: "Retention",
    reasoning: "Existing server row.",
  });
  const runtime = new FakeRuntime(snapshot);
  let attempts = 0;
  let created = 0;
  const prompts: string[] = [];
  const executor: AgentExecutor = {
    async createConversation() {
      created++;
      return "conv_fresh";
    },
    async run({ agent, prompt }) {
      attempts++;
      prompts.push(prompt);
      if (attempts === 1) throw new Error("Conversation conv_missing not found");
      await invoke(agent, "complete_run", { summary: "Resumed existing model." });
      return { finalOutput: "Resumed existing model." };
    },
  };

  const outcome = await runIntegrationAgent({
    repoPath: process.cwd(),
    config,
    session,
    playbook,
    snapshot,
    runtime: runtime as never,
    checkpoint: { isRepo: false },
    inspectIntegration: completeInspection,
    executor,
  });

  assert.equal(attempts, 2);
  assert.equal(created, 1);
  assert.equal(outcome.conversationId, "conv_fresh");
  assert.equal(runtime.calls.filter((call) => call.kind === "item").length, 0);
  assert.match(prompts[1]!, /aig_existing/);
});

test("a failed run with an existing conversation resumes as running without duplicate writes", async () => {
  const snapshot = makeSnapshot();
  snapshot.resumed = true;
  snapshot.run.status = "failed";
  snapshot.run.phase = "integrating";
  snapshot.run.modelConversationId = "conv_existing";
  snapshot.model.groups.push({
    id: "aig_existing",
    code: "retention",
    name: "Retention",
    reasoning: "Existing server row.",
  });
  const runtime = new FakeRuntime(snapshot);
  const executor: AgentExecutor = {
    async createConversation() {
      throw new Error("the existing conversation should be reused");
    },
    async run({ agent }) {
      await invoke(agent, "complete_run", { summary: "Resumed existing work." });
      return { finalOutput: "Resumed existing work." };
    },
  };

  await runIntegrationAgent({
    repoPath: process.cwd(),
    config,
    session,
    playbook,
    snapshot,
    runtime: runtime as never,
    checkpoint: { isRepo: false },
    inspectIntegration: completeInspection,
    executor,
  });

  assert.deepEqual(runtime.calls[0], {
    kind: "update",
    input: { status: "running", modelConversationId: "conv_existing" },
  });
  assert.equal(runtime.calls.filter((call) => call.kind === "item").length, 0);
});

test("an executor error after complete_run does not turn a completed run into a failure", async () => {
  const snapshot = makeSnapshot();
  const runtime = new FakeRuntime(snapshot);
  const executor: AgentExecutor = {
    async createConversation() {
      return "conv_1";
    },
    async run({ agent }) {
      await invoke(agent, "complete_run", { summary: "Complete before disconnect." });
      throw new Error("stream disconnected after completion");
    },
  };

  const outcome = await runIntegrationAgent({
    repoPath: process.cwd(),
    config,
    session,
    playbook,
    snapshot,
    runtime: runtime as never,
    checkpoint: { isRepo: false },
    inspectIntegration: completeInspection,
    executor,
  });

  assert.equal(outcome.snapshot.run.status, "completed");
  assert.equal(outcome.summary, "Whisperr generation and integration completed.");
});

test("conversation fallback only accepts missing or invalid conversation errors", () => {
  assert.equal(isConversationUnavailable(new Error("conversation abc is unavailable")), true);
  assert.equal(
    isConversationUnavailable({ status: 404, message: "Conversation was not found" }),
    true,
  );
  assert.equal(isConversationUnavailable({ status: 404, message: "Model was not found" }), false);
  assert.equal(isConversationUnavailable(new Error("rate limit exceeded")), false);
});

function dummyTool(name: string): Tool {
  return tool({
    name,
    description: name,
    parameters: z.object({ input: z.string() }),
    execute: ({ input }) => input,
  });
}

async function invoke(agent: Agent, name: string, input: Record<string, unknown>) {
  const entry = agent.tools.find(
    (candidate): candidate is FunctionTool =>
      candidate.type === "function" && candidate.name === name,
  );
  assert.ok(entry, `missing tool ${name}`);
  return entry.invoke(new RunContext(), JSON.stringify(input));
}

async function completeInspection() {
  return { files: ["src/app.ts"], identifyWired: true, wiredEvents: [] };
}

function makeSnapshot(): WizardRunSnapshot {
  return {
    app: { id: "app_1", name: "Demo", businessContext: "Subscription app" },
    project: {
      id: "wpr_1",
      appId: "app_1",
      repoFingerprint: "repo_1",
      displayName: "demo",
      target: "web-js",
      kind: "frontend",
    },
    run: { id: "wrun_1", projectId: "wpr_1", status: "running", phase: "authorizing" },
    model: { groups: [], interventions: [], events: [], links: [] },
    ingestion: { apiKey: "ingestion-secret-value", baseUrl: "https://ingest.test" },
  };
}

class FakeRuntime {
  calls: Array<
    | { kind: "update"; input: unknown }
    | { kind: "item"; input: WizardItemInput }
    | { kind: "get" }
    | { kind: "complete" }
  > = [];

  constructor(readonly snapshot: WizardRunSnapshot) {}

  async updateRun(_runId: string, input: unknown) {
    this.calls.push({ kind: "update", input });
    const update = input as { status?: "running" | "failed"; phase?: WizardRunSnapshot["run"]["phase"]; modelConversationId?: string };
    if (update.status) this.snapshot.run.status = update.status;
    if (update.phase) this.snapshot.run.phase = update.phase;
    if (update.modelConversationId) {
      this.snapshot.run.modelConversationId = update.modelConversationId;
    }
    return this.snapshot.run;
  }

  async createItem(_runId: string, input: WizardItemInput) {
    this.calls.push({ kind: "item", input });
    const id = `${input.kind}_${this.calls.length}`;
    const item = { id, ...input.payload };
    if (input.kind === "group") this.snapshot.model.groups.push(item as never);
    if (input.kind === "intervention") this.snapshot.model.interventions.push(item as never);
    if (input.kind === "event") this.snapshot.model.events.push({ ...item, projectId: "wpr_1" } as never);
    if (input.kind === "link") this.snapshot.model.links.push(item as never);
    return { kind: input.kind, idempotencyKey: input.idempotencyKey, item, created: true };
  }

  async getRun() {
    this.calls.push({ kind: "get" });
    return this.snapshot;
  }

  async completeRun() {
    this.calls.push({ kind: "complete" });
    this.snapshot.run.status = "completed";
    this.snapshot.run.phase = "completed";
    return this.snapshot;
  }
}
