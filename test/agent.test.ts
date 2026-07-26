import assert from "node:assert/strict";
import test from "node:test";
import { parseEventPlan, parsePlanningResult } from "../src/core/agent.js";
import {
  renderEventsBrief,
  renderOpportunitiesBrief,
} from "../src/core/playbooks/shared-prompt.js";
import type { IntegrationManifest } from "../src/types.js";

test("parseEventPlan parses a valid JSON code block", () => {
  const plan = parseEventPlan(
    [
      "```json",
      "[",
      '  {"event":"trial_started","decision":"place","file":"app/auth.ts","anchor":"createTrial","properties":[{"name":"plan","type":"string"}],"reason":"trial is created here"}',
      "]",
      "```",
    ].join("\n"),
  );

  assert.deepEqual(plan, [
    {
      event: "trial_started",
      decision: "place",
      file: "app/auth.ts",
      anchor: "createTrial",
      properties: [{ name: "plan", type: "string" }],
      reason: "trial is created here",
    },
  ]);
});

test("parseEventPlan keeps legacy property names without inventing types", () => {
  const plan = parseEventPlan(
    '[{"event":"trial_started","decision":"place","properties":["plan"],"reason":"here"}]',
  );
  assert.deepEqual(plan?.[0]?.properties, [{ name: "plan" }]);
});

test("parseEventPlan tolerates trailing prose after the first JSON array", () => {
  const plan = parseEventPlan(
    '[{"event":"payment_failed","decision":"skip","reason":"handled by backend webhooks"}]\nDone.',
  );

  assert.deepEqual(plan, [
    {
      event: "payment_failed",
      decision: "skip",
      reason: "handled by backend webhooks",
    },
  ]);
});

test("parseEventPlan returns null for malformed plan output", () => {
  assert.equal(parseEventPlan('[{"event":"trial_started","decision":"place"'), null);
  assert.equal(parseEventPlan("no json here"), null);
});

test("opportunities brief requests expected effects for every proposal kind", () => {
  const manifest = {
    identify: {},
    events: [],
  } as IntegrationManifest;
  const brief = renderOpportunitiesBrief(manifest);

  assert.equal(
    brief.match(/"expectedEffect"/g)?.length,
    2,
  );
  assert.match(
    brief,
    /Every proposal should include expectedEffect: one sentence on what adoption improves\./,
  );
});

// Proposals enter the approval queue, so the brief has to hold the line on
// evidence and explain that they are not event names for this run.
test("opportunities brief demands verified code evidence before proposing", () => {
  const manifest = {
    identify: {},
    events: [
      {
        eventDefinitionId: "ared_trial_started",
        eventType: "trial_started",
        suggestedWireableOn: ["frontend"],
        variantLinks: [],
      },
    ],
    interventions: [{ code: "winback_email" }],
  } as unknown as IntegrationManifest;
  const brief = renderOpportunitiesBrief(manifest);

  assert.match(brief, /VERIFY before you write it/);
  assert.match(brief, /dashboard approval/);
  assert.doesNotMatch(brief, /instrumented in this same run/);
  // Already-covered codes must be listed so they're never re-proposed.
  assert.match(brief, /trial_started/);
  assert.match(brief, /winback_email/);
});

test("events brief treats wireability as advice and renders typed variant links", () => {
  const brief = renderEventsBrief({
    businessContext: "A subscription app.",
    events: [
      {
        eventDefinitionId: "ared_payment_failed",
        eventType: "payment_failed",
        label: "Payment failed",
        description: "A renewal payment failed.",
        suggestedWireableOn: ["backend"],
        variantLinks: [
          {
            interventionCode: "dunning",
            interventionLabel: "Dunning",
            variantCode: "gentle_reminder",
            variantLabel: "Gentle reminder",
            role: "required",
            rationale: "A failed renewal should open recovery.",
          },
        ],
      },
    ],
  } as IntegrationManifest);

  assert.match(brief, /suggested surface: backend \(advisory only\)/);
  assert.match(brief, /Dunning \/ Gentle reminder \[required\]/);
  assert.match(brief, /inspect the code and capture properties actually available/);
  assert.doesNotMatch(brief, /importance|weight|properties to capture/);
});

test("events brief renders approved review evidence as planning guidance", () => {
  const brief = renderEventsBrief({
    events: [
      {
        eventDefinitionId: "ared_payment_failed",
        eventType: "payment_failed",
        suggestedWireableOn: ["backend"],
        variantLinks: [],
        reviewEvidence: {
          suggestionId: "suggestion_payment_failed",
          side: "backend",
          rationale: "Stripe webhook in src/billing/webhook.ts confirms the failure.",
          expectedEffect: "Start recovery while the failure is fresh.",
          confidence: 0.91,
          properties: [
            {
              name: "charge_type",
              description: "Initial or recurring charge.",
              required: true,
            },
          ],
        },
      },
    ],
  } as IntegrationManifest);

  assert.match(brief, /approved review evidence \(planning guidance only\)/);
  assert.match(brief, /observed surface: backend/);
  assert.match(brief, /src\/billing\/webhook\.ts confirms the failure/);
  assert.match(brief, /charge_type \(required\)/);
  assert.match(brief, /Start recovery while the failure is fresh/);
  assert.match(brief, /review confidence: 91%/);
});

