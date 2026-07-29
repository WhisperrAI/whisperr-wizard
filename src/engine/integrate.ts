import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

import { eventWrapperName, generateBindings, type GeneratedBindings } from "./bindings.js";
import { MAX_CLUSTER_ATTEMPTS, classifyFailure, nextClusterStatusAfterFailure } from "./budgets.js";
import { clustersComplete, nextPendingCluster, transitionCluster } from "./clusters.js";
import type { ProgressSink } from "./output.js";
import type { RegisteredEvent, SurveyArtifact } from "./selection.js";
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
  survey?: SurveyArtifact;
  allowedRepairFiles?: string[];
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

export async function runSdkSetupPass(
  deps: IntegrationDeps,
  bindings: GeneratedBindings,
  validate?: () => Promise<boolean>,
): Promise<boolean> {
  deps.sink.emit({ phase: "binding", action: "installing SDK and wiring identify()" });
  const allowedFiles = await sdkSetupFiles(deps.worktree.path, deps.survey, bindings.relativePath);
  const invocation: RoleInvocation = {
    role: "edit",
    task: "sdk_setup",
    sessionKey: "sdk_setup",
    systemPrompt: deps.playbookSystemPrompt,
    userPrompt: [
      "CORE SETUP for the Whisperr SDK in this repository. Do exactly this, then stop:",
      "1. Add and install the Whisperr SDK dependency for this stack.",
      `2. Initialize it once at app startup with API key ${deps.ingestion.apiKey} and base URL ${deps.ingestion.baseUrl}.`,
      `3. The deterministic bindings module at ${bindings.relativePath} queues events until bound.`,
      `   ${bindings.bindInstruction}`,
      "   Never edit the generated bindings content.",
      "4. Wire identify() for the END USER (paying customer) at login success AND session restoration.",
      "5. Wire reset() at every end-user logout anchor.",
      "Never instrument admin/staff/operator paths. Do not insert any product event calls. Do not run builds.",
      "",
      `Saved stack and identity anchors:\n${JSON.stringify({
        stack: deps.survey?.stack,
        identifyAnchors: deps.survey?.identifyAnchors ?? [],
        logoutAnchors: deps.survey?.logoutAnchors ?? [],
      })}`,
      "",
      `You may access only:\n${allowedFiles.map((file) => `- ${file}`).join("\n")}`,
    ].join("\n"),
    tools: [],
    repositoryAccess: { mode: "sdk_setup", allowedFiles },
    allowRepoWrite: true,
    cwd: deps.worktree.path,
  };
  let outcome = await deps.provider.invoke(
    invocation,
    modelConfigFor(deps.models, "sdk_setup", "edit"),
    (action) => deps.sink.emit({ phase: "binding", action }),
  );
  const passesValidation = async () => {
    if (!validate) return true;
    try {
      return await validate();
    } catch {
      return false;
    }
  };
  let valid = outcome.kind === "completed" && await passesValidation();
  if (!valid && deps.provider.invokeFallback) {
    await deps.discardChanges();
    await writeFile(join(deps.worktree.path, bindings.relativePath), bindings.content);
    deps.sink.emit({ phase: "binding", action: "Opus setup rolled back; retrying with Sol" });
    outcome = await deps.provider.invokeFallback(
      { ...invocation, sessionKey: "sdk_setup:sol" },
      modelConfigFor(deps.models, "repair", "edit"),
      (action) => deps.sink.emit({ phase: "binding", action }),
    );
    valid = outcome.kind === "completed" && await passesValidation();
  }
  return valid;
}

