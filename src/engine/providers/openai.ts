import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import {
  evaluateToolUse,
  isSecretPathLike,
} from "../../core/toolPolicy.js";
import type { WizardConfig, WizardSession } from "../../types.js";
import { classifyFailure } from "../budgets.js";
import type {
  EngineProvider,
  EngineTool,
  RoleInvocation,
  RoleModelConfig,
  RoleOutcome,
} from "../types.js";

interface FunctionCallItem {
  type: "function_call";
  name: string;
  call_id: string;
  arguments: string;
}

interface ResponsePayload {
  id?: string;
  output?: Array<Record<string, unknown>>;
  output_text?: string;
  error?: { message?: string };
}

function jailedPath(cwd: string, candidate: string): string {
  const resolved = resolve(cwd, candidate);
  if (resolved !== cwd && !resolved.startsWith(cwd + sep)) {
    throw new Error(`path ${candidate} escapes the repository`);
  }
  return resolved;
}

function guardedPath(
  cwd: string,
  toolName: "Read" | "Glob" | "Write" | "Edit",
  candidate: string,
): string {
  const path = jailedPath(cwd, candidate);
  const decision = evaluateToolUse(
    toolName,
    toolName === "Glob"
      ? { path: candidate, pattern: "*" }
      : { file_path: candidate },
    { repoPath: cwd },
  );
  if (decision.behavior === "deny") {
    throw new Error(decision.message);
  }
  return path;
}

export function fileTools(cwd: string, allowWrite: boolean): EngineTool[] {
  const tools: EngineTool[] = [
    {
      name: "read_file",
      description: "Read a repository file (UTF-8, truncated at 40000 chars).",
      inputSchema: {},
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async (input) => {
        const path = guardedPath(cwd, "Read", String(input.path ?? ""));
        const content = readFileSync(path, "utf8");
        return { content: content.slice(0, 40_000) };
      },
    },
    {
      name: "list_dir",
      description: "List entries of a repository directory.",
      inputSchema: {},
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async (input) => {
        const target = guardedPath(cwd, "Glob", String(input.path ?? "."));
        const entries = readdirSync(target)
          .filter((entry) => !isSecretPathLike(entry))
          .map((entry) => {
            const kind = statSync(join(target, entry)).isDirectory() ? "dir" : "file";
            return `${kind}:${entry}`;
          });
        return { entries: entries.slice(0, 500) };
      },
    },
  ];
  if (allowWrite) {
    tools.push(
      {
        name: "write_file",
        description: "Create or overwrite a repository file with the given content.",
        inputSchema: {},
        jsonSchema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
        handler: async (input) => {
          const path = guardedPath(cwd, "Write", String(input.path ?? ""));
          writeFileSync(path, String(input.content ?? ""));
          return { ok: true };
        },
      },
      {
        name: "replace_in_file",
        description: "Replace one exact occurrence of a string in a repository file.",
        inputSchema: {},
        jsonSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            oldText: { type: "string" },
            newText: { type: "string" },
          },
          required: ["path", "oldText", "newText"],
        },
        handler: async (input) => {
          const path = guardedPath(cwd, "Edit", String(input.path ?? ""));
          const content = readFileSync(path, "utf8");
          const oldText = String(input.oldText ?? "");
          if (!content.includes(oldText)) {
            return { ok: false, reason: "oldText not found" };
          }
          writeFileSync(path, content.replace(oldText, String(input.newText ?? "")));
          return { ok: true };
        },
      },
    );
  }
  return tools;
}

