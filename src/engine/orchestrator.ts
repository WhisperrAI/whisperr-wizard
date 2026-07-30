import { readFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";

import type { ReportEvent } from "../core/report.js";
import type { WizardConfig, WizardSession } from "../types.js";
import { eventWrapperName, generateBindings } from "./bindings.js";
import {
  clusterIdFor,
  deriveClusters,
} from "./clusters.js";
import {
  finalizeIntegration,
  repairIntegratedFile,
  repairVerification,
  reviewIntegratedFile,
  runClusterIntegration,
  runSdkSetupPass,
  structuralClusterCheck,
  writeBindingsModule,
  type IntegrationDeps,
} from "./integrate.js";
import type { ProgressSink } from "./output.js";
import {
  RunsApiError,
  RunsClient,
  artifactContentHash,
  type IntegrationEventEvidence,
  type IntegrationProgress,
  type RunBootstrap,
} from "./runs.js";
import {
  placementsFor,
  runSelection,
  runSurvey,
  type ProposedEvent,
  type RegisteredEvent,
  type SurveyArtifact,
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
  createWorktree,
  discardWorktreeChanges,
  removeWorktree,
  reversePatchInRepo,
  worktreePatch,
  type WorktreeHandle,
} from "./worktree.js";

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
      verificationStatus: "passed" | "failed" | "unavailable" | "pending";
      phaseTimings: Array<{ phase: string; ms: number }>;
      modelRoutes: Record<string, Record<string, unknown>>;
    };

interface OwnedPatch {
  patch: string;
  files: string[];
  eventCodes: string[];
  kind: "setup" | "cluster" | "semantic" | "verification";
  rolledBack?: boolean;
}

interface ClusterWorkerResult {
  cluster: Cluster;
  handle?: WorktreeHandle;
  integration?: Awaited<ReturnType<typeof runClusterIntegration>>;
  patch: string;
  error?: string;
}

