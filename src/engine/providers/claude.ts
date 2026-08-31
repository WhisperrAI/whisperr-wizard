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
const CONSTRAINED_EDIT_TOOLS = ["Read", "Edit", "Write"] as const;
const SETUP_TOOLS = ["Read", "Edit", "Write", "Bash"] as const;
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
  let runId = "";
  return {
    name: "claude",
    onRunReady(readyRunId: string): void {
      runId = readyRunId;
    },
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
      const accessMode = invocation.repositoryAccess?.mode ??
        (invocation.allowRepoWrite ? "repair" : "survey");
      const repositoryTools = accessMode === "none" || accessMode === "review"
        ? []
        : accessMode === "survey"
          ? READ_ONLY_TOOLS
          : accessMode === "sdk_setup"
            ? SETUP_TOOLS
            : CONSTRAINED_EDIT_TOOLS;
      const allowedTools = [...repositoryTools, ...trustedTools];
      const allowedFiles = invocation.repositoryAccess?.allowedFiles
        ? new Set(invocation.repositoryAccess.allowedFiles.map((file) => file.replaceAll("\\", "/")))
        : undefined;

      let sessionId = invocation.resumeSessionId;
      let costUsd = 0;
      let turns = 0;

      const outcome = (
        kind: "completed" | "context_overflow" | "failed",
        text = "",
        error = "",
      ): RoleOutcome =>
        kind === "completed"
          ? { kind, text, sessionId, costUsd, turns }
          : kind === "failed"
            ? { kind, error, sessionId, costUsd, turns }
            : { kind, sessionId, costUsd, turns };

      const task = invocation.task ?? invocation.role;
      const sessionKey = invocation.sessionKey ?? task;
      const customHeaders = [
        process.env.ANTHROPIC_CUSTOM_HEADERS,
        runId ? `X-Whisperr-Wizard-Run-ID: ${headerValue(runId)}` : "",
        `X-Whisperr-Wizard-Task: ${headerValue(task)}`,
        `X-Whisperr-Wizard-Session-Key: ${headerValue(sessionKey)}`,
        `X-Whisperr-Wizard-Model: ${headerValue(roleConfig.model)}`,
        `X-Whisperr-Wizard-Effort: ${headerValue(roleConfig.effort ?? "")}`,
        `X-Whisperr-Wizard-Service-Tier: ${roleConfig.fastMode ? "fast" : "default"}`,
      ].filter(Boolean).join("\n");
      let prompt = invocation.userPrompt;
      let resume = invocation.resumeSessionId;
      for (;;) {
        try {
          const response = query({
            prompt,
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
              hooks: buildToolPolicyHooks(invocation.cwd, trustedTools, allowedFiles),
              canUseTool: createToolPermissionCallback(invocation.cwd, trustedTools, allowedFiles),
              settings: {
                fastMode: roleConfig.fastMode ?? supportsClaudeFastMode(roleConfig.model),
                autoCompactEnabled: true,
                autoCompactWindow: 750_000,
                switchModelsOnFlag: false,
              },
              ...(resume ? { resume } : {}),
              settingSources: [],
              env: {
                ...process.env,
                ANTHROPIC_CUSTOM_HEADERS: customHeaders,
              },
            },
          });
          let retry = false;
          for await (const raw of response as AsyncIterable<StreamMessage>) {
            if (raw.session_id) {
              sessionId = raw.session_id;
              resume = raw.session_id;
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
            } else if (raw.type === "result") {
              costUsd = raw.total_cost_usd ?? 0;
              const subtype = raw.subtype ?? "";
              if (subtype === "success") {
                return outcome("completed", raw.result ?? "");
              }
              const detail = raw.result ?? subtype;
              if (classifyFailure(detail) === "context_overflow") {
                prompt = rolloverPrompt(invocation.userPrompt);
                resume = undefined;
                retry = true;
                break;
              }
              if (classifyFailure(detail) === "transient") {
                onProgress("provider interrupted; retrying the same model and conversation");
                await retryDelay();
                retry = true;
                break;
              }
              return outcome("failed", "", detail || "model run failed");
            }
          }
          if (retry) continue;
          return outcome("failed", "", "model stream ended without a result");
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const failure = classifyFailure(detail);
          if (failure === "context_overflow") {
            prompt = rolloverPrompt(invocation.userPrompt);
            resume = undefined;
            onProgress("context rolled into a fresh conversation with the same Opus model");
            continue;
          }
          if (failure === "transient") {
            onProgress("provider interrupted; retrying the same Opus model and conversation");
            await retryDelay();
            continue;
          }
          return outcome("failed", "", detail);
        }
      }
    },
  };
}

function headerValue(value: string): string {
  return value.replace(/[\r\n]/g, "").slice(0, 200);
}

function rolloverPrompt(original: string): string {
  return [
    original,
    "",
    "The provider compacted or replaced the prior context. Continue the same task with the same ownership.",
    "Repository changes and server-side tool state are authoritative. Inspect current allowed files as needed,",
    "do not repeat completed mutations, and finish the required task.",
  ].join("\n");
}

function retryDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5_000));
}
