import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { preflightIntegration } from "../src/core/integration-bootstrap.js";
import { primitivePayload, SharedEngineRegistration } from "../src/engine/shared-registration.js";
import type { RunBootstrap } from "../src/engine/runs.js";
import type { WizardConfig, WizardSession } from "../src/types.js";

test("local preflight refuses non-git, unborn, staged, untracked and dirty repositories", async () => {
  const repo = mkdtempSync(join(tmpdir(), "shared-preflight-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  await assert.rejects(preflightIntegration(repo), /Not a git repository/);
  await preflightIntegration(repo, true);
  git("init", "-q");
  await assert.rejects(preflightIntegration(repo, true), /no commit/);
  git("-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "--allow-empty", "-m", "baseline");
  await preflightIntegration(repo);
  writeFileSync(join(repo, "app.ts"), "original");
  await assert.rejects(preflightIntegration(repo), /uncommitted changes/);
  git("add", "app.ts");
  await assert.rejects(preflightIntegration(repo), /uncommitted changes/);
  git("-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-m", "app");
  writeFileSync(join(repo, "app.ts"), "user work");
  await assert.rejects(preflightIntegration(repo), /uncommitted changes/);
  await preflightIntegration(repo, true);
});

test("engine consumes authoritative primitive schemas and never guesses prose or discards nested constraints", () => {
  assert.deepEqual(primitivePayload({ count: "integer", total: "number", paid: "boolean", result: "null" }), { count: "integer", total: "number", paid: "boolean", result: "null" });
  assert.deepEqual(primitivePayload({ type: "object", properties: { total: { type: "number" } }, additionalProperties: false }), { total: "number" });
  assert.throws(() => primitivePayload({ value: "Order total" }), /not supported/);
  assert.throws(() => primitivePayload({ value: { type: "string", enum: ["approved"] } }), /not supported/);
  assert.throws(() => primitivePayload({ value: { type: "object", properties: {} } }), /not supported/);
});

test("shared resume replaces flattened snapshot types and retains the exact structured schema during placement recovery", async () => {
  const approved = { code: "checkout_started", name: "Approved checkout", reasoning: "Approved reasoning", payload_schema: { type: "object", properties: { count: { type: "integer" }, plan: { type: "string" } }, required: ["plan"], additionalProperties: false } };
  const calls: string[] = [];
  const request: typeof fetch = async (raw, init) => {
    const path = new URL(String(raw)).pathname;
    calls.push(path);
    if (path.endsWith("/status")) return Response.json({ contract_version: "2.0.0", required_events: [approved] });
    if (path.endsWith("/source")) return Response.json({ contract_version: "2.0.0", connection_id: "con_1" });
    if (path.endsWith("/drafts")) {
      assert.deepEqual(JSON.parse(String(init?.body)).events, [approved]);
      return Response.json({ contract_version: "2.0.0", revision: { revision_id: "rev_existing", state: "committed", events: [approved] }, content_hash: "hash", gaps: [], current_event_codes: [approved.code] });
    }
    assert.match(path, /\/rev_existing\/placement$/);
    assert.equal(JSON.parse(String(init?.body)).event_code, approved.code);
    return Response.json({ id: "event_canonical" });
  };
  const client = new SharedEngineRegistration({ apiBaseUrl: "https://api.whisperr.net" } as WizardConfig, { token: "token" } as WizardSession, "run_1", request);
  const snapshot = { project: { id: "project_1" }, snapshot: { events: [{ id: "event_canonical", projectId: "project_1", code: approved.code, name: "stale name", reasoning: "stale reason", payloadSchema: { count: "flattened description" }, anchorFile: "checkout.ts" }] } } as RunBootstrap;
  await client.restoreSnapshot(snapshot);
  const saved = snapshot.snapshot.events[0]!;
  assert.deepEqual(saved.payloadSchema, { count: "integer", plan: "string" });
  assert.equal(saved.name, approved.name);
  const placed = await client.registerAndPlace([{ code: saved.code, name: "model suggestion", reasoning: "model suggestion", anchorFile: "checkout.ts", payloadSchema: { plan: "string", count: "integer" } }]);
  assert.equal(placed[0]?.eventId, "event_canonical");
  assert.equal(placed[0]?.name, approved.name);
  assert.doesNotMatch(calls.join("\n"), /\/tests|\/commit|\/items|\/deployment/);
  await assert.rejects(client.registerAndPlace([{ ...placed[0]!, payloadSchema: { count: "string", plan: "string" } }]), /cannot redefine/);
});

test("shared resume refuses removed current definitions without reviving them from a legacy snapshot", async () => {
  const client = new SharedEngineRegistration({ apiBaseUrl: "https://api.whisperr.net" } as WizardConfig, { token: "token" } as WizardSession, "run_1", async () => Response.json({ contract_version: "2.0.0", required_events: [] }));
  await assert.rejects(client.restoreSnapshot({ project: { id: "project" }, snapshot: { events: [{ projectId: "project", code: "deleted_event", payloadSchema: {} }] } } as RunBootstrap), /no current approved registry definition/);
});
