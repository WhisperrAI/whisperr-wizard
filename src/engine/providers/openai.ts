import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
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
  error?: { message?: string; code?: string; error?: { message?: string; code?: string } };
  usage?: { input_tokens?: number };
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
  allowedFiles?: ReadonlySet<string>,
): string {
  const path = jailedPath(cwd, candidate);
  const decision = evaluateToolUse(
    toolName,
    toolName === "Glob"
      ? { path: candidate, pattern: "*" }
      : { file_path: candidate },
    { repoPath: cwd, allowedFiles },
  );
  if (decision.behavior === "deny") {
    throw new Error(decision.message);
  }
  return path;
}

export function fileTools(
  cwd: string,
  allowWrite: boolean,
  access: RoleInvocation["repositoryAccess"] = { mode: allowWrite ? "repair" : "survey" },
): EngineTool[] {
  if (access.mode === "none" || access.mode === "review") {
    return [];
  }
  const allowedFiles = access.allowedFiles
    ? new Set(access.allowedFiles.map((file) => file.replaceAll("\\", "/")))
    : undefined;
  const tools: EngineTool[] = [
    {
      name: "read_file",
      description: "Read a repository UTF-8 file.",
      inputSchema: {},
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      handler: async (input) => {
        const path = guardedPath(cwd, "Read", String(input.path ?? ""), allowedFiles);
        const content = readFileSync(path, "utf8");
        return { content };
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
        const target = guardedPath(cwd, "Glob", String(input.path ?? "."), allowedFiles);
        const entries = readdirSync(target)
          .filter((entry) => !isSecretPathLike(entry))
          .map((entry) => {
            const kind = statSync(join(target, entry)).isDirectory() ? "dir" : "file";
            return `${kind}:${entry}`;
          });
        return { entries };
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
          const path = guardedPath(cwd, "Write", String(input.path ?? ""), allowedFiles);
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
          const path = guardedPath(cwd, "Edit", String(input.path ?? ""), allowedFiles);
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
    if (access.mode === "sdk_setup") {
      tools.push({
        name: "run_setup_command",
        description:
          "Run a policy-approved package installation or repository verification command for SDK setup.",
        inputSchema: {},
        jsonSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        handler: async (input) => {
          const command = String(input.command ?? "").trim();
          const decision = evaluateToolUse("Bash", { command }, {
            repoPath: cwd,
            allowedFiles,
          });
          if (decision.behavior === "deny") {
            return { ok: false, reason: decision.message };
          }
          return runCommand(cwd, command);
        },
      });
    }
  }
  return tools;
}

function runCommand(cwd: string, command: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, stdout, stderr: String(error) }));
    child.on("close", (code) => resolve({ ok: code === 0, exitCode: code, stdout, stderr }));
  });
}

