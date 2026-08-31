import type { WizardConfig } from "../types.js";

/**
 * Resolve wizard configuration from env + flags.
 *
 * Production: the CLI never carries an Anthropic key. It authenticates the user
 * (device flow), receives a short-lived wizard token, and points the Agent SDK
 * at Whisperr's Anthropic-compatible gateway via ANTHROPIC_BASE_URL +
 * ANTHROPIC_AUTH_TOKEN. The gateway injects the real key server-side and meters
 * usage per app.
 *
 * Local dev: set WHISPERR_WIZARD_DIRECT_ANTHROPIC_KEY (or ANTHROPIC_API_KEY) and
 * --offline to run the whole flow against a real model + a mock manifest, with
 * no backend required.
 */

const DEFAULT_API_BASE = "https://api.whisperr.net";
// Opus 5 runs every default engine role so all phases can use Anthropic fast
// mode. Keep separate model/planner overrides for controlled experiments.
// Override the editor with WHISPERR_WIZARD_MODEL or --model. Override the
// planner with WHISPERR_WIZARD_PLANNER_MODEL.
const DEFAULT_MODEL = "claude-opus-5";
const DEFAULT_PLANNER_MODEL = "claude-opus-5";
// Reasoning effort (pairs with adaptive thinking). "high" — placement is a
// reasoning task (which moment, which branch, which properties), so we give it
// room to think. Drop to medium/low via WHISPERR_WIZARD_EFFORT for cheap runs.
const DEFAULT_EFFORT = "high";
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_LEVELS)[number];

function resolveEffort(): Effort {
  const raw = (process.env.WHISPERR_WIZARD_EFFORT ?? "").toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(raw)
    ? (raw as Effort)
    : DEFAULT_EFFORT;
}

export interface CliFlags {
  offline?: boolean;
  apiBaseUrl?: string;
  model?: string;
  /** Proceed even without a clean git working tree (no safe auto-undo). */
  force?: boolean;
  /** Confirm the placement plan before wiring, instead of just running it. */
  reviewPlan?: boolean;
  /** Stage universe proposals for dashboard approval instead of adding them. */
  proposeOnly?: boolean;
  /** Run the self-review on the planner model at full depth. */
  strictReview?: boolean;
}

export function resolveConfig(flags: CliFlags = {}): WizardConfig {
  const apiBaseUrl = (
    flags.apiBaseUrl ??
    process.env.WHISPERR_WIZARD_API_BASE ??
    DEFAULT_API_BASE
  ).replace(/\/+$/, "");

  const llmBaseUrl = (
    process.env.WHISPERR_WIZARD_LLM_BASE ?? `${apiBaseUrl}/wizard/llm`
  ).replace(/\/+$/, "");

  const directAnthropicKey =
    process.env.WHISPERR_WIZARD_DIRECT_ANTHROPIC_KEY ??
    process.env.ANTHROPIC_API_KEY;

  const offline =
    flags.offline ??
    ["1", "true", "yes"].includes(
      (process.env.WHISPERR_WIZARD_OFFLINE ?? "").toLowerCase(),
    );

  return {
    apiBaseUrl,
    llmBaseUrl,
    model: flags.model ?? process.env.WHISPERR_WIZARD_MODEL ?? DEFAULT_MODEL,
    plannerModel:
      process.env.WHISPERR_WIZARD_PLANNER_MODEL ?? DEFAULT_PLANNER_MODEL,
    effort: resolveEffort(),
    // Cost is the real limiter (budgetUsd below). maxTurns is only a high safety
    // backstop against a stuck loop — it should NOT bind on a normal run. (It
    // used to be 55, which guillotined high-effort multi-phase runs mid-work.)
    maxTurns: Number(process.env.WHISPERR_WIZARD_MAX_TURNS) || 200,
    // Hard ceiling on TOTAL spend across all phases. If hit, the run stops
    // cleanly and keeps whatever already landed. Real runs finish well under it.
    budgetUsd: Number(process.env.WHISPERR_WIZARD_BUDGET_USD) || 25,
    directAnthropicKey,
    offline,
    reviewPlan: flags.reviewPlan ?? false,
    proposeOnly: flags.proposeOnly ?? false,
    strictReview: flags.strictReview ?? false,
  };
}
