import assert from "node:assert/strict";
import test from "node:test";
import { postRunReport, scrubSummary, type RunReport } from "../src/core/report.js";
import type { WizardConfig, WizardSession } from "../src/types.js";

const config = {
  apiBaseUrl: "https://example.invalid",
  offline: false,
} as WizardConfig;

const session: WizardSession = {
  token: "test-token",
  appId: "test-app",
  expiresAt: Date.now() / 1000 + 600,
};

const report: RunReport = {
  target: "test-target",
  repo_fingerprint: "test-fingerprint",
  identify_wired: true,
  verified: true,
  cost_usd: 0,
  duration_ms: 1,
  summary: "done",
  events: [],
};

test("postRunReport returns status and bounded detail for non-2xx responses", async () => {
  const realFetch = globalThis.fetch;
  const body = "x".repeat(250);
  globalThis.fetch = (async () => new Response(body, { status: 400 })) as typeof fetch;

  try {
    const result = await postRunReport(config, session, report);

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 400);
      assert.equal(result.detail, body.slice(0, 200));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("postRunReport returns network error detail when fetch throws", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network unavailable");
  }) as typeof fetch;

  try {
    const result = await postRunReport(config, session, report);

    assert.deepEqual(result, { ok: false, detail: "network unavailable" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("postRunReport returns ok for 2xx responses", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;

  try {
    assert.deepEqual(await postRunReport(config, session, report), { ok: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("scrubSummary strips terminal control characters", () => {
  assert.equal(scrubSummary("ok\x1b[31m red\x1b[0m\nnext\x00line"), "ok red next line");
});

test("scrubSummary strips OSC sequences", () => {
  assert.equal(scrubSummary("safe\x1b]8;;https://evil.test\x07link"), "safelink");
});

test("scrubSummary redacts Anthropic-style secret keys", () => {
  assert.equal(scrubSummary("token sk-ant-abc_DEF-123"), "token [redacted]");
});

test("scrubSummary redacts generic sk tokens", () => {
  assert.equal(scrubSummary("token sk-1234567890abcdef"), "token [redacted]");
});

test("scrubSummary redacts AWS access key IDs", () => {
  assert.equal(scrubSummary("aws AKIA1234567890ABCDEF"), "aws [redacted]");
});

test("scrubSummary redacts bearer tokens", () => {
  assert.equal(scrubSummary("auth Bearer abc.DEF-123_xyz"), "auth [redacted]");
});

test("scrubSummary redacts Anthropic env variable values", () => {
  assert.equal(
    scrubSummary("ANTHROPIC_AUTH_TOKEN=secret ANTHROPIC_API_KEY='sk-ant-secret'"),
    "ANTHROPIC_AUTH_TOKEN=[redacted] ANTHROPIC_API_KEY=[redacted]",
  );
});

// The telemetry fields are the whole point of the expanded report: if any of
// them silently stops serializing, the backoffice row goes blank and nobody
// notices until they need it. This pins the wire contract with whisperr-go.
test("postRunReport serializes run telemetry and per-event skip reasons", async () => {
  const realFetch = globalThis.fetch;
  let sentBody: unknown;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    sentBody = JSON.parse(String(init.body));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    await postRunReport(config, session, {
      ...report,
      verified: false,
      events: [
        { event_type: "menu_viewed", status: "wired", file: "src/app/menu/page.tsx" },
        {
          event_type: "booking_started",
          status: "skipped",
          reason: "no clear trigger in this codebase",
        },
      ],
      wizard_version: "0.4.0",
      planner_model: "claude-opus-5",
      editor_model: "claude-sonnet-5",
      effort: "high",
      exit_class: "verify_failed",
      phase_timings: [{ phase: "Planning your integration", ms: 41230 }],
      opportunities_proposed: 4,
      opportunities_applied: 3,
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  const body = sentBody as Record<string, unknown>;
  assert.equal(body.wizard_version, "0.4.0");
  assert.equal(body.planner_model, "claude-opus-5");
  assert.equal(body.editor_model, "claude-sonnet-5");
  assert.equal(body.effort, "high");
  assert.equal(body.exit_class, "verify_failed");
  assert.equal(body.opportunities_proposed, 4);
  assert.equal(body.opportunities_applied, 3);
  // false must survive as false — it means the build broke, which is not the
  // same as null ("we couldn't tell").
  assert.equal(body.verified, false);
  assert.deepEqual(body.phase_timings, [{ phase: "Planning your integration", ms: 41230 }]);

  const events = body.events as Array<Record<string, unknown>>;
  assert.equal(events[1]?.reason, "no clear trigger in this codebase");
});

// An older backend ignores unknown keys, but a run with nothing to report
// shouldn't invent values either — omitted stays omitted.
test("postRunReport omits telemetry the run never produced", async () => {
  const realFetch = globalThis.fetch;
  let sentBody: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    sentBody = JSON.parse(String(init.body));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    await postRunReport(config, session, report);
  } finally {
    globalThis.fetch = realFetch;
  }

  for (const key of ["exit_class", "phase_timings", "opportunities_proposed"]) {
    assert.equal(key in sentBody, false, `${key} should not be sent when unset`);
  }
});

// A verify failure reports from the middle of the run and the reporter latches,
// so per-event coverage has to be derived AT report time. The first version
// read a variable assigned further down the happy path, which meant the runs
// most worth inspecting — failed builds — landed with `events: []`.
test("postRunReport sends the events it is given, including from a mid-run exit", async () => {
  const realFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  try {
    await postRunReport(config, session, {
      ...report,
      verified: false,
      exit_class: "verify_failed",
      events: [
        { event_type: "trial_started", status: "wired", file: "app/auth.ts" },
        { event_type: "seat_added", status: "skipped", reason: "no team features here" },
      ],
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  const events = bodies[0]?.events as Array<Record<string, unknown>>;
  assert.equal(bodies[0]?.exit_class, "verify_failed");
  assert.equal(events.length, 2, "a failed-verify report must still carry per-event outcomes");
  assert.equal(events[1]?.reason, "no team features here");
});