async function sdkSetupFiles(
  repoPath: string,
  survey: SurveyArtifact | undefined,
  bindingsFile: string,
): Promise<string[]> {
  const candidates = new Set<string>([
    bindingsFile,
    ...(survey?.stack.entryPoints ?? []),
    ...(survey?.identifyAnchors.map((anchor) => anchor.file) ?? []),
    ...(survey?.logoutAnchors.map((anchor) => anchor.file) ?? []),
    ...(survey?.featureAreas.flatMap((area) =>
      area.files.filter(isSdkConfigurationFile)
    ) ?? []),
    "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "bun.lock", "bun.lockb", "pyproject.toml", "requirements.txt", "Pipfile",
    "Package.swift", "Podfile", "pubspec.yaml", "go.mod", "composer.json",
    "tsconfig.json", "next.config.js", "next.config.mjs", "next.config.ts",
    "vite.config.js", "vite.config.ts", "app.json", "Info.plist",
  ]);
  const available: string[] = [];
  for (const file of candidates) {
    try {
      if ((await stat(join(repoPath, file))).isFile()) available.push(file.replaceAll("\\", "/"));
    } catch {
      // Stack manifests are optional and the constrained model cannot discover
      // files beyond the saved survey.
    }
  }
  return [...new Set(available)].sort();
}

