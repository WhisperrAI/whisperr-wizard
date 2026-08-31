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
  constructor(config: WizardConfig, session: WizardSession, runId: string, request: typeof fetch = fetch) {
    this.client = new IntegrationWorkflowClient(config.apiBaseUrl, session.token, runId, request);
  }

  async restoreSnapshot(bootstrap: RunBootstrap): Promise<void> {
    const current = await this.client.status();
    for (const event of current.required_events) this.definitions.set(event.code, event);
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
    const committed = await this.client.registerEvents(definitions);
    const registered: RegisteredEvent[] = [];
    for (const event of events) {
      const eventId = await this.client.attachPlacement(committed.revision.revision_id, event.code, event.anchorFile, event.anchorSymbol);
      const definition = definitions.find((candidate) => candidate.code === event.code)!;
      registered.push({ ...event, eventId, name: definition.name, reasoning: definition.reasoning ?? "", payloadSchema: primitivePayload(definition.payload_schema) });
    }
    return registered;
  }
}
