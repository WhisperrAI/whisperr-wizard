import { readFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

import type { ReportEvent } from "../core/report.js";
import type { WizardConfig, WizardSession } from "../types.js";
import { eventWrapperName } from "./bindings.js";
import {
  clustersComplete,
  deriveClusters,
  nextConcurrentClusters,
  transitionCluster,
} from "./clusters.js";
import {
  finalizeIntegration,
  repairVerification,
  runClusterIntegration,
  runSdkSetupPass,
  writeBindingsModule,
  type IntegrationDeps,
} from "./integrate.js";
import type { ProgressSink } from "./output.js";
import {
  RunsApiError,
  RunsClient,
  type IntegrationEventEvidence,
  type IntegrationProgress,
  type RunBootstrap,
} from "./runs.js";
import {
  placementsFor,
  registerApprovedEvents,
  runSelection,
  runSurvey,
  type ProposedEvent,
  type RegisteredEvent,
} from "./selection.js";
import type {
  Cluster,
  EngineModelConfig,
  EnginePhase,
  EngineProvider,
  EventIntegrationStatus,
} from "./types.js";
import {
  applyPatchToRepo,
  commitWorktreeCheckpoint,
  createWorktree,
  discardWorktreeChanges,
  removeWorktree,
  worktreePatch,
  WorktreeError,
  type WorktreeHandle,
} from "./worktree.js";

export interface EngineCallbacks {
  reviewEvents: (proposed: ProposedEvent[]) => Promise<ProposedEvent[] | null>;
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
  input.provider.onRunReady?.(runId, bootstrap.run.modelConversationId);
  const patchPhase = async (phase: EnginePhase, message?: string) => {
    try {
      await runs.patchRun(runId, { phase, ...(message ? { message } : {}) });
    } catch {
      // A stale heartbeat must not destroy repository work.
    }
  };
  const failRun = async (error: string) => {
    try {
      await runs.patchRun(runId, { status: "failed", error: error.slice(0, 500) });
    } catch {
      // Best effort: repository and per-event progress remain independently recoverable.
    }
  };

  let registered: RegisteredEvent[];
  try {
    const projectEvents = bootstrap.snapshot.events.filter(
      (event) => event.projectId === bootstrap.project.id,
    );
    const placed = registeredFromSnapshot(projectEvents);
    const missingPlacement = projectEvents.filter((event) => !event.anchorFile);

    if (placed.length === 0 || missingPlacement.length > 0) {
      input.sink.emit({
        phase: "surveying",
        action: projectEvents.length === 0
          ? "no saved progress found; starting a fresh survey"
          : "saved events need placement recovery; verifying the repository",
      });
      await patchPhase("surveying");
      const survey = await runSurvey(
        input.provider,
        input.models,
        input.repoPath,
        bootstrap,
        input.sink,
      );
      if (survey.outcome.kind !== "completed") {
        await failRun(`survey ${survey.outcome.kind}`);
        return { kind: "aborted", reason: `survey ${survey.outcome.kind}` };
      }

      await patchPhase("designing");
      const recoverableCodes = new Set(missingPlacement.map((event) => event.code));
      const existingCodes = bootstrap.snapshot.events
        .filter((event) => !recoverableCodes.has(event.code))
        .map((event) => event.code);
      const selection = await runSelection(
        input.provider,
        input.models,
        input.repoPath,
        bootstrap,
        survey.report,
        [],
        input.sink,
        existingCodes,
      );
      if (!selection.finished) {
        const reason = selection.outcome === "completed"
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

      await patchPhase("persisting", `registering ${approved.length} events`);
      const newlyRegistered = await registerApprovedEvents(runs, runId, approved, input.sink);
      registered = mergeRegistered(placed, newlyRegistered);
      const unresolved = projectEvents
        .filter((event) => !registered.some((candidate) => candidate.code === event.code))
        .map((event) => event.code);
      if (unresolved.length > 0) {
        throw new Error(`could not recover placements for: ${unresolved.join(", ")}`);
      }
    } else {
      registered = placed;
      input.sink.emit({
        phase: "integrating",
        action: `found ${registered.length} saved events; verifying current files`,
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failRun(`design failed: ${reason}`);
    return { kind: "aborted", reason: `design failed: ${reason}` };
  }

  if (registered.length === 0) {
    await failRun("no events registered for this project");
    return { kind: "aborted", reason: "no events registered for this project" };
  }

  const prior = bootstrap.run.integrationEvidence;
  const changedFiles = new Set(prior?.changedFiles ?? []);
  const eventStatuses = await reconcileProgress(input.repoPath, registered, prior, input.sink);
  const eventFailureReasons = new Map<string, string>();
  for (const event of registered) {
    const status = eventStatuses.get(event.code) ?? "planned";
    if (status !== "planned" && status !== "failed" && status !== "unsupported") {
      changedFiles.add(event.anchorFile);
    }
  }
  let identifyWired = prior?.identifyWired === true &&
    await setupLooksPresent(input.repoPath, changedFiles);

  const progress = (): IntegrationProgress => ({
    changedFiles: [...changedFiles].sort(),
    identifyWired,
    verificationStatus: "pending",
    events: buildEvidence(registered, eventStatuses),
  });
  const saveProgress = async () => {
    await runs.saveProgress(runId, progress());
  };
  try {
    await saveProgress();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failRun(`progress initialization failed: ${reason}`);
    return { kind: "aborted", reason: `progress initialization failed: ${reason}` };
  }

  await patchPhase("binding");
  let worktree: WorktreeHandle;
  try {
    worktree = await createWorktree(
      input.repoPath,
      input.force ?? false,
      [...changedFiles],
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await failRun(reason);
    return { kind: "aborted", reason };
  }

  const checkpoint = async (): Promise<string[]> => {
    const patch = await worktreePatch(worktree);
    if (patch.trim() === "") {
      return [];
    }
    const files = patchFiles(patch);
    for (const file of files) {
      changedFiles.add(file);
    }
    // Save the file allowlist before applying. If the process exits between the
    // next two calls, the next run can safely accept and verify those dirty files.
    await saveProgress();
    await applyPatchToRepo(worktree, patch);
    await commitWorktreeCheckpoint(worktree);
    return files;
  };

  try {
    const bindings = await writeBindingsModule(worktree, input.target, registered);
    if (!identifyWired) {
      const setupCompleted = await runSdkSetupPass({
        provider: input.provider,
        models: input.models,
        worktree,
        target: input.target,
        playbookSystemPrompt: input.playbookSystemPrompt,
        registered,
        ingestion: bootstrap.ingestion,
        sink: input.sink,
        saveClusters: () => {},
        discardChanges: async () => discardWorktreeChanges(worktree),
        onClusterIntegrated: async () => {},
      }, bindings);
      if (!setupCompleted) {
        throw new Error("SDK setup did not complete");
      }
      await checkpoint();
      identifyWired = await setupLooksPresent(input.repoPath, changedFiles);
      if (!identifyWired) {
        throw new Error("SDK initialization, bindings, or identify() could not be verified");
      }
      await saveProgress();
    } else {
      // The generated bindings may gain events after placement recovery.
      await checkpoint();
    }

    const pending = registered.filter((event) => {
      const status = eventStatuses.get(event.code) ?? "planned";
      return status === "planned" || status === "failed";
    });
    let clusters = deriveClusters(placementsFor(pending));
    await patchPhase("integrating");
    // The setup worktree has served its purpose. Every cluster gets a fresh,
    // isolated worktree seeded from the customer checkout and the saved
    // allowlist. Four model tasks run at once; their disjoint patches are then
    // applied serially so the checkout and server ledger advance together.
    await removeWorktree(worktree).catch(() => {});
    while (!clustersComplete(clusters)) {
      const wave = nextConcurrentClusters(clusters);
      if (wave.length === 0) {
        break;
      }
      const prepared: Array<{ cluster: Cluster; handle?: WorktreeHandle; error?: string }> = [];
      for (const cluster of wave) {
        try {
          prepared.push({
            cluster,
            handle: await createWorktree(input.repoPath, input.force ?? false, [...changedFiles]),
          });
        } catch (error) {
          prepared.push({
            cluster,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const completed = await Promise.all(prepared.map(async (worker) => {
        if (!worker.handle) {
          return { ...worker, integration: undefined, patch: "" };
        }
        const workerDeps: IntegrationDeps = {
          provider: input.provider,
          models: input.models,
          worktree: worker.handle,
          target: input.target,
          playbookSystemPrompt: input.playbookSystemPrompt,
          registered,
          ingestion: bootstrap.ingestion,
          sink: input.sink,
          saveClusters: () => {},
          discardChanges: async () => discardWorktreeChanges(worker.handle!),
          onClusterIntegrated: async () => {},
        };
        try {
          const integration = await runClusterIntegration(
            workerDeps,
            [worker.cluster],
            async () => worktreePatch(worker.handle!),
          );
          return {
            ...worker,
            integration,
            patch: await worktreePatch(worker.handle),
          };
        } catch (error) {
          return {
            ...worker,
            integration: undefined,
            patch: "",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }));

      for (const worker of completed) {
        const returned = worker.integration?.clusters[0];
        if (returned) {
          clusters = clusters.map((cluster) => cluster.id === returned.id ? returned : cluster);
        } else {
          clusters = transitionCluster(
            clusters,
            worker.cluster.id,
            "blocked",
            worker.error ?? "cluster worker failed",
          );
        }
        let applied = false;
        if (returned?.status === "reviewed") {
          const files = patchFiles(worker.patch);
          const unexpected = files.filter((file) => !worker.cluster.files.includes(file));
          if (unexpected.length > 0) {
            clusters = transitionCluster(
              clusters,
              worker.cluster.id,
              "blocked",
              `cluster edited files outside its isolation boundary: ${unexpected.join(", ")}`,
            );
          } else {
            try {
              for (const file of files) changedFiles.add(file);
              // Persist the dirty-file allowlist before the checkout mutation.
              await saveProgress();
              await applyPatchToRepo(worker.handle!, worker.patch);
              applied = true;
            } catch (error) {
              clusters = transitionCluster(
                clusters,
                worker.cluster.id,
                "blocked",
                `serial patch merge failed: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
        }
        for (const placement of worker.cluster.events) {
          const status = applied
            ? worker.integration?.eventStatuses.get(placement.eventCode) ?? "failed"
            : "failed";
          eventStatuses.set(placement.eventCode, status);
          if (status === "failed") {
            const current = clusters.find((candidate) => candidate.id === worker.cluster.id);
            eventFailureReasons.set(
              placement.eventCode,
              current?.note ?? worker.error ?? "cluster patch could not be merged",
            );
          }
          await saveProgress();
          input.sink.emit({
            phase: "integrating",
            file: placement.file,
            action: applied
              ? `merged and saved ${placement.eventCode}`
              : `${placement.eventCode} needs manual attention`,
          });
        }
        if (worker.handle) {
          await removeWorktree(worker.handle).catch(() => {});
        }
      }
    }
    await saveProgress();
    const unfinished = registered.filter((event) => {
      const status = eventStatuses.get(event.code) ?? "planned";
      return status === "planned" || status === "failed";
    });
    if (unfinished.length > 0) {
      throw new Error(
        `${unfinished.length} event${unfinished.length === 1 ? "" : "s"} still need integration`,
      );
    }

    await patchPhase("verifying");
    const verificationWorktree = await createWorktree(
      input.repoPath,
      input.force ?? false,
      [...changedFiles],
    );
    const verificationDeps: IntegrationDeps = {
      provider: input.provider,
      models: input.models,
      worktree: verificationWorktree,
      target: input.target,
      playbookSystemPrompt: input.playbookSystemPrompt,
      registered,
      ingestion: bootstrap.ingestion,
      sink: input.sink,
      saveClusters: () => {},
      discardChanges: async () => discardWorktreeChanges(verificationWorktree),
      onClusterIntegrated: async () => {},
    };
    let finalVerify = await finalizeIntegration(verificationDeps);
    if (finalVerify.status === "failed") {
      const repaired = await repairVerification(verificationDeps, finalVerify.results);
      if (repaired) {
        const repairPatch = await worktreePatch(verificationWorktree);
        const repairFiles = patchFiles(repairPatch);
        finalVerify = await finalizeIntegration(verificationDeps);
        if (finalVerify.status !== "failed") {
          for (const file of repairFiles) changedFiles.add(file);
          await saveProgress();
          await applyPatchToRepo(verificationWorktree, repairPatch);
        }
      }
    }
    await removeWorktree(verificationWorktree).catch(() => {});
    if (finalVerify.status === "failed") {
      for (const event of registered) {
        eventStatuses.set(event.code, "failed");
        eventFailureReasons.set(
          event.code,
          `final verification failed${finalVerify.command ? `: ${finalVerify.command}` : ""}`,
        );
      }
      await saveProgress();
      throw new Error("final verification still fails after Opus repair");
    }
    identifyWired = await setupLooksPresent(input.repoPath, changedFiles);
    if (!identifyWired) {
      for (const event of registered) {
        eventStatuses.set(event.code, "failed");
        eventFailureReasons.set(event.code, "SDK initialization or identify() is missing after final repair");
      }
      await saveProgress();
      throw new Error("SDK initialization and identify() must be present before completion");
    }
    await patchPhase("reporting");
    await runs.completeRun(runId, {
      changedFiles: [...changedFiles].sort(),
      identifyWired,
      verificationStatus: finalVerify.status,
      ...(finalVerify.command ? { verificationCommand: finalVerify.command } : {}),
      events: buildEvidence(registered, eventStatuses),
    });

    await removeWorktree(worktree).catch(() => {});
    const summaryLines = summarize(registered, eventStatuses);
    const hasFailures = [...eventStatuses.values()].some((status) => status === "failed");
    return {
      kind: hasFailures ? "partial" : "completed",
      runId,
      registered,
      eventStatuses,
      reportEvents: buildReportEvents(registered, eventStatuses, eventFailureReasons),
      changedFiles: [...changedFiles].sort(),
      identifyWired,
      applied: changedFiles.size > 0,
      summary: summaryLines.join("\n"),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const event of registered) {
      const status = eventStatuses.get(event.code) ?? "planned";
      if (status === "planned") {
        eventStatuses.set(event.code, "failed");
        eventFailureReasons.set(event.code, reason);
      }
    }
    await failRun(reason);
    await removeWorktree(worktree).catch(() => {});
    return {
      kind: "partial",
      runId,
      registered,
      eventStatuses,
      reportEvents: buildReportEvents(registered, eventStatuses, eventFailureReasons),
      changedFiles: [...changedFiles].sort(),
      identifyWired,
      applied: changedFiles.size > 0,
      summary: `Integration stopped early: ${reason}. Saved event progress will be verified on rerun.`,
    };
  }
}

function registeredFromSnapshot(events: RunBootstrap["snapshot"]["events"]): RegisteredEvent[] {
  return events
    .filter((event) => Boolean(event.anchorFile))
    .map((event) => ({
      code: event.code,
      name: event.name,
      reasoning: event.reasoning,
      eventId: event.id,
      anchorFile: event.anchorFile!.replaceAll("\\", "/"),
      ...(event.anchorSymbol ? { anchorSymbol: event.anchorSymbol } : {}),
      payloadSchema: event.payloadSchema ?? {},
    }));
}

function mergeRegistered(
  existing: RegisteredEvent[],
  added: RegisteredEvent[],
): RegisteredEvent[] {
  const merged = new Map(existing.map((event) => [event.code, event]));
  for (const event of added) {
    merged.set(event.code, event);
  }
  return [...merged.values()].sort((a, b) => a.code.localeCompare(b.code));
}

async function reconcileProgress(
  repoPath: string,
  registered: RegisteredEvent[],
  prior: IntegrationProgress | undefined,
  sink: ProgressSink,
): Promise<Map<string, EventIntegrationStatus>> {
  const priorById = new Map((prior?.events ?? []).map((event) => [event.eventId, event]));
  const statuses = new Map<string, EventIntegrationStatus>();
  for (const event of registered) {
    const saved = priorById.get(event.eventId);
    if (saved?.status === "unsupported") {
      statuses.set(event.code, "unsupported");
      continue;
    }
    const present = await fileContainsWrapper(repoPath, event.anchorFile, event.code);
    const savedIntegrated = saved && saved.status !== "planned" && saved.status !== "failed";
    const status = present ? (savedIntegrated ? saved.status : "applied") : "planned";
    statuses.set(event.code, status);
    if (saved && saved.status !== status) {
      sink.emit({
        phase: "verifying",
        file: event.anchorFile,
        action: present
          ? `recovered ${event.code} from the current code`
          : `${event.code} is missing and will be integrated again`,
      });
    }
  }
  return statuses;
}

async function fileContainsWrapper(
  repoPath: string,
  file: string,
  eventCode: string,
): Promise<boolean> {
  try {
    const path = safeRepoPath(repoPath, file);
    const content = await readFile(path, "utf8");
    return content.includes(eventWrapperName(eventCode));
  } catch {
    return false;
  }
}

async function setupLooksPresent(
  repoPath: string,
  changedFiles: Set<string>,
): Promise<boolean> {
  let bindingsFound = false;
  let bindingCallFound = false;
  let identifyFound = false;
  let sdkInitializationFound = false;
  for (const file of changedFiles) {
    try {
      const content = await readFile(safeRepoPath(repoPath, file), "utf8");
      const generated = content.includes("Generated by @whisperr/wizard");
      bindingsFound ||= generated;
      if (!generated) {
        bindingCallFound ||= content.includes("bindWhisperr(") ||
          content.includes("WhisperrEvents.bind(");
        identifyFound ||= /\bidentify\s*\(/.test(content);
        sdkInitializationFound ||= /whisperr/i.test(content) &&
          /(initiali[sz]e|configure|client|setup)/i.test(content);
      }
    } catch {
      // Missing progress files are handled as incomplete setup.
    }
  }
  return bindingsFound && bindingCallFound && identifyFound && sdkInitializationFound;
}

function safeRepoPath(repoPath: string, file: string): string {
  const root = resolve(repoPath);
  const path = resolve(root, file);
  if (path === root || !path.startsWith(root + sep)) {
    throw new Error(`unsafe progress file path: ${file}`);
  }
  return path;
}

function buildEvidence(
  registered: RegisteredEvent[],
  statuses: Map<string, EventIntegrationStatus>,
): IntegrationEventEvidence[] {
  return registered.map((event) => ({
    eventId: event.eventId,
    eventCode: event.code,
    file: event.anchorFile,
    status: statuses.get(event.code) ?? "planned",
  }));
}

function buildReportEvents(
  registered: RegisteredEvent[],
  statuses: Map<string, EventIntegrationStatus>,
  failureReasons: Map<string, string> = new Map(),
): ReportEvent[] {
  return registered.map((event) => {
    const status = statuses.get(event.code);
    const wired = status !== undefined &&
      status !== "failed" && status !== "unsupported" && status !== "planned";
    return {
      event_type: event.code,
      status: wired ? "wired" : "skipped",
      ...(wired ? { file: event.anchorFile } : {}),
      ...(wired ? {} : { reason: failureReasons.get(event.code) ?? status ?? "not integrated" }),
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
