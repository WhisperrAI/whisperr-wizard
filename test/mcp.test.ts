import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { IntegrationMCPClient, INTEGRATION_CONTRACT, MCPBrowserAuthorization, mcpBase, serveMCPStdio } from "../src/core/mcp.js";

const response = (body: unknown, status = 200) => new Response(status === 202 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("MCP origins reject secret-bearing, foreign, and insecure URLs", () => {
  assert.equal(mcpBase("https://api.whisperr.net/"), "https://api.whisperr.net");
  assert.equal(mcpBase("http://127.0.0.1:8123"), "http://127.0.0.1:8123");
  for (const value of ["http://api.whisperr.net", "https://api.whisperr.net.evil.test", "https://secret@api.whisperr.net", "https://api.whisperr.net?token=secret", "https://api.whisperr.net/mcp"]) assert.throws(() => mcpBase(value));
});

test("stdio forwards real JSON-RPC only, has no mutation retry, and never logs tokens", async () => {
  const calls: Record<string, unknown>[] = [];
  const request: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer wmcp_synthetic");
    assert.equal(init?.redirect, "error");
    const message = JSON.parse(String(init?.body)) as Record<string, unknown>; calls.push(message);
    if (message.method === "notifications/initialized") return response(null, 202);
    if (message.method === "tools/call") throw new Error("dependency echoed wmcp_synthetic provider-secret@example.test");
    return response({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "Whisperr", version: INTEGRATION_CONTRACT } } });
  };
  const client = new IntegrationMCPClient("https://api.whisperr.net", async () => "wmcp_synthetic", request);
  const input = Readable.from([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "commit_registration" } }) + "\n",
  ]);
  const output = new PassThrough(); let text = ""; output.on("data", (part) => { text += String(part); });
  await serveMCPStdio(client, input, output);
  assert.equal(calls.length, 3);
  const lines = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 1); assert.equal(lines[1].id, 2); assert.equal(lines[1].error.code, -32000);
  assert.doesNotMatch(text, /wmcp_synthetic|provider-secret|example.test/);
});

test("shared-playbook client pins contract and rejects a foreign protocol", async () => {
  let version = "2.0.0";
  let protocol = "2025-11-25";
  const calls: Record<string, unknown>[] = [];
  const request: typeof fetch = async (_url, init) => {
    const message = JSON.parse(String(init?.body)); calls.push(message);
    if (message.method === "notifications/initialized") return response(null, 202);
    return response({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: protocol } : { structuredContent: { contract_version: version } } });
  };
  await new IntegrationMCPClient("https://api.whisperr.net", async () => "wmcp_test", request).initialize();
  const tool = calls.find((message) => message.method === "tools/call")!;
  assert.equal(((tool.params as Record<string, unknown>).arguments as Record<string, unknown>).contract_version, "2.0.0");
  version = "3.0.0";
  await assert.rejects(new IntegrationMCPClient("https://api.whisperr.net", async () => "wmcp_test", request).initialize(), /contract mismatch/);
  protocol = "invented";
  await assert.rejects(new IntegrationMCPClient("https://api.whisperr.net", async () => "wmcp_test", request).initialize(), /Unsupported MCP protocol/);
});

test("browser authorization uses exact resource, S256, loopback/state, no disk credentials", async () => {
  const base = "https://api.whisperr.net";
  let challenge = "", redirect = "", tokenCalls = 0;
  const logs: string[] = [];
  const request: typeof fetch = async (raw, init) => {
    const url = String(raw);
    assert.equal(init?.redirect, "error");
    if (url.endsWith("/oauth-protected-resource/mcp")) return response({ resource: base + "/mcp", authorization_servers: [base] });
    if (url.endsWith("/oauth-authorization-server")) return response({ issuer: base, authorization_endpoint: base + "/oauth/mcp/authorize", token_endpoint: base + "/oauth/mcp/token", registration_endpoint: base + "/oauth/mcp/register" });
    if (url.endsWith("/register")) {
      const body = JSON.parse(String(init?.body)); redirect = body.redirect_uris[0];
      assert.equal(new URL(redirect).hostname, "127.0.0.1"); assert.equal(body.token_endpoint_auth_method, "none");
      return response({ client_id: "wmc_test" }, 201);
    }
    assert.ok(url.endsWith("/token")); tokenCalls++;
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("resource"), base + "/mcp"); assert.equal(body.get("redirect_uri"), redirect);
    assert.equal(body.get("code"), "test-code");
    assert.equal(createHash("sha256").update(body.get("code_verifier")!).digest("base64url"), challenge);
    return response({ access_token: "wmcp_access_synthetic", refresh_token: "wmcp_r_refresh_synthetic", expires_in: 900 });
  };
  const launch = async (raw: string) => {
    const auth = new URL(raw); challenge = auth.searchParams.get("code_challenge")!;
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.equal(auth.searchParams.get("resource"), base + "/mcp");
    const bad = new URL(redirect); bad.searchParams.set("state", "é".repeat(43)); bad.searchParams.set("code", "wrong");
    assert.equal((await fetch(bad)).status, 400);
    const good = new URL(redirect); good.searchParams.set("state", auth.searchParams.get("state")!); good.searchParams.set("code", "test-code");
    assert.equal((await fetch(good)).status, 200);
  };
  const auth = new MCPBrowserAuthorization(base, "integration:read", request, launch, (text) => { logs.push(text); });
  assert.equal(await auth.accessToken(), "wmcp_access_synthetic");
  assert.equal(await auth.accessToken(), "wmcp_access_synthetic");
  assert.equal(tokenCalls, 1);
  assert.doesNotMatch(logs.join("\n"), /wmcp_access|wmcp_r_refresh|test-code/);
});
