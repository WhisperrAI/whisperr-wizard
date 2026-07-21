import {
  Agent,
  OpenAIConversationsSession,
  OpenAIProvider,
  Runner,
  type Tool,
} from "@openai/agents";
import type { Playbook, WizardConfig, WizardSession } from "../types.js";
import {
  createRuntimeTools,
  persistCurrentIntegrationEvidence,
  type AgentToolState,
} from "./agentTools.js";
import { renderAgentInstructions, renderRunPrompt } from "./generationPrompt.js";
import type { GitCheckpoint } from "./git.js";
import {
  createReadOnlyRepositoryTools,
  createRepositoryTools,
} from "./repositoryTools.js";
import type {
  WizardRun,
  WizardRunSnapshot,
  WizardRuntimeClient,
} from "./runtime.js";

export interface AgentProgress {
  onPhase?(label: string): void | Promise<void>;
  onActivity?(line: string): void | Promise<void>;
}

export interface AgentRunOutcome {
  summary: string;
  durationMs: number;
  conversationId: string;
  snapshot: WizardRunSnapshot;
  verification: AgentToolState["verification"];
  wiredEvents: AgentToolState["wiredEvents"];
}

export interface AgentTopology {
  primary: Agent;
  explorer: Agent;
}

export interface AgentExecutor {
  createConversation(): Promise<string>;
  run(input: {
    agent: Agent;
    prompt: string;
    conversationId: string;
    maxTurns: number;
    signal?: AbortSignal;
  }): Promise<{ finalOutput?: unknown }>;
}

export interface RunIntegrationAgentOptions {
  repoPath: string;
  config: WizardConfig;
  session: WizardSession;
  playbook: Playbook;
  snapshot: WizardRunSnapshot;
  runtime: WizardRuntimeClient;
  checkpoint: GitCheckpoint;
  conversationId?: string;
  signal?: AbortSignal;
  progress?: AgentProgress;
  saveConversationId?: (conversationId: string) => Promise<void>;
  inspectIntegration?: AgentToolState["inspectIntegration"];
  executor?: AgentExecutor;
}

export async function runIntegrationAgent(
  options: RunIntegrationAgentOptions,
): Promise<AgentRunOutcome> {
  const started = Date.now();
  const executor =
    options.executor ??
    createOpenAIExecutor(options.config, options.session, options.snapshot.run.id);
  const toolState: AgentToolState = {
    runtime: options.runtime,
    runId: options.snapshot.run.id,
    repoPath: options.repoPath,
    checkpoint: options.checkpoint,
    playbook: options.playbook,
    ingestionKey: options.snapshot.ingestion.apiKey,
    completed: options.snapshot.run.status === "completed",
    latestSnapshot: options.snapshot,
    wiredEvents: [],
    inspectIntegration: options.inspectIntegration,
    onPhase: options.progress?.onPhase,
    onActivity: options.progress?.onActivity,
  };
  const topology = createAgentTopology({
    config: options.config,
    playbook: options.playbook,
    primaryTools: [
      ...createRepositoryTools({
        repoPath: options.repoPath,
        ingestion: options.snapshot.ingestion,
        onActivity: options.progress?.onActivity,
        onRepositoryChange: () => persistCurrentIntegrationEvidence(toolState),
      }),
      ...createRuntimeTools(toolState),
    ],
    explorerTools: createReadOnlyRepositoryTools({
      repoPath: options.repoPath,
      ingestion: options.snapshot.ingestion,
      onActivity: options.progress?.onActivity,
    }),
  });

  let conversationId =
    options.conversationId ?? options.snapshot.run.modelConversationId;
  if (!conversationId) {
    conversationId = await executor.createConversation();
  }
  toolState.latestSnapshot = {
    ...toolState.latestSnapshot,
    run: await persistConversation(options, conversationId),
  };
  await persistCurrentIntegrationEvidence(toolState);

  await options.progress?.onPhase?.(options.snapshot.resumed ? "resuming" : "exploring");
  const execute = (id: string) =>
    executor.run({
      agent: topology.primary,
      prompt: renderRunPrompt(toolState.latestSnapshot),
      conversationId: id,
      maxTurns: options.config.maxTurns,
      signal: options.signal,
    });

  let result;
  try {
    result = await execute(conversationId);
  } catch (error) {
    if (toolState.completed) {
      result = { finalOutput: "Whisperr generation and integration completed." };
    } else if (!isConversationUnavailable(error)) {
      throw error;
    } else {
      await options.progress?.onActivity?.(
        "The previous model conversation is unavailable; continuing from the runtime snapshot",
      );
      toolState.latestSnapshot = await options.runtime.getRun(options.snapshot.run.id);
      conversationId = await executor.createConversation();
      toolState.latestSnapshot = {
        ...toolState.latestSnapshot,
        run: await persistConversation(options, conversationId),
      };
      try {
        result = await execute(conversationId);
      } catch (fallbackError) {
        if (!toolState.completed) throw fallbackError;
        result = { finalOutput: "Whisperr generation and integration completed." };
      }
    }
  }

  if (!toolState.completed) {
    throw new Error(
      "The agent stopped without completing the runtime run. Its generated rows and repository edits were preserved for resume.",
    );
  }
  return {
    summary:
      typeof result.finalOutput === "string"
        ? result.finalOutput
        : "Whisperr generation and integration completed.",
    durationMs: Date.now() - started,
    conversationId,
    snapshot: toolState.latestSnapshot,
    verification: toolState.verification,
    wiredEvents: toolState.wiredEvents,
  };
}

