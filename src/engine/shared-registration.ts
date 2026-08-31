import { IntegrationWorkflowClient, type SharedEventDefinition } from "../core/integration-workflow.js";
import type { WizardConfig, WizardSession } from "../types.js";
import type { RunBootstrap } from "./runs.js";
import type { ProposedEvent, RegisteredEvent } from "./selection.js";

const primitives = new Set(["string", "number", "integer", "boolean", "null"]);

/** The registry, not the flattened run snapshot, owns payload types. Refuse
 * unsupported schemas before any registration instead of inventing coercions. */
export function primitivePayload(schema: Record<string, unknown>): Record<string, string> {
  const raw = schema.type === "object" ? schema.properties : schema;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Shared registration needs an explicit primitive payload schema.");
  return Object.fromEntries(Object.entries(raw).map(([field, value]) => {
    const type = typeof value === "object" && value !== null ? (value as Record<string, unknown>).type : value;
    // Constrained/nested definitions cannot be losslessly flattened into this
    // engine's wrapper contract. Keep the durable definition untouched.
    if (typeof type !== "string" || !primitives.has(type) ||
      (typeof value === "object" && value !== null && Object.keys(value).some((key) => key !== "type"))) {
      throw new Error(`Shared payload field ${field} is not supported by this executor; use the exact schema with MCP instead.`);
    }
    return [field, type];
  }));
}

export class SharedEngineRegistration {
  private readonly client: IntegrationWorkflowClient;
  private readonly definitions = new Map<string, SharedEventDefinition>();
  private readonly ownedRevisions = new Map<string, string>();
  constructor(config: WizardConfig, session: WizardSession, runId: string, request: typeof fetch = fetch) {
    this.client = new IntegrationWorkflowClient(config.apiBaseUrl, session.token, runId, request);
  }

  async restoreSnapshot(bootstrap: RunBootstrap): Promise<void> {
    const current = await this.client.status();
    for (const event of current.required_events) this.definitions.set(event.code, event);
    // Commit expands revision.events into an app-wide snapshot. Only the
    // separately persisted request scope identifies this run's intended work.
    // Older records without that scope are ambiguous, not evidence of success.
    if (current.registrations.length >= 50) throw new Error("Run registration history may be incomplete; resolve its full scope before resuming.");
    for (const registration of current.registrations) {
      if (!["committed", "superseded"].includes(registration.revision.state)) continue;
      const codes = registration.requested_event_codes;
      if (!Array.isArray(codes) || !codes.length || codes.some((code) => typeof code !== "string" || !code)) {
        throw new Error("Saved registration has no explicit run-owned event scope; resolve this historical run before resuming.");
      }
      for (const code of codes) {
        // The server returns revisions newest first. A newer approved revision
        // can replace this run's older definition without losing its scope.
        if (this.ownedRevisions.has(code)) continue;
        const definition = this.definitions.get(code);
        if (!definition || !registration.current_event_codes?.includes(code) ||
          !registration.revision.events.some((event) => event.code === code)) {
          throw new Error(`Run-owned event ${code} is no longer currently approved; resolve registration before resuming.`);
        }
        this.ownedRevisions.set(code, registration.revision.revision_id);
        const placedHere = bootstrap.snapshot.events.find((event) => event.code === code && event.projectId === bootstrap.project.id);
        if (placedHere) continue;
        const canonical = bootstrap.snapshot.events.find((event) => event.code === code);
        if (!canonical) throw new Error(`Run-owned event ${code} is missing from the canonical snapshot; reload before resuming.`);
        // This is a local recovery worklist, not a fabricated server binding.
        // Preserve the real canonical ID, but never borrow another repo's anchor.
        bootstrap.snapshot.events.push({ ...canonical, projectId: bootstrap.project.id, anchorFile: undefined, anchorSymbol: undefined });
      }
    }
    for (const event of bootstrap.snapshot.events) {
      if (event.projectId !== bootstrap.project.id) continue;
      const definition = this.definitions.get(event.code);
      if (!definition) throw new Error(`Saved placement ${event.code} has no current approved registry definition; resolve registration before resuming.`);
      event.name = definition.name;
      event.reasoning = definition.reasoning ?? "";
      event.payloadSchema = primitivePayload(definition.payload_schema);
    }
  }

  async registerAndPlace(events: ProposedEvent[]): Promise<RegisteredEvent[]> {
    const definitions = events.map((event) => {
      const payload = primitivePayload(event.payloadSchema);
      const existing = this.definitions.get(event.code);
      const ordered = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      if (existing && ordered(primitivePayload(existing.payload_schema)) !== ordered(payload)) {
        throw new Error(`Placement recovery cannot redefine the approved schema for ${event.code}.`);
      }
      // Retain the exact authoritative structured definition on recovery;
      // flattening is solely for the local primitive wrapper signature.
      return existing ?? { code: event.code, name: event.name, reasoning: event.reasoning, payload_schema: payload };
    });
    const newDefinitions = definitions.filter((definition) => !this.ownedRevisions.has(definition.code));
    if (newDefinitions.length) {
      const committed = await this.client.registerEvents(newDefinitions);
      for (const definition of newDefinitions) {
        this.ownedRevisions.set(definition.code, committed.revision.revision_id);
        this.definitions.set(definition.code, definition);
      }
    }
    const registered: RegisteredEvent[] = [];
    for (const event of events) {
      const eventId = await this.client.attachPlacement(this.ownedRevisions.get(event.code)!, event.code, event.anchorFile, event.anchorSymbol);
      const definition = definitions.find((candidate) => candidate.code === event.code)!;
      registered.push({ ...event, eventId, name: definition.name, reasoning: definition.reasoning ?? "", payloadSchema: primitivePayload(definition.payload_schema) });
    }
    return registered;
  }
}
