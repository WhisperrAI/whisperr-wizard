import { createSdkMcpServer, query, tool, type Options } from "@anthropic-ai/claude-agent-sdk";

import {
  applyModelAuthEnv,
  buildToolPolicyHooks,
  createToolPermissionCallback,
} from "../../core/agent.js";
import { trustedEngineMcpTools } from "../../core/toolPolicy.js";
import type { WizardConfig, WizardSession } from "../../types.js";
import { classifyFailure } from "../budgets.js";
import type {
  EngineProvider,
  RoleInvocation,
  RoleModelConfig,
  RoleOutcome,
} from "../types.js";

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;
const EDIT_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"] as const;
const FAST_MODE_MODELS = new Set(["claude-opus-5", "claude-opus-4-8"]);

export function supportsClaudeFastMode(model: string): boolean {
  return FAST_MODE_MODELS.has(model);
}

interface StreamTextBlock {
  type: string;
  text?: string;
  name?: string;
}

interface StreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  message?: { content?: StreamTextBlock[] };
}

export function createClaudeProvider(
  config: WizardConfig,
  session: WizardSession,
): EngineProvider {
  return {
    name: "claude",
    async invoke(
      invocation: RoleInvocation,
      roleConfig: RoleModelConfig,
      onProgress: (action: string) => void,
    ): Promise<RoleOutcome> {
      applyModelAuthEnv(config, session);

      const hostTools = invocation.tools.map((engineTool) =>
        tool(engineTool.name, engineTool.description, engineTool.inputSchema, async (args) => {
          const result = await engineTool.handler(args as Record<string, unknown>);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }),
      );
      const trustedTools = trustedEngineMcpTools(invocation.tools);
      const allowedTools = [
        ...(invocation.allowRepoWrite ? EDIT_TOOLS : READ_ONLY_TOOLS),
        ...trustedTools,
      ];

      let sessionId = invocation.resumeSessionId;
      let costUsd = 0;
      let turns = 0;
      const deadline = Date.now() + roleConfig.maxMs;

      const outcome = (
        kind: "completed" | "context_overflow" | "budget_exhausted" | "failed",
        text = "",
        error = "",
      ): RoleOutcome =>
        kind === "completed"
          ? { kind, text, sessionId, costUsd, turns }
          : kind === "failed"
            ? { kind, error, sessionId, costUsd, turns }
            : { kind, sessionId, costUsd, turns };

      try {
        const response = query({
          prompt: invocation.userPrompt,
          options: {
            model: roleConfig.model,
            cwd: invocation.cwd,
            systemPrompt: invocation.systemPrompt,
            thinking: { type: "adaptive" },
            ...(roleConfig.effort ? { effort: roleConfig.effort as Options["effort"] } : {}),
            tools: [...allowedTools],
            ...(hostTools.length > 0
              ? { mcpServers: { engine: createSdkMcpServer({ name: "engine", tools: hostTools }) } }
              : {}),
            hooks: buildToolPolicyHooks(invocation.cwd, trustedTools),
            canUseTool: createToolPermissionCallback(invocation.cwd, trustedTools),
            maxTurns: roleConfig.maxTurns,
            ...(supportsClaudeFastMode(roleConfig.model)
              ? { settings: { fastMode: true } }
              : {}),
            ...(invocation.resumeSessionId ? { resume: invocation.resumeSessionId } : {}),
            settingSources: [],
          },
        });
        for await (const raw of response as AsyncIterable<StreamMessage>) {
          if (raw.session_id) {
            sessionId = raw.session_id;
          }
          if (raw.type === "assistant") {
            turns += 1;
            const block = raw.message?.content?.find(
              (candidate) => candidate.type === "text" || candidate.type === "tool_use",
            );
            if (block?.type === "text" && block.text?.trim()) {
              onProgress((block.text.trim().split("\n")[0] ?? "").slice(0, 120));
            } else if (block?.type === "tool_use" && block.name) {
              onProgress(`using ${block.name}`);
            }
            if (Date.now() > deadline) {
              await (response as { interrupt?: () => Promise<void> }).interrupt?.();
              return outcome("budget_exhausted");
            }
          } else if (raw.type === "result") {
            costUsd = raw.total_cost_usd ?? 0;
            const subtype = raw.subtype ?? "";
            if (subtype === "success") {
              return outcome("completed", raw.result ?? "");
            }
            if (subtype.includes("max_turns") || subtype.includes("max_budget")) {
              return outcome("budget_exhausted");
            }
            const detail = raw.result ?? subtype;
            if (classifyFailure(detail) === "context_overflow") {
              return outcome("context_overflow");
            }
            return outcome("failed", "", detail || "model run failed");
          }
        }
        return outcome("failed", "", "model stream ended without a result");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (classifyFailure(detail) === "context_overflow") {
          return outcome("context_overflow");
        }
        return outcome("failed", "", detail);
      }
    },
  };
}
