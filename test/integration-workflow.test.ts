import { strict as assert } from "node:assert";
import { test } from "node:test";
import { IntegrationWorkflowClient, sharedServerKeyGuidance, syntheticProperties } from "../src/core/integration-workflow.js";

const event = { code: "checkout_started", name: "Checkout", payload_schema: { plan: "string", total: "number", active: "boolean" } };
test("shared server guidance keeps credentials in hosting config and distinguishes code from live proof", () => {
  assert.equal(sharedServerKeyGuidance(false), "");
  const guidance = sharedServerKeyGuidance(true);
  assert.match(guidance, /bootstrap key is publishable/);
  assert.match(guidance, /Never read, echo, invent, hard-code, or commit a server secret/);
  assert.match(guidance, /not deployment or live proof/);
});
function revision(state: string, missing = false) {
  return { contract_version: "2.0.0", revision: { revision_id: "rev_1", state, events: [event] },
    content_hash: "hash", current_event_codes: ["committed", "superseded"].includes(state) ? [event.code] : [],
    gaps: missing ? [{ event_code: event.code, reason: "isolated_test_event_not_received" }] : [] };
}
test("shared registration uses real isolated receipts and authoritative polling before commit", async () => {
  const paths: string[] = []; let tests = 0; let reads = 0;
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-run-session");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    for (const denied of ["app_id", "user_id", "mode", "environment", "consent", "test_events_seen"]) assert.equal(body[denied], undefined);
    if (path.endsWith("/source")) return Response.json({ contract_version: "2.0.0", connection_id: "con_code" });
    if (path.endsWith("/drafts")) { assert.deepEqual(body.events, [event]); return Response.json(revision("draft", true)); }
    if (path.endsWith("/validation")) return Response.json(revision("validating", true));
    if (path.endsWith("/tests")) {
      tests++; assert.deepEqual(body.properties, { plan: "synthetic", total: 0, active: false });
      return Response.json({ delivery_id: "delivery_1", disposition: "retrying" });
    }
    if (path.endsWith("/commit")) { assert.equal(tests, 1); assert.equal(reads, 2); return Response.json(revision("committed")); }
    if (path.endsWith("/deployment")) return Response.json({ reported: true, live_verified: false });
    reads++; return Response.json(revision("validating", reads < 2));
  };
  const client = new IntegrationWorkflowClient("https://api.whisperr.net", "synthetic-run-session", "run_1", request, async () => {});
  assert.equal((await client.registerEvents([event])).revision.state, "committed");
  assert.ok(!paths.some((path) => /oauth|items|deployment/.test(path)));
  await client.reportDeployment("deployment:abc123");
  assert.ok(paths.at(-1)?.endsWith("/deployment"));
});

test("missing receipt evidence never commits or falls back to legacy writers", async () => {
  const paths: string[] = [];
  const request: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path.endsWith("/source")) return Response.json({ contract_version: "2.0.0", connection_id: "con_code" });
    if (path.endsWith("/drafts")) return Response.json(revision("validating", true));
    if (path.endsWith("/tests")) return Response.json({ disposition: "retrying" });
    return Response.json(revision("validating", true));
  };
  const client = new IntegrationWorkflowClient("https://api.whisperr.net", "test", "run_1", request, async () => {}, 2);
  await assert.rejects(client.registerEvents([event]), /not committed/);
  assert.ok(!paths.some((path) => /commit|items|deployment/.test(path)));
});
test("unsupported contract and denied scope stop without mutation retries", async () => {
  let calls = 0;
  const bad: typeof fetch = async () => { calls++; return Response.json({ contract_version: "3.0.0", connection_id: "con_code" }); };
  await assert.rejects(new IntegrationWorkflowClient("https://api.whisperr.net", "test", "run_1", bad).registerEvents([event]), /code-source/);
  assert.equal(calls, 1);
  const denied: typeof fetch = async () => { calls++; return Response.json({ error: { code: "executor_not_authorized", message: "private detail" } }, { status: 403 }); };
  await assert.rejects(new IntegrationWorkflowClient("https://api.whisperr.net", "test", "run_1", denied).registerEvents([event]), /403: executor_not_authorized/);
  assert.equal(calls, 2);
});
test("durable committed resume skips new tests and deployment stays explicit", async () => {
  let calls = 0;
  const request: typeof fetch = async (input) => {
    calls++;
    if (String(input).endsWith("/source")) return Response.json({ contract_version: "2.0.0", connection_id: "con_code" });
    return Response.json(revision("committed"));
  };
  await new IntegrationWorkflowClient("https://api.whisperr.net", "test", "run_1", request).registerEvents([event]);
  assert.equal(calls, 2);
});
test("synthetic generation never interprets free-text descriptions as types", () => {
  assert.throws(() => syntheticProperties({ amount: "customer total from profile" }), /Unsupported/);
  assert.deepEqual(syntheticProperties({ type: "object", properties: { count: { type: "integer" }, list: { type: "array" } } }), { count: 0, list: [] });
});

test("superseded resume requires server-confirmed current definitions, without new proof or legacy writes", async () => {
  let current = true; const paths: string[] = [];
  const request: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname; paths.push(path);
    if (path.endsWith("/source")) return Response.json({ contract_version: "2.0.0", connection_id: "con_code" });
    return Response.json({ ...revision("superseded"), current_event_codes: current ? [event.code] : [] });
  };
  const client = new IntegrationWorkflowClient("https://api.whisperr.net", "test", "run_1", request);
  assert.equal((await client.registerEvents([event])).revision.state, "superseded");
  current = false;
  await assert.rejects(client.registerEvents([event]), /definitions changed/);
  assert.ok(!paths.some((path) => /tests|commit|items|deployment/.test(path)));
});
