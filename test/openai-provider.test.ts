import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOpenAIProvider } from "../src/engine/providers/openai.js";
import { createRoutedProvider } from "../src/engine/providers/router.js";
import type { EngineProvider, RoleModelConfig } from "../src/engine/types.js";
import type { WizardConfig, WizardSession } from "../src/types.js";

const roleConfig: RoleModelConfig = { model: "gpt-5.6-sol", effort: "high", maxTurns: 6, maxMs: 30_000 };

test("openai provider binds a conversation and loops function calls", async () => {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      seen.push({ path: request.url ?? "", body: parsed });
      response.setHeader("Content-Type", "application/json");
      if ((request.url ?? "").endsWith("/v1/conversations")) {
        response.end(JSON.stringify({ id: "conv_1" }));
        return;
      }
      const input = parsed.input as Array<Record<string, unknown>>;
      const isToolResult = input.some((item) => item.type === "function_call_output");
      if (!isToolResult) {
        response.end(JSON.stringify({
          id: "resp_1",
          output: [{ type: "function_call", name: "probe", call_id: "call_1", arguments: JSON.stringify({ ping: "pong" }) }],
        }));
      } else {
        response.end(JSON.stringify({ id: "resp_2", output: [], output_text: "final answer" }));
      }
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  const provider = createOpenAIProvider(
    { apiBaseUrl: `http://127.0.0.1:${port}` } as WizardConfig,
    { token: "tok", appId: "app", expiresAt: 0 } as WizardSession,
  );
  provider.onRunReady?.("wrun_9");

  const toolCalls: Array<Record<string, unknown>> = [];
  const outcome = await provider.invoke(
    {
      role: "design",
      systemPrompt: "sys",
      userPrompt: "go",
      tools: [{
        name: "probe",
        description: "test tool",
        inputSchema: {},
        jsonSchema: { type: "object", properties: { ping: { type: "string" } } },
        handler: async (input) => {
          toolCalls.push(input);
          return { ok: true };
        },
      }],
      allowRepoWrite: false,
      cwd: mkdtempSync(join(tmpdir(), "openai-cwd-")),
    },
    roleConfig,
    () => {},
  );
  server.close();

  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.equal(outcome.text, "final answer");
    assert.equal(outcome.sessionId, "conv_1");
  }
  assert.deepEqual(toolCalls, [{ ping: "pong" }]);
  assert.ok(seen[0].path.includes("/wizard/openai/runs/wrun_9/v1/conversations"));
  assert.equal(seen[1].body.conversation, "conv_1");
  const tools = seen[1].body.tools as Array<{ name: string }>;
  assert.ok(tools.some((tool) => tool.name === "probe"));
  assert.ok(tools.some((tool) => tool.name === "read_file"));
  assert.ok(!tools.some((tool) => tool.name === "write_file"));
});

test("file tools are jailed to the repository", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "openai-jail-"));
  writeFileSync(join(cwd, "inside.txt"), "safe");
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if ((request.url ?? "").endsWith("/v1/conversations")) {
        response.end(JSON.stringify({ id: "conv_2" }));
        return;
      }
      const parsed = JSON.parse(body) as { input: Array<Record<string, unknown>> };
      const isToolResult = parsed.input.some((item) => item.type === "function_call_output");
      if (!isToolResult) {
        response.end(JSON.stringify({
          output: [{ type: "function_call", name: "read_file", call_id: "c1", arguments: JSON.stringify({ path: "../../etc/hosts" }) }],
        }));
      } else {
        const output = JSON.parse(String(parsed.input[0].output)) as { ok?: boolean; reason?: string };
        response.end(JSON.stringify({ output: [], output_text: output.reason ?? "no reason" }));
      }
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  const provider = createOpenAIProvider(
    { apiBaseUrl: `http://127.0.0.1:${port}` } as WizardConfig,
    { token: "tok", appId: "app", expiresAt: 0 } as WizardSession,
  );
  provider.onRunReady?.("wrun_10");
  const outcome = await provider.invoke(
    { role: "survey", systemPrompt: "s", userPrompt: "u", tools: [], allowRepoWrite: false, cwd },
    roleConfig,
    () => {},
  );
  server.close();
  assert.equal(outcome.kind, "completed");
  if (outcome.kind === "completed") {
    assert.ok(outcome.text.includes("escapes the repository"));
  }
});

test("routed provider dispatches by role and fans out run binding", async () => {
  const calls: string[] = [];
  const stub = (name: string): EngineProvider => ({
    name,
    onRunReady: () => calls.push(`ready:${name}`),
    invoke: async () => {
      calls.push(`invoke:${name}`);
      return { kind: "completed", text: name, costUsd: 0, turns: 1 };
    },
  });
  const routed = createRoutedProvider({ design: stub("openai") }, stub("claude"));
  routed.onRunReady?.("wrun_11");
  await routed.invoke(
    { role: "design", systemPrompt: "", userPrompt: "", tools: [], allowRepoWrite: false, cwd: "/tmp" },
    roleConfig,
    () => {},
  );
  await routed.invoke(
    { role: "edit", systemPrompt: "", userPrompt: "", tools: [], allowRepoWrite: true, cwd: "/tmp" },
    roleConfig,
    () => {},
  );
  assert.ok(calls.includes("ready:openai") && calls.includes("ready:claude"));
  assert.deepEqual(calls.filter((entry) => entry.startsWith("invoke:")), ["invoke:openai", "invoke:claude"]);
});
