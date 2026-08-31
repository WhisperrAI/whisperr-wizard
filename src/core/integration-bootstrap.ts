import { basename } from "node:path";
import { IntegrationWorkflowClient, type SharedEventDefinition } from "./integration-workflow.js";
import type { IntegrationManifest, OpportunityEvent, WizardConfig, WizardSession } from "../types.js";
import type { ReportEvent } from "./report.js";

export interface IntegrationBootstrap {
  client: IntegrationWorkflowClient;
  manifest: IntegrationManifest;
  definitions: Map<string, SharedEventDefinition>;
  runID: string;
}

/** Opt-in wizard-mode bootstrap. The existing device session is bound by the
 * server to this exact run; runtime installation keeps the existing bootstrap
 * credential path, not an MCP token exchange or an agent-authored credential. */
export async function bootstrapIntegration(config: WizardConfig, session: WizardSession, repoPath: string, fingerprint: string, target: string, request: typeof fetch = fetch): Promise<IntegrationBootstrap> {
  const response = await request(`${config.apiBaseUrl}/wizard/runs`, {
    method: "POST", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ repoFingerprint: fingerprint, displayName: basename(repoPath), target,
      kind: target === "nextjs" ? "fullstack" : ["node", "php", "python"].includes(target) ? "backend" : "frontend" }),
    signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (!response.ok) throw new Error(`Shared integration bootstrap failed (${response.status}); no legacy manifest fallback was attempted.`);
  const data = await response.json() as {
    run?: { id: string }; project?: { id: string }; universeMode?: string;
    app?: { name?: string }; onboardingContext?: Record<string, unknown>;
    ingestion?: { apiKey: string; baseUrl: string };
  };
  if (!data.run?.id || !data.ingestion?.apiKey || data.universeMode !== "wizard") throw new Error("Invalid shared integration bootstrap.");
  const client = new IntegrationWorkflowClient(config.apiBaseUrl, session.token, data.run.id, request);
  // Legacy run snapshots flatten structured schemas. Only the shared registry
  // may supply the approved definition, including nested field allowlists.
  const current = await client.status();
  const definitions = new Map(current.required_events.map((event) => [event.code, {
    code: event.code, name: event.name, reasoning: event.reasoning, payload_schema: event.payload_schema,
  }]));
  const manifest: IntegrationManifest = {
    appId: session.appId, appName: data.app?.name, ingestionApiKey: data.ingestion.apiKey,
    ingestionBaseUrl: data.ingestion.baseUrl || config.apiBaseUrl,
    businessContext: data.onboardingContext ? JSON.stringify(data.onboardingContext).slice(0, 8000) : undefined,
    identify: { traits: [], channels: [], notes: "Use the stable end-user ID. Do not collect contact details or infer consent; delivery setup is separate." },
    events: [...definitions.values()].map((event) => ({ eventType: event.code, label: event.name, description: event.reasoning,
      properties: Object.entries(event.payload_schema.type === "object"
        ? event.payload_schema.properties as Record<string, unknown> ?? {} : event.payload_schema)
        .map(([name, field]) => ({ name, description: `Approved schema: ${JSON.stringify(field)}`,
          type: typeof field === "string" ? field : typeof field === "object" && field !== null ? String((field as Record<string, unknown>).type) : undefined })),
    })),
  };
  return { client, manifest, definitions, runID: data.run.id };
}

export function opportunityDefinition(event: OpportunityEvent): SharedEventDefinition {
  const payload: Record<string, string> = {};
  for (const property of event.properties ?? []) {
    if (!property.type || !["string", "number", "integer", "boolean", "null"].includes(property.type)) {
      throw new Error(`Event ${event.code} property ${property.name} needs an explicit primitive type from the code before registration.`);
    }
    payload[property.name] = property.type;
  }
  return { code: event.code, name: event.label || event.code, reasoning: event.rationale || event.description || "", payload_schema: payload };
}

export function startIntegrationHeartbeat(config: WizardConfig, session: WizardSession, runID: string): () => void {
  let pending = false;
  const timer = setInterval(() => {
    if (pending) return;
    pending = true;
    void fetch(`${config.apiBaseUrl}/wizard/runs/${encodeURIComponent(runID)}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phase: "integrating" }), redirect: "error", signal: AbortSignal.timeout(15_000),
    }).catch(() => {}).finally(() => { pending = false; });
  }, 20_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Finalize local code evidence only. Neither a source schema test nor this
 * report claims that the customer has deployed the changed repository. */
export async function finishIntegration(config: WizardConfig, session: WizardSession, setup: IntegrationBootstrap, reports: ReportEvent[], files: string[], identifyWired: boolean, verified: boolean | null, exitClass: string, revisions: Map<string, string>, request: typeof fetch = fetch): Promise<void> {
  const runPath = `${config.apiBaseUrl}/wizard/runs/${encodeURIComponent(setup.runID)}`;
  const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
  if (!["completed", "events_incomplete"].includes(exitClass)) {
    const response = await request(runPath, { method: "PATCH", headers, redirect: "error", signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ status: "failed", error: `Local integration ended: ${exitClass}` }),
    });
    if (!response.ok) throw new Error(`Could not record the local run outcome (${response.status}).`);
    return;
  }
  for (const report of reports) {
    if (report.status !== "wired" || !report.file) continue;
    const definition = setup.definitions.get(report.event_type);
    if (!definition) throw new Error(`No approved schema for placed event ${report.event_type}.`);
    let revisionID = revisions.get(report.event_type);
    if (!revisionID) {
      const committed = await setup.client.registerEvents([definition]);
      revisionID = committed.revision.revision_id;
      revisions.set(report.event_type, revisionID);
    }
    await setup.client.attachPlacement(revisionID, report.event_type, report.file);
  }
  const response = await request(runPath, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Could not read the run's registered placements (${response.status}).`);
  const latest = await response.json() as { project?: { id: string }; snapshot?: { events?: Array<{ id: string; code: string; projectId: string }> } };
  if (!latest.project?.id || !latest.snapshot?.events) throw new Error("Invalid run placement snapshot.");
  const reportMap = new Map(reports.map((report) => [report.event_type, report]));
  const events = latest.snapshot.events.filter((event) => event.projectId === latest.project?.id).map((event) => {
    const report = reportMap.get(event.code);
    return { eventId: event.id, eventCode: event.code,
      status: report?.status === "wired" ? (verified === true ? "build_verified" : "applied") : "failed",
      ...(report?.status === "wired" && report.file ? { file: report.file } : {}),
    };
  });
  const completed = exitClass === "completed" && identifyWired && verified !== false && reports.every((report) => report.status === "wired");
  const result = await request(runPath + "/complete", { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ outcome: completed ? "completed" : "partial", changedFiles: files, identifyWired,
      verificationStatus: verified === true ? "passed" : verified === false ? "failed" : "unavailable", events }),
  });
  if (!result.ok) throw new Error(`Could not finalize the local run (${result.status}); its durable registration remains resumable.`);
}
