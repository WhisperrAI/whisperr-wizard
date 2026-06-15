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
// Coding-agent default. Opus 4.8 — this work lives or dies on JUDGMENT: picking
// the END-USER auth path over an admin/staff one, finding the real server-side
// moment, sourcing the right properties. A mis-placed event corrupts the
// customer's churn data, so we pay for the most capable model. Override with
// WHISPERR_WIZARD_MODEL=claude-sonnet-4-6 for a cheaper, lighter run.
const DEFAULT_MODEL = "claude-opus-4-8";
// Reasoning effort (pairs with adaptive thinking). "low" keeps Opus fast/cheap
// while still far stronger than Sonnet on placement judgment. If placements
// still miss on a hard repo, raising effort is the most direct lever:
// WHISPERR_WIZARD_EFFORT=medium (or high).
const DEFAULT_EFFORT = "low";
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
    effort: resolveEffort(),
    maxTurns: Number(process.env.WHISPERR_WIZARD_MAX_TURNS ?? 55),
    directAnthropicKey,
    offline,
  };
}