function isSdkConfigurationFile(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  return /(^|\/)(?:[^/]*config[^/]*|settings[^/]*|Info\.plist|AndroidManifest\.xml|Podfile|pubspec\.yaml)$/.test(
    normalized,
  );
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

export async function runClusterIntegration(
  deps: IntegrationDeps,
  initialClusters: Cluster[],
  _clusterDiff: (files: string[]) => Promise<string>,
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
        repositoryAccess: { mode: "cluster", allowedFiles: cluster.files },
        allowRepoWrite: true,
        cwd: deps.worktree.path,
      };
    let edit = await deps.provider.invoke(
      invocation,
      modelConfigFor(deps.models, "cluster_edit", "edit"),
      (action) =>
        deps.sink.emit({ phase: "integrating", cluster: { index, total }, action }),
    );

    let structural = edit.kind === "completed"
      ? await structuralClusterCheck(deps.worktree.path, cluster)
      : { ok: false, notes: `edit ${edit.kind}` };
    if ((!structural.ok || edit.kind !== "completed") && deps.provider.invokeFallback) {
      await deps.discardChanges();
      deps.sink.emit({
        phase: "integrating",
        cluster: { index, total },
        action: "Terra attempt rolled back; retrying the clean cluster with Sol",
      });
      edit = await deps.provider.invokeFallback(
        { ...invocation, task: "repair", sessionKey: `cluster_sol:${cluster.id}` },
        modelConfigFor(deps.models, "repair", "edit"),
        (action) =>
          deps.sink.emit({ phase: "integrating", cluster: { index, total }, action }),
      );
      structural = edit.kind === "completed"
        ? await structuralClusterCheck(deps.worktree.path, cluster)
        : { ok: false, notes: `Sol escalation ${edit.kind}` };
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

    const finalStatus: EventIntegrationStatus = "syntax_verified";
    clusters = transitionCluster(clusters, cluster.id, "verified");
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
      const wrapper = eventWrapperName(placement.eventCode);
      if (!content.includes(wrapper)) {
        missing.push(`${placement.eventCode}: wrapper call missing from ${placement.file}`);
      }
      if (content.includes("<<<<<<<") || content.includes(">>>>>>>")) {
        missing.push(`${placement.eventCode}: merge conflict marker in ${placement.file}`);
      }
      if (/\.(?:ts|tsx|js|jsx|swift|dart|kt|java|go|py|php)$/.test(placement.file) &&
        !balancedSourceDelimiters(content)) {
        missing.push(`${placement.eventCode}: basic syntax delimiters are unbalanced in ${placement.file}`);
      }
      if (/\.(?:ts|tsx|js|jsx)$/.test(placement.file) &&
        content.includes("WhisperrEvents.") &&
        !/import[\s\S]{0,300}\bWhisperrEvents\b/.test(content)) {
        missing.push(`${placement.eventCode}: WhisperrEvents import is missing from ${placement.file}`);
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

function balancedSourceDelimiters(content: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]!;
    const next = content[index + 1] ?? "";
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = "";
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") stack.push(char);
    if (pairs[char] && stack.pop() !== pairs[char]) return false;
  }
  return stack.length === 0 && !quote && !blockComment;
}

export interface SemanticReviewIssue {
  eventCode: string;
  reason: string;
}

export interface SemanticReviewResult {
  ok: boolean;
  issues: SemanticReviewIssue[];
  notes: string;
}

export async function reviewIntegratedFile(
  deps: IntegrationDeps,
  file: string,
  events: RegisteredEvent[],
  sessionSuffix = "",
): Promise<SemanticReviewResult> {
  let verdict: "pass" | "fail" | undefined;
  let issues: SemanticReviewIssue[] = [];
  let notes = "";
  const expectedCodes = new Set(events.map((event) => event.code));
  const finishTool = {
    name: "finish_review",
    description: "Return the semantic verdict for this one file and its exact event contracts.",
    inputSchema: {
      verdict: z.enum(["pass", "fail"]),
      issues: z.array(z.object({
        eventCode: z.string(),
        reason: z.string(),
      })).max(100),
      notes: z.string().optional(),
    },
    jsonSchema: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["pass", "fail"] },
        issues: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            properties: {
              eventCode: { type: "string" },
              reason: { type: "string" },
            },
            required: ["eventCode", "reason"],
          },
        },
        notes: { type: "string" },
      },
      required: ["verdict", "issues"],
    },
    handler: async (input: Record<string, unknown>) => {
      const rawIssues = Array.isArray(input.issues) ? input.issues : [];
      const normalized: SemanticReviewIssue[] = [];
      for (const candidate of rawIssues) {
        const issue = candidate as Record<string, unknown>;
        const eventCode = String(issue.eventCode ?? "").trim();
        const reason = String(issue.reason ?? "").trim();
        if (!expectedCodes.has(eventCode) || !reason) {
          return { ok: false, reason: "issues must name an expected event and a concrete reason" };
        }
        normalized.push({ eventCode, reason });
      }
      verdict = input.verdict === "pass" ? "pass" : "fail";
      issues = normalized;
      notes = String(input.notes ?? "").trim();
      if (verdict === "pass" && issues.length > 0) {
        return { ok: false, reason: "a passing verdict cannot include issues" };
      }
      return { ok: true };
    },
  };
  const content = await readFile(resolve(deps.worktree.path, file), "utf8");
  const contracts = events.map((event) => ({
    code: event.code,
    reasoning: event.reasoning,
    anchorFile: event.anchorFile,
    anchorSymbol: event.anchorSymbol,
    payloadSchema: event.payloadSchema,
  }));
  const surveyAnchors = deps.survey?.integratableCallSites.filter((anchor) => anchor.file === file) ?? [];
  const key = createHash("sha256").update(file).digest("hex").slice(0, 12);
  const outcome = await deps.provider.invoke(
    {
      role: "review",
      task: "review",
      sessionKey: `review:${key}${sessionSuffix}`,
      systemPrompt: [
        "You are the file-isolated semantic review pass for product analytics instrumentation.",
        "Use finish_review exactly once. Do not browse the repository and do not edit files.",
      ].join("\n"),
      userPrompt: [
        "Validate every expected wrapper call for:",
        "- placement after the confirmed outcome rather than intent",
        "- deduplication, especially view/render/navigation events",
        "- payload correctness against the exact contract",
        "- absence of personal identifiers",
        "- generated wrapper usage rather than raw track calls",
        "",
        `Event contracts:\n${JSON.stringify(contracts)}`,
        `Saved survey anchors:\n${JSON.stringify(surveyAnchors)}`,
        "",
        `Expanded context for ${file}:\n${content.slice(0, 60_000)}`,
      ].join("\n"),
      tools: [finishTool],
      repositoryAccess: { mode: "review" },
      allowRepoWrite: false,
      cwd: deps.worktree.path,
    },
    modelConfigFor(deps.models, "review", "review"),
    (action) => deps.sink.emit({ phase: "reviewing", file, action }),
  );
  if (outcome.kind !== "completed" || verdict === undefined) {
    return {
      ok: false,
      issues: events.map((event) => ({
        eventCode: event.code,
        reason: `semantic review did not finish (${outcome.kind})`,
      })),
      notes: `semantic review did not finish (${outcome.kind})`,
    };
  }
  return { ok: verdict === "pass" && issues.length === 0, issues, notes };
}

