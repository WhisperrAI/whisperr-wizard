import { z } from "zod";

import {
  renderOnboardingContext,
  SELECTION_SYSTEM_PROMPT,
  SURVEY_SYSTEM_PROMPT,
  selectionUserPrompt,
  surveyUserPrompt,
} from "./prompts.js";
import type { RunBootstrap, RunsClient } from "./runs.js";
import type { ProgressSink } from "./output.js";
import type {
  EngineProvider,
  EngineModelConfig,
  EngineTool,
  EventPlacement,
  RoleOutcome,
} from "./types.js";

export interface ProposedEvent {
  code: string;
  name: string;
  reasoning: string;
  anchorFile: string;
  anchorSymbol?: string;
  payloadSchema: Record<string, string>;
}

export interface SelectionResult {
  outcome: RoleOutcome["kind"];
  proposed: ProposedEvent[];
  summary: string;
  surveyReport: string;
  sessionId?: string;
}

const PII_SEGMENTS = new Set([
  "email", "phone", "address", "surname", "dob", "birthday", "birthdate",
  "ssn", "passport", "password", "username",
]);

const PII_PAIRS: Array<[string, string]> = [
  ["first", "name"], ["last", "name"], ["full", "name"], ["user", "name"],
  ["middle", "name"], ["maiden", "name"], ["birth", "date"], ["date", "birth"],
  ["national", "id"], ["government", "id"], ["device", "id"], ["personal", "number"],
  ["social", "security"], ["tax", "id"], ["drivers", "license"],
];

export function isPIIField(name: string): boolean {
  const segments = name.split("_");
  if (segments.some((segment) => PII_SEGMENTS.has(segment))) {
    return true;
  }
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (PII_PAIRS.some(([a, b]) => segments[index] === a && segments[index + 1] === b)) {
      return true;
    }
  }
  return false;
}

export function normalizeEventCode(value: string): string {
  const collapsed = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
  return /^[a-z]/.test(collapsed) ? collapsed : "";
}

export function validateProposedEvent(
  input: ProposedEvent,
  seen: Set<string>,
  rejected: Set<string>,
): { ok: true; event: ProposedEvent } | { ok: false; reason: string } {
  const code = normalizeEventCode(input.code);
  if (code === "") {
    return { ok: false, reason: `event code ${JSON.stringify(input.code)} is not snake_case` };
  }
  if (seen.has(code)) {
    return { ok: false, reason: `event ${code} was already proposed` };
  }
  if (rejected.has(code)) {
    return { ok: false, reason: `event ${code} was rejected by the user — do not re-propose it` };
  }
  if (!input.name.trim() || !input.reasoning.trim() || !input.anchorFile.trim()) {
    return { ok: false, reason: "name, reasoning, and anchorFile are required" };
  }
  const schema: Record<string, string> = {};
  for (const [field, description] of Object.entries(input.payloadSchema ?? {})) {
    const normalizedField = normalizeEventCode(field);
    if (normalizedField === "" || !description.trim()) {
      return { ok: false, reason: `payload field ${JSON.stringify(field)} needs a snake_case name and a description` };
    }
    if (isPIIField(normalizedField)) {
      return { ok: false, reason: `payload field ${normalizedField} is a personal identifier and is not allowed` };
    }
    schema[normalizedField] = description.trim();
  }
  if (Object.keys(schema).length > 20) {
    return { ok: false, reason: "payload schema exceeds 20 fields" };
  }
  return {
    ok: true,
    event: {
      code,
      name: input.name.trim(),
      reasoning: input.reasoning.trim(),
      anchorFile: input.anchorFile.trim(),
      anchorSymbol: input.anchorSymbol?.trim() || undefined,
      payloadSchema: schema,
    },
  };
}

export async function runSurvey(
  provider: EngineProvider,
  models: EngineModelConfig,
  repoPath: string,
  bootstrap: RunBootstrap,
  sink: ProgressSink,
  resumeSessionId?: string,
): Promise<{ report: string; outcome: RoleOutcome }> {
  sink.emit({ phase: "surveying", action: "mapping the repository" });
  const outcome = await provider.invoke(
    {
      role: "survey",
      systemPrompt: SURVEY_SYSTEM_PROMPT,
      userPrompt: surveyUserPrompt(repoPath, renderOnboardingContext(bootstrap.onboardingContext)),
      tools: [],
      allowRepoWrite: false,
      cwd: repoPath,
      resumeSessionId,
    },
    models.survey,
    (action) => sink.emit({ phase: "surveying", action }),
  );
  return { report: outcome.kind === "completed" ? outcome.text : "", outcome };
}

