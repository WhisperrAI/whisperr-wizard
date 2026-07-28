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
  item?: { id: string; code?: string };
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
    return this.request<unknown>("POST", "/wizard/runs", { ...input }).then(normalizeRunBootstrap);
  }

  getRun(runId: string): Promise<RunBootstrap> {
    return this.request<unknown>("GET", `/wizard/runs/${runId}`).then(normalizeRunBootstrap);
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
    return this.request<unknown>("POST", `/wizard/runs/${runId}/items`, {
      idempotencyKey: itemIdempotencyKey(kind, code, idempotencyExtra),
      kind,
      payload,
    }).then(normalizeItemWriteResult);
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

function normalizeItemWriteResult(payload: unknown): ItemWriteResult {
  const value = record(payload);
  const item = record(value?.item);
  const id = stringValue(value?.id) || stringValue(item?.id);
  if (!value || value.kind !== "event" || typeof value.created !== "boolean" || !id) {
    throw new RunsApiError("runs API returned an invalid item write response");
  }
  return {
    kind: "event",
    created: value.created,
    id,
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(item && typeof item.id === "string"
      ? { item: { id: item.id, ...(typeof item.code === "string" ? { code: item.code } : {}) } }
      : {}),
  };
}

/** Accept both the current nested snapshot and the legacy flattened runs response. */
export function normalizeRunBootstrap(payload: unknown): RunBootstrap {
  const value = record(payload);
  if (!value) {
    throw new RunsApiError("runs API returned an invalid run bootstrap response");
  }
  const snapshotSource = record(value.snapshot) ?? value;
  const events = Array.isArray(snapshotSource.events) ? snapshotSource.events : undefined;
  const run = record(value.run);
  const project = record(value.project);
  const ingestion = record(value.ingestion);
  if (
    !run ||
    typeof run.id !== "string" ||
    !project ||
    typeof project.id !== "string" ||
    !events ||
    events.some((event) => !isSnapshotEvent(event)) ||
    !ingestion ||
    typeof ingestion.apiKey !== "string" ||
    typeof ingestion.baseUrl !== "string"
  ) {
    throw new RunsApiError("runs API returned an invalid run bootstrap response");
  }
  return {
    project: {
      id: project.id,
      repoFingerprint: stringValue(project.repoFingerprint),
      displayName: stringValue(project.displayName),
      target: stringValue(project.target),
      kind: stringValue(project.kind),
    },
    run: { id: run.id, status: stringValue(run.status), phase: stringValue(run.phase) },
    resumed: value.resumed === true,
    universeMode: stringValue(value.universeMode),
    ...(record(value.onboardingContext) ? { onboardingContext: record(value.onboardingContext)! } : {}),
    app: record(value.app) ?? {},
    snapshot: {
      setupStatus: stringValue(snapshotSource.setupStatus),
      events,
    },
    ingestion: { apiKey: ingestion.apiKey, baseUrl: ingestion.baseUrl },
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isSnapshotEvent(value: unknown): value is RunSnapshotEvent {
  const event = record(value);
  return !!event && typeof event.id === "string" && typeof event.code === "string" &&
    typeof event.name === "string" && typeof event.reasoning === "string" &&
    typeof event.projectId === "string" && !!record(event.payloadSchema);
}
