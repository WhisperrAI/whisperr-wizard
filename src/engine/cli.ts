import * as p from "@clack/prompts";

import { postRunReport } from "../core/report.js";
import { pollFirstEvent } from "../core/verify.js";
import type { Playbook, WizardConfig, WizardSession } from "../types.js";
import { createProgressSink } from "./output.js";
import { runEngine } from "./orchestrator.js";
import { createClaudeProvider } from "./providers/claude.js";
import { createOpenAIProvider } from "./providers/openai.js";
import { createRoutedProvider } from "./providers/router.js";
import type { ProposedEvent } from "./selection.js";
import type { EngineModelConfig } from "./types.js";

const MINUTE = 60_000;

export function engineModelConfig(config: WizardConfig): EngineModelConfig {
  const model = (task: string, fallback: string) =>
    process.env[`WHISPERR_WIZARD_ENGINE_${task.toUpperCase()}_MODEL`]?.trim() || fallback;
  const terra = "gpt-5.6-terra";
  const opus = "claude-opus-5";
  const opusOnly = process.env.WHISPERR_WIZARD_PRESET?.trim() === "claude-default" ||
    config.offline === true;
  const survey = opusOnly
    ? { model: model("survey", opus), effort: "medium", fastMode: true, maxTurns: 30, maxMs: 5 * MINUTE }
    : { model: model("survey", terra), effort: "medium", serviceTier: "priority" as const, maxTurns: 30, maxMs: 5 * MINUTE };
  const design = { model: model("design", opus), effort: "medium", fastMode: true, maxTurns: 80, maxMs: 20 * MINUTE };
  const sdkSetup = { model: model("sdk_setup", opus), effort: "medium", fastMode: true, maxTurns: 60, maxMs: 12 * MINUTE };
  const clusterEdit = opusOnly
    ? { model: model("cluster_edit", opus), effort: "medium", fastMode: true, maxTurns: 60, maxMs: 12 * MINUTE }
    : { model: model("cluster_edit", terra), effort: "medium", serviceTier: "priority" as const, maxTurns: 30, maxMs: 5 * MINUTE };
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

export function engineProvider(config: WizardConfig, session: WizardSession) {
  const claude = createClaudeProvider(config, session);
  const models = engineModelConfig(config);
  const preset = process.env.WHISPERR_WIZARD_PRESET?.trim() ?? "hybrid";
  if (preset === "claude-default" || config.offline) {
    return createRoutedProvider({}, claude, 2);
  }
  const openai = createOpenAIProvider(config, session);
  if (preset === "sol-design") {
    return createRoutedProvider({
      survey: { provider: openai, fallbackConfig: models.sdk_setup },
      design: { provider: openai, fallbackConfig: models.design },
      review: { provider: openai, fallbackConfig: models.review },
    }, claude);
  }
  return createRoutedProvider({
    survey: { provider: openai, concurrency: 4, fallbackConfig: models.sdk_setup },
    cluster_edit: { provider: openai, concurrency: 4, fallbackConfig: models.sdk_setup },
  }, claude, 2);
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
    models: engineModelConfig(config),
    target: playbook.target.id,
    projectKind: ["node", "python", "php", "go", "express", "django", "fastapi", "laravel", "spring-boot"].includes(
      playbook.target.id,
    )
      ? "backend"
      : "frontend",
    playbookSystemPrompt: playbook.systemPrompt,
    sink,
    callbacks: {
      reviewEvents: async (proposed) => reviewEventsInTerminal(proposed, theme),
    },
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
    verified: null,
    cost_usd: 0,
    duration_ms: Date.now() - startedAt,
    summary: result.summary.slice(0, 2000),
    events: result.reportEvents,
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

async function reviewEventsInTerminal(
  proposed: ProposedEvent[],
  theme: { bright: (text: string) => string; muted: (text: string) => string },
): Promise<ProposedEvent[] | null> {
  if (proposed.length === 0) {
    return [];
  }
  const lines = proposed.map((event) => {
    const fields = Object.keys(event.payloadSchema);
    return [
      `${theme.bright(event.code)} — ${event.name}`,
      `  ${event.reasoning}`,
      `  anchor: ${event.anchorFile}${event.anchorSymbol ? ` (${event.anchorSymbol})` : ""}`,
      fields.length > 0 ? `  payload: ${fields.join(", ")}` : "  payload: none",
    ].join("\n");
  });
  p.note(lines.join("\n\n"), `Proposed events (${proposed.length})`);
  const selection = await p.multiselect({
    message: "Register and integrate these events? Deselect any you don't want.",
    options: proposed.map((event) => ({ value: event.code, label: event.code, hint: event.name })),
    initialValues: proposed.map((event) => event.code),
    required: false,
  });
  if (p.isCancel(selection)) {
    return null;
  }
  const chosen = new Set(selection as string[]);
  return proposed.filter((event) => chosen.has(event.code));
}
