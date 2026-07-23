import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessageDeduper,
  filterEventPlan,
  formatDuration,
  summarizeManifest,
} from "../src/cli.js";

test("summarizeManifest renders universe summary before the event list", () => {
  const summary = stripAnsi(
    summarizeManifest({
      identify: { channels: ["email"] },
      universeSummary: {
        total: 94,
        wireableHere: 31,
        derived: 41,
        otherSurface: 22,
      },
      events: [
        { eventType: "payment_failed", importance: 1 },
        { eventType: "trial_started", importance: 0.5 },
      ],
    }),
  );

  const lines = summary.split("\n");
  assert.equal(
    lines[0],
    "94 events in your universe — 31 wireable here · " +
      "41 computed by Whisperr from your raw events · 22 live on other surfaces",
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
