import assert from "node:assert/strict";
import test from "node:test";
import { postRunReport, type RunReport } from "../src/core/report.js";
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
