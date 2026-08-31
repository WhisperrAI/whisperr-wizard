import { createHash } from "node:crypto";
import { SHARED_CONTRACT_VERSION } from "./integration-playbook.js";

export function sharedServerKeyGuidance(enabled: boolean): string {
  return enabled ? "Trusted server-source setup: the bootstrap key is publishable and cannot prove server activity. Preserve the backend's environment/config key reference (for example WHISPERR_API_KEY); the customer must configure their explicitly approved server key in their hosting environment. Never read, echo, invent, hard-code, or commit a server secret or place one in a browser/mobile bundle. Do not add profile/contact fields or infer consent. A PR, local build, synthetic schema test, or key binding is not deployment or live proof; only accepted traffic from that approved server key establishes live server activity." : "";
}

export interface SharedEventDefinition {
  code: string;
  name: string;
  reasoning?: string;
  payload_schema: Record<string, unknown>;
}
export interface SharedRevision {
  contract_version: string;
  revision: { revision_id: string; state: string; events: SharedEventDefinition[] };
  content_hash: string;
  gaps: Array<{ event_code: string; reason: string }>;
  current_event_codes: string[];
  /** Exact run-owned request scope, not the additive app-wide revision snapshot. */
  requested_event_codes?: string[] | null;
}
export class IntegrationWorkflowError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Shared integration request failed (${status}: ${code}); no legacy fallback was attempted.`);
    this.name = "IntegrationWorkflowError";
  }
}
type Requester = typeof fetch;
type Pause = (milliseconds: number) => Promise<void>;
const pause: Pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().filter((key) => record[key] !== undefined)
      .map((key) => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

/** Synthetic values are generated from the declared types, never by copying a
 * customer's data or turning local build success into server receipt proof. */
export function syntheticProperties(schema: Record<string, unknown>): Record<string, unknown> {
  function value(field: unknown, depth: number): unknown {
    if (depth > 8) throw new Error("Schema is too deeply nested for an isolated test.");
    const spec = field && typeof field === "object" ? field as Record<string, unknown> : undefined;
    const type = spec?.type ?? field;
    switch (type) {
      case "string": return "synthetic";
      case "number": case "integer": return 0;
      case "boolean": return false;
      case "null": return null;
      case "array": return [];
      case "object": return object(spec?.properties, depth + 1);
      default: throw new Error("Unsupported payload type; correct the schema before validation.");
    }
  }
  function object(input: unknown, depth: number): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) return {};
    return Object.fromEntries(Object.entries(input).map(([key, field]) => [key, value(field, depth)]));
  }
  return object(schema.type === "object" ? schema.properties : schema, 0);
}

/** Thin transport over server-owned registry/ingress semantics. The credential
 * remains the exact wizard/dispatch session; it is never traded for MCP OAuth. */
export class IntegrationWorkflowClient {
  private latestRevisionID?: string;
  constructor(
    private readonly base: string,
    private readonly token: string,
    readonly runID: string,
    private readonly request: Requester = fetch,
    private readonly wait: Pause = pause,
    private readonly polls = 30,
  ) {}
  private path(suffix: string): string {
    return `${this.base}/wizard/runs/${encodeURIComponent(this.runID)}/integration${suffix}`;
  }
  private async call<T>(method: string, suffix: string, body?: Record<string, unknown>): Promise<T> {
    const url = this.path(suffix) + (method === "GET" ? `?contract_version=${SHARED_CONTRACT_VERSION}` : "");
    const response = await this.request(url, {
      method, headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      redirect: "error", signal: AbortSignal.timeout(30_000),
      body: method === "GET" ? undefined : JSON.stringify({ ...body, contract_version: SHARED_CONTRACT_VERSION }),
    });
    const text = await response.text();
    if (text.length > 1_048_576) throw new Error("Integration response exceeded its bound.");
    let payload: Record<string, any>;
    try { payload = JSON.parse(text); } catch { throw new Error("Invalid integration response."); }
    if (!response.ok) throw new IntegrationWorkflowError(response.status, typeof payload.error?.code === "string" ? payload.error.code : "request_rejected");
    return payload as T;
  }
  private revision(value: SharedRevision): SharedRevision {
    if (value.contract_version !== SHARED_CONTRACT_VERSION || !value.revision?.revision_id ||
      !Array.isArray(value.gaps) || !Array.isArray(value.revision.events)) {
      throw new Error("Integration contract mismatch; update the executor.");
    }
    return value;
  }
  async status(): Promise<{ contract_version: string; required_events: SharedEventDefinition[]; registrations: SharedRevision[] }> {
    const result = await this.call<{ contract_version: string; required_events: SharedEventDefinition[]; registrations: SharedRevision[]; run_id?: string }>("GET", "/status");
    if (result.contract_version !== SHARED_CONTRACT_VERSION || !Array.isArray(result.required_events) ||
      !Array.isArray(result.registrations) || (result.run_id !== undefined && result.run_id !== this.runID) ||
      result.required_events.some((event) => !event || typeof event.code !== "string" || typeof event.name !== "string" ||
        !event.payload_schema || typeof event.payload_schema !== "object" || Array.isArray(event.payload_schema))) {
      throw new Error("Integration contract mismatch; update the executor.");
    }
    for (const registration of result.registrations) this.revision(registration);
    return result;
  }
  async read(revisionID: string): Promise<SharedRevision> {
    return this.revision(await this.call("GET", `/drafts/${encodeURIComponent(revisionID)}`));
  }
  async stageEvents(events: SharedEventDefinition[]): Promise<SharedRevision> {
    if (!events.length) throw new Error("Registration requires at least one event.");
    const normalized = [...events].sort((a, b) => a.code.localeCompare(b.code));
    return this.revision(await this.call("POST", "/drafts", { operation_id: digest(normalized), events: normalized }));
  }
  async attachPlacement(revisionID: string, eventCode: string, file: string, symbol?: string): Promise<string> {
    const result = await this.call<{ id: string }>("POST", `/drafts/${encodeURIComponent(revisionID)}/placement`, {
      event_code: eventCode, anchor_file: file, ...(symbol ? { anchor_symbol: symbol } : {}),
    });
    if (!result.id) throw new Error("Placement response has no canonical event ID.");
    return result.id;
  }
  async registerEvents(events: SharedEventDefinition[]): Promise<SharedRevision> {
    if (!events.length) throw new Error("Registration requires at least one event.");
    const source = await this.call<{ connection_id: string; contract_version: string }>("POST", "/source");
    if (source.contract_version !== SHARED_CONTRACT_VERSION || !source.connection_id) throw new Error("Invalid code-source response.");
    let state = await this.stageEvents(events);
    const revisionID = state.revision.revision_id;
    const route = `/drafts/${encodeURIComponent(revisionID)}`;
    if (state.revision.state === "draft") state = this.revision(await this.call("POST", route + "/validation"));
    if (state.revision.state === "validating") {
      const missing = new Set(state.gaps.filter((gap) => gap.reason === "isolated_test_event_not_received").map((gap) => gap.event_code));
      for (const event of state.revision.events) {
        if (!missing.has(event.code)) continue;
        await this.call("POST", route + "/tests", {
          operation_id: digest({ revisionID, event }), connection_id: source.connection_id, event_code: event.code,
          properties: syntheticProperties(event.payload_schema),
        });
      }
      for (let attempt = 0; attempt < this.polls; attempt++) {
        state = await this.read(revisionID);
        if (state.revision.state !== "validating" || state.gaps.length === 0) break;
        await this.wait(500);
      }
      if (state.gaps.length !== 0) throw new Error("Isolated validation is incomplete. Inspect the durable draft; registration was not committed.");
      if (state.revision.state === "validating") state = this.revision(await this.call("POST", route + "/commit"));
    }
    if (!["committed", "superseded"].includes(state.revision.state)) throw new Error(`Registration is ${state.revision.state}; reload and resolve it explicitly.`);
    const current = new Set(state.current_event_codes ?? []);
    if (!events.every((event) => current.has(event.code))) {
      throw new Error("Approved definitions changed or their code source was removed; inspect the current registration before resuming.");
    }
    this.latestRevisionID = state.revision.revision_id;
    return state;
  }
  /** Caller must have an actual deployment reference. A PR, local diff, or
   * successful test is not a deployment and must not call this automatically. */
  async reportDeployment(deploymentRef: string, revisionID = this.latestRevisionID): Promise<void> {
    if (!revisionID) throw new Error("A committed revision is required before reporting deployment.");
    await this.call("POST", `/drafts/${encodeURIComponent(revisionID)}/deployment`, {
      report_id: digest({ revisionID, deploymentRef }), deployment_ref: deploymentRef,
    });
  }
}
