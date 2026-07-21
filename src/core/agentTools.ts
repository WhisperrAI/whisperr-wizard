import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type { Playbook } from "../types.js";
import {
  changedFiles,
  hasWhisperrMethodCall,
  scanWiredEvents,
  type GitCheckpoint,
} from "./git.js";
import { runVerifyCommand, type VerifyResult } from "./postflight.js";
import { scrubError } from "./scrub.js";
import { isSecretPathLike } from "./toolPolicy.js";
import type {
  GeneratedEvent,
  WizardIntegrationEvidence,
  WizardItemInput,
  WizardRunPhase,
  WizardRunSnapshot,
  WizardRuntimeClient,
} from "./runtime.js";

const code = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, "must be lowercase snake_case");
const conciseText = z.string().trim().min(1).max(1000);
const progressPhase = z.enum([
  "authorizing",
  "analyzing",
  "designing",
  "persisting",
  "integrating",
  "verifying",
]);
const phaseOrder: WizardRunPhase[] = [
  "authorizing",
  "analyzing",
  "designing",
  "persisting",
  "integrating",
  "verifying",
  "completed",
];

export interface AgentToolState {
  runtime: WizardRuntimeClient;
  runId: string;
  repoPath: string;
  checkpoint: GitCheckpoint;
  playbook: Playbook;
  ingestionKey: string;
  completed: boolean;
  latestSnapshot: WizardRunSnapshot;
  verification?: VerifyResult;
  wiredEvents: Array<{ id: string; code: string; status: "wired" | "skipped"; file?: string }>;
  inspectIntegration?: (
    snapshot: WizardRunSnapshot,
  ) => Promise<{
    files: string[];
    identifyWired: boolean;
    wiredEvents: AgentToolState["wiredEvents"];
  }>;
  onPhase?: (phase: string) => void | Promise<void>;
  onActivity?: (message: string) => void | Promise<void>;
}