test("events brief recognizes runtime existing and added coverage statuses", () => {
  const brief = renderEventsBrief({
    identify: {},
    events: [
      {
        eventDefinitionId: "ared_existing",
        eventType: "account_created",
        suggestedWireableOn: ["backend"],
        variantLinks: [],
        coverage: [
          { target: "node", status: "existing", sameSurface: true },
        ],
      },
      {
        eventDefinitionId: "ared_added_elsewhere",
        eventType: "payment_failed",
        suggestedWireableOn: ["backend"],
        variantLinks: [],
        coverage: [
          { target: "php", status: "added", sameSurface: false },
        ],
      },
    ],
  } as IntegrationManifest);

  assert.match(brief, /account_created.*\[already wired here\]/);
  assert.match(brief, /payment_failed.*\[wired on php\]/);
});

// --- parsePlanningResult ---
//
// One pass now returns the map, the plan, and the proposals together. A parse
// failure here is expensive — it costs a whole extra Sonnet pass re-exploring
// the repo — so the shape has to survive realistic model output.

const PLANNING_OUTPUT = [
  "----- REPO MAP -----",
  "framework + entry points: Next.js app router, app/layout.tsx",
  "auth flows: END-USER app/(shop)/login/route.ts; admin app/admin/login/route.ts",
  "billing surfaces: app/api/stripe/webhook/route.ts",
  "----- END REPO MAP -----",
  "",
  "```json",
  "{",
  '  "plan": [',
  '    {"event":"trial_started","decision":"place","file":"app/auth.ts","anchor":"createTrial","properties":["plan"],"reason":"trial is created here"},',
  '    {"event":"seat_added","decision":"skip","reason":"no team features in this repo"}',
  "  ],",
  '  "opportunities": {',
  '    "events": [{"code":"cart_abandoned","rationale":"checkout session expiry in webhook/route.ts"}],',
  '    "interventions": [{"code":"cart_rescue"}]',
  "  }",
  "}",
  "```",
].join("\n");

test("parsePlanningResult splits the map, the plan and the proposals", () => {
  const result = parsePlanningResult(PLANNING_OUTPUT);

  assert.match(result.repoMap, /Next\.js app router/);
  // The section markers are the CLI's own framing — they shouldn't be
  // re-injected into the downstream prompts.
  assert.doesNotMatch(result.repoMap, /----- REPO MAP -----/);
  // The JSON block belongs to the payload, not the map.
  assert.doesNotMatch(result.repoMap, /"plan"/);

  assert.equal(result.plan?.length, 2);
  assert.equal(result.plan?.[0]?.event, "trial_started");
  assert.equal(result.plan?.[0]?.decision, "place");
  assert.equal(result.plan?.[1]?.decision, "skip");

  assert.deepEqual(
    result.opportunities.events.map((e) => (e as { code: string }).code),
    ["cart_abandoned"],
  );
  assert.equal(result.opportunities.interventions.length, 1);
});

// A repo map naming a path like `app/[slug]/page.tsx` used to break plan
// parsing outright, because the first `[` in the response won the match.
test("parsePlanningResult survives brackets in the repo map", () => {
  const result = parsePlanningResult(
    [
      "directory guide: dynamic routes live in app/[slug]/page.tsx",
      "arrays like [1, 2, 3] appear in prose too",
      "```json",
      '{"plan": [{"event":"trial_started","decision":"place","reason":"here"}]}',
      "```",
    ].join("\n"),
  );

  assert.equal(result.plan?.length, 1);
  assert.equal(result.plan?.[0]?.event, "trial_started");
  assert.match(result.repoMap, /app\/\[slug\]\/page\.tsx/);
});

test("parsePlanningResult falls back to an unfenced JSON object", () => {
  const result = parsePlanningResult(
    [
      "framework + entry points: Flutter, lib/main.dart",
      "{",
      '  "plan": [{"event":"trial_started","decision":"unsure","reason":"maybe onboarding"}],',
      '  "opportunities": {"events": [], "interventions": []}',
      "}",
    ].join("\n"),
  );

  assert.equal(result.plan?.[0]?.decision, "unsure");
  assert.match(result.repoMap, /Flutter/);
});

test("parsePlanningResult falls back to the legacy bare plan array", () => {
  const result = parsePlanningResult(
    '[{"event":"trial_started","decision":"place","reason":"legacy shape"}]',
  );

  assert.equal(result.plan?.length, 1);
  assert.deepEqual(result.opportunities, { events: [], interventions: [] });
});

test("parsePlanningResult keeps the map when nothing parses", () => {
  // The pass still did the reading — losing the plan shouldn't also lose the
  // map, which is what the fallback wiring pass runs on.
  const result = parsePlanningResult("framework: Rails. I could not produce JSON.");

  assert.equal(result.plan, null);
  assert.match(result.repoMap, /Rails/);
  assert.deepEqual(result.opportunities, { events: [], interventions: [] });
});

test("parsePlanningResult ignores non-array opportunity payloads", () => {
  const result = parsePlanningResult(
    ["```json", '{"plan": [], "opportunities": {"events": "nope"}}', "```"].join("\n"),
  );

  assert.deepEqual(result.opportunities, { events: [], interventions: [] });
});


// A plan `reason` is model-authored and gets printed in the customer's
// terminal and stored in the run ledger, so it needs the same scrubbing the
// opportunities path already applies — otherwise it can restyle the UI around
// it or fake extra output lines.
test("plan reasons are stripped of terminal control sequences", () => {
  const esc = String.fromCharCode(27);
  const plan = parseEventPlan(
    JSON.stringify([
      {
        event: "trial_started",
        decision: "skip",
        reason: `${esc}[31mnot here${esc}[0m\nFAKE: everything wired`,
      },
    ]),
  );

  const reason = plan?.[0]?.reason ?? "";
  assert.equal(reason.includes(esc), false, "ANSI escapes must not survive");
  assert.equal(reason.includes("\n"), false, "newlines must not survive");
  assert.match(reason, /not here/);
});
