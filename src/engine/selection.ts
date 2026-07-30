import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

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
import { describeRoleOutcome, modelConfigFor } from "./types.js";

export interface ProposedEvent {
  code: string;
  name: string;
  reasoning: string;
  anchorFile: string;
  anchorSymbol?: string;
  payloadSchema: Record<string, string>;
}

export interface SurveyFeatureArea {
  name: string;
  root: string;
  files: string[];
}

export interface SurveyAnchor {
  file: string;
  symbol?: string;
  description: string;
}

export interface SurveyCallSite extends SurveyAnchor {
  outcome: string;
  payloadFields: string[];
  similarPaths: string[];
}

/** Structured, source-free repository map persisted with a wizard run. */
export interface SurveyArtifact {
  stack: {
    frameworks: string[];
    packageManager?: string;
    entryPoints: string[];
  };
  featureAreas: SurveyFeatureArea[];
  identifyAnchors: SurveyAnchor[];
  logoutAnchors: SurveyAnchor[];
  existingAnalytics: SurveyAnchor[];
  integratableCallSites: SurveyCallSite[];
}

export interface SelectionResult {
  outcome: RoleOutcome["kind"];
  outcomeDetail: string;
  /** True only when finish_event_design ran successfully — not when the model stream ended. */
  finished: boolean;
  proposed: ProposedEvent[];
  summary: string;
  survey: SurveyArtifact;
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
): Promise<{ survey?: SurveyArtifact; finished: boolean; outcome: RoleOutcome }> {
  let survey: SurveyArtifact | undefined;
  let finished = false;
  const finishSurvey: EngineTool = {
    name: "finish_survey",
    description: "Return the complete structured repository survey without raw source code.",
    inputSchema: {
      stack: z.object({
        frameworks: z.array(z.string()).max(30),
        packageManager: z.string().optional(),
        entryPoints: z.array(z.string()).max(50),
      }),
      featureAreas: z.array(z.object({
        name: z.string(),
        root: z.string(),
        files: z.array(z.string()).max(200),
      })).max(200),
      identifyAnchors: z.array(z.object({
        file: z.string(),
        symbol: z.string().optional(),
        description: z.string(),
      })).max(50),
      logoutAnchors: z.array(z.object({
        file: z.string(),
        symbol: z.string().optional(),
        description: z.string(),
      })).max(50),
      existingAnalytics: z.array(z.object({
        file: z.string(),
        symbol: z.string().optional(),
        description: z.string(),
      })).max(100),
      integratableCallSites: z.array(z.object({
        file: z.string(),
        symbol: z.string().optional(),
        description: z.string(),
        outcome: z.string(),
        payloadFields: z.array(z.string()).max(50),
        similarPaths: z.array(z.string()).max(50),
      })).max(500),
    },
    jsonSchema: surveyJSONSchema(),
    handler: async (input) => {
      if (finished) {
        return { ok: false, reason: "survey is already frozen" };
      }
      const normalized = normalizeSurveyArtifact(input);
      if (!normalized) {
        return { ok: false, reason: "survey fields or repository-relative paths are invalid" };
      }
      survey = normalized;
      finished = true;
      return { ok: true, callSites: normalized.integratableCallSites.length };
    },
  };
  sink.emit({ phase: "surveying", action: "mapping the repository" });
  const invocation = {
    role: "survey" as const,
    task: "survey" as const,
    sessionKey: "survey",
    systemPrompt: SURVEY_SYSTEM_PROMPT,
    userPrompt: surveyUserPrompt(repoPath, renderOnboardingContext(bootstrap.onboardingContext)),
    tools: [finishSurvey],
    repositoryAccess: { mode: "survey" as const },
    allowRepoWrite: false,
    cwd: repoPath,
    resumeSessionId,
  };
  const outcome = await provider.invoke(
    invocation,
    modelConfigFor(models, "survey", "survey"),
    (action) => sink.emit({ phase: "surveying", action }),
  );
  return { survey, finished, outcome };
}