export async function repairIntegratedFile(
  deps: IntegrationDeps,
  file: string,
  events: RegisteredEvent[],
  review: SemanticReviewResult,
): Promise<boolean> {
  const key = createHash("sha256").update(file).digest("hex").slice(0, 12);
  deps.sink.emit({ phase: "reviewing", file, action: "Sol is repairing semantic review failures" });
  const outcome = await deps.provider.invoke(
    {
      role: "edit",
      task: "repair",
      sessionKey: `semantic_repair:${key}`,
      systemPrompt: deps.playbookSystemPrompt,
      userPrompt: [
        `Repair only ${file}.`,
        "Preserve the exact event set and generated wrappers. Do not add events or edit other files.",
        "Correct placement timing, deduplication, payloads, PII safety, and wrapper usage as reported.",
        `Issues:\n${JSON.stringify(review.issues)}`,
        `Contracts:\n${JSON.stringify(events.map((event) => ({
          code: event.code,
          anchorSymbol: event.anchorSymbol,
          payloadSchema: event.payloadSchema,
          reasoning: event.reasoning,
        })))}`,
      ].join("\n"),
      tools: [],
      repositoryAccess: { mode: "repair", allowedFiles: [file] },
      allowRepoWrite: true,
      cwd: deps.worktree.path,
    },
    modelConfigFor(deps.models, "repair", "edit"),
    (action) => deps.sink.emit({ phase: "reviewing", file, action }),
  );
  return outcome.kind === "completed";
}

export async function finalizeIntegration(
  deps: IntegrationDeps,
  verifyCwd = deps.worktree.path,
): Promise<{ results: VerifyStepResult[]; status: "pending" | "passed" | "failed" | "unavailable"; command?: string }> {
  const steps = resolveVerifySteps(verifyCwd, deps.target);
  deps.sink.emit({ phase: "verifying", action: "final verification pass" });
  const results = await runVerifySteps(verifyCwd, steps);
  return {
    results,
    status: runVerificationStatus(results),
    command: verificationCommand(results),
  };
}

export async function repairVerification(
  deps: IntegrationDeps,
  results: VerifyStepResult[],
  cycle = 1,
): Promise<boolean> {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) return true;
  deps.sink.emit({ phase: "verifying", action: "Sol is repairing final verification failures" });
  const allowedFiles = deps.allowedRepairFiles ?? deps.registered.map((event) => event.anchorFile);
  const outcome = await deps.provider.invoke(
    {
      role: "edit",
      task: "repair",
      sessionKey: `final_repair:${cycle}`,
      systemPrompt: deps.playbookSystemPrompt,
      userPrompt: [
        "The one final repository verification failed after all instrumentation patches were merged.",
        "Repair only the affected integration files and their imports/configuration. Preserve every generated event wrapper call.",
        "Do not redesign events. Stop after the repair; the wizard will rerun verification.",
        "",
        failed.map((result) => `$ ${result.command} ${result.args.join(" ")}\n${result.output}`).join("\n\n").slice(0, 30_000),
      ].join("\n"),
      tools: [],
      repositoryAccess: { mode: "repair", allowedFiles },
      allowRepoWrite: true,
      cwd: deps.worktree.path,
    },
    modelConfigFor(deps.models, "repair", "edit"),
    (action) => deps.sink.emit({ phase: "verifying", action }),
  );
  return outcome.kind === "completed";
}