export async function runEngine(input: EngineRunInput): Promise<EngineRunResult> {
  const runs = new RunsClient(input.config, input.session);
  const phaseTimings: Array<{ phase: string; ms: number }> = [];
  let activePhase: EnginePhase = "authorizing";
  let phaseStartedAt = Date.now();
  let timingsFinished = false;
  const finishTimings = () => {
    if (!timingsFinished) {
      phaseTimings.push({ phase: activePhase, ms: Date.now() - phaseStartedAt });
      timingsFinished = true;
    }
  };
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
    if (phase !== activePhase) {
      phaseTimings.push({ phase: activePhase, ms: Date.now() - phaseStartedAt });
      activePhase = phase;
      phaseStartedAt = Date.now();
    }
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

  let survey = artifactContent<SurveyArtifact>(bootstrap, "survey");
  let registered: RegisteredEvent[];
  let preparedSetup: { handle: WorktreeHandle; completed: boolean } | undefined;
  let surveySessionId: string | undefined =
    bootstrap.modelSessions.survey ?? bootstrap.run.modelConversationId;
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
      if (!survey) {
        await patchPhase("surveying");
        const surveyRun = await runSurvey(
          input.provider,
          input.models,
          input.repoPath,
          bootstrap,
          input.sink,
        );
        if (surveyRun.outcome.kind !== "completed" || !surveyRun.finished || !surveyRun.survey) {
          await failRun(`survey ${surveyRun.outcome.kind}`);
          return { kind: "aborted", reason: `survey ${surveyRun.outcome.kind}` };
        }
        survey = surveyRun.survey;
        surveySessionId = surveyRun.outcome.sessionId;
        const config = modelConfigForTask(input.models, "survey", "survey");
        await runs.persistSurveyArtifact(runId, survey, modelMetadata(config));
        if (surveySessionId) {
          await runs.saveModelSession(runId, "survey", "survey", surveySessionId);
        }
      } else {
        input.sink.emit({ phase: "surveying", action: "reusing the saved immutable survey" });
      }

      await patchPhase("designing");
      const recoverableCodes = new Set(missingPlacement.map((event) => event.code));
      const existingCodes = bootstrap.snapshot.events
        .filter((event) => !recoverableCodes.has(event.code))
        .map((event) => event.code);
      const designPromise = runSelection(
        input.provider,
        input.models,
        input.repoPath,
        bootstrap,
        survey,
        [],
        input.sink,
        existingCodes,
        [...recoverableCodes],
        surveySessionId,
      );
      const setupPromise = prepareSdkSetup(
        input,
        bootstrap,
        survey,
        bootstrap.run.integrationEvidence?.changedFiles ?? [],
      );
      const [selection, setup] = await Promise.all([designPromise, setupPromise]);
      preparedSetup = setup;
      if (!setup.completed) {
        throw new Error("Sol SDK setup did not complete deterministic validation");
      }
      if (!selection.finished) {
        const reason = selection.outcome === "completed"
          ? "design did not call finish_event_design"
          : `design ${selection.outcome}`;
        await failRun(reason);
        return { kind: "aborted", reason };
      }
      if (selection.proposed.length === 0) {
        await failRun("selection finished with no accepted events");
        return { kind: "aborted", reason: "selection finished with no accepted events" };
      }

      if (
        recoverableCodes.size > 0 &&
        (selection.proposed.length !== recoverableCodes.size ||
          selection.proposed.some((event) => !recoverableCodes.has(event.code)))
      ) {
        throw new Error("placement recovery must cover the frozen event set exactly");
      }

      await patchPhase("persisting", `registering ${selection.proposed.length} events`);
      const design = {
        surveyHash: artifactContentHash(survey),
        summary: selection.summary,
        events: [...selection.proposed].sort((a, b) => a.code.localeCompare(b.code)),
      };
      const config = modelConfigForTask(input.models, "design", "design");
      const committed = await runs.commitDesign(
        runId,
        design,
        design.events.map(eventRequest),
        modelMetadata(config),
      );
      registered = registeredFromSnapshot(
        committed.events.filter((event) => event.projectId === bootstrap.project.id),
      );
      input.sink.emit({
        phase: "persisting",
        action: `designed and registered ${selection.proposed.length} events`,
      });
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
    if (preparedSetup) await removeWorktree(preparedSetup.handle).catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    const stage = earlyPipelineFailureStage(activePhase);
    await failRun(`${stage} failed: ${reason}`);
    return { kind: "aborted", reason: `${stage} failed: ${reason}` };
  }

  if (registered.length === 0) {
    await failRun("no events registered for this project");
    return { kind: "aborted", reason: "no events registered for this project" };
  }

  const prior = bootstrap.run.integrationEvidence;
  const changedFiles = new Set(prior?.changedFiles ?? []);
  const eventStatuses = await reconcileProgress(input.repoPath, registered, prior, input.sink);
  const eventFailureReasons = new Map<string, string>();
  let verificationStatus: "pending" | "passed" | "failed" | "unavailable" = "pending";
  for (const event of registered) {
    const status = eventStatuses.get(event.code) ?? "planned";
    if (status !== "planned" && status !== "failed" && status !== "unsupported") {
      changedFiles.add(event.anchorFile);
    }
  }
  let identifyWired = prior?.identifyWired === true &&
    await setupLooksPresent(input.repoPath, changedFiles, survey);

  const progress = (): IntegrationProgress => ({
    changedFiles: [...changedFiles].sort(),
    identifyWired,
    verificationStatus,
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
  let worktree: WorktreeHandle | undefined = preparedSetup?.handle;
  const ownedPatches: OwnedPatch[] = [];
  if (!worktree) {
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
  }
  const setupWorktree = worktree;

  const checkpoint = async (
    handle: WorktreeHandle,
    kind: "setup" | "cluster" | "semantic" | "verification",
    eventCodes: string[] = [],
  ): Promise<string[]> => {
    const patch = await worktreePatch(handle);
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
    await applyPatchToRepo(handle, patch);
    ownedPatches.push({ patch, files, eventCodes, kind });
    return files;
  };

  try {
    const bindings = await writeBindingsModule(setupWorktree, input.target, registered);
    if (!identifyWired && !preparedSetup?.completed) {
      const validateSetup = async () => {
        if (
          await readFile(resolve(setupWorktree.path, bindings.relativePath), "utf8") !==
            bindings.content
        ) {
          return false;
        }
        const candidatePatch = await worktreePatch(setupWorktree);
        if (patchAddsProductEvents(candidatePatch, bindings.relativePath, registered)) {
          return false;
        }
        return setupLooksPresent(
          setupWorktree.path,
          new Set(patchFiles(candidatePatch)),
          survey,
        );
      };
      const setupCompleted = await runSdkSetupPass({
        provider: input.provider,
        models: input.models,
        worktree: setupWorktree,
        target: input.target,
        playbookSystemPrompt: input.playbookSystemPrompt,
        registered,
        ingestion: bootstrap.ingestion,
        survey,
        sink: input.sink,
        saveClusters: () => {},
        discardChanges: async () => discardWorktreeChanges(setupWorktree),
        onClusterIntegrated: async () => {},
      }, bindings, validateSetup);
      if (!setupCompleted) {
        throw new Error("SDK setup did not complete or failed deterministic validation");
      }
      const setupPatch = await worktreePatch(setupWorktree);
      const setupFiles = patchFiles(setupPatch);
      if (!await setupLooksPresent(setupWorktree.path, new Set(setupFiles), survey)) {
        throw new Error("SDK initialization, identify(), session restoration, or logout reset() could not be verified");
      }
      await checkpoint(setupWorktree, "setup");
      identifyWired = await setupLooksPresent(input.repoPath, changedFiles, survey);
      if (!identifyWired) {
        throw new Error("SDK initialization, bindings, identify(), and reset() could not be verified");
      }
      await saveProgress();
    } else {
      if (
        preparedSetup?.completed &&
        !await setupLooksPresent(
          setupWorktree.path,
          new Set(patchFiles(await worktreePatch(setupWorktree))),
          survey,
        )
      ) {
        throw new Error("prepared Sol SDK setup is missing initialization, identify(), binding, or reset()");
      }
      // The generated bindings may gain events after placement recovery.
      await checkpoint(setupWorktree, "setup");
      identifyWired = await setupLooksPresent(input.repoPath, changedFiles, survey);
      if (!identifyWired) {
        throw new Error("SDK initialization, bindings, identify(), and reset() could not be verified");
      }
      await saveProgress();
    }

    const pending = registered.filter((event) => {
      const status = eventStatuses.get(event.code) ?? "planned";
      return status === "planned" || status === "failed";
    });
    const clusters = deriveClusters(placementsFor(pending));
    await patchPhase("integrating");
    await removeWorktree(setupWorktree).catch(() => {});
    worktree = undefined;
    const queue = [...clusters];
    const active = new Map<number, Promise<ClusterWorkerResult>>();
    const lockedFiles = new Set<string>();
    let workerSequence = 0;
    while (queue.length > 0 || active.size > 0) {
      while (active.size < 1) {
        const nextIndex = queue.findIndex((cluster) => !lockedFiles.has(cluster.files[0]!));
        if (nextIndex < 0) break;
        const cluster = queue.splice(nextIndex, 1)[0]!;
        const file = cluster.files[0]!;
        lockedFiles.add(file);
        const id = workerSequence++;
        active.set(id, runClusterWorker(input, bootstrap, registered, survey, changedFiles, cluster));
      }
      if (active.size === 0) break;
      const { id, result: worker } = await Promise.race(
        [...active.entries()].map(async ([id, task]) => ({ id, result: await task })),
      );
      active.delete(id);
      lockedFiles.delete(worker.cluster.files[0]!);
      const returned = worker.integration?.clusters[0];
      let applied = false;
      let failure = worker.error ?? returned?.note ?? "cluster patch could not be merged";
      if (returned?.status === "verified" && worker.handle) {
        const files = patchFiles(worker.patch);
        const unexpected = files.filter((file) => !worker.cluster.files.includes(file));
        if (unexpected.length === 0) {
          try {
            for (const file of files) changedFiles.add(file);
            await saveProgress();
            await applyPatchToRepo(worker.handle, worker.patch);
            ownedPatches.push({
              patch: worker.patch,
              files,
              eventCodes: worker.cluster.events.map((event) => event.eventCode),
              kind: "cluster",
            });
            applied = true;
          } catch (error) {
            failure = `serial patch merge failed: ${error instanceof Error ? error.message : String(error)}`;
          }
        } else {
          failure = `cluster edited files outside its isolation boundary: ${unexpected.join(", ")}`;
        }
      }
      {
        for (const placement of worker.cluster.events) {
          const status: EventIntegrationStatus = applied ? "syntax_verified" : "failed";
          eventStatuses.set(placement.eventCode, status);
          if (!applied) eventFailureReasons.set(placement.eventCode, failure);
          await saveProgress();
          input.sink.emit({
            phase: "integrating",
            file: placement.file,
            action: applied
              ? `merged and saved ${placement.eventCode}`
              : `${placement.eventCode} needs manual attention`,
          });
        }
      }
      if (worker.handle) await removeWorktree(worker.handle).catch(() => {});
      await runs.savePlacementManifest(
        runId,
        await buildPlacementManifest(input.repoPath, registered, eventStatuses),
      );
    }
    await saveProgress();

    await patchPhase("reviewing");
    const reviewableByFile = groupEventsByFile(registered.filter(
      (event) => eventStatuses.get(event.code) === "syntax_verified",
    ));
    if (reviewableByFile.size > 0) {
      const reviewWorktree = await createWorktree(
        input.repoPath,
        input.force ?? false,
        [...changedFiles],
      );
      const reviewDeps = integrationDeps(
        input,
        bootstrap,
        registered,
        survey,
        reviewWorktree,
        [...changedFiles],
      );
      const reviews = await mapLimit(
        [...reviewableByFile.entries()],
        1,
        async ([file, events]) => ({
          file,
          events,
          review: await reviewIntegratedFile(reviewDeps, file, events),
        }),
      );
      await removeWorktree(reviewWorktree).catch(() => {});
      for (const reviewed of reviews) {
        if (reviewed.review.ok) {
          for (const event of reviewed.events) eventStatuses.set(event.code, "reviewed");
          await saveProgress();
          continue;
        }
        const repairWorktree = await createWorktree(
          input.repoPath,
          input.force ?? false,
          [...changedFiles],
        );
        const repairDeps = integrationDeps(
          input,
          bootstrap,
          registered,
          survey,
          repairWorktree,
          [...changedFiles],
        );
        const repaired = await repairIntegratedFile(
          repairDeps,
          reviewed.file,
          reviewed.events,
          reviewed.review,
        );
        const reviewCluster: Cluster = {
          id: clusterIdFor([reviewed.file], reviewed.events.map((event) => event.eventId)),
          files: [reviewed.file],
          events: placementsFor(reviewed.events),
          status: "verified",
          attempts: 1,
        };
        const structural = repaired
          ? await structuralClusterCheck(repairWorktree.path, reviewCluster)
          : { ok: false, notes: "Sol repair did not complete" };
        const recheck = structural.ok
          ? await reviewIntegratedFile(repairDeps, reviewed.file, reviewed.events, ":recheck")
          : { ok: false, issues: [], notes: structural.notes };
        const repairPatch = await worktreePatch(repairWorktree);
        const repairFiles = patchFiles(repairPatch);
        if (
          repaired && structural.ok && recheck.ok &&
          repairFiles.every((file) => file === reviewed.file)
        ) {
          for (const file of repairFiles) changedFiles.add(file);
          await saveProgress();
          await applyPatchToRepo(repairWorktree, repairPatch);
          ownedPatches.push({
            patch: repairPatch,
            files: repairFiles,
            eventCodes: reviewed.events.map((event) => event.code),
            kind: "semantic",
          });
          for (const event of reviewed.events) eventStatuses.set(event.code, "reviewed");
        } else {
          const reasons = reviewed.review.issues.map((issue) => issue.reason).join("; ") ||
            recheck.notes || structural.notes;
          await rollbackFileEventPatches(
            input.repoPath,
            reviewed.file,
            ownedPatches,
          );
          for (const event of reviewed.events) {
            eventStatuses.set(event.code, "failed");
            eventFailureReasons.set(event.code, reasons.slice(0, 500));
          }
        }
        await removeWorktree(repairWorktree).catch(() => {});
        await saveProgress();
        await runs.savePlacementManifest(
          runId,
          await buildPlacementManifest(input.repoPath, registered, eventStatuses),
        );
      }
    }

    await patchPhase("verifying");
    let verificationWorktree = await createWorktree(
      input.repoPath, input.force ?? false, [...changedFiles],
    );
    let verificationDeps = integrationDeps(
      input, bootstrap, registered, survey, verificationWorktree, [...changedFiles],
    );
    // Verification runs in the actual repository so its installed
    // dependencies and workspace caches remain available. Sol repairs stay
    // isolated and are merged serially before the next verification attempt.
    let finalVerify = await finalizeIntegration(verificationDeps, input.repoPath);
    for (let cycle = 0; finalVerify.status === "failed"; cycle += 1) {
      const repaired = await repairVerification(verificationDeps, finalVerify.results, cycle + 1);
      if (!repaired) break;
      const repairPatch = await worktreePatch(verificationWorktree);
      const repairFiles = patchFiles(repairPatch);
      const allowedRepairFiles = new Set(verificationDeps.allowedRepairFiles ?? []);
      const structural = await structuralRepairCheck(
        verificationWorktree.path,
        registered,
        repairFiles,
      );
      if (
        repairPatch.trim() === "" ||
        repairFiles.some((file) => !allowedRepairFiles.has(file)) ||
        !structural.ok
      ) {
        break;
      }
      for (const file of repairFiles) changedFiles.add(file);
      await saveProgress();
      await applyPatchToRepo(verificationWorktree, repairPatch);
      ownedPatches.push({
        patch: repairPatch,
        files: repairFiles,
        eventCodes: registered.map((event) => event.code),
        kind: "verification",
      });
      await removeWorktree(verificationWorktree).catch(() => {});
      finalVerify = await finalizeIntegration(verificationDeps, input.repoPath);
      if (finalVerify.status === "failed") {
        verificationWorktree = await createWorktree(
          input.repoPath, input.force ?? false, [...changedFiles],
        );
        verificationDeps = integrationDeps(
          input, bootstrap, registered, survey, verificationWorktree, [...changedFiles],
        );
      }
    }
    verificationStatus = finalVerify.status;
    if (finalVerify.status !== "passed") {
      await removeWorktree(verificationWorktree).catch(() => {});
      await rollbackOwnedPatches(input.repoPath, ownedPatches);
      changedFiles.clear();
      identifyWired = false;
      for (const event of registered) {
        eventStatuses.set(event.code, "failed");
        eventFailureReasons.set(
          event.code,
          `final verification ${finalVerify.status}${finalVerify.command ? `: ${finalVerify.command}` : ""}`,
        );
      }
      await saveProgress();
      throw new Error(`final verification ${finalVerify.status} after Sol repair`);
    }
    await removeWorktree(verificationWorktree).catch(() => {});
    identifyWired = await setupLooksPresent(input.repoPath, changedFiles, survey);
    if (!identifyWired) {
      await rollbackOwnedPatches(input.repoPath, ownedPatches);
      changedFiles.clear();
      for (const event of registered) {
        eventStatuses.set(event.code, "failed");
        eventFailureReasons.set(event.code, "SDK initialization or identify() is missing after final repair");
      }
      await saveProgress();
      throw new Error("SDK initialization, identify(), and logout reset() must be present before completion");
    }
    for (const event of registered) {
      if (eventStatuses.get(event.code) === "reviewed") {
        eventStatuses.set(event.code, "build_verified");
      }
    }
    await saveProgress();
    await runs.savePlacementManifest(
      runId,
      await buildPlacementManifest(input.repoPath, registered, eventStatuses),
    );
    const failures = registered.filter((event) => eventStatuses.get(event.code) !== "build_verified");
    if (failures.length > 0) {
      const reason = `${failures.length} event${failures.length === 1 ? "" : "s"} could not be verified`;
      await failRun(reason);
      finishTimings();
      return {
        kind: "partial",
        runId,
        registered,
        eventStatuses,
        reportEvents: buildReportEvents(registered, eventStatuses, eventFailureReasons),
        changedFiles: [...changedFiles].sort(),
        identifyWired,
        applied: changedFiles.size > 0,
        summary: summarize(registered, eventStatuses).join("\n"),
        verificationStatus,
        phaseTimings,
        modelRoutes: modelRoutes(input.models),
      };
    }
    await patchPhase("reporting");
    await runs.completeRun(runId, {
      changedFiles: [...changedFiles].sort(),
      identifyWired,
      verificationStatus: finalVerify.status,
      ...(finalVerify.command ? { verificationCommand: finalVerify.command } : {}),
      events: buildEvidence(registered, eventStatuses),
    });

    if (worktree) await removeWorktree(worktree).catch(() => {});
    const summaryLines = summarize(registered, eventStatuses);
    finishTimings();
    return {
      kind: "completed",
      runId,
      registered,
      eventStatuses,
      reportEvents: buildReportEvents(registered, eventStatuses, eventFailureReasons),
      changedFiles: [...changedFiles].sort(),
      identifyWired,
      applied: changedFiles.size > 0,
      summary: summaryLines.join("\n"),
      verificationStatus,
      phaseTimings,
      modelRoutes: modelRoutes(input.models),
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
    if (worktree) await removeWorktree(worktree).catch(() => {});
    finishTimings();
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
      verificationStatus,
      phaseTimings,
      modelRoutes: modelRoutes(input.models),
    };
  }
}

function earlyPipelineFailureStage(phase: EnginePhase): string {
  if (phase === "surveying") return "survey persistence";
  if (phase === "persisting") return "design persistence";
  return "design";
}

function artifactContent<T>(
  bootstrap: RunBootstrap,
  kind: "survey" | "event_design",
): T | undefined {
  return bootstrap.artifacts.find((artifact) => artifact.kind === kind)?.content as T | undefined;
}

function modelConfigForTask(
  models: EngineModelConfig,
  task: keyof Pick<EngineModelConfig, "survey" | "design" | "sdk_setup" | "cluster_edit" | "review" | "repair">,
  role: "survey" | "design" | "edit" | "review",
) {
  return models[task] ?? models[role];
}

function modelMetadata(config: ReturnType<typeof modelConfigForTask>) {
  return {
    model: config.model,
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.serviceTier ? { serviceTier: config.serviceTier } : {}),
    fastMode: config.fastMode === true,
  };
}