export async function runSelection(
  provider: EngineProvider,
  models: EngineModelConfig,
  repoPath: string,
  bootstrap: RunBootstrap,
  survey: SurveyArtifact,
  rejectedCodes: string[],
  sink: ProgressSink,
  existingEventCodes = bootstrap.snapshot.events.map((event) => event.code),
  recoveryCodes: string[] = [],
  resumeSessionId?: string,
): Promise<SelectionResult> {
  const proposed: ProposedEvent[] = [];
  const seen = new Set<string>();
  const rejected = new Set(rejectedCodes);
  const existing = new Set(existingEventCodes.map(normalizeEventCode));
  const recovery = new Set(recoveryCodes.map(normalizeEventCode));
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
      if (finished) {
        return { ok: false, reason: "event design draft is already complete" };
      }
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
      if (recovery.size > 0 && !recovery.has(validated.event.code)) {
        return { ok: false, reason: `placement recovery cannot create event ${validated.event.code}` };
      }
      if (existing.has(validated.event.code) && !recovery.has(validated.event.code)) {
        return { ok: false, reason: `event ${validated.event.code} is already registered` };
      }
      const anchorError = await validateAnchor(repoPath, validated.event);
      if (anchorError) {
        return { ok: false, reason: anchorError };
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
    name: "finish_event_design",
    description:
      "Complete the proposed batch for deterministic server validation and atomic commit.",
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
  const invocation = {
    role: "design" as const,
    task: "design" as const,
    sessionKey: "survey",
    systemPrompt: SELECTION_SYSTEM_PROMPT,
    userPrompt: selectionUserPrompt(
      JSON.stringify(survey),
      renderOnboardingContext(bootstrap.onboardingContext),
      existingEventCodes,
      rejectedCodes,
    ),
    tools: [proposeBatchTool, finishTool],
    repositoryAccess: { mode: "none" as const },
    allowRepoWrite: false,
    cwd: repoPath,
    resumeSessionId,
  };
  const outcome = await provider.invoke(
    invocation,
    modelConfigFor(models, "design", "design"),
    (action) => sink.emit({ phase: "designing", action }),
  );
  return {
    outcome: outcome.kind,
    outcomeDetail: describeRoleOutcome(outcome),
    finished,
    proposed,
    summary,
    survey,
    sessionId: outcome.sessionId,
  };
}

async function validateAnchor(repoPath: string, event: ProposedEvent): Promise<string | undefined> {
  const root = resolve(repoPath);
  const path = resolve(root, event.anchorFile);
  if (path === root || !path.startsWith(root + sep)) {
    return `${event.code}: anchor escapes the repository`;
  }
  try {
    const info = await stat(path);
    if (!info.isFile()) return `${event.code}: anchor is not a file`;
    if (event.anchorSymbol) {
      const content = await readFile(path, "utf8");
      if (!content.includes(event.anchorSymbol)) {
        return `${event.code}: anchor symbol ${event.anchorSymbol} is not present in ${event.anchorFile}`;
      }
    }
  } catch {
    return `${event.code}: anchor file ${event.anchorFile} does not exist`;
  }
  return undefined;
}

function surveyJSONSchema(): Record<string, unknown> {
  const anchor = {
    type: "object",
    properties: {
      file: { type: "string" },
      symbol: { type: "string" },
      description: { type: "string" },
    },
    required: ["file", "description"],
  };
  return {
    type: "object",
    properties: {
      stack: {
        type: "object",
        properties: {
          frameworks: { type: "array", items: { type: "string" }, maxItems: 30 },
          packageManager: { type: "string" },
          entryPoints: { type: "array", items: { type: "string" }, maxItems: 50 },
        },
        required: ["frameworks", "entryPoints"],
      },
      featureAreas: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            root: { type: "string" },
            files: { type: "array", items: { type: "string" }, maxItems: 200 },
          },
          required: ["name", "root", "files"],
        },
      },
      identifyAnchors: { type: "array", items: anchor, maxItems: 50 },
      logoutAnchors: { type: "array", items: anchor, maxItems: 50 },
      existingAnalytics: { type: "array", items: anchor, maxItems: 100 },
      integratableCallSites: {
        type: "array",
        maxItems: 500,
        items: {
          ...anchor,
          properties: {
            ...(anchor.properties as Record<string, unknown>),
            outcome: { type: "string" },
            payloadFields: { type: "array", items: { type: "string" }, maxItems: 50 },
            similarPaths: { type: "array", items: { type: "string" }, maxItems: 50 },
          },
          required: ["file", "description", "outcome", "payloadFields", "similarPaths"],
        },
      },
    },
    required: [
      "stack", "featureAreas", "identifyAnchors", "logoutAnchors",
      "existingAnalytics", "integratableCallSites",
    ],
  };
}

