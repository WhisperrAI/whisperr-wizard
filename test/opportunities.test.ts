import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPPORTUNITIES_FILE,
  collectOpportunities,
  normalizeCode,
  sanitizeOpportunities,
  submitAdditions,
} from "../src/core/opportunities.js";
import type { IntegrationManifest, WizardConfig, WizardSession } from "../src/types.js";

const manifest: IntegrationManifest = {
  appId: "app_1",
  ingestionApiKey: "pk_test",
  ingestionBaseUrl: "https://api.whisperr.net",
  identify: {},
  events: [
    {
      eventType: "subscription_cancelled",
      interventions: [{ code: "retention", weight: 0.8 }],
    },
    { eventType: "viewed_pricing", interventions: [{ code: "monetization" }] },
  ],
};

const config = {
  apiBaseUrl: "https://api.whisperr.net",
  offline: false,
} as WizardConfig;

const session: WizardSession = {
  token: "wzs_test",
  appId: "app_1",
  expiresAt: Date.now() / 1000 + 600,
};

test("normalizeCode mirrors whisperr-go's NormalizeCode", () => {
  assert.equal(normalizeCode("Payment Failed"), "payment_failed");
  assert.equal(normalizeCode("  sub.cancelled/v2  "), "sub_cancelled_v2");
  assert.equal(normalizeCode("__weird--CODE__"), "weird_code");
  assert.equal(normalizeCode("---"), "");
});

test("sanitizeOpportunities keeps valid proposals and normalizes codes", () => {
  const out = sanitizeOpportunities(
    {
      events: [
        {
          code: "Payment Failed",
          side: "Backend",
          confidence: 1.4,
          rationale: "billing webhook has no event",
          properties: [{ name: "charge_type", required: true }, "plan", { bogus: true }],
          links: [{ interventionCode: "Retention", weight: 0.6 }, { weight: 0.2 }],
        },
      ],
      interventions: [
        {
          code: "support_rescue",
          links: [{ eventCode: "payment_failed" }],
        },
      ],
    },
    manifest,
  );

  assert.equal(out.events.length, 1);
  const ev = out.events[0]!;
  assert.equal(ev.code, "payment_failed");
  assert.equal(ev.side, "backend");
  assert.equal(ev.confidence, 1); // clamped
  assert.deepEqual(ev.properties, [
    { name: "charge_type", required: true },
    { name: "plan" },
  ]);
  assert.deepEqual(ev.links, [{ interventionCode: "retention", weight: 0.6 }]);

  assert.equal(out.interventions.length, 1);
  assert.deepEqual(out.interventions[0]!.links, [{ eventCode: "payment_failed" }]);
});

test("sanitizeOpportunities drops manifest duplicates, repeats, and junk", () => {
  const out = sanitizeOpportunities(
    {
      events: [
        { code: "subscription_cancelled" }, // already in the manifest
        { code: "Viewed Pricing" }, // manifest duplicate after normalization
        { code: "trial_expired" },
        { code: "trial_expired" }, // repeat within the proposal set
        { code: "   " }, // empty after normalization
        "nonsense",
      ],
      interventions: [
        { code: "retention" }, // existing intervention
        { code: "winback" },
      ],
    },
    manifest,
  );
  assert.deepEqual(
    out.events.map((e) => e.code),
    ["trial_expired"],
  );
  assert.deepEqual(
    out.interventions.map((i) => i.code),
    ["winback"],
  );
});

test("sanitizeOpportunities tolerates a completely malformed document", () => {
  for (const doc of [null, 42, "hi", [], { events: "nope", interventions: 7 }]) {
    const out = sanitizeOpportunities(doc, manifest);
    assert.deepEqual(out, { events: [], interventions: [] });
  }
});

test("collectOpportunities reads then deletes the proposals file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsp-opps-"));
  await writeFile(
    join(dir, OPPORTUNITIES_FILE),
    JSON.stringify({ events: [{ code: "trial_expired" }], interventions: [] }),
  );

  const out = await collectOpportunities(dir, manifest);
  assert.deepEqual(
    out.events.map((e) => e.code),
    ["trial_expired"],
  );
  // The file must never linger in the customer's working tree.
  assert.deepEqual(await readdir(dir), []);
});

test("collectOpportunities returns empty when the file is absent or invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsp-opps-"));
  assert.deepEqual(await collectOpportunities(dir, manifest), {
    events: [],
    interventions: [],
  });

  await writeFile(join(dir, OPPORTUNITIES_FILE), "not json {");
  assert.deepEqual(await collectOpportunities(dir, manifest), {
    events: [],
    interventions: [],
  });
  assert.deepEqual(await readdir(dir), []);
});

test("submitAdditions posts the whisperr-go contract and returns its result", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        additionId: "wua_1",
        configVersionId: "arcv_1",
        applied: 2,
        duplicates: 0,
        invalid: 0,
        outcomes: [
          { kind: "event", code: "trial_expired", status: "applied" },
          { kind: "link", code: "trial_expired -> retention", status: "applied" },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const result = await submitAdditions(config, session, "nextjs", "fp-1", {
      events: [
        { code: "trial_expired", links: [{ interventionCode: "retention", weight: 0.4 }] },
      ],
      interventions: [],
    });
    assert.equal(result.applied, 2);
    assert.equal(result.outcomes.length, 2);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.whisperr.net/wizard/universe/additions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer wzs_test");
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body, {
      target: "nextjs",
      repoFingerprint: "fp-1",
      events: [
        { code: "trial_expired", links: [{ interventionCode: "retention", weight: 0.4 }] },
      ],
      interventions: [],
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("submitAdditions surfaces backend failures", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "onboarding_incomplete" }), { status: 409 })) as typeof fetch;
  try {
    await assert.rejects(
      submitAdditions(config, session, "nextjs", "fp-1", {
        events: [{ code: "trial_expired" }],
        interventions: [],
      }),
      /409/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