export function createOpenAIProvider(
  config: WizardConfig,
  session: WizardSession,
): EngineProvider {
  let runId: string | undefined;
  let conversationId: string | undefined;

  const gatewayFetch = async (path: string, body: Record<string, unknown>): Promise<ResponsePayload> => {
    if (!runId) {
      throw new Error("OpenAI provider used before the run was created");
    }
    const response = await fetch(
      `${config.apiBaseUrl}/wizard/openai/runs/${encodeURIComponent(runId)}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify(body),
      },
    );
    const text = await response.text();
    let payload: ResponsePayload & { code?: string; message?: string };
    try {
      payload = text ? (JSON.parse(text) as ResponsePayload) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const detail = (payload as { message?: string; code?: string }).message ?? text;
      const error = new Error(detail || `gateway request failed (${response.status})`);
      (error as { code?: string }).code = (payload as { code?: string }).code;
      throw error;
    }
    return payload;
  };

  const ensureConversation = async (resumeId?: string): Promise<string> => {
    if (conversationId) {
      return conversationId;
    }
    if (resumeId) {
      conversationId = resumeId;
      return resumeId;
    }
    try {
      const created = await gatewayFetch("/v1/conversations", {});
      conversationId = created.id;
    } catch (error) {
      if ((error as { code?: string }).code !== "conversation_already_bound") {
        throw error;
      }
    }
    if (!conversationId) {
      throw new Error("wizard run already has a bound conversation; rerun with its resume state");
    }
    return conversationId;
  };

  return {
    name: "openai-gateway",
    onRunReady(readyRunId: string, resumeSessionId?: string): void {
      runId = readyRunId;
      conversationId = resumeSessionId;
    },
    async invoke(
      invocation: RoleInvocation,
      roleConfig: RoleModelConfig,
      onProgress: (action: string) => void,
    ): Promise<RoleOutcome> {
      let costUsd = 0;
      let turns = 0;
      const outcome = (
        kind: "completed" | "context_overflow" | "budget_exhausted" | "failed",
        text = "",
        error = "",
      ): RoleOutcome =>
        kind === "completed"
          ? { kind, text, sessionId: conversationId, costUsd, turns }
          : kind === "failed"
            ? { kind, error, sessionId: conversationId, costUsd, turns }
            : { kind, sessionId: conversationId, costUsd, turns };

      const allTools = [...invocation.tools, ...fileTools(invocation.cwd, invocation.allowRepoWrite)];
      const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
      const toolDefs = allTools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.jsonSchema,
      }));

      try {
        const conversation = await ensureConversation(invocation.resumeSessionId);
        const deadline = Date.now() + roleConfig.maxMs;
        let input: Array<Record<string, unknown>> = [
          { role: "user", content: invocation.userPrompt },
        ];

        for (let turn = 0; turn < roleConfig.maxTurns; turn += 1) {
          turns = turn + 1;
          if (Date.now() > deadline) {
            return outcome("budget_exhausted");
          }
          const response = await gatewayFetch("/v1/responses", {
            model: roleConfig.model,
            instructions: invocation.systemPrompt,
            conversation,
            input,
            tools: toolDefs,
            ...(roleConfig.effort ? { reasoning: { effort: roleConfig.effort } } : {}),
          });
          const items = response.output ?? [];
          const calls = items.filter(
            (item) => item.type === "function_call",
          ) as unknown as FunctionCallItem[];
          if (calls.length === 0) {
            const text =
              response.output_text ??
              items
                .filter((item) => item.type === "message")
                .map((item) =>
                  Array.isArray(item.content)
                    ? (item.content as Array<{ text?: string }>)
                        .map((block) => String(block.text ?? ""))
                        .join("")
                    : "",
                )
                .join("\n");
            return outcome("completed", String(text ?? ""));
          }
          const results: Array<Record<string, unknown>> = [];
          for (const call of calls) {
            onProgress(`using ${call.name}`);
            const tool = toolsByName.get(call.name);
            let output: Record<string, unknown>;
            if (!tool) {
              output = { ok: false, reason: `unknown tool ${call.name}` };
            } else {
              try {
                output = await tool.handler(JSON.parse(call.arguments || "{}") as Record<string, unknown>);
              } catch (error) {
                output = { ok: false, reason: error instanceof Error ? error.message : String(error) };
              }
            }
            results.push({
              type: "function_call_output",
              call_id: call.call_id,
              output: JSON.stringify(output),
            });
          }
          input = results;
        }
        return outcome("budget_exhausted");
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
