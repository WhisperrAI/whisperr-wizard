import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessageDeduper,
  filterEventPlan,
  formatDuration,
  summarizeManifest,
} from "../src/cli.js";

test("summarizeManifest renders the focused event list without legacy universe counts", () => {
  const summary = stripAnsi(
    summarizeManifest({
      identify: { channels: ["email"] },
      events: [
        { eventType: "payment_failed" },
        { eventType: "trial_started" },
      ],
    }),
  );

  const lines = summary.split("\n");
  assert.equal(
    lines[0],
    "identify() + 2 events",
  );
  assert.deepEqual(lines.slice(1), [
    "• payment_failed",
    "• trial_started",
    "channels: email",
  ]);
});

test("createMessageDeduper returns only changed messages", () => {
  const next = createMessageDeduper();

  assert.equal(next("phase one"), "phase one");
  assert.equal(next("phase one"), null);
  assert.equal(next("phase two"), "phase two");
  assert.equal(next("phase two"), null);
});

test("formatDuration formats seconds and zero-padded minute durations", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(41_400), "41s");
  assert.equal(formatDuration(59_999), "60s");
  assert.equal(formatDuration(60_000), "1m00s");
  assert.equal(formatDuration(221_500), "3m42s");
});

test("filterEventPlan turns deselected placements into skips", () => {
  const plan = [
    {
      event: "account_created",
      decision: "place" as const,
      file: "src/auth.ts",
      anchor: "signUp",
      reason: "Account is persisted here.",
    },
    {
      event: "trial_started",
      decision: "place" as const,
      file: "src/trials.ts",
      anchor: "startTrial",
      reason: "Trial starts here.",
    },
    {
      event: "invoice_paid",
      decision: "skip" as const,
      reason: "Handled by the billing service.",
    },
  ];

  const filtered = filterEventPlan(plan, ["trial_started"]);

  assert.deepEqual(filtered, [
    {
      event: "account_created",
      decision: "skip",
      file: "src/auth.ts",
      anchor: "signUp",
      reason: "Deselected in plan review.",
    },
    plan[1],
    plan[2],
  ]);
  assert.equal(plan[0].decision, "place");
});

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}
