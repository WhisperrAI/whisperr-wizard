import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type HookOutput = {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
};

type AgentModule = {
  buildToolPolicyHooks?: (repoPath: string) => {
    PreToolUse?: Array<{
      hooks?: Array<
        (
          input: Record<string, unknown>,
          toolUseID: string | undefined,
          options: { signal: AbortSignal },
        ) => Promise<HookOutput>
      >;
    }>;
  };
  createToolPermissionCallback?: (
    repoPath: string,
  ) => (
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ) => Promise<{ behavior: string; message?: string }>;
};

test("sandbox policy denies in-cwd .env via Read and Bash cat before execution", async () => {
  const repoPath = await mkdtemp(join(tmpdir(), "whisperr-sandbox-"));
  const sentinel = "WHISPERR_SENTINEL_SECRET=sk-ant-SENTINEL-DO-NOT-LEAK";
  await writeFile(join(repoPath, ".env"), `${sentinel}\n`, "utf8");

  try {
    const agent = (await import("../src/core/agent.js")) as AgentModule;
    assert.equal(
      typeof agent.buildToolPolicyHooks,
      "function",
      "agent module must export buildToolPolicyHooks; without it runPass has no PreToolUse pre-allow gate",
    );
    assert.equal(
      typeof agent.createToolPermissionCallback,
      "function",
      "agent module must export createToolPermissionCallback for the second policy layer",
    );

    const hooks = agent.buildToolPolicyHooks(repoPath);
    const preToolUse = hooks.PreToolUse?.[0]?.hooks?.[0];
    assert.equal(typeof preToolUse, "function", "runPass policy options must include a PreToolUse hook");

    const canUseTool = agent.createToolPermissionCallback(repoPath);
    const controller = new AbortController();
    const vectors = [
      { toolName: "Read", input: { file_path: ".env" } },
      { toolName: "Bash", input: { command: "cat .env" } },
    ];

    for (const [index, vector] of vectors.entries()) {
      const hookResult = await preToolUse(
        {
          hook_event_name: "PreToolUse",
          session_id: "test-session",
          transcript_path: join(repoPath, "transcript.jsonl"),
          cwd: repoPath,
          tool_name: vector.toolName,
          tool_input: vector.input,
          tool_use_id: `hook-${index}`,
        },
        `hook-${index}`,
        { signal: controller.signal },
      );
      assert.equal(hookResult.hookSpecificOutput?.hookEventName, "PreToolUse");
      assert.equal(hookResult.hookSpecificOutput?.permissionDecision, "deny");
      assert.ok(hookResult.hookSpecificOutput?.permissionDecisionReason);
      assert.equal(JSON.stringify(hookResult).includes(sentinel), false);

      const permissionResult = await canUseTool(vector.toolName, vector.input, {
        signal: controller.signal,
        toolUseID: `can-${index}`,
      });
      assert.equal(permissionResult.behavior, "deny");
      assert.equal(JSON.stringify(permissionResult).includes(sentinel), false);
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