export function createOpenAIProvider(
  config: WizardConfig,
  session: WizardSession,
): EngineProvider {
  let runId: string | undefined;
  const conversationIds = new Map<string, string>();
  let legacyConversationId: string | undefined;

  const gatewayFetch = async (
    path: string,
    body: Record<string, unknown>,
    sessionKey: string,
    task: string,
  ): Promise<ResponsePayload> => {
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
          ...(sessionKey === "legacy"
            ? {}
            : {
                "X-Whisperr-Wizard-Session-Key": sessionKey,
                "X-Whisperr-Wizard-Task": task,
              }),
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
      const top = payload as {
        message?: string;
        code?: string;
        error?: { message?: string; code?: string; error?: { message?: string; code?: string } };
      };
      const nested = top.error?.error ?? top.error;
      const detail = top.message ?? nested?.message ?? text;
      const error = new Error(detail || `gateway request failed (${response.status})`);
      (error as { code?: string }).code = top.code ?? nested?.code;
      throw error;
    }
    return payload;
  };

  const ensureConversation = async (
    sessionKey: string,
    task: string,
    resumeId?: string,
  ): Promise<string> => {
    const existing = sessionKey === "legacy"
      ? legacyConversationId
      : conversationIds.get(sessionKey);
    if (existing) {
      return existing;
    }
    if (resumeId) {
      if (sessionKey === "legacy") {
        legacyConversationId = resumeId;
      } else {
        conversationIds.set(sessionKey, resumeId);
      }
      return resumeId;
    }
    try {
      const created = await gatewayFetch("/v1/conversations", {}, sessionKey, task);
      if (created.id) {
        if (sessionKey === "legacy") {
          legacyConversationId = created.id;
        } else {
          conversationIds.set(sessionKey, created.id);
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "conversation_already_bound") {
        throw error;
      }
    }
    const createdId = sessionKey === "legacy"
      ? legacyConversationId
      : conversationIds.get(sessionKey);
    if (!createdId) {
      throw new Error("wizard run already has a bound conversation; rerun with its resume state");
    }
    return createdId;
  };

  return {
    name: "openai-gateway",
    onRunReady(readyRunId: string, resumeSessionId?: string): void {
      runId = readyRunId;
      legacyConversationId = resumeSessionId;
    },
    async invoke(
      invocation: RoleInvocation,
      roleConfig: RoleModelConfig,
      onProgress: (action: string) => void,
    ): Promise<RoleOutcome> {
      let costUsd = 0;
      let turns = 0;
      const task = invocation.task ?? invocation.role;
      const baseSessionKey = invocation.sessionKey?.trim() || "legacy";
      let conversationGeneration = 0;
      let sessionKey = baseSessionKey;
      let activeConversationId = sessionKey === "legacy"
        ? legacyConversationId
        : conversationIds.get(sessionKey);
      const outcome = (
        kind: "completed" | "context_overflow" | "failed",
        text = "",
        error = "",
      ): RoleOutcome =>
        kind === "completed"
          ? { kind, text, sessionId: activeConversationId, costUsd, turns }
          : kind === "failed"
            ? { kind, error, sessionId: activeConversationId, costUsd, turns }
            : { kind, sessionId: activeConversationId, costUsd, turns };

      const allTools = [
        ...invocation.tools,
        ...fileTools(invocation.cwd, invocation.allowRepoWrite, invocation.repositoryAccess),
      ];
      const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
      const toolDefs = allTools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.jsonSchema,
      }));

      try {
        let conversation = await ensureConversation(
          sessionKey,
          task,
          invocation.resumeSessionId,
        );
        activeConversationId = conversation;
        let input: Array<Record<string, unknown>> = [
          { role: "user", content: invocation.userPrompt },
        ];

        for (;;) {
          turns += 1;
          let response: ResponsePayload;
          try {
            response = await gatewayFetch("/v1/responses", {
              model: roleConfig.model,
              instructions: invocation.systemPrompt,
              conversation,
              input,
              tools: toolDefs,
              reasoning: {
                ...(roleConfig.effort ? { effort: roleConfig.effort } : {}),
                summary: "detailed",
                context: "all_turns",
              },
              ...(roleConfig.serviceTier ? { service_tier: roleConfig.serviceTier } : {}),
            }, sessionKey, task);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const failure = classifyFailure(detail);
            if (failure === "transient") {
              onProgress("provider interrupted; retrying the same model and conversation");
              await retryDelay();
              continue;
            }
            if (failure === "context_overflow") {
              const compacted = await tryCompact(
                gatewayFetch, roleConfig.model, conversation, sessionKey, task,
              );
              if (compacted) continue;
              conversationGeneration += 1;
              sessionKey = `${baseSessionKey}:generation:${conversationGeneration}`;
              conversation = await ensureConversation(sessionKey, task);
              activeConversationId = conversation;
              input = [{
                role: "user",
                content: rolloverPrompt(invocation.userPrompt),
              }];
              onProgress("context rolled into a fresh conversation with the same model");
              continue;
            }
            throw error;
          }
          if ((response.usage?.input_tokens ?? 0) >= 787_500) {
            await tryCompact(gatewayFetch, roleConfig.model, conversation, sessionKey, task);
          }
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

async function tryCompact(
  gatewayFetch: (
    path: string,
    body: Record<string, unknown>,
    sessionKey: string,
    task: string,
  ) => Promise<ResponsePayload>,
  model: string,
  conversation: string,
  sessionKey: string,
  task: string,
): Promise<boolean> {
  try {
    await gatewayFetch("/v1/responses/compact", { model, conversation }, sessionKey, task);
    return true;
  } catch {
    return false;
  }
}

function rolloverPrompt(original: string): string {
  return [
    original,
    "",
    "Continue this same task in a replacement context using the same model.",
    "The current repository files and persisted wizard artifacts are authoritative.",
    "Do not repeat completed changes; inspect allowed files and finish the remaining work.",
  ].join("\n");
}

function retryDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5_000));
}
