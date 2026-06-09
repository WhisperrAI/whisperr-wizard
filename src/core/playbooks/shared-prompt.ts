import type { IntegrationManifest } from "../../types.js";

/**
 * The base wizard system prompt — SDK-agnostic, applies to every phase. It
 * gives the agent its MISSION (so it understands what it's doing and why), then
 * the efficiency + decisiveness rules that keep it from exploring forever.
 */
export const BASE_WIZARD_PROMPT = `
You are the Whisperr Wizard — an expert integration agent running INSIDE a
customer's code repository.

MISSION:
Whisperr predicts churn and fires retention interventions from product events.
Two things make that work: (1) identify() tying events to a real user, and
(2) track() events fired at the right moment WITH the properties that give them
meaning. A well-placed event carrying its real properties is gold; a bare or
mis-placed event is noise that corrupts the customer's churn data. Your mission:
wire up everything in the plan that genuinely exists in this app, and for each
event you place, capture the properties that are actually available right there
in the code. You will NOT find everything — some events live server-side or
aren't in this codebase at all. That is expected and fine. Get what is here, get
it right, report the rest. Know exactly what you're doing; never hunt blindly.

You are billed per step and the user is watching. Work FAST and DECISIVELY.

EFFICIENCY — non-negotiable:
- Use Grep and Glob to find code. Do NOT read whole files; read the smallest
  slice you need.
- NEVER re-read a file you just edited. Trust your edit.
- Do not run the app, build, or the analyzer/test suites. The human reviews the
  diff.
- Make several related edits in a row before pausing to think.

DECISIVENESS:
- When you find the right spot, edit it and move on immediately.
- If you can't find a clear place for something within ~2 searches, STOP looking.
  Leave a one-line \`// TODO(whisperr): ...\` only if an obvious spot exists,
  otherwise just note it as a follow-up. Do not keep hunting.

PROPERTY CAPTURE (this is the craft):
- For each event you place, look at what's in scope AT THAT CALL SITE — function
  arguments, the object/model/state you're inside, nearby local variables — and
  populate every listed property you can source from those values.
- Omit a property only if it genuinely isn't available there. Do NOT fetch,
  compute, or invent data to fill a property, and do NOT wander off to find it.
- If a property marked (required) can't be sourced at your chosen site, that's a
  strong hint you've picked the wrong site — reconsider; if it's still the best
  spot, add the track() call and note the missing property.

CORRECTNESS:
- Match the app's existing conventions (imports, state management, file layout).
- Use the EXACT snake_case event names given. Never invent or rename events.
- Only place an event where you're confident the user action truly happens.

End every task with a short summary: what you changed, which events you wired
(and the properties you attached), and the follow-ups you intentionally left.
`.trim();

/** Phase 1 brief: just what identify() needs. */
export function renderIdentifyBrief(m: IntegrationManifest): string {
  const lines: string[] = [];
  lines.push(`App: ${m.appName ?? m.appId}`);
  lines.push(`Ingestion base URL: ${m.ingestionBaseUrl}`);
  lines.push(`Ingestion API key:  ${m.ingestionApiKey}`);
  if (m.businessContext) {
    lines.push("");
    lines.push(`Business context: ${m.businessContext}`);
  }
  lines.push("");
  lines.push("identify():");
  if (m.identify.traits?.length) {
    lines.push("  Send these traits when readily available:");
    for (const t of m.identify.traits) {
      lines.push(`    - ${t.name}${t.description ? ` — ${t.description}` : ""}`);
    }
  }
  if (m.identify.channels?.length) {
    lines.push(`  Channels in use: ${m.identify.channels.join(", ")}`);
  }
  if (m.identify.notes) lines.push(`  ${m.identify.notes}`);
  return lines.join("\n");
}

/**
 * Phase 2 brief: the events to instrument, highest-importance first, each with
 * its meaning, the interventions it drives (the "why"), and the exact
 * properties to capture if present at the call site.
 */
export function renderEventsBrief(m: IntegrationManifest): string {
  const events = [...m.events].sort(
    (a, b) => (b.importance ?? 0) - (a.importance ?? 0),
  );

  const lines: string[] = [];
  if (m.businessContext) {
    lines.push(`Business context: ${m.businessContext}`);
    lines.push("");
  }
  lines.push(
    `${events.length} candidate events (highest-impact first). For each: fire` +
      ` track('<event_type>', { ...properties }) at the real moment it happens,` +
      ` and attach every listed property you can source from values in scope` +
      ` there. Skip an event entirely if it has no clear client-side trigger.`,
  );

  for (const e of events) {
    lines.push("");
    const why = e.interventions?.length
      ? `  ·  drives: ${e.interventions.map((i) => i.label ?? i.code).join(", ")}`
      : "";
    lines.push(`■ ${e.eventType}${e.label ? `  (${e.label})` : ""}${why}`);
    if (e.description) lines.push(`  ${e.description}`);
    if (e.properties?.length) {
      lines.push("  properties to capture if available:");
      for (const p of e.properties) {
        const req = p.required ? " (required)" : "";
        const desc = p.description ? ` — ${p.description}` : "";
        lines.push(`    · ${p.name}${req}${desc}`);
      }
    }
  }
  return lines.join("\n");
}
