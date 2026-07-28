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
  const model = (role: string, fallback: string) =>
    process.env[`WHISPERR_WIZARD_ENGINE_${role.toUpperCase()}_MODEL`]?.trim() || fallback;
  return {
    survey: { model: model("survey", config.model), effort: "medium", maxTurns: 40, maxMs: 12 * MINUTE },
    design: { model: model("design", config.plannerModel), effort: "high", maxTurns: 40, maxMs: 15 * MINUTE },
    edit: { model: model("edit", config.model), effort: config.effort, maxTurns: 50, maxMs: 15 * MINUTE },
    review: { model: model("review", config.model), effort: "medium", maxTurns: 15, maxMs: 8 * MINUTE },
  };
}

export function engineProvider(config: WizardConfig, session: WizardSession) {
  const claude = createClaudeProvider(config, session);
  const preset = process.env.WHISPERR_WIZARD_PRESET?.trim() ?? "claude-default";
  if (preset === "sol-design") {
    const openai = createOpenAIProvider(config, session);
    return createRoutedProvider({ survey: openai, design: openai, review: openai }, claude);
  }
  return claude;
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
      confirmApply: async (patch, summaryLines) => {
        p.note(summaryLines.join("\n"), "Integration result");
        const lineCount = patch.split("\n").length;
        const answer = await p.confirm({
          message: `Apply these changes to your working tree? (${lineCount} patch lines)`,
          initialValue: true,
        });
        return answer === true;
      },
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
    message: "Register these events? Deselect any you don't want.",
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
