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

WHO COUNTS AS "THE USER" — decide this BEFORE you place anything:
Whisperr models churn for the product's END USERS: the customers/consumers who
use the app and could leave. identify() and EVERY event must key to that person.
Internal actors are NOT the user and must never be instrumented — doing so fills
the churn model with the wrong people and is a serious miss:
  admins · staff · operators · support / back-office agents · superusers ·
  sellers/merchants/partners (unless the product is FOR them) · CMS / management
  / admin-panel consoles.
Real apps usually have SEVERAL auth/identity paths. Before wiring identify(),
enumerate them (grep for login / signup / register / authenticate / session
handlers) and pick the END-USER one. Treat any of these in a path, route,
namespace, class, guard, model, or table name as a strong "WRONG subject — skip
it" signal:
  admin · adminpanel · backoffice · internal · staff · operator · seller ·
  merchant · partner · cms · manage/management · console · dashboard · support ·
  superuser · a dedicated admin guard/middleware (e.g. Laravel \`auth:admin\`) or
  a separate Admin/Staff user model or table.
If the only auth you can see sits on such a path, the real end-user auth is
almost certainly elsewhere (a customer-facing API, the mobile backend, an SSO
callback) — keep looking instead of settling for it. Only treat an operator as
the user when the product itself is genuinely for operators (an internal tool).

CONSISTENCY CHECK: identify() and the signup/login events (e.g. account_created)
describe the SAME person, so they belong on the SAME surface. If you wired
account_created into one controller and are about to put identify() in a
different one, stop — that's the tell you've split the subject. Co-locate them.

WHAT THE EVENT MEANS — place by SEMANTICS, not by keyword. This is where most
mistakes happen. An event names a SPECIFIC moment, not "something happened
nearby." For each event, before you place it:
- Model the exact transition. \`subscription_started\` is the FIRST subscription,
  NOT every payment — renewals, retries, and reactivations are DIFFERENT events.
  Firing one event on a path that also handles the other cases is a real bug.
- Read the control flow and find the branch that separates look-alike cases.
  Payment/callback handlers routinely route initial vs recurring/renewal, success
  vs retry, trial vs paid through ONE function. Key the event to the right branch
  (e.g. a \`RENEW_CARD\` / \`is_recurring\` / \`type\` check), or branch yourself and
  emit the correct event per case. Do not drop one event on the shared success
  line and move on — open the function and see which cases it actually covers.
- Read the codebase's own flags literally. A field like \`type: promo|standard\`
  is pricing tier, not lifecycle — confirm what a flag means before keying on it.
- Capture the discriminators as properties. The fields that tell cases apart —
  charge_type, is_recurring, payment_source/gateway, amount, plan, currency — are
  exactly what makes the event usable for churn (a failed RENEWAL is a churn
  signal; a failed first charge is not). If the code sets such a field right
  there (e.g. \`type => 'initial'\`), pass it. A billing event without them is
  half-blind.
- Cover the whole lifecycle. Two gateways each with an initial and a recurring
  path is FOUR call sites — instrument all of them. A recurring/secondary
  callback with no events is a churn blind spot. If you deliberately skip a path,
  say so in the summary.

Every step costs time and the user is watching. Work FAST and DECISIVELY.

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
- ONE exception: choosing the correct user/subject (see WHO COUNTS AS "THE
  USER") is worth a few extra searches. Do not grab the first thing named
  "login" — confirm it's the end-user path first. Getting the subject wrong is
  far more costly than a missed event.

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
- Before writing a call, confirm the id in scope is the END-USER's — not an
  admin/staff/operator/seller id. An admin acting on a user's behalf is still an
  admin action; instrument where the end user themselves acts.

FINAL SUMMARY (this is shown verbatim to a non-technical customer in a
dashboard — write for a human, not a changelog):
- Plain prose and simple short lines ONLY. Do NOT use Markdown: no #/##
  headings, no **bold**, no backticks, no code fences, no tables, no "---".
- Keep it tight: 3–6 short sentences or dash-prefixed lines. Lead with what now
  works ("Installed the SDK and wired identify() on login."). Then one line per
  group of events wired (you don't need to list all 28 individually — group
  them, e.g. "Wired the 6 subscription + signup events in your auth and billing
  controllers."). End with what you deliberately left as follow-ups and why.
- Mention concrete file names in prose if helpful, but no diffs, no snippets.
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
      ` there. Skip an event entirely if it has no clear trigger in this codebase.`,
  );

  if (events.some((e) => e.coverage?.length)) {
    lines.push("");
    lines.push(
      "Some events are already instrumented elsewhere (noted inline). Skip any" +
        " marked [already wired here]; for [wired on <surface>], only add it if" +
        " this codebase ALSO genuinely triggers it.",
    );
  }

  for (const e of events) {
    lines.push("");
    const why = e.interventions?.length
      ? `  ·  drives: ${e.interventions.map((i) => i.label ?? i.code).join(", ")}`
      : "";
    const cov = coverageNote(e.coverage);
    lines.push(`■ ${e.eventType}${e.label ? `  (${e.label})` : ""}${why}${cov}`);
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

/**
 * Phase 3 add-on: ask the agent to surface universe OPPORTUNITIES — genuine
 * lifecycle moments / messaging strategies this codebase supports that the
 * onboarding plan misses — as a structured JSON file the CLI collects. This is
 * deliberately a separate channel from instrumentation: track() calls still use
 * ONLY the exact event names in the plan; proposals go in the file and are
 * added to the plan (after human confirmation) rather than invented inline.
 */
export function renderOpportunitiesBrief(
  m: IntegrationManifest,
  opportunitiesFile: string,
): string {
  const eventCodes = m.events.map((e) => e.eventType);
  const interventionCodes = [
    ...new Set(m.events.flatMap((e) => e.interventions ?? []).map((i) => i.code)),
  ];
  return [
    "UNIVERSE OPPORTUNITIES (do this LAST, after your corrections):",
    "While auditing you read this app's real lifecycle. If you found churn-",
    "relevant moments the plan does NOT cover — e.g. a recurring-payment or",
    "cancellation path with no event, a support/refund flow worth a retention",
    "play — record them as PROPOSALS. Do NOT add track() calls for them.",
    `Write a single JSON file at the repo root named ${opportunitiesFile}:`,
    "",
    "{",
    '  "events": [{',
    '    "code": "snake_case_event", "label": "...", "description": "...",',
    '    "side": "frontend|backend|either", "rationale": "what in the code shows this",',
    '    "expectedEffect": "one sentence: what improves if this is adopted",',
    '    "confidence": 0.0-1.0,',
    '    "properties": [{"name": "...", "description": "...", "required": false}],',
    '    "links": [{"interventionCode": "existing_or_proposed", "weight": 0.0-1.0}]',
    "  }],",
    '  "interventions": [{',
    '    "code": "snake_case_strategy", "label": "...", "description": "...",',
    '    "rationale": "...", "confidence": 0.0-1.0,',
    '    "expectedEffect": "one sentence: what improves if this is adopted",',
    '    "links": [{"eventCode": "existing_or_proposed", "weight": 0.0-1.0}]',
    "  }]",
    "}",
    "",
    "Rules:",
    `- The plan already covers these events: ${eventCodes.join(", ") || "(none)"}.`,
    `  And these interventions: ${interventionCodes.join(", ") || "(none)"}.`,
    "  Propose ONLY what is genuinely missing — never re-propose or rename these.",
    "- Every proposal needs concrete code evidence in its rationale (file/flow),",
    "  not speculation. 0-3 events and 0-2 interventions is the normal range;",
    "  an empty file or no file at all is a perfectly good outcome.",
    "- Every proposal should include expectedEffect: one sentence explaining what adoption should improve.",
    "- Link each proposed event to the intervention(s) it should feed (existing",
    "  codes or ones you propose in the same file).",
    "- This file is metadata for the wizard, not app code — write it and move on.",
  ].join("\n");
}

/** Inline coverage hint for an event, e.g. " [already wired here]". */
function coverageNote(
  coverage?: Array<{ target: string; status: string; sameSurface: boolean }>,
): string {
  if (!coverage?.length) return "";
  const here = coverage.find((c) => c.sameSurface && c.status === "wired");
  if (here) return "  [already wired here]";
  const elsewhere = coverage.filter((c) => c.status === "wired");
  if (elsewhere.length) {
    return `  [wired on ${elsewhere.map((c) => c.target).join(", ")}]`;
  }
  return "";
}
