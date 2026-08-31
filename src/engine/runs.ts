import { createHash } from "node:crypto";

import type { WizardConfig, WizardSession } from "../types.js";
import type { EnginePhase, EngineTask, EventIntegrationStatus } from "./types.js";

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
  modelConversationId?: string;
  integrationEvidence?: IntegrationProgress;
}

export type RunArtifactKind = "survey" | "event_design";

export interface RunArtifact<T = unknown> {
  kind: RunArtifactKind;
  content: T;
  contentHash: string;
  model: string;
  effort?: string;
  serviceTier?: string;
  fastMode: boolean;
  frozenAt?: string;
  createdAt: string;
}

export interface RunSnapshotEvent {
  id: string;
  code: string;
  name: string;
  reasoning: string;
  projectId: string;
  anchorFile?: string;
  anchorSymbol?: string;
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
  artifacts: RunArtifact[];
  modelSessions: Record<string, string>;
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

export interface IntegrationProgress {
  changedFiles: string[];
  identifyWired: boolean;
  verificationStatus: string;
  verificationCommand?: string;
  events: IntegrationEventEvidence[];
}

export interface PlacementManifestItem {
  eventCode: string;
  file: string;
  startLine?: number;
  endLine?: number;
  wrapper: string;
  payloadKeys: string[];
  status: EventIntegrationStatus;
}

export interface ArtifactModelMetadata {
  model: string;
  effort?: string;
  serviceTier?: string;
  fastMode?: boolean;
}

export interface DesignCommitResult {
  artifact: RunArtifact;
  events: RunSnapshotEvent[];
  created: boolean;
}

export interface WizardCapabilities {
  modelGateways: {
    anthropic: boolean;
    openai: boolean;
  };
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
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "request failed";
      throw new RunsApiError(`runs API ${method} ${path} could not be reached: ${detail}`);
    }
    let payload: unknown;
    const text = await response.text();
    let parsed = false;
    try {
      payload = text.length > 0 ? JSON.parse(text) : {};
      parsed = text.length > 0;
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const envelope = payload as { error?: { code?: string; message?: string }; code?: string; message?: string };
      const detail = envelope.error ?? envelope;
      throw new RunsApiError(
        detail.message ?? `runs API ${method} ${path} failed`,
        response.status,
        detail.code,
      );
    }
    if (!parsed) {
      throw new RunsApiError(
        text
          ? `runs API ${method} ${path} returned invalid JSON`
          : `runs API ${method} ${path} returned an empty response`,
        response.status,
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
    return this.request<unknown>("POST", "/wizard/runs", { ...input }).then(async (payload) => {
      try {
        return normalizeRunBootstrap(payload);
      } catch (error) {
        const runId = stringValue(record(record(payload)?.run)?.id);
        if (runId) {
          try { await this.patchRun(runId, { status: "failed", error: "Invalid run bootstrap; local integration did not start." }); }
          catch { throw new RunsApiError("Invalid run bootstrap and failure could not be saved; resolve the run in the dashboard."); }
        }
        throw error;
      }
    });
  }

  getRun(runId: string): Promise<RunBootstrap> {
    return this.request<unknown>("GET", `/wizard/runs/${runId}`).then(normalizeRunBootstrap);
  }

  getCapabilities(): Promise<WizardCapabilities> {
    return this.request<unknown>("GET", "/wizard/capabilities").then(
      normalizeWizardCapabilities,
    );
  }

  patchRun(
    runId: string,
    patch: {
      phase?: EnginePhase;
      status?: string;
      modelConversationId?: string | null;
      error?: string;
      message?: string;
      integrationEvidence?: IntegrationProgress;
    },
  ): Promise<RunRecord> {
    return this.request<RunRecord>("PATCH", `/wizard/runs/${runId}`, { ...patch });
  }

  saveProgress(runId: string, progress: IntegrationProgress): Promise<RunRecord> {
    return this.patchRun(runId, { integrationEvidence: progress });
  }

  saveModelSession(
    runId: string,
    sessionKey: string,
    task: EngineTask,
    conversationId: string,
  ): Promise<{ sessionKey: string; conversationId: string }> {
    return this.request<{ sessionKey: string; conversationId: string }>(
      "PUT",
      `/wizard/runs/${runId}/model-sessions/${encodeURIComponent(sessionKey)}`,
      { task, conversationId },
    );
  }

  savePlacementManifest(
    runId: string,
    items: PlacementManifestItem[],
  ): Promise<{ saved: number }> {
    return this.request<{ saved: number }>(
      "POST",
      `/wizard/runs/${runId}/placements`,
      { items },
    );
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

  persistSurveyArtifact<T>(
    runId: string,
    content: T,
    metadata: ArtifactModelMetadata,
  ): Promise<RunArtifact<T>> {
    return this.request<RunArtifact<T>>(
      "POST",
      `/wizard/runs/${runId}/artifacts/survey`,
      artifactRequest(content, metadata),
    );
  }

  commitDesign<T>(
    runId: string,
    content: T,
    events: Array<Record<string, unknown>>,
    metadata: ArtifactModelMetadata,
  ): Promise<DesignCommitResult> {
    return this.request<DesignCommitResult>(
      "POST",
      `/wizard/runs/${runId}/design/commit`,
      { ...artifactRequest(content, metadata), events },
    );
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

function normalizeWizardCapabilities(payload: unknown): WizardCapabilities {
  const value = record(payload);
  const gateways = record(value?.modelGateways);
  if (
    !gateways ||
    typeof gateways.anthropic !== "boolean" ||
    typeof gateways.openai !== "boolean"
  ) {
    throw new RunsApiError("runs API returned invalid wizard capabilities");
  }
  return {
    modelGateways: {
      anthropic: gateways.anthropic,
      openai: gateways.openai,
    },
  };
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
    run: {
      id: run.id,
      status: stringValue(run.status),
      phase: stringValue(run.phase),
      ...(stringValue(run.modelConversationId)
        ? { modelConversationId: stringValue(run.modelConversationId) }
        : {}),
      ...(normalizeIntegrationProgress(run.integrationEvidence)
        ? { integrationEvidence: normalizeIntegrationProgress(run.integrationEvidence)! }
        : {}),
    },
    resumed: value.resumed === true,
    universeMode: stringValue(value.universeMode),
    ...(record(value.onboardingContext) ? { onboardingContext: record(value.onboardingContext)! } : {}),
    app: record(value.app) ?? {},
    snapshot: {
      setupStatus: stringValue(snapshotSource.setupStatus),
      events,
    },
    ingestion: { apiKey: ingestion.apiKey, baseUrl: ingestion.baseUrl },
    artifacts: normalizeArtifacts(value.artifacts ?? snapshotSource.artifacts),
    modelSessions: normalizeModelSessions(value.modelSessions),
  };
}

function normalizeModelSessions(payload: unknown): Record<string, string> {
  const value = record(payload);
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([sessionKey, conversationId]) =>
        sessionKey.trim().length > 0 && typeof conversationId === "string" &&
        conversationId.trim().length > 0,
    ),
  ) as Record<string, string>;
}

function normalizeArtifacts(payload: unknown): RunArtifact[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((candidate) => {
    const value = record(candidate);
    const kind = value?.kind;
    if (
      (kind !== "survey" && kind !== "event_design") ||
      typeof value?.contentHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.contentHash) ||
      typeof value.model !== "string" ||
      typeof value.createdAt !== "string"
    ) {
      return [];
    }
    return [{
      kind,
      content: value.content,
      contentHash: value.contentHash,
      model: value.model,
      ...(typeof value.effort === "string" ? { effort: value.effort } : {}),
      ...(typeof value.serviceTier === "string" ? { serviceTier: value.serviceTier } : {}),
      fastMode: value.fastMode === true,
      ...(typeof value.frozenAt === "string" ? { frozenAt: value.frozenAt } : {}),
      createdAt: value.createdAt,
    }];
  });
}

