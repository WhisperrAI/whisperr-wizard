import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fetchIntegrationPlaybook } from "../src/core/integration-playbook.js";

const fixture = { contract_version: "2.0.0", playbook_version: "1", sdk_contract: "v1_unchanged", steps: ["inspect_repository", "read_authoritative_gaps"], invariants: ["tests cannot create live users"] };

test("legacy executor consumes the shared version-pinned playbook without minting MCP credentials", async () => {
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "https://api.whisperr.net/wizard/integration-playbook?contract_version=2.0.0");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-wizard-session");
    assert.equal(init?.redirect, "error");
    return new Response(JSON.stringify(fixture), { status: 200 });
  };
  assert.deepEqual(await fetchIntegrationPlaybook("https://api.whisperr.net", "synthetic-wizard-session", request), fixture);
  assert.equal(calls, 1);
});

test("version mismatch and disabled backend stop immediately without legacy fallback", async () => {
  let calls = 0;
  const mismatched: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ ...fixture, contract_version: "3.0.0" })); };
  await assert.rejects(fetchIntegrationPlaybook("https://api.whisperr.net", "test", mismatched), /contract mismatch/);
  assert.equal(calls, 1);
  const disabled: typeof fetch = async () => { calls++; return new Response(null, { status: 404 }); };
  await assert.rejects(fetchIntegrationPlaybook("https://api.whisperr.net", "test", disabled), /no legacy fallback/);
  assert.equal(calls, 2);
});