export function createRuntimeTools(state: AgentToolState): Tool[] {
  const createGroup = tool({
    name: "create_intervention_group",
    description:
      "Immediately persist one evidence-backed intervention group. Reusing the idempotency key safely returns the canonical row.",
    parameters: z.object({
      code,
      name: conciseText,
      reasoning: conciseText,
    }),
    execute: (input) => {
      const payload = { code: input.code, name: input.name, reasoning: input.reasoning };
      return createItem(state, {
        kind: "group",
        idempotencyKey: payloadIdempotencyKey("group", [input.code], payload),
        payload,
      });
    },
  });
  const createIntervention = tool({
    name: "create_intervention",
    description:
      "Immediately persist one distinct action under an existing group code.",
    parameters: z.object({
      groupCode: code,
      code,
      name: conciseText,
      reasoning: conciseText,
      enabled: z.boolean(),
    }),
    execute: (input) => {
      const payload = {
        groupCode: input.groupCode,
        code: input.code,
        name: input.name,
        reasoning: input.reasoning,
        enabled: input.enabled,
      };
      return createItem(state, {
        kind: "intervention",
        idempotencyKey: payloadIdempotencyKey("intervention", [input.code], payload),
        payload,
      });
    },
  });
  const createEvent = tool({
    name: "create_event",
    description:
      "Immediately persist one concrete event owned by this project. A real call site or authoritative occurrence is required.",
    parameters: z.object({
      code,
      name: conciseText,
      reasoning: conciseText,
    }),
    execute: (input) => {
      const payload = { code: input.code, name: input.name, reasoning: input.reasoning };
      return createItem(state, {
        kind: "event",
        idempotencyKey: payloadIdempotencyKey("event", [input.code], payload),
        payload,
      });
    },
  });
  const createLink = tool({
    name: "create_link",
    description:
      "Immediately persist one direct causal link between an existing event and intervention.",
    parameters: z.object({
      interventionCode: code,
      eventCode: code,
      reasoning: conciseText,
    }),
    execute: (input) => {
      const payload = {
        interventionCode: input.interventionCode,
        eventCode: input.eventCode,
        reasoning: input.reasoning,
      };
      return createItem(state, {
        kind: "link",
        idempotencyKey: payloadIdempotencyKey(
          "link",
          [input.eventCode, input.interventionCode],
          payload,
        ),
        payload,
      });
    },
  });
  const updateProgress = tool({
    name: "update_progress",
    description:
      "Record a concise phase and activity message for the customer-facing live run view.",
    parameters: z.object({
      phase: progressPhase,
      activity: z.string().trim().min(1).max(300),
    }),
    async execute({ phase, activity }) {
      const effectivePhase = monotonicPhase(state.latestSnapshot.run.phase, phase);
      const run = await state.runtime.updateRun(state.runId, {
        status: "running",
        phase: effectivePhase,
        message: activity,
      });
      state.latestSnapshot = { ...state.latestSnapshot, run };
      await state.onPhase?.(effectivePhase);
      await state.onActivity?.(activity);
      return { ok: true, phase: effectivePhase };
    },
  });
  const completeRun = tool({
    name: "complete_run",
    description:
      "Run host-owned deterministic verification and complete the runtime run. If verification fails, repair the reported errors before retrying.",
    parameters: z.object({ summary: z.string().trim().min(1).max(1000) }),
    async execute({ summary }) {
      if (state.completed) {
        return { ok: true, alreadyComplete: true, summary };
      }
      await state.onPhase?.("verifying");
      const run = await state.runtime.updateRun(state.runId, {
        status: "running",
        phase: "verifying",
        message: "Running deterministic project verification",
      });
      state.latestSnapshot = { ...state.latestSnapshot, run };
      state.verification = await runVerifyCommand(
        state.repoPath,
        state.playbook.verifyCommand,
      );
      const inspection = await inspectCurrentIntegration(state);
      await persistIntegrationEvidence(
        state,
        inspection,
        verificationEvidenceLabel(state.verification),
      );
      if (
        state.verification.ran &&
        !state.verification.ok &&
        !state.verification.toolMissing &&
        !state.verification.timedOut
      ) {
        await state.onActivity?.("Verification failed; returning errors for repair");
        return {
          ok: false,
          error: "Deterministic verification failed. Repair these errors and call complete_run again.",
          command: state.verification.command,
          output: scrubError(state.verification.output, [state.ingestionKey]),
        };
      }

      if (!inspection.identifyWired) {
        await state.onActivity?.("The stable end-user identity still needs a Whisperr call site");
        return {
          ok: false,
          error: "Wire Whisperr identify at a concrete user lifecycle call site before completing the run.",
        };
      }

      const missingEvents = state.wiredEvents.filter((event) => event.status !== "wired");
      if (missingEvents.length) {
        await state.onActivity?.("Generated events still need concrete repository call sites");
        return {
          ok: false,
          error: "Wire every generated event in the repository before calling complete_run again.",
          events: missingEvents.map((event) => event.code),
        };
      }
      const verificationStatus = verificationLabel(state.verification);
      state.latestSnapshot = await state.runtime.completeRun(state.runId, {
        changedFiles: inspection.files,
        identifyWired: inspection.identifyWired,
        verificationStatus,
        ...(state.verification.command
          ? { verificationCommand: state.verification.command }
          : {}),
        events: state.wiredEvents.map((event) => ({
          eventId: event.id,
          eventCode: event.code,
          file: event.file!,
        })),
      });
      state.completed = true;
      await state.onPhase?.("completed");
      await state.onActivity?.("Runtime model and repository integration completed");
      return {
        ok: true,
        summary,
        changedFiles: inspection.files,
        verification: verificationLabel(state.verification),
        events: state.wiredEvents,
      };
    },
  });
  return [
    createGroup,
    createIntervention,
    createEvent,
    createLink,
    updateProgress,
    completeRun,
  ];
}

export async function persistCurrentIntegrationEvidence(
  state: AgentToolState,
  verificationStatus: WizardIntegrationEvidence["verificationStatus"] = "pending",
): Promise<void> {
  const inspection = await inspectCurrentIntegration(state);
  await persistIntegrationEvidence(state, inspection, verificationStatus);
}

