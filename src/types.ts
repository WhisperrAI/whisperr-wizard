/**
 * Shared types for the Whisperr Wizard.
 *
 * The wizard is intentionally SDK-agnostic: the only thing that knows how a
 * given language/framework should be integrated is its `Playbook`. Everything
 * else here is the contract between the four moving parts —
 *   detection -> auth -> manifest -> agent.
 */

/** A single Whisperr SDK shipped for one language/framework. */
export interface SdkTarget {
  /** Stable id, e.g. "flutter", "web-js", "react", "react-native", "swift". */
  id: string;
  /** Human label shown in the terminal, e.g. "Flutter". */
  displayName: string;
  /** Primary language, e.g. "dart", "typescript", "swift". */
  language: string;
  /**
   * Whether the SDK actually exists yet.
   * - "available": published + the agent can install it.
   * - "planned":   we can detect the stack but the SDK isn't shipped — the
   *                wizard explains and offers to register interest instead of
   *                writing code it can't support.
   */
  availability: "available" | "planned";
}

/** Result of scanning the target repo for a known stack. */
export interface Detection {
  target: SdkTarget;
  /** 0..1 — how sure we are this playbook matches. */
  confidence: number;
  /** Human-readable evidence, e.g. ["pubspec.yaml", "lib/main.dart"]. */
  evidence: string[];
}

/**
 * A Playbook teaches the agent how to integrate ONE SDK. Adding a new SDK to
 * the wizard means adding one Playbook — nothing else changes.
 */
export interface Playbook {
  target: SdkTarget;
  /**
   * Detect whether this playbook applies to `repoPath`. Return null for no
   * match. Cheap, synchronous-ish filesystem checks only.
   */
  detect(ctx: DetectContext): Promise<Detection | null>;
  /** Package/dependency the agent should add (for display + the prompt). */
  packageRef: string;
  /**
   * The SDK-specific system-prompt fragment. This is the heart of the wizard:
   * the best-practice integration guide, API surface, and gotchas for THIS
   * SDK. It is appended to the base wizard prompt.
   */
  systemPrompt: string;
  /**
   * A command the agent can run to verify the integration compiles/builds,
   * e.g. "flutter analyze". Optional.
   */
  verifyCommand?: string;
}

export interface DetectContext {
  repoPath: string;
  /** Lazily read + cached file contents, returns "" if missing. */
  read(relPath: string): Promise<string>;
  /** True if a file or directory exists. */
  exists(relPath: string): Promise<boolean>;
  /** Glob-ish: returns matching relative paths (shallow, bounded). */
  list(relDir: string): Promise<string[]>;
}

/** One canonical event the agent must instrument, sourced from onboarding. */
export interface ManifestEvent {
  /** The exact snake_case event_type the SDK should emit. */
  eventType: string;
  /** Human label, e.g. "Subscription cancelled". */
  label?: string;
  /** What this event means / when it fires — guides placement. */
  description?: string;
  /** Suggested properties to attach, with descriptions. */
  properties?: Array<{ name: string; description?: string; required?: boolean }>;
  /** Why this event matters: the interventions it drives + weights. */
  interventions?: Array<{ code: string; label?: string; weight?: number }>;
  /** Relative importance 0..1 (max weight across its interventions). */
  importance?: number;
  /** Where this event is already instrumented across the app's surfaces. */
  coverage?: Array<{
    target: string;
    repoFingerprint?: string;
    status: string;
    sameSurface: boolean;
  }>;
}

/** Guidance for the identify() call. */
export interface ManifestIdentify {
  /** Traits onboarding expects (e.g. plan, signup_date). */
  traits?: Array<{ name: string; description?: string }>;
  /** Channels the product uses (email/sms/push) for interventions. */
  channels?: string[];
  notes?: string;
}

/**
 * The integration manifest returned by whisperr-go for the authed app.
 * This is the onboarding-derived "what to integrate" packet.
 */
export interface IntegrationManifest {
  appId: string;
  appName?: string;
  /** The ingestion API key the SDK will use (surfaced to the client here). */
  ingestionApiKey: string;
  /** Base URL the SDK should post events to. */
  ingestionBaseUrl: string;
  /** Short business-context summary to orient the agent. */
  businessContext?: string;
  identify: ManifestIdentify;
  events: ManifestEvent[];
  /** SDK ids the backend knows about, for cross-checking detection. */
  supportedTargets?: string[];
}

/** A short-lived session the CLI holds after device authorization. */
export interface WizardSession {
  /** Opaque token; used as ANTHROPIC_AUTH_TOKEN against the LLM gateway and
   *  as the bearer for manifest calls. */
  token: string;
  appId: string;
  /** Epoch seconds. */
  expiresAt: number;
}

export interface WizardConfig {
  /** Base URL of the Whisperr runtime/api (whisperr-go). */
  apiBaseUrl: string;
  /** Anthropic-compatible LLM gateway base (defaults to apiBaseUrl + /wizard/llm). */
  llmBaseUrl: string;
  /** Model id for the coding agent. */
  model: string;
  /**
   * Reasoning effort for the coding agent (pairs with adaptive thinking).
   * Default "medium" — the sweet spot for agentic, tool-heavy SDK wiring on
   * Sonnet 4.6. Bump to "high" for the hardest repos.
   */
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Max agent turns before we stop. */
  maxTurns: number;
  /**
   * Local-dev escape hatch: if set, the agent talks to Anthropic directly with
   * this key instead of going through the gateway. Mirrors production exactly
   * except for where the key lives.
   */
  directAnthropicKey?: string;
  /** Skip the browser/device flow and use a fake manifest (local dev). */
  offline: boolean;
}