function normalizeSurveyArtifact(input: Record<string, unknown>): SurveyArtifact | undefined {
  const safePath = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().replaceAll("\\", "/");
    if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) ||
      normalized.split("/").some((part) => !part || part === "." || part === "..")) {
      return undefined;
    }
    return normalized;
  };
  const stringList = (value: unknown, max: number): string[] | undefined =>
    Array.isArray(value) && value.length <= max &&
      value.every((item) => typeof item === "string" && item.trim())
      ? [...new Set(value.map((item) => String(item).trim()))]
      : undefined;
  const value = input as Record<string, any>;
  const stack = value.stack as Record<string, unknown> | undefined;
  const frameworks = stringList(stack?.frameworks, 30);
  const entryPoints = stringList(stack?.entryPoints, 50);
  if (!stack || !frameworks || !entryPoints || entryPoints.some((file) => !safePath(file))) {
    return undefined;
  }
  const anchors = (raw: unknown, max: number): SurveyAnchor[] | undefined => {
    if (!Array.isArray(raw) || raw.length > max) return undefined;
    const result: SurveyAnchor[] = [];
    for (const item of raw) {
      const row = item as Record<string, unknown>;
      const file = safePath(row?.file);
      const description = typeof row?.description === "string" ? row.description.trim() : "";
      if (!file || !description) return undefined;
      result.push({
        file,
        ...(typeof row.symbol === "string" && row.symbol.trim()
          ? { symbol: row.symbol.trim() }
          : {}),
        description,
      });
    }
    return result;
  };
  if (!Array.isArray(value.featureAreas) || value.featureAreas.length > 200) return undefined;
  const featureAreas: SurveyFeatureArea[] = [];
  for (const item of value.featureAreas) {
    const row = item as Record<string, unknown>;
    const root = safePath(row?.root);
    const files = stringList(row?.files, 200);
    if (typeof row?.name !== "string" || !row.name.trim() || !root || !files ||
      files.some((file) => !safePath(file))) return undefined;
    featureAreas.push({ name: row.name.trim(), root, files: files.map((file) => safePath(file)!) });
  }
  const identifyAnchors = anchors(value.identifyAnchors, 50);
  const logoutAnchors = anchors(value.logoutAnchors, 50);
  const existingAnalytics = anchors(value.existingAnalytics, 100);
  const baseCallSites = anchors(value.integratableCallSites, 500);
  if (!identifyAnchors || !logoutAnchors || !existingAnalytics || !baseCallSites ||
    !Array.isArray(value.integratableCallSites)) return undefined;
  const integratableCallSites: SurveyCallSite[] = [];
  for (let index = 0; index < baseCallSites.length; index += 1) {
    const row = value.integratableCallSites[index] as Record<string, unknown>;
    const outcome = typeof row.outcome === "string" ? row.outcome.trim() : "";
    const payloadFields = stringList(row.payloadFields, 50);
    const similarPaths = stringList(row.similarPaths, 50);
    if (!outcome || !payloadFields || !similarPaths ||
      similarPaths.some((file) => !safePath(file))) return undefined;
    integratableCallSites.push({
      ...baseCallSites[index]!,
      outcome,
      payloadFields,
      similarPaths: similarPaths.map((file) => safePath(file)!),
    });
  }
  return {
    stack: {
      frameworks,
      ...(typeof stack.packageManager === "string" && stack.packageManager.trim()
        ? { packageManager: stack.packageManager.trim() }
        : {}),
      entryPoints: entryPoints.map((file) => safePath(file)!),
    },
    featureAreas,
    identifyAnchors,
    logoutAnchors,
    existingAnalytics,
    integratableCallSites,
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
