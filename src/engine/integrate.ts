import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { eventWrapperName, generateBindings, type GeneratedBindings } from "./bindings.js";
import { MAX_CLUSTER_ATTEMPTS, classifyFailure, nextClusterStatusAfterFailure } from "./budgets.js";
import { clustersComplete, nextPendingCluster, transitionCluster } from "./clusters.js";
import type { ProgressSink } from "./output.js";
import type { RegisteredEvent } from "./selection.js";
import type {
  Cluster,
  EngineModelConfig,
  EngineProvider,
  EventIntegrationStatus,
  RoleInvocation,
} from "./types.js";
import { modelConfigFor } from "./types.js";
import {
  resolveVerifySteps,
  runVerificationStatus,
  runVerifySteps,
  verificationCommand,
  verifiedStatus,
  type VerifyStepResult,
} from "./verify.js";
import type { WorktreeHandle } from "./worktree.js";

export interface IntegrationDeps {
  provider: EngineProvider;
  models: EngineModelConfig;
  worktree: WorktreeHandle;
  target: string;
  playbookSystemPrompt: string;
  registered: RegisteredEvent[];
  ingestion: { apiKey: string; baseUrl: string };
  sink: ProgressSink;
  saveClusters: (clusters: Cluster[]) => void;
  discardChanges: () => Promise<void>;
  onClusterIntegrated: (
    cluster: Cluster,
    status: EventIntegrationStatus,
  ) => Promise<void>;
}

export interface IntegrationResult {
  clusters: Cluster[];
  eventStatuses: Map<string, EventIntegrationStatus>;
  finalVerify: VerifyStepResult[];
  runVerification: "pending" | "passed" | "failed" | "unavailable";
  verificationCommand?: string;
  bindings: GeneratedBindings;
  identifyWired: boolean;
}

const REVIEW_CHECKLIST = [
  "- Events must fire after the confirmed outcome (post-await/success), never on intent or button tap.",
  "- View-appearance events must be deduplicated against re-renders and navigation returns.",
  "- Debounced flows must emit after the debounce commits, not per keystroke/tap.",
  "- Denied/failed permission or authorization results must not be recorded as granted.",
  "- Never persist a sent/once marker before the track call actually executed.",
  "- Payloads must use only the generated wrapper fields — no extra fields, no personal identifiers.",
].join("\n");

export async function writeBindingsModule(
  worktree: WorktreeHandle,
  target: string,
  registered: RegisteredEvent[],
): Promise<GeneratedBindings> {
  const bindings = generateBindings(target, registered);
  await writeFile(join(worktree.path, bindings.relativePath), bindings.content);
  return bindings;
}

export async function runSdkSetupPass(deps: IntegrationDeps, bindings: GeneratedBindings): Promise<boolean> {
  deps.sink.emit({ phase: "binding", action: "installing SDK and wiring identify()" });
  const outcome = await deps.provider.invoke(
    {
      role: "edit",
      task: "sdk_setup",
      sessionKey: "sdk_setup",
      systemPrompt: deps.playbookSystemPrompt,
      userPrompt: [
        "CORE SETUP for the Whisperr SDK in this repository. Do exactly this, then stop:",
        "1. Add and install the Whisperr SDK dependency for this stack.",
        `2. Initialize it once at app startup with API key ${deps.ingestion.apiKey} and base URL ${deps.ingestion.baseUrl}.`,
        `3. The generated bindings module at ${bindings.relativePath} queues events until bound.`,
        `   ${bindings.bindInstruction}`,
        "   You may move the generated file to the idiomatic source directory (fix imports), but never edit its generated content.",
        "4. Wire identify() for the END USER (paying customer) at login success and session restore; reset() on logout.",
        "   Never instrument admin/staff/operator paths.",
        "Do not instrument product events yet. Do not run builds.",
      ].join("\n"),
      tools: [],
      allowRepoWrite: true,
      cwd: deps.worktree.path,
    },
    modelConfigFor(deps.models, "sdk_setup", "edit"),
    (action) => deps.sink.emit({ phase: "binding", action }),
  );
  return outcome.kind === "completed";
}

function clusterPrompt(
  cluster: Cluster,
  registered: RegisteredEvent[],
  bindings: GeneratedBindings,
): string {
  const byCode = new Map(registered.map((event) => [event.code, event]));
  const briefs = cluster.events.map((placement) => {
    const event = byCode.get(placement.eventCode);
    const fields = Object.keys(event?.payloadSchema ?? {});
    return [
      `- ${placement.eventCode}: call the generated wrapper from ${bindings.relativePath}`,
      `  anchor: ${placement.file}${placement.symbol ? ` (${placement.symbol})` : ""}`,
      `  why: ${event?.reasoning ?? ""}`,
      fields.length > 0 ? `  payload fields: ${fields.join(", ")}` : "  payload: none",
    ].join("\n");
  });
  return [
    "Instrument EXACTLY these events by calling their generated wrapper functions at the anchors.",
    "Use only the generated wrappers — never call the SDK's raw track() and never invent event names.",
    "",
    "Placement rules:",
    REVIEW_CHECKLIST,
    "",
    "Events for this cluster:",
    ...briefs,
    "",
    "Only edit the listed files (plus imports of the bindings module). Then stop.",
  ].join("\n");
}

