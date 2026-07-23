import assert from "node:assert/strict";
import test from "node:test";
import { buildGapReport, renderGapReport } from "../src/core/gapreport.js";
import type { IntegrationManifest } from "../src/types.js";

const plainTheme = {
  bright: (text: string) => text,
  muted: (text: string) => text,
};

test("classifies fully and partially blocked interventions", () => {
  const report = buildGapReport({
    manifest: manifestWithEvents([
      event("first_signal", "fully_blocked", "Fully blocked"),
      event("second_signal", "fully_blocked", "Fully blocked"),
      event("first_signal", "partial_play", "Partial play"),
      event("third_signal", "partial_play", "Partial play"),
    ]),
    events: [
      { eventType: "first_signal", status: "skipped" },
      { eventType: "second_signal", status: "skipped" },
      { eventType: "third_signal", status: "wired" },
    ],
  });

  assert.deepEqual(
    report.interventionGaps.map(({ code, blocked, missingEvents }) => ({
      code,
      blocked,
      missingEvents: missingEvents.map((missing) => missing.code),
    })),
    [
      {
        code: "fully_blocked",
        blocked: "fully",
        missingEvents: ["first_signal", "second_signal"],
      },
      {
        code: "partial_play",
        blocked: "partially",
        missingEvents: ["first_signal"],
      },
    ],
  );
});

test("omits fully wired interventions and deduplicates shared interventions", () => {
  const report = buildGapReport({
    manifest: manifestWithEvents([
      event("one", "shared", "Shared play"),
      event("two", "shared", "Shared play"),
      event("three", "healthy", "Healthy play"),
    ]),
    events: [
      { eventType: "one", status: "skipped" },
      { eventType: "two", status: "wired" },
      { eventType: "three", status: "wired" },
    ],
  });

  assert.equal(report.interventionGaps.length, 1);
  assert.equal(report.interventionGaps[0]?.code, "shared");
  assert.deepEqual(report.interventionGaps[0]?.missingEvents, [{ code: "one" }]);
});

test("trims reasons, lowercases their first letter, and omits an absent reason clause", () => {
  const report = buildGapReport({
    manifest: manifestWithEvents([
      event("with_reason", "rescue", "Rescue"),
      event("without_reason", "rescue", "Rescue"),
    ]),
    events: [
      {
        eventType: "with_reason",
        status: "skipped",
        reason: "  Handled by the billing service.  ",
      },
      { eventType: "without_reason", status: "skipped" },
    ],
  });

  assert.equal(report.interventionGaps[0]?.missingEvents[0]?.reason, "Handled by the billing service.");
  const rendered = renderGapReport(report, plainTheme);
  assert.match(
    rendered,
    /with_reason isn't flowing yet — handled by the billing service\./,
  );
  assert.match(rendered, /without_reason isn't flowing yet\n/);
  assert.doesNotMatch(rendered, /without_reason isn't flowing yet —/);
});

test("renders surface and derived facts only when positive and computes hasContent", () => {
  const empty = buildGapReport({
    manifest: manifestWithEvents([], { otherSurface: 0, derived: 3 }),
    events: [],
  });
  assert.equal(empty.hasContent, false);

  const report = buildGapReport({
    manifest: manifestWithEvents([], { otherSurface: 1, derived: 2 }),
    events: [],
  });
  assert.equal(report.hasContent, true);
  const rendered = renderGapReport(report, plainTheme);
  assert.match(rendered, /■ 1 more event live on another surface/);
  assert.match(rendered, /2 derived signals/);

  const noCounts = renderGapReport(
    { interventionGaps: [], otherSurface: 0, derived: 0, hasContent: false },
    plainTheme,
  );
  assert.doesNotMatch(noCounts, /another surface/);
  assert.doesNotMatch(noCounts, /derived signal/);
});

test("renders the signed-off opportunity copy verbatim", () => {
  const report = buildGapReport({
    manifest: manifestWithEvents(
      [
        event("missing_one", "on_hold", "On-hold play"),
        event("missing_two", "partial", "Partial play"),
        event("working", "partial", "Partial play"),
      ],
      { otherSurface: 2, derived: 4 },
    ),
    events: [
      { eventType: "missing_one", status: "skipped" },
      { eventType: "missing_two", status: "skipped" },
      { eventType: "working", status: "wired" },
    ],
  });

  const rendered = renderGapReport(report, plainTheme);
  assert.ok(
    rendered.includes(
      "Ship the missing flow and this play switches on by itself — the strategy is already built for it.",
    ),
  );
  assert.ok(
    rendered.includes(
      "It works today, but with only part of its signal — every event above sharpens it.",
    ),
  );
  assert.ok(
    rendered.includes(
      "Run the wizard there and they join the same strategy — nothing to reconfigure.",
    ),
  );
  assert.ok(
    rendered.includes(
      "All of this is capacity your strategy already includes. Each item you unlock compounds the rest.",
    ),
  );
});

function event(eventType: string, code: string, label: string) {
  return {
    eventType,
    interventions: [{ code, label }],
  };
}

function manifestWithEvents(
  events: IntegrationManifest["events"],
  counts: { otherSurface: number; derived: number } = { otherSurface: 0, derived: 0 },
): IntegrationManifest {
  return {
    appId: "app",
    ingestionApiKey: "key",
    ingestionBaseUrl: "https://example.invalid",
    identify: {},
    events,
    universeSummary: {
      total: events.length + counts.otherSurface + counts.derived,
      wireableHere: events.length,
      otherSurface: counts.otherSurface,
      derived: counts.derived,
    },
  };
}