function artifactRequest<T>(
  content: T,
  metadata: ArtifactModelMetadata,
): Record<string, unknown> {
  return {
    content,
    contentHash: artifactContentHash(content),
    model: metadata.model,
    ...(metadata.effort ? { effort: metadata.effort } : {}),
    ...(metadata.serviceTier ? { serviceTier: metadata.serviceTier } : {}),
    fastMode: metadata.fastMode === true,
  };
}

export function artifactContentHash(content: unknown): string {
  return createHash("sha256").update(stableJSONStringify(content)).digest("hex");
}

function stableJSONStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJSONStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) =>
      `${canonicalJSONString(key)}:${stableJSONStringify(item)}`
    ).join(",")}}`;
  }
  return canonicalJSONString(value);
}

function canonicalJSONString(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function normalizeIntegrationProgress(payload: unknown): IntegrationProgress | undefined {
  const value = record(payload);
  if (!value || !Array.isArray(value.changedFiles) || !Array.isArray(value.events)) {
    return undefined;
  }
  const events = value.events
    .map((candidate) => {
      const event = record(candidate);
      if (!event || !stringValue(event.eventId) || !stringValue(event.eventCode)) {
        return undefined;
      }
      return {
        eventId: stringValue(event.eventId),
        eventCode: stringValue(event.eventCode),
        ...(stringValue(event.file) ? { file: stringValue(event.file) } : {}),
        status: stringValue(event.status) as EventIntegrationStatus,
      };
    })
    .filter((event): event is IntegrationEventEvidence => event !== undefined);
  return {
    changedFiles: value.changedFiles.filter((file): file is string => typeof file === "string"),
    identifyWired: value.identifyWired === true,
    verificationStatus: stringValue(value.verificationStatus) || "pending",
    ...(stringValue(value.verificationCommand)
      ? { verificationCommand: stringValue(value.verificationCommand) }
      : {}),
    events,
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
    typeof event.projectId === "string" &&
    (event.anchorFile === undefined || typeof event.anchorFile === "string") &&
    (event.anchorSymbol === undefined || typeof event.anchorSymbol === "string") &&
    !!record(event.payloadSchema);
}
