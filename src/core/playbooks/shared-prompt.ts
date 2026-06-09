import type { IntegrationManifest } from "../../types.js";

/**
 * The base wizard system prompt — SDK-agnostic. Each playbook appends its own
 * SDK-specific guide on top of this. The manifest (events/identify/key) is
 * injected separately as a structured user message so it stays cache-friendly
 * and unambiguous.
 */
export const BASE_WIZARD_PROMPT = `
You are the Whisperr Wizard — an expert integration agent. You are running
INSIDE a customer's code repository. Your single job: integrate the Whisperr SDK
so the product starts sending the right events to Whisperr, then stop.

Whisperr is a churn-prevention engine. It needs two things from the app:
  1. identify() — tell Whisperr who the end-user is (a stable external user id)
     plus traits and contact channels, called right after the user is known
     (login / session restore / signup).
  2. track() — emit the specific business events listed in the integration
     manifest, at the exact places in the code where those user actions happen.
     These named events drive the customer's churn interventions, so placing
     them at the correct call sites matters more than anything else you do.

Operating rules:
- Work autonomously. Make the edits directly; do not ask for confirmation.
- Be surgical. Add the SDK dependency, initialize it once at app startup, wire
  identify() where the user becomes known, and add track() calls for the
  manifest events. Do not refactor unrelated code, restyle, or "improve" things.
- Find the RIGHT call site for each named event by reading the code, not by
  guessing. If you genuinely cannot find where an event occurs, add a clearly
  commented TODO with the exact Whisperr call to make, and report it at the end
  rather than firing the event from a wrong place.
- Never invent event types. Use the exact snake_case event_type strings from the
  manifest. Custom data goes under properties.
- Keep the API key out of source where the SDK/platform supports env/secrets;
  otherwise place it where the manifest guidance says and flag it.
- Match the repository's existing conventions (imports, formatting, state
  management, file layout).

When done, output a concise summary:
  - files changed
  - where identify() was wired
  - each manifest event -> the call site you instrumented (or TODO + reason)
  - any follow-ups the human must do (env var, push token, etc.)
`.trim();

/** Render the manifest into a compact, agent-readable brief. */
export function renderManifestBrief(m: IntegrationManifest): string {
  const lines: string[] = [];
  lines.push(`# Whisperr integration manifest for app: ${m.appName ?? m.appId}`);
  lines.push("");
  lines.push(`Ingestion base URL: ${m.ingestionBaseUrl}`);
  lines.push(`Ingestion API key:  ${m.ingestionApiKey}`);
  if (m.businessContext) {
    lines.push("");
    lines.push("## Business context");
    lines.push(m.businessContext);
  }

  lines.push("");
  lines.push("## identify()");
  if (m.identify.traits?.length) {
    lines.push("Traits to send when available:");
    for (const t of m.identify.traits) {
      lines.push(`  - ${t.name}${t.description ? ` — ${t.description}` : ""}`);
    }
  }
  if (m.identify.channels?.length) {
    lines.push(`Channels in use: ${m.identify.channels.join(", ")}`);
  }
  if (m.identify.notes) lines.push(m.identify.notes);

  lines.push("");
  lines.push("## Events to instrument (use these exact event_type strings)");
  // Most important first so the agent prioritizes the load-bearing events.
  const events = [...m.events].sort(
    (a, b) => (b.importance ?? 0) - (a.importance ?? 0),
  );
  for (const e of events) {
    lines.push("");
    lines.push(`### ${e.eventType}${e.label ? `  (${e.label})` : ""}`);
    if (e.description) lines.push(e.description);
    if (e.properties?.length) {
      lines.push("Properties:");
      for (const p of e.properties) {
        lines.push(
          `  - ${p.name}${p.required ? " (required)" : ""}${
            p.description ? ` — ${p.description}` : ""
          }`,
        );
      }
    }
    if (e.interventions?.length) {
      const drv = e.interventions
        .map((i) => i.label ?? i.code)
        .join(", ");
      lines.push(`Drives: ${drv}`);
    }
  }

  return lines.join("\n");
}