async function reviewCluster(
  deps: IntegrationDeps,
  cluster: Cluster,
  diff: string,
): Promise<{ ok: boolean; notes: string }> {
  const outcome = await deps.provider.invoke(
    {
      role: "review",
      task: "review",
      sessionKey: `review:${cluster.id}`,
      systemPrompt: [
        "You review an instrumentation diff against a strict checklist. Answer with a verdict line",
        "`VERDICT: pass` or `VERDICT: fail`, then bullet notes for anything wrong.",
      ].join("\n"),
      userPrompt: [
        "Checklist:",
        REVIEW_CHECKLIST,
        "",
        `Events expected: ${cluster.events.map((event) => event.eventCode).join(", ")}`,
        "",
        "Diff:",
        diff.length > 60_000 ? diff.slice(0, 60_000) + "\n…(truncated)" : diff,
      ].join("\n"),
      tools: [],
      allowRepoWrite: false,
      cwd: deps.worktree.path,
    },
    modelConfigFor(deps.models, "review", "review"),
    (action) => deps.sink.emit({ phase: "reviewing", action }),
  );
  if (outcome.kind !== "completed") {
    return { ok: false, notes: `review pass did not complete (${outcome.kind})` };
  }
  const ok = /verdict:\s*pass/i.test(outcome.text);
  return { ok, notes: outcome.text.trim() };
}

export async function runClusterIntegration(
  deps: IntegrationDeps,
  initialClusters: Cluster[],
  clusterDiff: (files: string[]) => Promise<string>,
): Promise<{ clusters: Cluster[]; eventStatuses: Map<string, EventIntegrationStatus> }> {
  let clusters = initialClusters;
  const eventStatuses = new Map<string, EventIntegrationStatus>();
  const bindings = generateBindings(deps.target, deps.registered);
  const total = clusters.length;

  for (;;) {
    const cluster = nextPendingCluster(clusters);
    if (!cluster) {
      break;
    }
    const index = clusters.findIndex((candidate) => candidate.id === cluster.id) + 1;
    clusters = transitionCluster(clusters, cluster.id, "editing");
    deps.saveClusters(clusters);
    deps.sink.emit({
      phase: "integrating",
      cluster: { index, total },
      file: cluster.files[0],
      action: "placing events",
    });

    const invocation: RoleInvocation = {
        role: "edit",
        task: "cluster_edit",
        sessionKey: cluster.id,
        systemPrompt: deps.playbookSystemPrompt,
        userPrompt: clusterPrompt(cluster, deps.registered, bindings),
        tools: [],
        allowRepoWrite: true,
        cwd: deps.worktree.path,
      };
    let edit = await deps.provider.invoke(
      invocation,
      modelConfigFor(deps.models, "cluster_edit", "edit"),
      (action) =>
        deps.sink.emit({ phase: "integrating", cluster: { index, total }, action }),
    );

    let escalated = false;
    let structural = edit.kind === "completed"
      ? await structuralClusterCheck(deps.worktree.path, cluster)
      : { ok: false, notes: `edit ${edit.kind}` };
    if ((!structural.ok || edit.kind !== "completed") && deps.provider.invokeFallback) {
      await deps.discardChanges();
      escalated = true;
      deps.sink.emit({
        phase: "integrating",
        cluster: { index, total },
        action: "Terra attempt rolled back; retrying with Opus",
      });
      edit = await deps.provider.invokeFallback(
        { ...invocation, task: "repair", sessionKey: `escalation:${cluster.id}` },
        modelConfigFor(deps.models, "sdk_setup", "edit"),
        (action) =>
          deps.sink.emit({ phase: "integrating", cluster: { index, total }, action }),
      );
      structural = edit.kind === "completed"
        ? await structuralClusterCheck(deps.worktree.path, cluster)
        : { ok: false, notes: `Opus escalation ${edit.kind}` };
    }

    if (edit.kind !== "completed" || !structural.ok) {
      const failure =
        edit.kind === "context_overflow"
          ? "context_overflow"
          : edit.kind === "budget_exhausted"
            ? "context_overflow"
            : classifyFailure(edit.kind === "failed" ? edit.error : "");
      const nextStatus = nextClusterStatusAfterFailure(failure, cluster.attempts);
      clusters = transitionCluster(
        clusters,
        cluster.id,
        nextStatus,
        structural.notes || `edit ${edit.kind}`,
      );
      deps.saveClusters(clusters);
      for (const placement of cluster.events) {
        eventStatuses.set(placement.eventCode, "failed");
      }
      await deps.discardChanges();
      continue;
    }

    clusters = transitionCluster(clusters, cluster.id, "verified");
    deps.saveClusters(clusters);

    const diff = await clusterDiff(cluster.files);
    let review = await reviewCluster(deps, cluster, diff);
    if (!review.ok && !escalated && deps.provider.invokeFallback) {
      await deps.discardChanges();
      deps.sink.emit({
        phase: "reviewing",
        cluster: { index, total },
        action: "Terra diff rejected; retrying the clean cluster with Opus",
      });
      edit = await deps.provider.invokeFallback(
        { ...invocation, task: "repair", sessionKey: `review-retry:${cluster.id}` },
        modelConfigFor(deps.models, "sdk_setup", "edit"),
        (action) => deps.sink.emit({ phase: "integrating", cluster: { index, total }, action }),
      );
      structural = edit.kind === "completed"
        ? await structuralClusterCheck(deps.worktree.path, cluster)
        : { ok: false, notes: `Opus review retry ${edit.kind}` };
      if (edit.kind === "completed" && structural.ok) {
        review = await reviewCluster(deps, cluster, await clusterDiff(cluster.files));
      }
    }
    if (!structural.ok || !review.ok) {
      clusters = transitionCluster(
        clusters,
        cluster.id,
        "blocked",
        (!structural.ok ? structural.notes : review.notes).slice(0, 500),
      );
      for (const placement of cluster.events) {
        eventStatuses.set(placement.eventCode, "failed");
      }
      await deps.discardChanges();
      continue;
    }
    const statuses: EventIntegrationStatus = "reviewed";
    const finalStatus: EventIntegrationStatus = review.ok
      ? statuses
      : statuses;
    clusters = transitionCluster(clusters, cluster.id, "reviewed", review.ok ? undefined : review.notes.slice(0, 500));
    deps.saveClusters(clusters);
    for (const placement of cluster.events) {
      eventStatuses.set(placement.eventCode, finalStatus);
    }
    await deps.onClusterIntegrated(cluster, finalStatus);
  }

  if (!clustersComplete(clusters)) {
    throw new Error("cluster queue did not reach a terminal state");
  }
  return { clusters, eventStatuses };
}