export async function runSelection(
  provider: EngineProvider,
  models: EngineModelConfig,
  repoPath: string,
  bootstrap: RunBootstrap,
  surveyReport: string,
  rejectedCodes: string[],
  sink: ProgressSink,
): Promise<SelectionResult> {
  const proposed: ProposedEvent[] = [];
  const seen = new Set<string>();
  const rejected = new Set(rejectedCodes);
  let summary = "";

  const proposeTool: EngineTool = {
    name: "propose_event",
    description:
      "Propose one important, concretely-anchored product event. Returns ok:true when accepted.",
    inputSchema: {
      code: z.string().describe("lowercase snake_case event code"),
      name: z.string().describe("short human-readable name"),
      reasoning: z.string().describe("why this event matters for this business"),
      anchorFile: z.string().describe("repository file where the committed action happens"),
      anchorSymbol: z.string().optional().describe("function/symbol at the anchor"),
      payloadSchema: z
        .record(z.string(), z.string())
        .optional()
        .describe("important payload fields: name -> short description; no personal identifiers"),
    },
    handler: async (input) => {
      const candidate: ProposedEvent = {
        code: String(input.code ?? ""),
        name: String(input.name ?? ""),
        reasoning: String(input.reasoning ?? ""),
        anchorFile: String(input.anchorFile ?? ""),
        anchorSymbol: input.anchorSymbol === undefined ? undefined : String(input.anchorSymbol),
        payloadSchema: (input.payloadSchema ?? {}) as Record<string, string>,
      };
      const validated = validateProposedEvent(candidate, seen, rejected);
      if (!validated.ok) {
        return { ok: false, reason: validated.reason };
      }
      seen.add(validated.event.code);
      proposed.push(validated.event);
      sink.emit({
        phase: "designing",
        file: validated.event.anchorFile,
        action: `proposed ${validated.event.code}`,
      });
      return { ok: true, code: validated.event.code };
    },
  };

  const finishTool: EngineTool = {
    name: "finish_selection",
    description: "Signal that every important event has been proposed.",
    inputSchema: { summary: z.string().describe("one line on what was selected and why") },
    handler: async (input) => {
      summary = String(input.summary ?? "");
      return { ok: true };
    },
  };

  sink.emit({ phase: "designing", action: "selecting important events" });
  const outcome = await provider.invoke(
    {
      role: "design",
      systemPrompt: SELECTION_SYSTEM_PROMPT,
      userPrompt: selectionUserPrompt(
        surveyReport,
        renderOnboardingContext(bootstrap.onboardingContext),
        bootstrap.snapshot.events.map((event) => event.code),
        rejectedCodes,
      ),
      tools: [proposeTool, finishTool],
      allowRepoWrite: false,
      cwd: repoPath,
    },
    models.design,
    (action) => sink.emit({ phase: "designing", action }),
  );

  return {
    outcome: outcome.kind,
    proposed,
    summary,
    surveyReport,
    sessionId: outcome.sessionId,
  };
}

export interface RegisteredEvent extends ProposedEvent {
  eventId: string;
}

export async function registerApprovedEvents(
  runs: RunsClient,
  runId: string,
  approved: ProposedEvent[],
  sink: ProgressSink,
): Promise<RegisteredEvent[]> {
  const registered: RegisteredEvent[] = [];
  for (const event of approved) {
    const result = await runs.writeItem(runId, "event", {
      code: event.code,
      name: event.name,
      reasoning: event.reasoning,
      ...(Object.keys(event.payloadSchema).length > 0
        ? { payloadSchema: event.payloadSchema }
        : {}),
    });
    const item = (result as { item?: { id?: string } }).item;
    registered.push({ ...event, eventId: item?.id ?? result.id ?? "" });
    sink.emit({ phase: "persisting", file: event.anchorFile, action: `registered ${event.code}` });
  }
  return registered;
}

export function placementsFor(registered: RegisteredEvent[]): EventPlacement[] {
  return registered.map((event) => ({
    eventId: event.eventId,
    eventCode: event.code,
    file: event.anchorFile,
    symbol: event.anchorSymbol,
    status: "planned",
  }));
}
