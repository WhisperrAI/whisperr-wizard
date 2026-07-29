import type { ZodRawShape } from "zod";

export type EngineRole = "survey" | "design" | "edit" | "review";

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
  maxTurns: number;
  maxMs: number;
}

export type EngineModelConfig = Record<EngineRole, RoleModelConfig>;

export interface EngineTool {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  jsonSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface RoleInvocation {
  role: EngineRole;
  systemPrompt: string;
  userPrompt: string;
  tools: EngineTool[];
  allowRepoWrite: boolean;
  cwd: string;
  resumeSessionId?: string;
}

export type RoleOutcome =
  | { kind: "completed"; text: string; sessionId?: string; costUsd: number; turns: number }
  | { kind: "context_overflow"; sessionId?: string; costUsd: number; turns: number }
  | { kind: "budget_exhausted"; sessionId?: string; costUsd: number; turns: number }
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
