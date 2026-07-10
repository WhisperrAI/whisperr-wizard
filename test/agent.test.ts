import assert from "node:assert/strict";
import test from "node:test";
import { parseEventPlan } from "../src/core/agent.js";

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
