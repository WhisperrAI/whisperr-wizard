import * as p from "@clack/prompts";

import { postRunReport } from "../core/report.js";
import { pollFirstEvent } from "../core/verify.js";
import { packageVersion } from "../core/version.js";
import type { Playbook, WizardConfig, WizardSession } from "../types.js";
import { createProgressSink } from "./output.js";
import { runEngine } from "./orchestrator.js";
import { createClaudeProvider } from "./providers/claude.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { createRoutedProvider } from "./providers/router.js";
import type { EngineModelConfig } from "./types.js";

const MINUTE = 60_000;

export function engineModelConfig(config: WizardConfig): EngineModelConfig {
  const model = (task: string, fallback: string) =>
    process.env[`WHISPERR_WIZARD_ENGINE_${task.toUpperCase()}_MODEL`]?.trim() || fallback;
  const terra = "gpt-5.6-terra";
  const sol = "gpt-5.6-sol";
  const opus = "claude-opus-5";
  const opusOnly = process.env.WHISPERR_WIZARD_PRESET?.trim() === "claude-default" ||
    config.offline === true;
  if (opusOnly) {
    // Emergency rollback preset intentionally preserves the previous Opus-only
    // behavior and budgets.
    const survey = { model: model("survey", opus), effort: "medium", fastMode: true, maxTurns: 30, maxMs: 5 * MINUTE };
    const design = { model: model("design", opus), effort: "medium", fastMode: true, maxTurns: 80, maxMs: 20 * MINUTE };
    const sdkSetup = { model: model("sdk_setup", opus), effort: "medium", fastMode: true, maxTurns: 60, maxMs: 12 * MINUTE };
    const clusterEdit = { model: model("cluster_edit", opus), effort: "medium", fastMode: true, maxTurns: 60, maxMs: 12 * MINUTE };
    const repair = { model: model("repair", opus), effort: "medium", fastMode: true, maxTurns: 30, maxMs: 8 * MINUTE };
    const review = { model: model("review", opus), effort: "medium", fastMode: true, maxTurns: 30, maxMs: 8 * MINUTE };
    return {
      survey,
      design,
      edit: sdkSetup,
      review,
      sdk_setup: sdkSetup,
      cluster_edit: clusterEdit,
      repair,
    };
  }
  const survey = { model: model("survey", opus), effort: "low", fastMode: true, maxTurns: 30, maxMs: 5 * MINUTE };
  const design = { model: model("design", opus), effort: "low", fastMode: true, maxTurns: 20, maxMs: 5 * MINUTE };
  const sdkSetup = { model: model("sdk_setup", opus), effort: "low", fastMode: true, maxTurns: 30, maxMs: 6 * MINUTE };
  const clusterEdit = opusOnly
    ? { model: model("cluster_edit", opus), effort: "medium", fastMode: true, maxTurns: 60, maxMs: 12 * MINUTE }
    : {
        model: model("cluster_edit", terra),
        effort: "medium",
        serviceTier: "priority" as const,
        maxTurns: 20,
        maxMs: 4 * MINUTE,
        maxOutputTokens: 8_000,
      };
  const repair = {
    model: model("repair", sol),
    effort: "medium",
    serviceTier: "priority" as const,
    maxTurns: 30,
    maxMs: 8 * MINUTE,
    maxOutputTokens: 12_000,
  };
  const review = {
    model: model("review", sol),
    effort: "medium",
    serviceTier: "priority" as const,
    maxTurns: 8,
    maxMs: 3 * MINUTE,
    maxOutputTokens: 4_000,
  };
  return {
    survey,
    design,
    edit: sdkSetup,
    review,
    sdk_setup: sdkSetup,
    cluster_edit: clusterEdit,
    repair,
  };
}

export function engineProvider(config: WizardConfig, session: WizardSession) {
  const claude = createClaudeProvider(config, session);
  const models = engineModelConfig(config);
  const preset = process.env.WHISPERR_WIZARD_PRESET?.trim() ?? "hybrid";
  if (preset === "claude-default" || config.offline) {
    return createRoutedProvider({}, claude, 2);
  }
  const openai = createOpenAIProvider(config, session);
  return createRoutedProvider({
    survey: { provider: claude, concurrency: 3, fallbackConfig: models.repair },
    design: { provider: claude, concurrency: 3, fallbackConfig: models.repair },
    sdk_setup: { provider: claude, concurrency: 2, fallbackConfig: models.repair },
    cluster_edit: { provider: openai, concurrency: 4, fallbackConfig: models.repair },
    review: { provider: openai, concurrency: 2, fallbackConfig: models.review },
    repair: { provider: openai, concurrency: 2, fallbackConfig: models.repair },
  }, openai, 2);
}

export interface EngineFlowResult {
  handled: boolean;
  exitCode: number;
}

export async function tryEngineFlow(options: {
  repoPath: string;
  fingerprint: string;
  config: WizardConfig;
  session: WizardSession;
  playbook: Playbook;
  theme: { bright: (text: string) => string; muted: (text: string) => string };
}): Promise<EngineFlowResult> {
  const { repoPath, fingerprint, config, session, playbook, theme } = options;
  const startedAt = Date.now();
  const models = engineModelConfig(config);
  const sink = createProgressSink({
    json: false,
    isTTY: Boolean(process.stdout.isTTY),
    write: (line) => p.log.message(theme.muted(line)),
  });

  const result = await runEngine({
    repoPath,
    repoFingerprint: fingerprint,
    config,
    session,
    provider: engineProvider(config, session),
    models,
    target: playbook.target.id,
    projectKind: ["node", "python", "php", "go", "express", "django", "fastapi", "laravel", "spring-boot"].includes(
      playbook.target.id,
    )
      ? "backend"
      : "frontend",
    playbookSystemPrompt: playbook.systemPrompt,
    sink,
  });

  if (result.kind === "wrong_mode") {
    return { handled: false, exitCode: 0 };
  }
  if (result.kind === "aborted") {
    p.cancel(result.reason);
    return { handled: true, exitCode: 1 };
  }

  p.note(result.summary || "Nothing to integrate.", "Run summary");
  if (result.partialPatchPath) {
    p.log.warn(`Unapplied changes saved to ${result.partialPatchPath}`);
  }

  await postRunReport(config, session, {
    target: playbook.target.id,
    repo_fingerprint: fingerprint,
    identify_wired: result.identifyWired,
    verified: result.verificationStatus === "passed"
      ? true
      : result.verificationStatus === "failed"
        ? false
        : null,
    verification_status: result.verificationStatus,
    cost_usd: 0,
    duration_ms: Date.now() - startedAt,
    summary: result.summary.slice(0, 2000),
    events: result.reportEvents,
    wizard_version: packageVersion(),
    planner_model: models.survey.model,
    editor_model: models.cluster_edit?.model ?? models.edit.model,
    effort: models.cluster_edit?.effort ?? models.edit.effort,
    phase_timings: result.phaseTimings,
    model_routes: result.modelRoutes,
    exit_class: result.kind === "completed" ? "engine_completed" : "engine_partial",
  });

  if (result.applied && result.registered.length > 0) {
    const spin = p.spinner();
    spin.start("Waiting for the first event (deploy or run your app)");
    const first = await pollFirstEvent(config, session, { timeoutMs: 90_000 });
    spin.stop(
      first.received
        ? theme.bright(`Whisperr received ${first.eventType ?? "an event"} ✓`)
        : theme.muted("No event yet — it will show up once the instrumented build runs."),
    );
  }
  return { handled: true, exitCode: result.kind === "completed" ? 0 : 1 };
}
