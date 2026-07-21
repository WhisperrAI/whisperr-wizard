import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeRequestError, WizardRuntimeClient } from "../src/core/runtime.js";
import type { WizardConfig, WizardSession } from "../src/types.js";

const config = {
  apiBaseUrl: "https://api.test",
} as WizardConfig;
const session: WizardSession = {
  token: "session-secret",
  appId: "app_1",
  expiresAt: 0,
};

test("runtime client uses the run endpoints and camelCase idempotent item envelope", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const bootstrap = makeBootstrap();
  const client = new WizardRuntimeClient(
    config,
    session,
    (async (input, init) => {
      requests.push({ url: String(input), init });
      const method = init?.method;
      const url = String(input);
      if (method === "PATCH") {
        return Response.json(bootstrap.run);
      }
      if (url.endsWith("/complete")) {
        return Response.json({
          projects: [bootstrap.project],
          runs: [{ ...bootstrap.run, status: "completed", phase: "completed" }],
          interventionGroups: bootstrap.interventionGroups,
          interventions: bootstrap.interventions,
          events: bootstrap.events,
          links: bootstrap.links,
        });
      }
      if (url.endsWith("/items")) {
        return Response.json({
          kind: "group",
          created: true,
          item: bootstrap.interventionGroups[0],
        });
      }
      return Response.json(bootstrap);
    }) as typeof fetch,
  );

  await client.createOrResumeRun({
    repoFingerprint: "repo_1",
    displayName: "demo",
    target: "web-js",
    kind: "frontend",
  });
  await client.getRun("wrun_1");
  await client.updateRun("wrun_1", {
    phase: "analyzing",
    modelConversationId: "conv_1",
    message: "Inspecting repository",
    integrationEvidence: {
      changedFiles: ["src/app.ts"],
      identifyWired: true,
      verificationStatus: "pending",
      events: [],
    },
  });
  await client.createItem("wrun_1", {
    kind: "group",
    idempotencyKey: "group:retention",
    payload: {
      code: "retention",
      name: "Retention",
      reasoning: "The product has a concrete cancellation flow.",
    },
  });
  await client.completeRun("wrun_1", {
    changedFiles: ["src/app.ts"],
    identifyWired: true,
    verificationStatus: "unavailable",
    events: [],
  });

  assert.deepEqual(
    requests.map((request) => [request.init?.method, request.url]),
    [
      ["POST", "https://api.test/wizard/runs"],
      ["GET", "https://api.test/wizard/runs/wrun_1"],
      ["PATCH", "https://api.test/wizard/runs/wrun_1"],
      ["POST", "https://api.test/wizard/runs/wrun_1/items"],
      ["POST", "https://api.test/wizard/runs/wrun_1/complete"],
    ],
  );
  assert.equal(
    new Headers(requests[0]!.init?.headers).get("authorization"),
    "Bearer session-secret",
  );
  assert.deepEqual(JSON.parse(String(requests[3]!.init?.body)), {
    kind: "group",
    idempotencyKey: "group:retention",
    payload: {
      code: "retention",
      name: "Retention",
      reasoning: "The product has a concrete cancellation flow.",
    },
  });
  assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), {
    repoFingerprint: "repo_1",
    displayName: "demo",
    target: "web-js",
    kind: "frontend",
  });
  assert.deepEqual(JSON.parse(String(requests[2]!.init?.body)), {
    phase: "analyzing",
    modelConversationId: "conv_1",
    message: "Inspecting repository",
    integrationEvidence: {
      changedFiles: ["src/app.ts"],
      identifyWired: true,
      verificationStatus: "pending",
      events: [],
    },
  });
});

test("runtime client normalizes the bootstrap snapshot used by the agent", async () => {
  const client = new WizardRuntimeClient(
    config,
    session,
    (async () => Response.json(makeBootstrap())) as typeof fetch,
  );

  const snapshot = await client.getRun("wrun_1");

  assert.equal(snapshot.project.repoFingerprint, "repo_1");
  assert.equal(snapshot.run.modelConversationId, "conv_1");
  assert.equal(snapshot.model.groups[0]?.code, "retention");
  assert.match(snapshot.app.businessContext ?? "", /subscription/i);
});

test("runtime client reconciles a lost completion response from the authoritative run", async () => {
  const bootstrap = makeBootstrap();
  const client = new WizardRuntimeClient(
    config,
    session,
    (async (input, init) => {
      if (String(input).endsWith("/complete") && init?.method === "POST") {
        throw new Error("response lost after commit");
      }
      return Response.json({
        ...bootstrap,
        run: { ...bootstrap.run, status: "completed", phase: "completed" },
      });
    }) as typeof fetch,
  );

  const snapshot = await client.completeRun("wrun_1", {
    changedFiles: ["src/app.ts"],
    identifyWired: true,
    verificationStatus: "unavailable",
    events: [],
  });

  assert.equal(snapshot.run.status, "completed");
});

test("runtime errors scrub bearer and OpenAI-shaped secrets", async () => {
  const client = new WizardRuntimeClient(
    config,
    session,
    (async () =>
      new Response("Bearer session-secret failed for sk-abcdefghijklmnop", {
        status: 500,
      })) as typeof fetch,
  );
  await assert.rejects(
    () => client.getRun("wrun_1"),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeRequestError);
      assert.equal(error.message.includes("session-secret"), false);
      assert.equal(error.message.includes("sk-abcdefghijklmnop"), false);
      return true;
    },
  );
});

function makeBootstrap() {
  return {
    app: {
      id: "app_1",
      name: "Demo",
      businessContext: {
        productName: "Demo subscriptions",
        productDescription: "Subscription product",
        activation: "Customer completes checkout",
      },
    },
    project: {
      id: "wpr_1",
      appId: "app_1",
      repoFingerprint: "repo_1",
      displayName: "demo",
      target: "web-js",
      kind: "frontend",
    },
    run: {
      id: "wrun_1",
      projectId: "wpr_1",
      status: "running",
      phase: "analyzing",
      modelConversationId: "conv_1",
    },
    resumed: true,
    ingestion: { apiKey: "ingestion-key", baseUrl: "https://ingest.test" },
    interventionGroups: [
      {
        id: "aig_1",
        code: "retention",
        name: "Retention",
        reasoning: "The product has a concrete cancellation flow.",
      },
    ],
    interventions: [],
    events: [],
    links: [],
  };
}
