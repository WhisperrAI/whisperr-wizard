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
// Coding-agent default. Sonnet 4.6 at HIGH effort. The failure mode here isn't a
// capability ceiling — it's skimming: not reading a callback's control flow to
// see the initial-vs-renewal branch, not sourcing the discriminator properties
// the code already exposes. That's fixed by THINKING DEPTH (effort), not model
// tier, and Sonnet-high reads control flow well at ~0.6x Opus's token price.
// Override with WHISPERR_WIZARD_MODEL=claude-opus-4-8 for the hardest repos.
const DEFAULT_MODEL = "claude-sonnet-4-6";
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