export async function structuralClusterCheck(
  repoPath: string,
  cluster: Cluster,
): Promise<{ ok: boolean; notes: string }> {
  const allowed = new Set(cluster.files);
  const missing: string[] = [];
  for (const placement of cluster.events) {
    if (!allowed.has(placement.file)) {
      missing.push(`${placement.eventCode}: placement escaped cluster`);
      continue;
    }
    try {
      const root = resolve(repoPath);
      const path = resolve(root, placement.file);
      if (!path.startsWith(root + sep)) {
        missing.push(`${placement.eventCode}: unsafe file`);
        continue;
      }
      const content = await readFile(path, "utf8");
      if (!content.includes(eventWrapperName(placement.eventCode))) {
        missing.push(`${placement.eventCode}: wrapper call missing from ${placement.file}`);
      }
    } catch {
      missing.push(`${placement.eventCode}: cannot read ${placement.file}`);
    }
  }
  return {
    ok: missing.length === 0,
    notes: missing.join("; "),
  };
}

export async function finalizeIntegration(
  deps: IntegrationDeps,
): Promise<{ results: VerifyStepResult[]; status: "pending" | "passed" | "failed" | "unavailable"; command?: string }> {
  const steps = resolveVerifySteps(deps.worktree.path, deps.target);
  deps.sink.emit({ phase: "verifying", action: "final verification pass" });
  const results = await runVerifySteps(deps.worktree.path, steps);
  return {
    results,
    status: runVerificationStatus(results),
    command: verificationCommand(results),
  };
}

export async function repairVerification(
  deps: IntegrationDeps,
  results: VerifyStepResult[],
): Promise<boolean> {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return true;
  deps.sink.emit({ phase: "verifying", action: "Opus is repairing final verification failures" });
  const outcome = await deps.provider.invoke(
    {
      role: "edit",
      task: "repair",
      sessionKey: "final_repair",
      systemPrompt: deps.playbookSystemPrompt,
      userPrompt: [
        "The one final repository verification failed after all instrumentation patches were merged.",
        "Repair only the affected integration files and their imports/configuration. Preserve every generated event wrapper call.",
        "Do not redesign events. Stop after the repair; the wizard will rerun verification.",
        "",
        failed.map((result) => `$ ${result.command} ${result.args.join(" ")}\n${result.output}`).join("\n\n").slice(0, 30_000),
      ].join("\n"),
      tools: [],
      allowRepoWrite: true,
      cwd: deps.worktree.path,
    },
    modelConfigFor(deps.models, "repair", "edit"),
    (action) => deps.sink.emit({ phase: "verifying", action }),
  );
  return outcome.kind === "completed";
}
