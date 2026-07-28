import { basename, join } from "node:path";

import type { ReportEvent } from "../core/report.js";
import type { WizardConfig, WizardSession } from "../types.js";
import { deriveClusters } from "./clusters.js";
import {
  finalizeIntegration,
  runClusterIntegration,
  runSdkSetupPass,
  writeBindingsModule,
  type IntegrationDeps,
} from "./integrate.js";
import type { ProgressSink } from "./output.js";
import { RunsApiError, RunsClient, type RunBootstrap } from "./runs.js";
import {
  placementsFor,
  registerApprovedEvents,
  runSelection,
  runSurvey,
  type ProposedEvent,
  type RegisteredEvent,
} from "./selection.js";
import { loadRunState, saveRunState } from "./state.js";
import type {
  Cluster,
  EngineModelConfig,
  EnginePhase,
  EngineProvider,
  EngineRunState,
  EventIntegrationStatus,
} from "./types.js";
import {
  applyPatchToRepo,
  createWorktree,
  removeWorktree,
  savePartialPatch,
  worktreePatch,
  type WorktreeHandle,
} from "./worktree.js";

export interface EngineCallbacks {
  reviewEvents: (proposed: ProposedEvent[]) => Promise<ProposedEvent[] | null>;
  confirmApply: (patch: string, summaryLines: string[]) => Promise<boolean>;
}

export interface EngineRunInput {
  repoPath: string;
  repoFingerprint: string;
  config: WizardConfig;
  session: WizardSession;
  provider: EngineProvider;
  models: EngineModelConfig;
  target: string;
  projectKind: "frontend" | "backend" | "fullstack";
  playbookSystemPrompt: string;
  sink: ProgressSink;
  callbacks: EngineCallbacks;
  force?: boolean;
}

export type EngineRunResult =
  | { kind: "wrong_mode" }
  | { kind: "aborted"; reason: string }
  | {
      kind: "completed" | "partial";
      runId: string;
      registered: RegisteredEvent[];
      eventStatuses: Map<string, EventIntegrationStatus>;
      reportEvents: ReportEvent[];
      changedFiles: string[];
      identifyWired: boolean;
      applied: boolean;
      partialPatchPath?: string;
      summary: string;
    };

