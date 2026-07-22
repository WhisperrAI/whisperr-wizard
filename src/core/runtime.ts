import type { WizardConfig, WizardSession } from "../types.js";
import { scrubError } from "./scrub.js";

export type WizardProjectKind = "frontend" | "backend" | "fullstack";
export type WizardRunStatus = "pending" | "running" | "failed" | "completed";
export type WizardRunPhase =
  | "authorizing"
  | "analyzing"
  | "designing"
  | "persisting"
  | "integrating"
  | "verifying"
  | "completed";

export interface WizardProject {
  id: string;
  appId: string;
  repoFingerprint: string;
  displayName: string;
  target: string;
  kind: WizardProjectKind;
}

export interface WizardRun {
  id: string;
  projectId: string;
  status: WizardRunStatus;
  phase: WizardRunPhase;
  modelConversationId?: string;
  terminalError?: string;
  integrationEvidence?: WizardIntegrationEvidence;
  heartbeatAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface WizardIntegrationEvidence {
  changedFiles: string[];
  identifyWired: boolean;
  verificationStatus: "pending" | "passed" | "failed" | "unavailable";
  verificationCommand?: string;
  events: Array<{ eventId: string; eventCode: string; file: string }>;
}

export interface InterventionGroup {
  id: string;
  code: string;
  name: string;
  reasoning: string;
}

export interface Intervention {
  id: string;
  interventionGroupId: string;
  groupCode: string;
  code: string;
  name: string;
  reasoning: string;
  enabled: boolean;
}

export interface GeneratedEvent {
  id: string;
  projectId: string;
  code: string;
  name: string;
  reasoning: string;
}

export interface InterventionEventLink {
  id: string;
  interventionId: string;
  interventionCode: string;
  eventId: string;
  eventCode: string;
  reasoning: string;
}

export interface GeneratedModel {
  groups: InterventionGroup[];
  interventions: Intervention[];
  events: GeneratedEvent[];
  links: InterventionEventLink[];
}

export interface WizardRunSnapshot {
  app: {
    id: string;
    name?: string;
    businessContext?: string;
  };
  project: WizardProject;
  run: WizardRun;
  model: GeneratedModel;
  ingestion: {
    apiKey: string;
    baseUrl: string;
  };
  /** True when POST /wizard/runs selected an existing incomplete run. */
  resumed?: boolean;
}

export interface CreateRunInput {
  repoFingerprint: string;
  displayName: string;
  target: string;
  kind: WizardProjectKind;
}

export interface RunUpdate {
  status?: "running" | "failed";
  phase?: Exclude<WizardRunPhase, "completed">;
  modelConversationId?: string;
  error?: string;
  message?: string;
  integrationEvidence?: WizardIntegrationEvidence;
}

export type CompleteRunInput = WizardIntegrationEvidence;

export type WizardItemInput =
  | {
      kind: "group";
      idempotencyKey: string;
      payload: { code: string; name: string; reasoning: string };
    }
  | {
      kind: "intervention";
      idempotencyKey: string;
      payload: {
        groupCode: string;
        code: string;
        name: string;
        reasoning: string;
        enabled: boolean;
      };
    }
  | {
      kind: "event";
      idempotencyKey: string;
      payload: { code: string; name: string; reasoning: string };
    }
  | {
      kind: "link";
      idempotencyKey: string;
      payload: {
        interventionCode: string;
        eventCode: string;
        reasoning: string;
      };
    };

export interface WizardItemResult {
  kind: WizardItemInput["kind"];
  idempotencyKey: string;
  item: InterventionGroup | Intervention | GeneratedEvent | InterventionEventLink;
  created: boolean;
}

interface RuntimeSnapshot {
  interventionGroups: InterventionGroup[];
  interventions: Intervention[];
  events: GeneratedEvent[];
  links: InterventionEventLink[];
}

interface WizardBusinessContext {
  productName?: string;
  productDescription?: string;
  pricingModel?: string;
  customerType?: string;
  classifiedIcp?: string;
  industry?: string;
  subIndustry?: string;
  productCategory?: string;
  activation?: string;
  antiIcp?: string[];
  atRiskSignals?: string[];
  healthySignals?: string[];
}

interface RunBootstrapResponse extends RuntimeSnapshot {
  app: {
    id: string;
    name?: string;
    businessContext?: WizardBusinessContext;
  };
  project: WizardProject;
  run: WizardRun;
  resumed?: boolean;
  ingestion: WizardRunSnapshot["ingestion"];
}

interface RuntimeItemResult {
  kind: WizardItemInput["kind"];
  created: boolean;
  item: WizardItemResult["item"];
}

interface CompleteRunResponse extends RuntimeSnapshot {
  projects: WizardProject[];
  runs: WizardRun[];
}

export class RuntimeRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RuntimeRequestError";
  }
}

