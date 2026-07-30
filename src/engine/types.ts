import type { ZodRawShape } from "zod";

export type EngineRole = "survey" | "design" | "edit" | "review";
export type EngineTask =
  | "survey"
  | "design"
  | "sdk_setup"
  | "cluster_edit"
  | "repair"
  | "review";

export const ENGINE_PHASES = [
  "authorizing",
  "surveying",
  "designing",
  "persisting",
  "binding",
  "integrating",
  "reviewing",
  "verifying",
  "reporting",
  "completed",
] as const;

export type EnginePhase = (typeof ENGINE_PHASES)[number];

export interface RoleModelConfig {
  model: string;
  effort?: string;
  serviceTier?: "default" | "priority";
  fastMode?: boolean;
}

/**
 * The role keys remain required for source compatibility with older embedders.
 * New engine code always asks for a task key first and only falls back to its
 * legacy role while old presets are being phased out.
 */
export type EngineModelConfig = Record<EngineRole, RoleModelConfig> &
  Partial<Record<EngineTask, RoleModelConfig>>;

export interface EngineTool {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  jsonSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface RoleInvocation {
  role: EngineRole;
  task?: EngineTask;
  /** Stable within a run; isolates concurrent OpenAI conversations. */
  sessionKey?: string;
  /** Explicit repository boundary for this invocation. */
  repositoryAccess?: RepositoryAccess;
  systemPrompt: string;
  userPrompt: string;
  tools: EngineTool[];
  allowRepoWrite: boolean;
  cwd: string;
  resumeSessionId?: string;
}

export type RepositoryAccessMode =
  | "none"
  | "survey"
  | "sdk_setup"
  | "cluster"
  | "review"
  | "repair";

export interface RepositoryAccess {
  mode: RepositoryAccessMode;
  /**
   * Repository-relative files available to constrained setup/edit/repair
   * invocations. Survey is the sole mode allowed to explore broadly.
   */
  allowedFiles?: string[];
}

export type RoleOutcome =
  | { kind: "completed"; text: string; sessionId?: string; costUsd: number; turns: number }
  | { kind: "context_overflow"; sessionId?: string; costUsd: number; turns: number }
  | { kind: "failed"; error: string; sessionId?: string; costUsd: number; turns: number };

export interface EngineProvider {
  name: string;
  onRunReady?(runId: string, resumeSessionId?: string): void;
  invoke(
    invocation: RoleInvocation,
    config: RoleModelConfig,
    onProgress: (action: string) => void,
  ): Promise<RoleOutcome>;
}

export function modelConfigFor(
  models: EngineModelConfig,
  task: EngineTask,
  role: EngineRole,
): RoleModelConfig {
  return models[task] ?? models[role];
}

export type ClusterStatus =
  | "pending"
  | "editing"
  | "verified"
  | "reviewed"
  | "failed_resumable"
  | "blocked";

export type EventIntegrationStatus =
  | "planned"
  | "applied"
  | "syntax_verified"
  | "type_verified"
  | "build_verified"
  | "reviewed"
  | "runtime_observed"
  | "unsupported"
  | "failed";

export interface EventPlacement {
  eventId: string;
  eventCode: string;
  file: string;
  symbol?: string;
  status: EventIntegrationStatus;
}

export interface Cluster {
  id: string;
  files: string[];
  events: EventPlacement[];
  status: ClusterStatus;
  attempts: number;
  note?: string;
}
