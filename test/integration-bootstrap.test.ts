import assert from "node:assert/strict";
import { test } from "node:test";
import { bootstrapIntegration, finishIntegration, opportunityDefinition, type IntegrationBootstrap } from "../src/core/integration-bootstrap.js";
import { sanitizeOpportunities } from "../src/core/opportunities.js";
import type { WizardConfig, WizardSession } from "../src/types.js";
import type { IntegrationWorkflowClient } from "../src/core/integration-workflow.js";

const config = { apiBaseUrl: "https://api.whisperr.net" } as WizardConfig;
const session: WizardSession = { token: "synthetic-device-session", appId: "app_one", expiresAt: Date.now() / 1000 + 60 };
const event = { code: "checkout_started", name: "Checkout", reasoning: "Committed checkout", payload_schema: { total: "number" } };

test("opt-in bootstrap binds exact repo run with existing device session and no legacy manifest fallback", async () => {
  let calls = 0;
  const nested = { ...event, payload_schema: { type: "object", properties: { order: { type: "object", properties: { total: { type: "number" } }, additionalProperties: false } }, additionalProperties: false } };
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-device-session");
    if (calls === 2) {
      assert.equal(String(url), "https://api.whisperr.net/wizard/runs/run_one/integration/status?contract_version=2.0.0");
      return Response.json({ contract_version: "2.0.0", required_events: [nested] });
    }
    assert.equal(String(url), "https://api.whisperr.net/wizard/runs");
    const body = JSON.parse(String(init?.body)); assert.deepEqual(body, { repoFingerprint: "opaque-fingerprint", displayName: "customer-app", target: "nextjs", kind: "fullstack" });
    return Response.json({ universeMode: "wizard", run: { id: "run_one" }, project: { id: "project_one" }, app: { name: "App" },
      ingestion: { apiKey: "synthetic-runtime-installation-key", baseUrl: "https://api.whisperr.net" },
      snapshot: { events: [{ code: event.code, name: event.name, reasoning: event.reasoning, payloadSchema: event.payload_schema }] },
    });
  };
  const setup = await bootstrapIntegration(config, session, "/local/customer-app", "opaque-fingerprint", "nextjs", request);
  assert.equal(calls, 2); assert.equal(setup.runID, "run_one"); assert.equal(setup.manifest.events[0]?.eventType, event.code);
  assert.deepEqual(setup.definitions.get(event.code)?.payload_schema, nested.payload_schema);
  assert.match(setup.manifest.events[0]?.properties?.[0]?.description ?? "", /additionalProperties/);
  assert.deepEqual(setup.manifest.identify.channels, []);
  await assert.rejects(bootstrapIntegration(config, session, "/local/customer-app", "fp", "nextjs", async () => new Response(null, { status: 403 })), /no legacy manifest fallback/);
});

test("typed opportunities survive sanitization; descriptions are never guessed into schema types", () => {
  const clean = sanitizeOpportunities({ events: [{ code: event.code, properties: [{ name: "total", type: "number", description: "Order total" }] }] }, { events: [], identify: {} } as any);
  assert.deepEqual(opportunityDefinition(clean.events[0]!).payload_schema, { total: "number" });
  assert.throws(() => opportunityDefinition({ code: "unknown", properties: [{ name: "value", description: "Some value" }] }), /explicit primitive type/);
});

test("local finalization records real code evidence and never claims deployment", async () => {
  const calls: string[] = [];
  const client = {
    async registerEvents() { calls.push("register"); return { revision: { revision_id: "rev_one" } }; },
    async attachPlacement(revision: string, code: string, file: string) { calls.push("placement"); assert.equal(revision, "rev_one"); assert.equal(code, event.code); assert.equal(file, "src/checkout.ts"); return "event_stable"; },
    async reportDeployment() { throw new Error("Local code is not deployed"); },
  } as unknown as IntegrationWorkflowClient;
  const setup = { client, runID: "run_one", definitions: new Map([[event.code, event]]) } as IntegrationBootstrap;
  const request: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/complete")) {
      const body = JSON.parse(String(init?.body)); calls.push("complete");
      assert.equal(body.outcome, "completed"); assert.equal(body.verificationStatus, "passed");
      assert.deepEqual(body.events, [{ eventId: "event_stable", eventCode: event.code, status: "build_verified", file: "src/checkout.ts" }]);
      return Response.json({});
    }
    return Response.json({ project: { id: "project_one" }, snapshot: { events: [{ id: "event_stable", code: event.code, projectId: "project_one" }] } });
  };
  await finishIntegration(config, session, setup, [{ event_type: event.code, status: "wired", file: "src/checkout.ts" }], ["src/checkout.ts"], true, true, "completed", new Map(), request);
  assert.deepEqual(calls, ["register", "placement", "complete"]);
});
