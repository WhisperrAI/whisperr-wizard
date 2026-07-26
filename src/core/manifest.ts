import type {
  IntegrationManifest,
  WizardConfig,
  WizardSession,
} from "../types.js";

/**
 * Fetch the integration manifest for the authed app from whisperr-go.
 *
 * Backend contract (Phase 0, whisperr-go):
 *   GET {api}/v1/wizard/manifest         (Authorization: Bearer <wizard token>)
 *     ?target=<detected sdk id>          (optional hint)
 *   -> IntegrationManifest
 *
 * The manifest is served from whisperr-go's focused universe graph:
 * event definitions + typed intervention-variant links. `eventType` is the
 * literal SDK event name; aliases and payload contracts do not exist here.
 */
export async function fetchManifest(
  config: WizardConfig,
  session: WizardSession,
  targetId?: string,
  repoFingerprint?: string,
): Promise<IntegrationManifest> {
  if (config.offline) return mockManifest(session.appId, config);

  const url = new URL(`${config.apiBaseUrl}/wizard/manifest`);
  if (targetId) url.searchParams.set("target", targetId);
  if (repoFingerprint) url.searchParams.set("repo", repoFingerprint);

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  if (!res.ok) {
    throw new Error(
      `Could not load your integration manifest (${res.status}). ` +
        `Make sure onboarding is complete for this app.`,
    );
  }
  return parseManifest(await res.json());
}

/**
 * Fail closed on identity/revision fields. A report against a guessed event ID
 * or stale config is worse than stopping before edits begin.
 */
export function parseManifest(value: unknown): IntegrationManifest {
  if (!isRecord(value)) throw new Error("Invalid integration manifest: expected an object");
  requireString(value, "appId");
  requireString(value, "configVersionId");
  requireString(value, "manifestRevision");
  requireString(value, "ingestionApiKey");
  requireString(value, "ingestionBaseUrl");
  if (!isRecord(value.identify)) {
    throw new Error("Invalid integration manifest: identify must be an object");
  }
  if (!Array.isArray(value.events)) {
    throw new Error("Invalid integration manifest: events must be an array");
  }

  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const [index, rawEvent] of value.events.entries()) {
    if (!isRecord(rawEvent)) {
      throw new Error(`Invalid integration manifest: events[${index}] must be an object`);
    }
    const id = requireString(rawEvent, "eventDefinitionId", `events[${index}]`);
    const code = requireString(rawEvent, "eventType", `events[${index}]`);
    if (ids.has(id)) {
      throw new Error(`Invalid integration manifest: duplicate eventDefinitionId ${id}`);
    }
    if (codes.has(code)) {
      throw new Error(`Invalid integration manifest: duplicate eventType ${code}`);
    }
    ids.add(id);
    codes.add(code);

    if (
      !Array.isArray(rawEvent.suggestedWireableOn) ||
      rawEvent.suggestedWireableOn.length === 0 ||
      rawEvent.suggestedWireableOn.some(
        (surface) => surface !== "frontend" && surface !== "backend",
      )
    ) {
      throw new Error(
        `Invalid integration manifest: events[${index}].suggestedWireableOn`,
      );
    }
    if (!Array.isArray(rawEvent.variantLinks)) {
      throw new Error(`Invalid integration manifest: events[${index}].variantLinks`);
    }
    for (const [linkIndex, rawLink] of rawEvent.variantLinks.entries()) {
      if (!isRecord(rawLink)) {
        throw new Error(
          `Invalid integration manifest: events[${index}].variantLinks[${linkIndex}]`,
        );
      }
      requireString(
        rawLink,
        "interventionCode",
        `events[${index}].variantLinks[${linkIndex}]`,
      );
      requireString(
        rawLink,
        "variantCode",
        `events[${index}].variantLinks[${linkIndex}]`,
      );
      if (
        rawLink.role !== "required" &&
        rawLink.role !== "optional" &&
        rawLink.role !== "outcome"
      ) {
        throw new Error(
          `Invalid integration manifest: events[${index}].variantLinks[${linkIndex}].role`,
        );
      }
    }
  }
  return value as unknown as IntegrationManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  path = "manifest",
): string {
  const raw = value[field];
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`Invalid integration manifest: ${path}.${field}`);
  }
  return raw;
}

