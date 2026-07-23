import assert from "node:assert/strict";
import test from "node:test";
import { parseEventPlan } from "../src/core/agent.js";
import { renderOpportunitiesBrief } from "../src/core/playbooks/shared-prompt.js";
import type { IntegrationManifest } from "../src/types.js";

test("parseEventPlan parses a valid JSON code block", () => {
  const plan = parseEventPlan(
    [
      "```json",
      "[",
      '  {"event":"trial_started","decision":"place","file":"app/auth.ts","anchor":"createTrial","properties":["plan"],"reason":"trial is created here"}',
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
      properties: ["plan"],
      reason: "trial is created here",
    },
  ]);
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
  const brief = renderOpportunitiesBrief(manifest, "whisperr-opportunities.json");

  assert.equal(
    brief.match(/"expectedEffect": "one sentence: what improves if this is adopted"/g)
      ?.length,
    2,
  );
  assert.match(
    brief,
    /Every proposal should include expectedEffect: one sentence explaining what adoption should improve\./,
  );
});
