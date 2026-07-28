import { createHash } from "node:crypto";

import type { WizardConfig, WizardSession } from "../types.js";
import type { EnginePhase, EventIntegrationStatus } from "./types.js";

export interface RunProject {
  id: string;
  repoFingerprint: string;
  displayName: string;
  target: string;
  kind: string;
}

export interface RunRecord {
  id: string;
  status: string;
  phase: string;
}

export interface RunSnapshotEvent {
  id: string;
  code: string;
  name: string;
  reasoning: string;
  projectId: string;
  payloadSchema: Record<string, string>;
}

export interface RunSnapshot {
  setupStatus: string;
  events: RunSnapshotEvent[];
}

export interface RunBootstrap {
  project: RunProject;
  run: RunRecord;
  resumed: boolean;
  universeMode: string;
  onboardingContext?: Record<string, unknown>;
  app: Record<string, unknown>;
  snapshot: RunSnapshot;
  ingestion: { apiKey: string; baseUrl: string };
}

export type ItemKind = "event";

export interface ItemWriteResult {
  kind: ItemKind;
  created: boolean;
  id: string;
  code?: string;
}

export interface IntegrationEventEvidence {
  eventId: string;
  eventCode: string;
  file?: string;
  status: EventIntegrationStatus;
}

export class RunsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RunsApiError";
  }
}

export function itemIdempotencyKey(kind: ItemKind, code: string, extra = ""): string {
  return createHash("sha256")
    .update(`${kind}\n${code}\n${extra}`)
    .digest("hex")
    .slice(0, 32);
}

export class RunsClient {
  constructor(
    private readonly config: WizardConfig,
    private readonly session: WizardSession,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.session.token}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new RunsApiError(error instanceof Error ? error.message : "request failed");
    }
    let payload: unknown;
    const text = await response.text();
    try {
      payload = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const detail = payload as { code?: string; message?: string };
      throw new RunsApiError(
        detail.message ?? `runs API ${method} ${path} failed`,
        response.status,
        detail.code,
      );
    }
    return payload as T;
  }

  createOrResumeRun(input: {
    repoFingerprint: string;
    displayName: string;
    target: string;
    kind: string;
  }): Promise<RunBootstrap> {
    return this.request<RunBootstrap>("POST", "/wizard/runs", { ...input });
  }

  getRun(runId: string): Promise<RunBootstrap> {
    return this.request<RunBootstrap>("GET", `/wizard/runs/${runId}`);
  }

  patchRun(
    runId: string,
    patch: {
      phase?: EnginePhase;
      status?: string;
      modelConversationId?: string | null;
      error?: string;
      message?: string;
    },
  ): Promise<RunRecord> {
    return this.request<RunRecord>("PATCH", `/wizard/runs/${runId}`, { ...patch });
  }

  writeItem(
    runId: string,
    kind: ItemKind,
    payload: Record<string, unknown>,
    idempotencyExtra = "",
  ): Promise<ItemWriteResult> {
    const code = typeof payload.code === "string" ? payload.code : JSON.stringify(payload);
    return this.request<ItemWriteResult>("POST", `/wizard/runs/${runId}/items`, {
      idempotencyKey: itemIdempotencyKey(kind, code, idempotencyExtra),
      kind,
      payload,
    });
  }

  completeRun(
    runId: string,
    completion: {
      changedFiles: string[];
      identifyWired: boolean;
      verificationStatus: string;
      verificationCommand?: string;
      events: IntegrationEventEvidence[];
    },
  ): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(
      "POST",
      `/wizard/runs/${runId}/complete`,
      { ...completion },
    );
  }
}
