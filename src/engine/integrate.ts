import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { generateBindings, type GeneratedBindings } from "./bindings.js";
import { MAX_CLUSTER_ATTEMPTS, classifyFailure, nextClusterStatusAfterFailure } from "./budgets.js";
import { clustersComplete, nextPendingCluster, transitionCluster } from "./clusters.js";
import type { ProgressSink } from "./output.js";
import type { RegisteredEvent } from "./selection.js";
import type {
  Cluster,
  EngineModelConfig,
  EngineProvider,
  EventIntegrationStatus,
} from "./types.js";
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
    deps.models.edit,
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
    deps.models.review,
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
  const steps = resolveVerifySteps(deps.worktree.path, deps.target);
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

    const edit = await deps.provider.invoke(
      {
        role: "edit",
        systemPrompt: deps.playbookSystemPrompt,
        userPrompt: clusterPrompt(cluster, deps.registered, bindings),
        tools: [],
        allowRepoWrite: true,
        cwd: deps.worktree.path,
      },
      deps.models.edit,
      (action) =>
        deps.sink.emit({ phase: "integrating", cluster: { index, total }, action }),
    );

    if (edit.kind !== "completed") {
      const failure =
        edit.kind === "context_overflow"
          ? "context_overflow"
          : edit.kind === "budget_exhausted"
            ? "context_overflow"
            : classifyFailure(edit.kind === "failed" ? edit.error : "");
      const nextStatus = nextClusterStatusAfterFailure(failure, cluster.attempts);
      clusters = transitionCluster(clusters, cluster.id, nextStatus, `edit ${edit.kind}`);
      deps.saveClusters(clusters);
      for (const placement of cluster.events) {
        eventStatuses.set(placement.eventCode, "failed");
      }
      await deps.discardChanges();
      continue;
    }

    let statuses: EventIntegrationStatus = "applied";
    if (steps.length > 0) {
      deps.sink.emit({ phase: "verifying", cluster: { index, total }, action: "running verifier" });
      const results = await runVerifySteps(deps.worktree.path, steps);
      statuses = verifiedStatus(results);
      if (results.some((result) => !result.ok) && cluster.attempts < MAX_CLUSTER_ATTEMPTS) {
        deps.sink.emit({ phase: "verifying", cluster: { index, total }, action: "repairing verification failure" });
        await deps.provider.invoke(
          {
            role: "edit",
            systemPrompt: deps.playbookSystemPrompt,
            userPrompt: [
              "The verification command failed after your edits. Fix ONLY the failure below, then stop.",
              "",
              results.map((result) => result.output).join("\n").slice(0, 20_000),
            ].join("\n"),
            tools: [],
            allowRepoWrite: true,
            cwd: deps.worktree.path,
          },
          deps.models.edit,
          (action) => deps.sink.emit({ phase: "verifying", cluster: { index, total }, action }),
        );
        const retried = await runVerifySteps(deps.worktree.path, steps);
        statuses = verifiedStatus(retried);
      }
    }
    clusters = transitionCluster(clusters, cluster.id, "verified");
    deps.saveClusters(clusters);

    const diff = await clusterDiff(cluster.files);
    const review = await reviewCluster(deps, cluster, diff);
    const finalStatus: EventIntegrationStatus = review.ok
      ? statuses === "applied"
        ? "applied"
        : "reviewed"
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