export function createAgentTopology(options: {
  config: WizardConfig;
  playbook: Playbook;
  primaryTools: Tool[];
  explorerTools: Tool[];
}): AgentTopology {
  const explorer = new Agent({
    name: "Terra repository explorer",
    handoffDescription: "Read-only repository evidence gathering",
    instructions: [
      "Inspect only the selected repository using your read, list, and search tools.",
      "Return concise evidence with exact paths and symbols. Distinguish customer-facing frontend paths from admin, staff, and backend paths.",
      "Do not make taxonomy decisions, propose speculative features, write files, run commands, call runtime APIs, or request credentials.",
    ].join(" "),
    model: options.config.explorerModel,
    modelSettings: {
      reasoning: { effort: options.config.explorerEffort },
      parallelToolCalls: false,
    },
    tools: options.explorerTools,
  });
  const explorerTool = explorer.asTool({
    toolName: "explore_repository",
    toolDescription:
      "Ask the read-only Terra explorer for precise repository evidence. It cannot mutate files, run commands, call runtime tools, or access credentials.",
    runConfig: {
      tracingDisabled: true,
      traceIncludeSensitiveData: false,
    },
  });
  const primary = new Agent({
    name: "Sol Whisperr integrator",
    handoffDescription: "Generate and integrate the Whisperr intervention model",
    instructions: renderAgentInstructions(options.playbook),
    model: options.config.primaryModel,
    modelSettings: {
      reasoning: { effort: options.config.primaryEffort },
      providerData: { service_tier: options.config.primaryServiceTier },
      parallelToolCalls: false,
    },
    tools: [explorerTool, ...options.primaryTools],
  });
  return { primary, explorer };
}

export function openAIProviderOptions(
  config: WizardConfig,
  session: WizardSession,
  runId?: string,
): ConstructorParameters<typeof OpenAIProvider>[0] {
  return {
    apiKey: config.directOpenAIKey ?? session.token,
    baseURL:
      config.directOpenAIKey || !runId
        ? config.openAIBaseUrl
        : `${config.openAIBaseUrl}/runs/${encodeURIComponent(runId)}/v1`,
    useResponses: true,
  };
}

export function createOpenAIExecutor(
  config: WizardConfig,
  session: WizardSession,
  runId: string,
): AgentExecutor {
  const providerOptions = openAIProviderOptions(config, session, runId);
  const provider = new OpenAIProvider(providerOptions);
  const runner = new Runner({
    modelProvider: provider,
    tracingDisabled: true,
    traceIncludeSensitiveData: false,
    workflowName: "Whisperr generated model and integration",
  });
  return {
    async createConversation() {
      const conversation = new OpenAIConversationsSession(providerOptions);
      return conversation.getSessionId();
    },
    async run({ agent, prompt, conversationId, maxTurns, signal }) {
      return runner.run(agent, prompt, {
        conversationId,
        maxTurns,
        signal,
      });
    },
  };
}

export function isConversationUnavailable(error: unknown): boolean {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status?: unknown }).status)
      : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message)
        : String(error);
  return (
    ((status === 404 || status === 400) && /conversation/i.test(message)) ||
    /conversation.*(?:not found|missing|invalid|expired|unavailable)/i.test(message)
  );
}

async function persistConversation(
  options: RunIntegrationAgentOptions,
  conversationId: string,
): Promise<WizardRun> {
  if (options.config.directOpenAIKey) {
    await options.saveConversationId?.(conversationId);
    return { ...options.snapshot.run, modelConversationId: conversationId };
  }
  const run = await options.runtime.updateRun(options.snapshot.run.id, {
    status: "running",
    modelConversationId: conversationId,
  });
  await options.saveConversationId?.(conversationId);
  return run;
}