function eventRequest(event: ProposedEvent): Record<string, unknown> {
  return {
    code: event.code,
    name: event.name,
    reasoning: event.reasoning,
    anchorFile: event.anchorFile,
    ...(event.anchorSymbol ? { anchorSymbol: event.anchorSymbol } : {}),
    ...(Object.keys(event.payloadSchema).length > 0
      ? { payloadSchema: event.payloadSchema }
      : {}),
  };
}

async function prepareSdkSetup(
  input: EngineRunInput,
  bootstrap: RunBootstrap,
  survey: SurveyArtifact,
  allowedDirtyFiles: string[],
): Promise<{ handle: WorktreeHandle; completed: boolean }> {
  const handle = await createWorktree(
    input.repoPath,
    input.force ?? false,
    allowedDirtyFiles,
  );
  try {
    const bindings = await writeBindingsModule(handle, input.target, []);
    const deps: IntegrationDeps = {
      provider: input.provider,
      models: input.models,
      worktree: handle,
      target: input.target,
      playbookSystemPrompt: input.playbookSystemPrompt,
      registered: [],
      ingestion: bootstrap.ingestion,
      survey,
      allowedRepairFiles: [],
      sink: input.sink,
      saveClusters: () => {},
      discardChanges: async () => discardWorktreeChanges(handle),
      onClusterIntegrated: async () => {},
    };
    const completed = await runSdkSetupPass(deps, bindings, async () => {
      if (
        await readFile(resolve(handle.path, bindings.relativePath), "utf8") !==
          bindings.content
      ) {
        return false;
      }
      const patch = await worktreePatch(handle);
      return setupLooksPresent(handle.path, new Set(patchFiles(patch)), survey);
    });
    return { handle, completed };
  } catch (error) {
    await removeWorktree(handle).catch(() => {});
    throw error;
  }
}

