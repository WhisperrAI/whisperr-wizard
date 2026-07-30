import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOpenAIProvider, fileTools } from "../src/engine/providers/openai.js";
import { createRoutedProvider } from "../src/engine/providers/router.js";
import type { EngineProvider, RoleModelConfig } from "../src/engine/types.js";
import type { WizardConfig, WizardSession } from "../src/types.js";

const roleConfig: RoleModelConfig = {
  model: "gpt-5.6-sol",
  effort: "medium",
  serviceTier: "priority",
};

test("OpenAI file tools hide and deny secret material", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "openai-secrets-"));
  writeFileSync(join(cwd, ".env.local"), "SECRET=local");
  writeFileSync(join(cwd, ".env.example"), "SECRET=example");
  writeFileSync(join(cwd, "visible.txt"), "safe");

  const tools = fileTools(cwd, true);
  const read = tools.find((tool) => tool.name === "read_file")!;
  const list = tools.find((tool) => tool.name === "list_dir")!;
  const write = tools.find((tool) => tool.name === "write_file")!;
  const replace = tools.find((tool) => tool.name === "replace_in_file")!;

  await assert.rejects(read.handler({ path: ".env.local" }), /secret material/);
  await assert.rejects(read.handler({ path: ".env.example" }), /secret material/);
  await assert.rejects(write.handler({ path: ".env.local", content: "changed" }), /secret material/);
  await assert.rejects(
    replace.handler({ path: ".env.example", oldText: "SECRET", newText: "KEY" }),
    /secret material/,
  );

  const listing = await list.handler({ path: "." }) as { entries: string[] };
  assert.deepEqual(listing.entries, ["file:visible.txt"]);
});

test("openai provider binds a conversation and loops function calls", async () => {
  const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
  let conversationSequence = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      seen.push({ path: request.url ?? "", body: parsed });
      response.setHeader("Content-Type", "application/json");
      if ((request.url ?? "").endsWith("/v1/conversations")) {
        conversationSequence += 1;
        response.end(JSON.stringify({ id: `conv_${conversationSequence}` }));
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
      task: "design",
      sessionKey: "design",
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
      repositoryAccess: { mode: "none" },
      allowRepoWrite: false,
      cwd: mkdtempSync(join(tmpdir(), "openai-cwd-")),
    },
    roleConfig,
    () => {},
  );
  const surveyOutcome = await provider.invoke(
    {
      role: "survey",
      task: "survey",
      sessionKey: "survey",
      systemPrompt: "sys",
      userPrompt: "go",
      tools: [{
        name: "probe",
        description: "test tool",
        inputSchema: {},
        jsonSchema: { type: "object", properties: { ping: { type: "string" } } },
        handler: async () => ({ ok: true }),
      }],
      repositoryAccess: { mode: "survey" },
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
  assert.equal(surveyOutcome.kind, "completed");
  if (surveyOutcome.kind === "completed") {
    assert.equal(surveyOutcome.sessionId, "conv_2");
  }
  assert.deepEqual(toolCalls, [{ ping: "pong" }]);
  assert.ok(seen[0].path.includes("/wizard/openai/runs/wrun_9/v1/conversations"));
  assert.equal(seen[1].body.conversation, "conv_1");
  const tools = seen[1].body.tools as Array<{ name: string }>;
  assert.ok(tools.some((tool) => tool.name === "probe"));
  assert.ok(!tools.some((tool) => tool.name === "read_file"));
  assert.ok(!tools.some((tool) => tool.name === "write_file"));
  assert.deepEqual(seen[1].body.reasoning, {
    effort: "medium",
    summary: "detailed",
    context: "all_turns",
  });
  assert.equal(seen[1].body.service_tier, "priority");
  assert.equal("max_output_tokens" in seen[1].body, false);
  const conversationCreates = seen.filter((request) => request.path.endsWith("/v1/conversations"));
  assert.equal(conversationCreates.length, 2, "design and survey use isolated conversations");
});

test("openai provider preserves a terminal response error returned with HTTP 200", async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("Content-Type", "application/json");
      if ((request.url ?? "").endsWith("/v1/conversations")) {
        response.end(JSON.stringify({ id: "conv_failed" }));
        return;
      }
      response.end(JSON.stringify({
        id: "resp_failed",
        status: "failed",
        error: { message: "provider rejected the setup request" },
        output: [],
      }));
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
  provider.onRunReady?.("wrun_failed");
  const outcome = await provider.invoke(
    {
      role: "edit",
      task: "sdk_setup",
      sessionKey: "sdk_setup",
      systemPrompt: "system",
      userPrompt: "setup",
      tools: [],
      repositoryAccess: { mode: "sdk_setup", allowedFiles: [] },
      allowRepoWrite: true,
      cwd: mkdtempSync(join(tmpdir(), "openai-failed-")),
    },
    roleConfig,
    () => {},
  );
  server.close();

  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed") {
    assert.match(outcome.error, /provider rejected the setup request/);
  }
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
    {
      role: "survey",
      task: "survey",
      sessionKey: "survey",
      systemPrompt: "s",
      userPrompt: "u",
      tools: [],
      repositoryAccess: { mode: "survey" },
      allowRepoWrite: false,
      cwd,
    },
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

test("fixed routes never reassign Terra work to Sol after a failure", async () => {
  const calls: string[] = [];
  const openai: EngineProvider = {
    name: "openai",
    invoke: async (_invocation, config) => {
      calls.push(config.model);
      if (config.model === "gpt-5.6-terra") {
        return { kind: "failed", error: "wizard model quota is exhausted", costUsd: 0, turns: 1 };
      }
      return { kind: "completed", text: "done", costUsd: 0, turns: 1 };
    },
  };
  const solConfig: RoleModelConfig = {
    model: "gpt-5.6-sol",
    effort: "medium",
    serviceTier: "priority",
  };
  const routed = createRoutedProvider({
    cluster_edit: { provider: openai },
    review: { provider: openai },
  }, openai);
  const invocation = {
    role: "edit" as const,
    task: "cluster_edit" as const,
    systemPrompt: "",
    userPrompt: "",
    tools: [],
    allowRepoWrite: true,
    cwd: "/tmp",
  };
  const terraConfig: RoleModelConfig = {
    model: "gpt-5.6-terra",
    effort: "medium",
    serviceTier: "priority",
  };
  const first = await routed.invoke(invocation, terraConfig, () => {});
  assert.equal(first.kind, "failed", "the current dirty attempt must be rolled back by the caller");
  const review = await routed.invoke(
    {
      ...invocation,
      role: "review",
      task: "review",
      allowRepoWrite: false,
      repositoryAccess: { mode: "review" },
    },
    solConfig,
    () => {},
  );
  assert.equal(review.kind, "completed");
  const next = await routed.invoke(invocation, terraConfig, () => {});
  assert.equal(next.kind, "failed");
  assert.deepEqual(calls, ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-terra"]);
});
