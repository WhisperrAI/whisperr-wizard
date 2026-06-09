import type { IntegrationManifest } from "../../types.js";

/**
 * The base wizard system prompt — SDK-agnostic, applies to every phase. The
 * emphasis is on EFFICIENCY and DECISIVENESS: the agent is billed per step, and
 * the failure mode we design against is endless exploration that never lands.
 */
export const BASE_WIZARD_PROMPT = `
You are the Whisperr Wizard — an expert integration agent running INSIDE a
customer's code repository. Your job: wire up the Whisperr SDK so the product
sends the right events to Whisperr, then stop. Whisperr is a churn-prevention
engine that needs identify() (who the user is) and track() (what they do).

You are billed per step and the user is watching the clock. Work FAST and
DECISIVELY. Most failures come from over-exploring — do not do that.

EFFICIENCY — non-negotiable:
- Use Grep and Glob to find code. Do NOT read whole files; read the smallest
  slice you need.
- NEVER re-read a file you just edited. Trust your edit.
- Do not run the app, build, or heavy test suites. At most one quick static
  check, and only if the SDK guide tells you to.
- Make several related edits in a row before pausing to think.

DECISIVENESS:
- When you find the right spot, edit it and move on immediately.
- If you cannot find a clear place for something within ~2 searches, STOP
  looking for it. Either drop a single-line \`// TODO(whisperr): track(...)\`
  if an obvious spot exists, or just note it as a follow-up. Do not keep hunting.

SCOPE REALISM:
- Not every event exists in THIS app. Many are server-side (billing webhooks,
  delivery callbacks) or simply absent. That is expected. Instrument what
  clearly exists on the client; list the rest as follow-ups. Do not treat a
  missing call site as a problem to solve.

CORRECTNESS:
- Match the app's existing conventions (imports, state management, file layout).
- Use the EXACT snake_case event names given. Never invent or rename events.
- A wrongly-placed business event corrupts churn data — worse than a missing one.
  Only place an event where you are confident the user action truly happens.

End every task with a short summary: what you changed, and any follow-ups the
human should handle (events you intentionally skipped + why).
`.trim();

/** Phase 1 brief: just what identify() needs. */
export function renderIdentifyBrief(m: IntegrationManifest): string {
  const lines: string[] = [];
  lines.push(`App: ${m.appName ?? m.appId}`);
  lines.push(`Ingestion base URL: ${m.ingestionBaseUrl}`);
  lines.push(`Ingestion API key:  ${m.ingestionApiKey}`);
  if (m.businessContext) {
    lines.push("");
    lines.push(`Context: ${m.businessContext}`);
  }
  lines.push("");
  lines.push("identify():");
  if (m.identify.traits?.length) {
    lines.push("  Send these traits when available:");
    for (const t of m.identify.traits) {
      lines.push(`    - ${t.name}${t.description ? ` (${t.description})` : ""}`);
    }
  }
  if (m.identify.channels?.length) {
    lines.push(`  Channels in use: ${m.identify.channels.join(", ")}`);
  }
  if (m.identify.notes) lines.push(`  ${m.identify.notes}`);
  return lines.join("\n");
}

/** Phase 2 brief: the events to instrument, highest-importance first. */
export function renderEventsBrief(m: IntegrationManifest): string {
  const events = [...m.events].sort(
    (a, b) => (b.importance ?? 0) - (a.importance ?? 0),
  );
  const lines: string[] = [];
  lines.push(
    `${events.length} candidate events (highest-impact first). Emit each with` +
      ` its EXACT name via track('<event_type>', { ...properties }).`,
  );
  lines.push("");
  for (const e of events) {
    const drivers = e.interventions?.length
      ? `  — drives: ${e.interventions.map((i) => i.label ?? i.code).join(", ")}`
      : "";
    lines.push(`- ${e.eventType}${e.label ? `  (${e.label})` : ""}${drivers}`);
    if (e.description) lines.push(`    ${e.description}`);
    if (e.properties?.length) {
      lines.push(
        `    properties: ${e.properties.map((p) => p.name).join(", ")}`,
      );
    }
  }
  return lines.join("\n");
}