async function runClusterWorker(
  input: EngineRunInput,
  bootstrap: RunBootstrap,
  registered: RegisteredEvent[],
  survey: SurveyArtifact | undefined,
  changedFiles: Set<string>,
  cluster: Cluster,
): Promise<ClusterWorkerResult> {
  let handle: WorktreeHandle | undefined;
  try {
    handle = await createWorktree(input.repoPath, input.force ?? false, [...changedFiles]);
    const deps = integrationDeps(input, bootstrap, registered, survey, handle, [...changedFiles]);
    const integration = await runClusterIntegration(
      deps,
      [cluster],
      async () => worktreePatch(handle!),
    );
    return {
      cluster,
      handle,
      integration,
      patch: await worktreePatch(handle),
    };
  } catch (error) {
    return {
      cluster,
      handle,
      patch: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function integrationDeps(
  input: EngineRunInput,
  bootstrap: RunBootstrap,
  registered: RegisteredEvent[],
  survey: SurveyArtifact | undefined,
  worktree: WorktreeHandle,
  allowedRepairFiles: string[],
): IntegrationDeps {
  return {
    provider: input.provider,
    models: input.models,
    worktree,
    target: input.target,
    playbookSystemPrompt: input.playbookSystemPrompt,
    registered,
    ingestion: bootstrap.ingestion,
    survey,
    allowedRepairFiles: allowedRepairFiles.filter(
      (file) => file !== generateBindings(input.target, registered).relativePath,
    ),
    sink: input.sink,
    saveClusters: () => {},
    discardChanges: async () => discardWorktreeChanges(worktree),
    onClusterIntegrated: async () => {},
  };
}

function groupEventsByFile(events: RegisteredEvent[]): Map<string, RegisteredEvent[]> {
  const grouped = new Map<string, RegisteredEvent[]>();
  for (const event of events) {
    const current = grouped.get(event.anchorFile) ?? [];
    current.push(event);
    grouped.set(event.anchorFile, current);
  }
  return grouped;
}

async function structuralRepairCheck(
  repoPath: string,
  events: RegisteredEvent[],
  files: string[],
): Promise<{ ok: boolean; notes: string }> {
  const repairedFiles = new Set(files);
  for (const [file, fileEvents] of groupEventsByFile(
    events.filter((event) => repairedFiles.has(event.anchorFile)),
  )) {
    const result = await structuralClusterCheck(repoPath, {
      id: clusterIdFor([file], fileEvents.map((event) => event.eventId)),
      files: [file],
      events: placementsFor(fileEvents),
      status: "verified",
      attempts: 1,
    });
    if (!result.ok) return result;
  }
  return { ok: true, notes: "" };
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await operation(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function rollbackFileEventPatches(
  repoPath: string,
  file: string,
  patches: OwnedPatch[],
): Promise<void> {
  for (let index = patches.length - 1; index >= 0; index -= 1) {
    const patch = patches[index]!;
    if (
      patch.rolledBack ||
      (patch.kind !== "cluster" && patch.kind !== "semantic") ||
      !patch.files.includes(file)
    ) {
      continue;
    }
    await reversePatchInRepo(repoPath, patch.patch);
    patch.rolledBack = true;
  }
}

async function rollbackOwnedPatches(repoPath: string, patches: OwnedPatch[]): Promise<void> {
  for (let index = patches.length - 1; index >= 0; index -= 1) {
    const patch = patches[index]!;
    if (patch.rolledBack) continue;
    await reversePatchInRepo(repoPath, patch.patch);
    patch.rolledBack = true;
  }
}

function modelRoutes(models: EngineModelConfig): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const task of ["survey", "design", "sdk_setup", "cluster_edit", "review", "repair"] as const) {
    const role = task === "survey" || task === "design"
      ? task
      : task === "review"
        ? "review"
        : "edit";
    const config = models[task] ?? models[role];
    result[task] = {
      model: config.model,
      ...(config.effort ? { effort: config.effort } : {}),
      serviceTier: config.fastMode ? "fast" : (config.serviceTier ?? "default"),
    };
  }
  return result;
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

async function buildPlacementManifest(
  repoPath: string,
  registered: RegisteredEvent[],
  statuses: Map<string, EventIntegrationStatus>,
) {
  const items = [];
  for (const event of registered) {
    const wrapper = eventWrapperName(event.code);
    let startLine: number | undefined;
    try {
      const content = await readFile(safeRepoPath(repoPath, event.anchorFile), "utf8");
      const index = content.indexOf(wrapper);
      if (index >= 0) {
        startLine = content.slice(0, index).split("\n").length;
      }
    } catch {
      // Missing files are represented without a line and remain actionable.
    }
    items.push({
      eventCode: event.code,
      file: event.anchorFile,
      ...(startLine ? { startLine, endLine: startLine } : {}),
      wrapper,
      payloadKeys: Object.keys(event.payloadSchema).sort(),
      status: statuses.get(event.code) ?? "planned",
    });
  }
  return items;
}

async function setupLooksPresent(
  repoPath: string,
  changedFiles: Set<string>,
  survey?: SurveyArtifact,
): Promise<boolean> {
  let bindingsFound = false;
  let bindingCallFound = false;
  let identifyFound = false;
  let resetFound = false;
  let sdkInitializationFound = false;
  const contents = new Map<string, string>();
  for (const file of changedFiles) {
    try {
      const content = await readFile(safeRepoPath(repoPath, file), "utf8");
      contents.set(file, content);
      const generated = content.includes("Generated by @whisperr/wizard");
      bindingsFound ||= generated;
      if (!generated) {
        bindingCallFound ||= content.includes("bindWhisperr(") ||
          content.includes("WhisperrEvents.bind(");
        identifyFound ||= /\bidentify\s*\(/.test(content);
        resetFound ||= /\breset\s*\(/.test(content);
        sdkInitializationFound ||= /whisperr/i.test(content) &&
          /(initiali[sz]e|configure|client|setup)/i.test(content);
      }
    } catch {
      // Missing progress files are handled as incomplete setup.
    }
  }
  const identifyAnchorsCovered = (survey?.identifyAnchors ?? []).every((anchor) =>
    /\bidentify\s*\(/.test(contents.get(anchor.file) ?? "")
  );
  const logoutAnchorsCovered = (survey?.logoutAnchors ?? []).every((anchor) =>
    /\breset\s*\(/.test(contents.get(anchor.file) ?? "")
  );
  return bindingsFound && bindingCallFound && identifyFound && resetFound &&
    sdkInitializationFound && identifyAnchorsCovered && logoutAnchorsCovered;
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

function patchAddsProductEvents(
  patch: string,
  bindingsFile: string,
  events: RegisteredEvent[],
): boolean {
  const wrappers = events.map((event) => eventWrapperName(event.code));
  let file = "";
  for (const line of patch.split("\n")) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header?.[1]) {
      file = header[1];
      continue;
    }
    if (
      file !== bindingsFile &&
      line.startsWith("+") &&
      !line.startsWith("+++") &&
      wrappers.some((wrapper) => line.includes(wrapper))
    ) {
      return true;
    }
  }
  return false;
}
