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
 * The manifest is served from whisperr-go's own materialized runtime config:
 *   app_runtime_event_definitions (code,label,description,event_schema_json)
 *   + app_runtime_event_aliases   (the literal event_type to emit)
 *   + app_runtime_event_weights -> app_runtime_interventions (why it matters)
 * plus a freshly minted/returned ingestion API key for the app.
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
  return (await res.json()) as IntegrationManifest;
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
    appName: "Acme (dev)",
    ingestionApiKey: "wrk_offline_demo_key_do_not_use",
    ingestionBaseUrl: config.apiBaseUrl,
    businessContext:
      "B2C subscription app. Free trial converts to a paid monthly plan. " +
      "Churn risk concentrates around trial end and the first failed payment.",
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
        eventType: "trial_started",
        label: "Trial started",
        description: "User begins their free trial.",
        importance: 0.7,
        properties: [{ name: "plan", description: "trial tier chosen" }],
        interventions: [{ code: "onboarding_nudge", label: "Onboarding nudge" }],
      },
      {
        eventType: "feature_activated",
        label: "Core feature activated",
        description:
          "User completes the core 'aha' action for the first time. Strong " +
          "retention signal; fire on first successful completion only.",
        importance: 0.6,
        interventions: [{ code: "activation_boost", label: "Activation boost" }],
      },
      {
        eventType: "payment_failed",
        label: "Payment failed",
        description:
          "A subscription charge was declined. Fire from the billing webhook " +
          "handler / failed-charge path.",
        importance: 0.95,
        properties: [
          { name: "amount", description: "charge amount" },
          { name: "reason", description: "decline reason if known" },
        ],
        interventions: [{ code: "dunning_recovery", label: "Dunning recovery", weight: 0.9 }],
      },
      {
        eventType: "subscription_cancelled",
        label: "Subscription cancelled",
        description: "User cancels their paid plan. Fire at the moment of cancel.",
        importance: 1,
        properties: [{ name: "reason", description: "stated cancel reason" }],
        interventions: [{ code: "win_back", label: "Win-back", weight: 1 }],
      },
    ],
    supportedTargets: ["flutter", "web-js", "nextjs", "react-native", "swift"],
  };
}