async function inspectCurrentIntegration(state: AgentToolState) {
  const snapshot = await state.runtime.getRun(state.runId);
  state.latestSnapshot = snapshot;
  const currentFiles = await changedFiles(state.repoPath, state.checkpoint);
  if (currentFiles.some((file) => isSecretPathLike(file))) {
    throw new Error(
      "blocked: a local credential file is visible to Git; restore its ignore rule before continuing",
    );
  }
  const files = [
    ...new Set([
      ...(state.latestSnapshot.run.integrationEvidence?.changedFiles ?? []),
      ...currentFiles,
    ]),
  ];
  const inspection = state.inspectIntegration
    ? await state.inspectIntegration(snapshot)
    : {
        files,
        identifyWired: await hasIdentifyCall(state.repoPath, files),
        wiredEvents: await eventCoverage(
          state.repoPath,
          files,
          snapshot.model.events.filter((event) => event.projectId === snapshot.project.id),
        ),
      };
  state.wiredEvents = inspection.wiredEvents;
  return inspection;
}

async function persistIntegrationEvidence(
  state: AgentToolState,
  inspection: Awaited<ReturnType<typeof inspectCurrentIntegration>>,
  verificationStatus: WizardIntegrationEvidence["verificationStatus"],
): Promise<void> {
  const integrationEvidence: WizardIntegrationEvidence = {
    changedFiles: inspection.files,
    identifyWired: inspection.identifyWired,
    verificationStatus,
    ...(state.verification?.command
      ? { verificationCommand: state.verification.command }
      : {}),
    events: inspection.wiredEvents.flatMap((event) =>
      event.status === "wired" && event.file
        ? [{ eventId: event.id, eventCode: event.code, file: event.file }]
        : [],
    ),
  };
  const run = await state.runtime.updateRun(state.runId, { integrationEvidence });
  state.latestSnapshot = { ...state.latestSnapshot, run };
}

async function createItem(state: AgentToolState, input: WizardItemInput) {
  const result = await state.runtime.createItem(state.runId, input);
  await state.onActivity?.(
    `Persisted ${input.kind.replaceAll("_", " ")} ${itemCode(input)}`,
  );
  return {
    ok: true,
    created: result.created,
    kind: result.kind,
    idempotencyKey: result.idempotencyKey,
    item: result.item,
  };
}

function monotonicPhase(
  current: WizardRunPhase,
  requested: Exclude<WizardRunPhase, "completed">,
): Exclude<WizardRunPhase, "completed"> {
  if (current === "completed") throw new Error("The runtime run is already completed.");
  return phaseOrder.indexOf(requested) < phaseOrder.indexOf(current)
    ? current
    : requested;
}

function itemCode(input: WizardItemInput): string {
  return input.kind === "link"
    ? `${input.payload.eventCode}->${input.payload.interventionCode}`
    : input.payload.code;
}

export function stableIdempotencyKey(kind: string, ...codes: string[]): string {
  return [kind, ...codes].join(":");
}

function payloadIdempotencyKey(
  kind: string,
  codes: string[],
  payload: Record<string, unknown>,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
  return stableIdempotencyKey(kind, ...codes, hash);
}

async function eventCoverage(
  repoPath: string,
  files: string[],
  events: GeneratedEvent[],
): Promise<AgentToolState["wiredEvents"]> {
  const wired = await scanWiredEvents(
    repoPath,
    files,
    events.map((event) => event.code),
  );
  return events.map((event) => ({
    id: event.id,
    code: event.code,
    status: wired.has(event.code) ? "wired" : "skipped",
    ...(wired.get(event.code) ? { file: wired.get(event.code) } : {}),
  }));
}

function verificationLabel(result: VerifyResult): "passed" | "unavailable" {
  return !result.ran || result.toolMissing || result.timedOut ? "unavailable" : "passed";
}

function verificationEvidenceLabel(
  result: VerifyResult,
): WizardIntegrationEvidence["verificationStatus"] {
  if (!result.ran || result.toolMissing || result.timedOut) return "unavailable";
  return result.ok ? "passed" : "failed";
}

async function hasIdentifyCall(repoPath: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    try {
      if (hasWhisperrMethodCall(await readFile(join(repoPath, file), "utf8"), "identify")) {
        return true;
      }
    } catch {
      // Ignore binary, deleted, or concurrently changed files.
    }
  }
  return false;
}
