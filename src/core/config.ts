import type { WizardConfig } from "../types.js";

/**
 * Resolve wizard configuration from env + flags.
 *
 * Production uses the short-lived wizard token against runtime's
 * OpenAI-compatible gateway. Local development can opt into a direct OpenAI
 * key, which remains process-local.
 *
 * Local dev: set WHISPERR_WIZARD_DIRECT_OPENAI_KEY explicitly.
 */

const DEFAULT_API_BASE = "https://api.whisperr.net";
const DEFAULT_OPENAI_GATEWAY_BASE =
  "https://ca-whisperr-api-prod.graycliff-3f912aeb.swedencentral.azurecontainerapps.io/wizard/openai";
export const DEFAULT_PRIMARY_MODEL = "gpt-5.6-sol";
export const DEFAULT_EXPLORER_MODEL = "gpt-5.6-terra";
const DEFAULT_PRIMARY_EFFORT = "high";
const DEFAULT_EXPLORER_EFFORT = "xhigh";
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORT_LEVELS)[number];

function resolveEffort(value: string | undefined, fallback: Effort): Effort {
  const raw = (value ?? "").toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(raw)
    ? (raw as Effort)
    : fallback;
}

export interface CliFlags {
  apiBaseUrl?: string;
  model?: string;
  /** Proceed with existing changes; failed-invocation restore preserves them. */
  force?: boolean;
}

export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

export function resolveConfig(flags: CliFlags = {}): WizardConfig {
  const apiBaseUrl = stripTrailingSlashes(
    flags.apiBaseUrl ??
    process.env.WHISPERR_WIZARD_API_BASE ??
    DEFAULT_API_BASE,
  );

  const directOpenAIKey = process.env.WHISPERR_WIZARD_DIRECT_OPENAI_KEY;
  const openAIBaseUrl = stripTrailingSlashes(
    process.env.WHISPERR_WIZARD_OPENAI_BASE ??
    (directOpenAIKey
      ? "https://api.openai.com/v1"
      : apiBaseUrl === DEFAULT_API_BASE
        ? DEFAULT_OPENAI_GATEWAY_BASE
        : `${apiBaseUrl}/wizard/openai`),
  );

  return {
    apiBaseUrl,
    openAIBaseUrl,
    primaryModel:
      flags.model ??
      process.env.WHISPERR_WIZARD_PRIMARY_MODEL ??
      DEFAULT_PRIMARY_MODEL,
    primaryEffort: resolveEffort(
      process.env.WHISPERR_WIZARD_PRIMARY_EFFORT,
      DEFAULT_PRIMARY_EFFORT,
    ),
    primaryServiceTier:
      process.env.WHISPERR_WIZARD_SERVICE_TIER === "default"
        ? "default"
        : "priority",
    explorerModel:
      process.env.WHISPERR_WIZARD_EXPLORER_MODEL ?? DEFAULT_EXPLORER_MODEL,
    explorerEffort: resolveEffort(
      process.env.WHISPERR_WIZARD_EXPLORER_EFFORT,
      DEFAULT_EXPLORER_EFFORT,
    ),
    maxTurns: Number(process.env.WHISPERR_WIZARD_MAX_TURNS) || 200,
    directOpenAIKey,
  };
}