export async function runEngine(input: EngineRunInput): Promise<EngineRunResult> {
  const runs = new RunsClient(input.config, input.session);

  let bootstrap: RunBootstrap;
  try {
    bootstrap = await runs.createOrResumeRun({
      repoFingerprint: input.repoFingerprint,
      displayName: basename(input.repoPath),
      target: input.target,
      kind: input.projectKind,
    });
  } catch (error) {
    if (error instanceof RunsApiError && error.code === "wrong_universe_mode") {
      return { kind: "wrong_mode" };
    }
    throw error;
  }

  const runId = bootstrap.run.id;
  input.provider.onRunReady?.(runId);
  const patchPhase = async (phase: EnginePhase, message?: string) => {
    try {
      await runs.patchRun(runId, { phase, ...(message ? { message } : {}) });
    } catch {
      /* heartbeat loss must never kill the run */
    }
  };
  const failRun = async (error: string) => {
    try {
      await runs.patchRun(runId, { status: "failed", error: error.slice(0, 500) });
    } catch {
      /* best effort */
    }
  };

  let state: EngineRunState;
  try {
    state =
      loadRunState(input.config.apiBaseUrl, input.session.appId, input.repoFingerprint) ??
      freshState(input, runId);
    if (state.runId !== runId) {
      state = freshState(input, runId);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failRun(`state initialization failed: ${reason}`);
    return { kind: "aborted", reason: `state initialization failed: ${reason}` };
  }
  const persist = () => saveRunState(state);

  let registered: RegisteredEvent[];
  if (!state.designComplete) {
    try {
      await patchPhase("surveying");
      const survey = await runSurvey(
        input.provider,
        input.models,
        input.repoPath,
        bootstrap,
        input.sink,
        state.providerSessions.survey,
      );
      if (survey.outcome.kind !== "completed") {
        await failRun(`survey ${survey.outcome.kind}`);
        return { kind: "aborted", reason: `survey ${survey.outcome.kind}` };
      }
      state.providerSessions.survey = survey.outcome.sessionId;
      persist();

      await patchPhase("designing");
      const selection = await runSelection(
        input.provider,
        input.models,
        input.repoPath,
        bootstrap,
        survey.report,
        state.tombstonedCodes,
        input.sink,
      );
      if (!selection.finished) {
        const reason =
          selection.outcome === "completed"
            ? "selection did not call finish_selection"
            : `selection ${selection.outcome}`;
        await failRun(reason);
        return { kind: "aborted", reason };
      }
      if (selection.proposed.length === 0) {
        await failRun("selection finished with no accepted events");
        return { kind: "aborted", reason: "selection finished with no accepted events" };
      }

      const approved = await input.callbacks.reviewEvents(selection.proposed);
      if (approved === null) {
        await failRun("selection rejected by user");
        return { kind: "aborted", reason: "selection rejected by user" };
      }
      if (approved.length === 0) {
        await failRun("no events accepted for instrumentation");
        return { kind: "aborted", reason: "no events accepted for instrumentation" };
      }
      const approvedCodes = new Set(approved.map((event) => event.code));
      for (const event of selection.proposed) {
        if (!approvedCodes.has(event.code) && !state.tombstonedCodes.includes(event.code)) {
          state.tombstonedCodes.push(event.code);
        }
      }
      persist();

      await patchPhase("persisting", `registering ${approved.length} events`);
      registered = await registerApprovedEvents(runs, runId, approved, input.sink);
      state.designComplete = true;
      state.clusters = deriveClusters(placementsFor(registered));
      persist();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await failRun(`design failed: ${reason}`);
      return { kind: "aborted", reason: `design failed: ${reason}` };
    }
  } else {
    registered = rebuildRegistered(state, bootstrap);
    input.sink.emit({ phase: "designing", action: `resumed with ${registered.length} registered events` });
  }

  if (registered.length === 0) {
    await failRun("no events registered for this project");
    return { kind: "aborted", reason: "no events registered for this project" };
  }

  await patchPhase("binding");
  let worktree: WorktreeHandle;
  try {
    worktree = await createWorktree(input.repoPath, input.force ?? false);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failRun(reason);
    return { kind: "aborted", reason };
  }
  state.worktreePath = worktree.path;
  persist();

  try {
    const bindings = await writeBindingsModule(worktree, input.target, registered);
    const deps: IntegrationDeps = {
      provider: input.provider,
      models: input.models,
      worktree,
      target: input.target,
      playbookSystemPrompt: input.playbookSystemPrompt,
      registered,
      ingestion: bootstrap.ingestion,
      sink: input.sink,
      saveClusters: (clusters: Cluster[]) => {
        state.clusters = clusters;
        persist();
      },
    };
    const identifyWired = await runSdkSetupPass(deps, bindings);

    await patchPhase("integrating");
    const integration = await runClusterIntegration(deps, state.clusters, async () =>
      worktreePatch(worktree),
    );
    state.clusters = integration.clusters;
    persist();

    const finalVerify = await finalizeIntegration(deps);
    const patch = await worktreePatch(worktree);
    const changedFiles = patchFiles(patch);

    await patchPhase("reporting");
    const evidence = buildEvidence(registered, integration.eventStatuses, changedFiles);
    await completeRun(
      runs,
      runId,
      evidence,
      integration.eventStatuses,
      changedFiles,
      identifyWired,
      finalVerify.status,
      finalVerify.command,
    );

    const summaryLines = summarize(registered, integration.eventStatuses);
    const applied =
      patch.trim() !== "" && (await input.callbacks.confirmApply(patch, summaryLines));
    if (applied) {
      await applyPatchToRepo(worktree, patch);
    }
    const partialPatchPath = applied
      ? undefined
      : await savePartialPatch(worktree, join(input.repoPath, ".whisperr-wizard.patch"));
    await removeWorktree(worktree);
    state.worktreePath = undefined;
    persist();

    const hasFailures = [...integration.eventStatuses.values()].some(
      (status) => status === "failed",
    );
    return {
      kind: hasFailures ? "partial" : "completed",
      runId,
      registered,
      eventStatuses: integration.eventStatuses,
      reportEvents: buildReportEvents(registered, integration.eventStatuses),
      changedFiles,
      identifyWired,
      applied,
      partialPatchPath: partialPatchPath ?? undefined,
      summary: summaryLines.join("\n"),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failRun(reason);
    const partialPatchPath = await savePartialPatch(
      worktree,
      join(input.repoPath, ".whisperr-wizard.patch"),
    ).catch(() => undefined);
    persist();
    return {
      kind: "partial",
      runId,
      registered,
      eventStatuses: new Map(),
      reportEvents: buildReportEvents(registered, new Map()),
      changedFiles: [],
      identifyWired: false,
      applied: false,
      partialPatchPath: partialPatchPath ?? undefined,
      summary: `Integration stopped early: ${reason}. Registered events are saved; rerun to resume.`,
    };
  }
}

function freshState(input: EngineRunInput, runId: string): EngineRunState {
  return {
    version: 1,
    apiBaseUrl: input.config.apiBaseUrl,
    appId: input.session.appId,
    repoFingerprint: input.repoFingerprint,
    runId,
    phase: "authorizing",
    providerSessions: {},
    designComplete: false,
    tombstonedCodes: [],
    clusters: [],
    updatedAt: new Date().toISOString(),
  };
}

function rebuildRegistered(state: EngineRunState, bootstrap: RunBootstrap): RegisteredEvent[] {
  const byCode = new Map(bootstrap.snapshot.events.map((event) => [event.code, event]));
  const registered: RegisteredEvent[] = [];
  for (const cluster of state.clusters) {
    for (const placement of cluster.events) {
      const event = byCode.get(placement.eventCode);
      if (!event) {
        continue;
      }
      registered.push({
        code: event.code,
        name: event.name,
        reasoning: event.reasoning,
        eventId: event.id,
        anchorFile: placement.file,
        anchorSymbol: placement.symbol,
        payloadSchema: event.payloadSchema ?? {},
      });
    }
  }
  return registered;
}

function buildEvidence(
  registered: RegisteredEvent[],
  statuses: Map<string, EventIntegrationStatus>,
  changedFiles: string[],
) {
  const changed = new Set(changedFiles);
  return registered.map((event) => {
    const status = statuses.get(event.code) ?? "planned";
    const needsFile = status !== "planned" && status !== "unsupported" && status !== "failed";
    const file = changed.has(event.anchorFile) ? event.anchorFile : changedFiles[0];
    return {
      eventId: event.eventId,
      eventCode: event.code,
      ...(needsFile && file ? { file } : {}),
      status,
    };
  });
}

async function completeRun(
  runs: RunsClient,
  runId: string,
  evidence: ReturnType<typeof buildEvidence>,
  _statuses: Map<string, EventIntegrationStatus>,
  changedFiles: string[],
  identifyWired: boolean,
  verificationStatus: string,
  verificationCommand: string | undefined,
): Promise<void> {
  await runs.completeRun(runId, {
    changedFiles,
    identifyWired,
    verificationStatus,
    ...(verificationCommand ? { verificationCommand } : {}),
    events: evidence,
  });
}

function buildReportEvents(
  registered: RegisteredEvent[],
  statuses: Map<string, EventIntegrationStatus>,
): ReportEvent[] {
  return registered.map((event) => {
    const status = statuses.get(event.code);
    const wired =
      status !== undefined && status !== "failed" && status !== "unsupported" && status !== "planned";
    return {
      event_type: event.code,
      status: wired ? "wired" : "skipped",
      ...(wired ? { file: event.anchorFile } : {}),
      ...(wired ? {} : { reason: status ?? "not integrated" }),
    };
  });
}

function summarize(
  registered: RegisteredEvent[],
  statuses: Map<string, EventIntegrationStatus>,
): string[] {
  return registered.map((event) => {
    const status = statuses.get(event.code) ?? "planned";
    return `${event.code}: ${status} (${event.anchorFile})`;
  });
}

function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/(.+?) b\//.exec(line);
    if (match?.[1]) {
      files.add(match[1]);
    }
  }
  return [...files];
}
