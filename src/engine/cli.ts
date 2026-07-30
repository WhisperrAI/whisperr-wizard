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

export function engineModelConfig(config: WizardConfig): EngineModelConfig {
  const model = (task: string, fallback: string) =>
    process.env[`WHISPERR_WIZARD_ENGINE_${task.toUpperCase()}_MODEL`]?.trim() || fallback;
  const terra = "gpt-5.6-terra";
  const sol = "gpt-5.6-sol";
  const opus = "claude-opus-5";
  const opusOnly = process.env.WHISPERR_WIZARD_PRESET?.trim() === "claude-default" ||
    config.offline === true;
  if (opusOnly) {
    const survey = { model: model("survey", opus), effort: "low", fastMode: true };
    const design = { model: model("design", opus), effort: "low", fastMode: true };
    const sdkSetup = { model: model("sdk_setup", opus), effort: "medium", fastMode: true };
    const clusterEdit = { model: model("cluster_edit", opus), effort: "medium", fastMode: true };
    const repair = { model: model("repair", opus), effort: "medium", fastMode: true };
    const review = { model: model("review", opus), effort: "medium", fastMode: true };
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
  const survey = { model: model("survey", opus), effort: "low", fastMode: true };
  const design = { model: model("design", opus), effort: "low", fastMode: true };
  const sdkSetup = {
    model: model("sdk_setup", sol),
    effort: "medium",
    serviceTier: "priority" as const,
  };
  const clusterEdit = {
    model: model("cluster_edit", terra),
    effort: "medium",
    serviceTier: "priority" as const,
  };
  const repair = {
    model: model("repair", sol),
    effort: "medium",
    serviceTier: "priority" as const,
  };
  const review = {
    model: model("review", sol),
    effort: "medium",
    serviceTier: "priority" as const,
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
    return createRoutedProvider({}, claude);
  }
  const openai = createOpenAIProvider(config, session);
  return createRoutedProvider({
    survey: { provider: claude },
    design: { provider: claude },
    sdk_setup: { provider: openai },
    cluster_edit: { provider: openai },
    review: { provider: openai },
    repair: { provider: openai },
  }, openai);
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
