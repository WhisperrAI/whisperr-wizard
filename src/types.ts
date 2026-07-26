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

export type WireableSurface = "frontend" | "backend";
export type VariantEventRole = "required" | "optional" | "outcome";

/** Why a generated event belongs to one intervention variant. */
export interface ManifestVariantLink {
  interventionCode: string;
  interventionLabel?: string;
  variantCode: string;
  variantLabel?: string;
  role: VariantEventRole;
  rationale?: string;
}

/**
 * Review-only evidence retained on an approved suggestion. The CLI attaches it
 * to the in-memory manifest so the planner can verify the proposed placement;
 * it is never part of the backend universe graph contract.
 */
export interface ManifestReviewEvidence {
  suggestionId: string;
  side?: string;
  rationale?: string;
  expectedEffect?: string;
  confidence?: number;
  properties?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/** One exact generated event the agent must evaluate and, when possible, instrument. */
export interface ManifestEvent {
  /** Stable database identity; reports must echo this with the exact eventType. */
  eventDefinitionId: string;
  /** The exact snake_case event_type the SDK should emit. */
  eventType: string;
  /** Human label, e.g. "Subscription cancelled". */
  label?: string;
  /** What this event means / when it fires — guides placement. */
  description?: string;
  /**
   * Universe-generation advice only. The wizard must inspect the repository
   * and may confirm or reject the suggestion.
   */
  suggestedWireableOn: WireableSurface[];
  /** Typed graph relationships; never policy weights. */
  variantLinks: ManifestVariantLink[];
  /** Ephemeral approved-suggestion evidence for the local planning pass only. */
  reviewEvidence?: ManifestReviewEvidence;
  /** Where this event is already instrumented across the app's surfaces. */
  coverage?: Array<{
    target: string;
    repoFingerprint?: string;
    status: string;
    sameSurface: boolean;
    placementFiles?: string[];
  }>;
}

/** Parent/variant catalog used only for suggestion dedupe and link selection. */
export interface ManifestIntervention {
  code: string;
  label?: string;
  variants?: Array<{ code: string; label?: string }>;
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
  /** Active runtime config this manifest was compiled from. */
  configVersionId: string;
  /** Opaque revision pin echoed by every report. */
  manifestRevision: string;
  appName?: string;
  /** The ingestion API key the SDK will use (surfaced to the client here). */
  ingestionApiKey: string;
  /** Base URL the SDK should post events to. */
  ingestionBaseUrl: string;
  /** Short business-context summary to orient the agent. */
  businessContext?: string;
  identify: ManifestIdentify;
  events: ManifestEvent[];
  /** Full active-config catalog, including variants with no event links. */
  interventions?: ManifestIntervention[];
  /** SDK ids the backend knows about, for cross-checking detection. */
  supportedTargets?: string[];
}

/**
 * Universe opportunities — new events/interventions the agent spotted while
 * reading the customer's code that the onboarding-generated universe misses.
 * The agent writes these to a JSON file; after the user confirms in the CLI
 * they're staged in whisperr-go for dashboard approval. There is no immediate
 * graph-mutation fallback.
 */
export interface OpportunityEvent {
  /** snake_case canonical event code, e.g. "subscription_payment_failed". */
  code: string;
  label?: string;
  description?: string;
  /** Where the event is emitted from: "frontend" | "backend" | "either". */
  side?: string;
  /** Why the agent believes this belongs in the universe (code evidence). */
  rationale?: string;
  /** What should improve if this event is adopted. */
  expectedEffect?: string;
  /** 0..1 */
  confidence?: number;
  properties?: Array<{ name: string; description?: string; required?: boolean }>;
  /** Existing (or same-batch) interventions this event should feed. */
  links?: Array<{
    interventionCode: string;
    /** Required when linking to an existing intervention with multiple variants. */
    variantCode?: string;
    role: VariantEventRole;
    rationale?: string;
  }>;
}

export interface OpportunityIntervention {
  /** snake_case intervention code, e.g. "support_rescue". */
  code: string;
  label?: string;
  description?: string;
  rationale?: string;
  /** What should improve if this intervention is adopted. */
  expectedEffect?: string;
  /** 0..1 */
  confidence?: number;
  /** Existing (or same-batch) events that should drive this intervention. */
  links?: Array<{
    eventCode: string;
    /** Omitted for a new intervention's server-created default variant. */
    variantCode?: string;
    role: VariantEventRole;
    rationale?: string;
  }>;
}

export interface UniverseOpportunities {
  events: OpportunityEvent[];
  interventions: OpportunityIntervention[];
}

/** How one submitted suggestion resolved during staging. */
export interface StageOutcome {
  kind: "event" | "intervention";
  code: string;
  status: "staged" | "duplicate" | "invalid";
  reason?: string;
  duplicateOf?: string;
}

/** Response of POST /wizard/universe/suggestions. */
export interface StageResult {
  staged: number;
  duplicates: number;
  invalid: number;
  outcomes: StageOutcome[];
  /** Dashboard approvals-queue link, server-derived; print it so proposals
   *  never rot unseen in the queue. Absent on older backends. */
  approvalsUrl?: string;
}

/** One proposal moving through dashboard approval and integration. */
export interface SuggestionRecord {
  id: string;
  kind: "event" | "intervention";
  code: string;
  status: "proposed" | "approved" | "rejected" | "integrated";
  payload: OpportunityEvent | OpportunityIntervention;
  target?: string;
  repoFingerprint?: string;
  createdAt?: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionNote?: string;
  additionId?: string;
  integratedAt?: string;
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
  /** Model id for planning/review passes that need deeper reasoning. */
  plannerModel: string;
  /**
   * Reasoning effort for the coding agent (pairs with adaptive thinking).
   * Default "high" — the sweet spot for agentic, tool-heavy SDK wiring on
   * Sonnet 5. Drop to medium/low for cheaper runs.
   */
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Max agent turns per pass — a high safety backstop, NOT the real limiter. */
  maxTurns: number;
  /** Hard ceiling on total USD spend across all phases (the real limiter). */
  budgetUsd: number;
  /**
   * Local-dev escape hatch: if set, the agent talks to Anthropic directly with
   * this key instead of going through the gateway. Mirrors production exactly
   * except for where the key lives.
   */
  directAnthropicKey?: string;
  /** Skip the browser/device flow and use a fake manifest (local dev). */
  offline: boolean;
  /**
   * Pause on the placement plan and let the user deselect events before the
   * agent wires them. Off by default: the run's job is to just do it, and the
   * plan is printed either way so nothing is hidden.
   */
  reviewPlan: boolean;
  /** Run the self-review on the planner model at full depth. */
  strictReview: boolean;
}
