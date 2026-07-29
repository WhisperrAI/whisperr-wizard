import { z } from "zod";

import {
  renderOnboardingContext,
  SELECTION_SYSTEM_PROMPT,
  SURVEY_SYSTEM_PROMPT,
  selectionUserPrompt,
  surveyUserPrompt,
} from "./prompts.js";
import { RunsApiError, type RunBootstrap, type RunsClient } from "./runs.js";
import type { ProgressSink } from "./output.js";
import type {
  EngineProvider,
  EngineModelConfig,
  EngineTool,
  EventPlacement,
  RoleOutcome,
} from "./types.js";
import { modelConfigFor } from "./types.js";

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
  /** True only when finish_selection ran successfully — not when the model stream ended. */
  finished: boolean;
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
  const anchorFile = input.anchorFile.trim().replaceAll("\\", "/");
  const anchorParts = anchorFile.split("/");
  if (!input.name.trim() || !input.reasoning.trim() || !anchorFile) {
    return { ok: false, reason: "name, reasoning, and anchorFile are required" };
  }
  if (
    anchorFile.startsWith("/") ||
    /^[a-z]:/i.test(anchorFile) ||
    anchorParts.some((part) => part === "" || part === "." || part === "..")
  ) {
    return { ok: false, reason: "anchorFile must be a safe repository-relative path" };
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
      anchorFile,
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
      task: "survey",
      sessionKey: "survey",
      systemPrompt: SURVEY_SYSTEM_PROMPT,
      userPrompt: surveyUserPrompt(repoPath, renderOnboardingContext(bootstrap.onboardingContext)),
      tools: [],
      allowRepoWrite: false,
      cwd: repoPath,
      resumeSessionId,
    },
    modelConfigFor(models, "survey", "survey"),
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
  existingEventCodes = bootstrap.snapshot.events.map((event) => event.code),
): Promise<SelectionResult> {
  const proposed: ProposedEvent[] = [];
  const seen = new Set<string>();
  const rejected = new Set(rejectedCodes);
  let summary = "";
  let finished = false;

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
    jsonSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "lowercase snake_case event code" },
        name: { type: "string", description: "short human-readable name" },
        reasoning: { type: "string", description: "why this event matters for this business" },
        anchorFile: { type: "string", description: "repository file where the committed action happens" },
        anchorSymbol: { type: "string", description: "function/symbol at the anchor" },
        payloadSchema: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "important payload fields: name -> short description; no personal identifiers",
        },
      },
      required: ["code", "name", "reasoning", "anchorFile"],
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

  const proposeBatchTool: EngineTool = {
    name: "propose_event_batch",
    description:
      "Propose a batch of important, concretely-anchored product events in one tool call.",
    inputSchema: {
      events: z.array(z.object(proposeTool.inputSchema)).min(1).max(200),
    },
    jsonSchema: {
      type: "object",
      properties: {
        events: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: proposeTool.jsonSchema,
        },
      },
      required: ["events"],
    },
    handler: async (input) => {
      const events = Array.isArray(input.events) ? input.events : [];
      const results: Record<string, unknown>[] = [];
      for (const event of events) {
        results.push(await proposeTool.handler((event ?? {}) as Record<string, unknown>));
      }
      return {
        ok: results.every((result) => result.ok === true),
        accepted: results.filter((result) => result.ok === true).length,
        results,
      };
    },
  };

  const finishTool: EngineTool = {
    name: "finish_selection",
    description: "Signal that every important event has been proposed.",
    inputSchema: { summary: z.string().describe("one line on what was selected and why") },
    jsonSchema: {
      type: "object",
      properties: { summary: { type: "string", description: "one line on what was selected and why" } },
      required: ["summary"],
    },
    handler: async (input) => {
      summary = String(input.summary ?? "");
      finished = true;
      return { ok: true };
    },
  };

  sink.emit({ phase: "designing", action: "selecting important events" });
  const outcome = await provider.invoke(
    {
      role: "design",
      task: "design",
      systemPrompt: SELECTION_SYSTEM_PROMPT,
      userPrompt: selectionUserPrompt(
        surveyReport,
        renderOnboardingContext(bootstrap.onboardingContext),
        existingEventCodes,
        rejectedCodes,
      ),
      tools: [proposeBatchTool, proposeTool, finishTool],
      allowRepoWrite: false,
      cwd: repoPath,
    },
    modelConfigFor(models, "design", "design"),
    (action) => sink.emit({ phase: "designing", action }),
  );

  return {
    outcome: outcome.kind,
    finished,
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
    let result;
    try {
      result = await runs.writeItem(runId, "event", {
        code: event.code,
        name: event.name,
        reasoning: event.reasoning,
        anchorFile: event.anchorFile,
        ...(event.anchorSymbol ? { anchorSymbol: event.anchorSymbol } : {}),
        ...(Object.keys(event.payloadSchema).length > 0
          ? { payloadSchema: event.payloadSchema }
          : {}),
      }, "placement-v2");
    } catch (error) {
      // Another project in this app already owns the code (multi-repo apps:
      // the backend registered it first). Selection saw the app-wide snapshot
      // and should not have re-proposed it, but the race is real when projects
      // run in parallel — skip the event instead of aborting the whole run.
      if (error instanceof RunsApiError && error.code === "wizard_project_conflict") {
        sink.emit({
          phase: "persisting",
          file: event.anchorFile,
          action: `skipped ${event.code} — already registered by another project`,
        });
        continue;
      }
      throw error;
    }
    registered.push({ ...event, eventId: result.id || result.item?.id || "" });
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