export class WizardRuntimeClient {
  private readonly snapshots = new Map<string, WizardRunSnapshot>();

  constructor(
    private readonly config: WizardConfig,
    private readonly session: WizardSession,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async createOrResumeRun(input: CreateRunInput): Promise<WizardRunSnapshot> {
    const snapshot = normalizeSnapshot(
      await this.request<RunBootstrapResponse>("POST", "/wizard/runs", input),
    );
    this.snapshots.set(snapshot.run.id, snapshot);
    return snapshot;
  }

  async getRun(runId: string): Promise<WizardRunSnapshot> {
    const snapshot = normalizeSnapshot(
      await this.request<RunBootstrapResponse>(
        "GET",
        `/wizard/runs/${encodeURIComponent(runId)}`,
      ),
    );
    this.snapshots.set(runId, snapshot);
    return snapshot;
  }

  async updateRun(runId: string, update: RunUpdate): Promise<WizardRun> {
    const run = await this.request<WizardRun>(
      "PATCH",
      `/wizard/runs/${encodeURIComponent(runId)}`,
      update,
    );
    const snapshot = this.snapshots.get(runId);
    if (snapshot) this.snapshots.set(runId, { ...snapshot, run });
    return run;
  }

  async createItem(runId: string, input: WizardItemInput): Promise<WizardItemResult> {
    const result = await this.request<RuntimeItemResult>(
      "POST",
      `/wizard/runs/${encodeURIComponent(runId)}/items`,
      input,
    );
    return { ...result, idempotencyKey: input.idempotencyKey };
  }

  async completeRun(runId: string, input: CompleteRunInput): Promise<WizardRunSnapshot> {
    let response: CompleteRunResponse;
    try {
      response = await this.request<CompleteRunResponse>(
        "POST",
        `/wizard/runs/${encodeURIComponent(runId)}/complete`,
        input,
      );
    } catch (error) {
      try {
        const authoritative = await this.getRun(runId);
        if (authoritative.run.status === "completed") return authoritative;
      } catch {
        // Preserve the original completion error when reconciliation is unavailable.
      }
      throw error;
    }
    const previous = this.snapshots.get(runId);
    const run = response.runs.find((candidate) => candidate.id === runId);
    if (!previous || !run) return this.getRun(runId);
    const snapshot: WizardRunSnapshot = {
      ...previous,
      project:
        response.projects.find((candidate) => candidate.id === run.projectId) ??
        previous.project,
      run,
      model: {
        groups: response.interventionGroups,
        interventions: response.interventions,
        events: response.events,
        links: response.links,
      },
      resumed: false,
    };
    this.snapshots.set(runId, snapshot);
    return snapshot;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, {
        method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.session.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new RuntimeRequestError(
        `Runtime request failed: ${scrubError(error, [this.session.token])}`,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const safeDetail = scrubError(detail, [this.session.token]).slice(0, 500);
      throw new RuntimeRequestError(
        `Runtime request failed: ${method} ${path} -> ${response.status}${safeDetail ? `: ${safeDetail}` : ""}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }
}

function normalizeSnapshot(response: RunBootstrapResponse): WizardRunSnapshot {
  return {
    app: {
      id: response.app.id,
      name: response.app.name,
      businessContext: renderBusinessContext(response.app.businessContext),
    },
    project: response.project,
    run: response.run,
    model: {
      groups: response.interventionGroups,
      interventions: response.interventions,
      events: response.events,
      links: response.links,
    },
    ingestion: response.ingestion,
    resumed: response.resumed,
  };
}

function renderBusinessContext(context: unknown): string | undefined {
  if (typeof context === "string") return context.trim() || undefined;
  if (context === undefined || context === null) return undefined;
  try {
    return JSON.stringify(context, null, 2);
  } catch {
    return undefined;
  }
}