/**
 * A representative manifest for --offline runs and demos. Shaped exactly like
 * what whisperr-go will return, so the agent + UI behave identically.
 */
export function mockManifest(
  appId: string,
  config: WizardConfig,
): IntegrationManifest {
  return {
    appId,
    configVersionId: "arcv_offline_demo",
    manifestRevision: "offline-demo-v2",
    appName: "Acme (dev)",
    ingestionApiKey: "wrk_offline_demo_key_do_not_use",
    ingestionBaseUrl: config.apiBaseUrl,
    // Same labelled shape whisperr-go renders from the app's onboarding
    // business context, so an offline run exercises the real prompt.
    businessContext: [
      "Product: Acme (Acme Inc)",
      "What it does: B2C subscription app; a free trial converts to a paid monthly plan",
      "Industry: Software / Productivity",
      "Who the paying end user is: individual consumers on the trial-to-paid path",
      "How it charges: monthly subscription",
      "Activation moment: first project created after signup",
      "Churn-risk signals onboarding identified: trial ending unused; first failed payment",
      "Healthy-usage signals: weekly active project edits",
    ].join("\n"),
    identify: {
      traits: [
        { name: "plan", description: "free | trial | pro" },
        { name: "signup_date", description: "ISO date the user signed up" },
      ],
      channels: ["email", "push"],
      notes:
        "Call identify on login and on session restore. Send email always; " +
        "push token when notifications are enabled.",
    },
    events: [
      {
        eventDefinitionId: "ared_offline_trial_started",
        eventType: "trial_started",
        label: "Trial started",
        description: "User begins their free trial.",
        suggestedWireableOn: ["frontend", "backend"],
        variantLinks: [
          {
            interventionCode: "onboarding_nudge",
            interventionLabel: "Onboarding nudge",
            variantCode: "default",
            variantLabel: "Default",
            role: "required",
            rationale: "Starting a trial makes the onboarding nudge relevant.",
          },
        ],
      },
      {
        eventDefinitionId: "ared_offline_feature_activated",
        eventType: "feature_activated",
        label: "Core feature activated",
        description:
          "User completes the core 'aha' action for the first time. Strong " +
          "retention signal; fire on first successful completion only.",
        suggestedWireableOn: ["frontend", "backend"],
        variantLinks: [
          {
            interventionCode: "activation_boost",
            interventionLabel: "Activation boost",
            variantCode: "default",
            variantLabel: "Default",
            role: "required",
          },
        ],
      },
      {
        eventDefinitionId: "ared_offline_payment_failed",
        eventType: "payment_failed",
        label: "Payment failed",
        description:
          "A subscription charge was declined. Fire from the billing webhook " +
          "handler / failed-charge path.",
        suggestedWireableOn: ["backend"],
        variantLinks: [
          {
            interventionCode: "dunning_recovery",
            interventionLabel: "Dunning recovery",
            variantCode: "default",
            variantLabel: "Default",
            role: "required",
          },
        ],
      },
      {
        eventDefinitionId: "ared_offline_subscription_cancelled",
        eventType: "subscription_cancelled",
        label: "Subscription cancelled",
        description: "User cancels their paid plan. Fire at the moment of cancel.",
        suggestedWireableOn: ["frontend", "backend"],
        variantLinks: [
          {
            interventionCode: "win_back",
            interventionLabel: "Win-back",
            variantCode: "default",
            variantLabel: "Default",
            role: "required",
          },
        ],
      },
    ],
    interventions: [
      { code: "onboarding_nudge", variants: [{ code: "default" }] },
      { code: "activation_boost", variants: [{ code: "default" }] },
      { code: "dunning_recovery", variants: [{ code: "default" }] },
      { code: "win_back", variants: [{ code: "default" }] },
    ],
    supportedTargets: ["flutter", "web-js", "nextjs", "react-native", "swift"],
  };
}
