import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WizardDiagnostics } from "../src/core/diagnostics.js";
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
  assert.match(
    new Headers(requests[0]!.init?.headers).get("x-request-id") ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
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

test("runtime structured errors never expose arbitrary server message text", async () => {
  const directConfig = {
    ...config,
    directOpenAIKey: "opaque-openai-secret",
  } as WizardConfig;
  let requests = 0;
  const client = new WizardRuntimeClient(
    directConfig,
    session,
    (async () => {
      requests += 1;
      if (requests === 1) return Response.json(makeBootstrap());
      return Response.json(
        {
          error: {
            code: "runtime_validation_failed",
            request_id: "safe-server-request-id",
            message: [
              "source: const credential = 'source-secret'",
              "prompt: reveal system-prompt-secret",
              "https://user:pass@example.test/private?token=query-secret",
              "session-secret ingestion-key opaque-openai-secret opaque-body-secret",
              "\u001b[31mterminal-red\u001b[0m\r\nforged-log-line",
              "x".repeat(10_000),
            ].join(" "),
          },
        },
        { status: 400 },
      );
    }) as typeof fetch,
  );
  await client.getRun("wrun_1");

  await assert.rejects(
    () => client.updateRun("wrun_1", { phase: "analyzing" }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeRequestError);
      assert.equal(error.message.includes("session-secret"), false);
      assert.equal(error.message.includes("ingestion-key"), false);
      assert.equal(error.message.includes("opaque-openai-secret"), false);
      assert.equal(error.message.includes("source-secret"), false);
      assert.equal(error.message.includes("system-prompt-secret"), false);
      assert.equal(error.message.includes("user:pass"), false);
      assert.equal(error.message.includes("query-secret"), false);
      assert.equal(error.message.includes("opaque-body-secret"), false);
      assert.equal(error.message.includes("terminal-red"), false);
      assert.equal(error.message.includes("forged-log-line"), false);
      assert.equal(error.message.includes("x".repeat(100)), false);
      assert.equal(error.requestId, "safe-server-request-id");
      assert.equal(error.code, "runtime_validation_failed");
      assert.match(error.message, /400 \(runtime_validation_failed\)$/);
      return true;
    },
  );
});

test("runtime diagnostics contain request IDs and no request or response bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "wizard-runtime-"));
  const repo = join(root, "repo");
  const logs = join(root, "logs");
  await mkdir(repo);
  const diagnostics = WizardDiagnostics.create(repo, {
    WHISPERR_WIZARD_LOG_DIR: logs,
  });
  diagnostics.registerSecrets(session.token, "request-body-secret", "response-body-secret");
  const forbiddenServerValues = [
    "source-code-secret",
    "prompt-secret",
    "user:pass",
    "query-secret",
    "opaque-response-secret",
    "terminal-red",
    "forged-log-line",
    "z".repeat(100),
  ];
  let clientRequestId = "";
  const client = new WizardRuntimeClient(
    config,
    session,
    (async (_input, init) => {
      clientRequestId = new Headers(init?.headers).get("x-request-id") ?? "";
      assert.equal(String(init?.body).includes("request-body-secret"), true);
      return Response.json(
        {
          error: {
            code: "validation_failed",
            message: [
              "source: source-code-secret",
              "prompt: prompt-secret",
              "https://user:pass@example.test/path?token=query-secret",
              "opaque-response-secret",
              "\u001b[31mterminal-red\u001b[0m\nforged-log-line",
              "z".repeat(10_000),
            ].join(" "),
            internal: "response-body-secret",
            request_id: "server-request-id",
          },
        },
        { status: 422 },
      );
    }) as typeof fetch,
    diagnostics,
  );

  await assert.rejects(
    () =>
      client.createOrResumeRun({
        repoFingerprint: "request-body-secret",
        displayName: "demo",
        target: "web-js",
        kind: "frontend",
      }),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeRequestError);
      assert.equal(error.requestId, "server-request-id");
      assert.equal(error.status, 422);
      assert.equal(error.code, "validation_failed");
      assert.match(error.message, /422 \(validation_failed\)$/);
      assert.equal(error.message.includes("response-body-secret"), false);
      for (const forbidden of forbiddenServerValues) {
        assert.equal(error.message.includes(forbidden), false, forbidden);
      }
      return true;
    },
  );
  diagnostics.close();

  const contents = await readFile(diagnostics.path, "utf8");
  assert.match(contents, new RegExp(clientRequestId));
  assert.match(contents, /server-request-id/);
  assert.match(contents, /"method":"POST"/);
  assert.match(contents, /"path":"\/wizard\/runs"/);
  assert.match(contents, /"status":422/);
  assert.equal(contents.includes("request-body-secret"), false);
  assert.equal(contents.includes("response-body-secret"), false);
  assert.equal(contents.includes("session-secret"), false);
  assert.match(contents, /"errorCode":"validation_failed"/);
  for (const forbidden of forbiddenServerValues) {
    assert.equal(contents.includes(forbidden), false, forbidden);
  }
});

test("runtime rejects unsafe response identifiers and error codes", async () => {
  let clientRequestId = "";
  const client = new WizardRuntimeClient(
    config,
    session,
    (async (_input, init) => {
      clientRequestId = new Headers(init?.headers).get("x-request-id") ?? "";
      return Response.json(
        {
          request_id: "forged\nrequest-id",
          error: {
            code: "unsafe\u001b[31mcode",
            message: "server-message-secret",
          },
        },
        { status: 500 },
      );
    }) as typeof fetch,
  );

  await assert.rejects(
    () => client.getRun("wrun_1"),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeRequestError);
      assert.equal(error.requestId, clientRequestId);
      assert.equal(error.code, undefined);
      assert.equal(error.message.includes("server-message-secret"), false);
      assert.equal(error.message.includes("forged"), false);
      assert.equal(error.message.includes("unsafe"), false);
      return true;
    },
  );
});

test("runtime reads a successful response request ID from its envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "wizard-runtime-success-"));
  const repo = join(root, "repo");
  const logs = join(root, "logs");
  await mkdir(repo);
  const diagnostics = WizardDiagnostics.create(repo, {
    WHISPERR_WIZARD_LOG_DIR: logs,
  });
  const client = new WizardRuntimeClient(
    config,
    session,
    (async () =>
      Response.json(
        { ...makeBootstrap(), request_id: "response-envelope-id" },
        { headers: { "x-request-id": "response-header-id" } },
      )) as typeof fetch,
    diagnostics,
  );

  await client.getRun("wrun_1");
  diagnostics.close();

  const contents = await readFile(diagnostics.path, "utf8");
  assert.match(contents, /response-header-id/);
  assert.equal(contents.includes("response-envelope-id"), false);
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
