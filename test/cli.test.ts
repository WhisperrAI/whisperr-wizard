import assert from "node:assert/strict";
import test from "node:test";
import { createMessageDeduper, summarizeManifest } from "../src/cli.js";

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

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}
