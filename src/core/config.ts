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
// Current coding-agent default. Override with WHISPERR_WIZARD_MODEL.
//   claude-opus-4-8   — most capable, best for autonomous agentic edits
//   claude-sonnet-4-6 — faster/cheaper workhorse
const DEFAULT_MODEL = "claude-opus-4-8";

export interface CliFlags {
  offline?: boolean;
  apiBaseUrl?: string;
  model?: string;
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
    maxTurns: Number(process.env.WHISPERR_WIZARD_MAX_TURNS ?? 40),
    directAnthropicKey,
    offline,
  };
}
