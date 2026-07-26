import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  enrichManifestWithApprovedSuggestions,
  fetchSuggestions,
  isExactCode,
  markSuggestionIntegrated,
  sanitizeOpportunities,
  suggestionsReadyToMarkIntegrated,
  submitSuggestions,
} from "../src/core/opportunities.js";
import { runVerifyCommand, verdictToVerified } from "../src/core/postflight.js";
import type {
  IntegrationManifest,
  SuggestionRecord,
  WizardConfig,
  WizardSession,
} from "../src/types.js";

const manifest: IntegrationManifest = {
  appId: "app_1",
  configVersionId: "arcv_1",
  manifestRevision: "manifest-r1",
  ingestionApiKey: "pk_test",
  ingestionBaseUrl: "https://api.whisperr.net",
  identify: {},
  events: [
    {
      eventDefinitionId: "ared_subscription_cancelled",
      eventType: "subscription_cancelled",
      suggestedWireableOn: ["backend"],
      variantLinks: [
        {
          interventionCode: "retention",
          variantCode: "winback",
          role: "required",
        },
      ],
    },
    {
      eventDefinitionId: "ared_viewed_pricing",
      eventType: "viewed_pricing",
      suggestedWireableOn: ["frontend"],
      variantLinks: [
        {
          interventionCode: "monetization",
          variantCode: "pricing_nudge",
          role: "optional",
        },
      ],
    },
  ],
  interventions: [
    {
      code: "retention",
      variants: [
        { code: "winback" },
        { code: "cancellation_rescue" },
      ],
    },
    { code: "monetization", variants: [{ code: "pricing_nudge" }] },
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
const manifestPin = {
  configVersionId: manifest.configVersionId,
  manifestRevision: manifest.manifestRevision,
};

test("approved event evidence enriches only the matching in-memory manifest event", () => {
  const approved: SuggestionRecord[] = [
    {
      id: "suggestion_payment_failed",
      kind: "event",
      code: "subscription_cancelled",
      status: "approved",
      payload: {
        code: "subscription_cancelled",
        side: "backend",
        rationale: "Stripe cancellation webhook in src/billing/webhook.ts.",
        expectedEffect: "Trigger win-back at the cancellation moment.",
        confidence: 0.94,
        properties: [
          {
            name: "plan",
            description: "The cancelled subscription plan.",
            required: true,
          },
        ],
      },
    },
    {
      id: "suggestion_unmatched",
      kind: "event",
      code: "not_in_manifest",
      status: "approved",
      payload: {
        code: "not_in_manifest",
        rationale: "This must not leak onto a different event.",
      },
    },
  ];

  const enriched = enrichManifestWithApprovedSuggestions(manifest, approved);

  assert.notEqual(enriched, manifest);
  assert.notEqual(enriched.events, manifest.events);
  assert.equal(manifest.events[0]?.reviewEvidence, undefined);
  assert.deepEqual(enriched.events[0]?.reviewEvidence, {
    suggestionId: "suggestion_payment_failed",
    side: "backend",
    rationale: "Stripe cancellation webhook in src/billing/webhook.ts.",
    expectedEffect: "Trigger win-back at the cancellation moment.",
    confidence: 0.94,
    properties: [
      {
        name: "plan",
        description: "The cancelled subscription plan.",
        required: true,
      },
    ],
  });
  assert.equal(enriched.events[1]?.reviewEvidence, undefined);
});

test("intervention integration waits for every required linked event", () => {
  const readinessManifest: IntegrationManifest = {
    ...manifest,
    events: [
      {
        eventDefinitionId: "ared_subscription_cancelled",
        eventType: "subscription_cancelled",
        suggestedWireableOn: ["backend"],
        variantLinks: [
          {
            interventionCode: "winback",
            variantCode: "winback",
            role: "required",
          },
          {
            interventionCode: "retention_rescue",
            variantCode: "retention_rescue",
            role: "required",
          },
        ],
      },
      {
        eventDefinitionId: "ared_payment_failed",
        eventType: "payment_failed",
        suggestedWireableOn: ["backend"],
        variantLinks: [
          {
            interventionCode: "retention_rescue",
            variantCode: "retention_rescue",
            role: "required",
          },
        ],
      },
      {
        eventDefinitionId: "ared_viewed_pricing",
        eventType: "viewed_pricing",
        suggestedWireableOn: ["frontend"],
        variantLinks: [
          {
            interventionCode: "pricing_nudge",
            variantCode: "pricing_nudge",
            role: "optional",
          },
        ],
      },
    ],
  };
  const approved: SuggestionRecord[] = [
    {
      id: "suggestion_event",
      kind: "event",
      code: "subscription_cancelled",
      status: "approved",
      payload: { code: "subscription_cancelled" },
    },
    {
      id: "suggestion_ready_intervention",
      kind: "intervention",
      code: "winback",
      status: "approved",
      payload: {
        code: "winback",
        // The required link was declared on the event suggestion. Readiness
        // must use the exact post-approval manifest, not this one-sided payload.
        links: [],
      },
    },
    {
      id: "suggestion_blocked_intervention",
      kind: "intervention",
      code: "retention_rescue",
      status: "approved",
      payload: {
        code: "retention_rescue",
        // This payload omits payment_failed, but the approved manifest has both
        // required links, so one covered event must not advance the lifecycle.
        links: [
          { eventCode: "subscription_cancelled", role: "required" },
        ],
      },
    },
    {
      id: "suggestion_no_required_dependencies",
      kind: "intervention",
      code: "pricing_nudge",
      status: "approved",
      payload: {
        code: "pricing_nudge",
        links: [
          { eventCode: "viewed_pricing", role: "optional" },
        ],
      },
    },
  ];

  const ready = suggestionsReadyToMarkIntegrated(
    approved,
    readinessManifest,
    new Set(["subscription_cancelled"]),
    new Set(["subscription_cancelled"]),
  );

  assert.deepEqual(
    ready.map((suggestion) => suggestion.id),
    ["suggestion_event", "suggestion_ready_intervention"],
  );
});

test("isExactCode mirrors the runtime graph's non-normalizing contract", () => {
  assert.equal(isExactCode("payment_failed"), true);
  assert.equal(isExactCode("event2_started"), true);
  assert.equal(isExactCode("Payment Failed"), false);
  assert.equal(isExactCode(" payment_failed "), false);
  assert.equal(isExactCode("sub.cancelled/v2"), false);
  assert.equal(isExactCode("__weird_code__"), false);
  assert.equal(isExactCode("---"), false);
});

test("sanitizeOpportunities keeps valid proposals without rewriting codes", () => {
  const out = sanitizeOpportunities(
    {
      events: [
        {
          code: "payment_failed",
          side: "Backend",
          confidence: 1.4,
          rationale: "billing webhook has no event",
          properties: [{ name: "charge_type", required: true }, "plan", { bogus: true }],
          links: [
            {
              interventionCode: "retention",
              variantCode: "winback",
              role: "Required",
              rationale: "The failed payment opens a recovery moment.",
            },
            { interventionCode: "retention", weight: 0.2 },
          ],
        },
      ],
      interventions: [
        {
          code: "support_rescue",
          links: [
            {
              eventCode: "payment_failed",
              role: "outcome",
              rationale: "Recovery should lead to a successful payment.",
            },
          ],
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
  assert.deepEqual(ev.links, [
    {
      interventionCode: "retention",
      variantCode: "winback",
      role: "required",
      rationale: "The failed payment opens a recovery moment.",
    },
  ]);

  assert.equal(out.interventions.length, 1);
  assert.deepEqual(out.interventions[0]!.links, [
    {
      eventCode: "payment_failed",
      role: "outcome",
      rationale: "Recovery should lead to a successful payment.",
    },
  ]);
});

test("sanitizeOpportunities drops exact manifest duplicates, repeats, and junk", () => {
  const out = sanitizeOpportunities(
    {
      events: [
        { code: "subscription_cancelled" }, // already in the manifest
        { code: "viewed_pricing" }, // exact manifest duplicate
        { code: "trial_expired" },
        { code: "trial_expired" }, // repeat within the proposal set
        { code: "" },
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

test("sanitizeOpportunities dedups against the top-level intervention catalog", () => {
  // A wizard-added intervention with no event links surfaces only in the
  // manifest's top-level catalog, never nested under an event. The pre-filter
  // must still treat a re-proposal of it as a duplicate.
  const withCatalog: IntegrationManifest = {
    ...manifest,
    interventions: [{ code: "support_rescue", label: "Support Rescue" }],
  };
  const out = sanitizeOpportunities(
    {
      interventions: [
        { code: "support_rescue" },
        { code: "brand_new" },
      ],
    },
    withCatalog,
  );
  assert.deepEqual(
    out.interventions.map((i) => i.code),
    ["brand_new"],
  );
});

test("sanitizeOpportunities requires the exact variant for existing multi-variant links", () => {
  const out = sanitizeOpportunities(
    {
      events: [
        {
          code: "trial_expired",
          links: [
            { interventionCode: "retention", role: "required" },
            {
              interventionCode: "retention",
              variantCode: "does_not_exist",
              role: "required",
            },
            {
              interventionCode: "retention",
              variantCode: "cancellation_rescue",
              role: "required",
            },
            { interventionCode: "monetization", role: "optional" },
            { interventionCode: "brand_new", role: "outcome" },
          ],
        },
      ],
    },
    manifest,
  );

  assert.deepEqual(out.events[0]?.links, [
    {
      interventionCode: "retention",
      variantCode: "cancellation_rescue",
      role: "required",
    },
    { interventionCode: "monetization", role: "optional" },
    { interventionCode: "brand_new", role: "outcome" },
  ]);
});

test("sanitizeOpportunities strips ANSI escapes and control chars from LLM strings", () => {
  const out = sanitizeOpportunities(
    {
      events: [
        {
          code: "trial_expired",
          description: "\x1b[32m✓ safe, already approved\x1b[0m",
          rationale: "line one\nline two\x07\x1b]0;spoofed title\x07 end",
          expectedEffect: "\x1b[36mFewer\nfailed renewals\x1b[0m",
        },
      ],
      interventions: [
        {
          code: "support_rescue",
          expectedEffect: "\x1b]8;;https://spoofed.example\x07Faster\trecovery\x1b]8;;\x07",
        },
      ],
    },
    manifest,
  );
  assert.equal(out.events.length, 1);
  const ev = out.events[0]!;
  // No escape bytes or newlines survive to the confirmation UI.
  assert.equal(ev.description, "✓ safe, already approved");
  assert.equal(ev.rationale, "line one line two end");
  assert.equal(ev.expectedEffect, "Fewer failed renewals");
  assert.equal(out.interventions[0]!.expectedEffect, "Faster recovery");
});

test("sanitizeOpportunities tolerates a completely malformed document", () => {
  for (const doc of [null, 42, "hi", [], { events: "nope", interventions: 7 }]) {
    const out = sanitizeOpportunities(doc, manifest);
    assert.deepEqual(out, { events: [], interventions: [] });
  }
});

test("sanitizeOpportunities preserves invalid model codes instead of normalizing identity", () => {
  const out = sanitizeOpportunities(
    {
      events: [
        {
          code: "Payment Failed",
          links: [
            {
              interventionCode: "Retention Rescue",
              variantCode: "Default Variant",
              role: "required",
            },
          ],
        },
      ],
      interventions: [
        {
          code: " support_rescue ",
          links: [
            {
              eventCode: "Payment Failed",
              role: "outcome",
            },
          ],
        },
      ],
    },
    manifest,
  );

  assert.equal(out.events[0]?.code, "Payment Failed");
  assert.equal(out.events[0]?.links?.[0]?.interventionCode, "Retention Rescue");
  assert.equal(out.events[0]?.links?.[0]?.variantCode, "Default Variant");
  assert.equal(out.interventions[0]?.code, " support_rescue ");
  assert.equal(out.interventions[0]?.links?.[0]?.eventCode, "Payment Failed");
});

test("submitSuggestions posts the staged-suggestions contract and returns its result", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(
      JSON.stringify({
        staged: 2,
        duplicates: 0,
        invalid: 0,
        outcomes: [
          { kind: "event", code: "trial_expired", status: "staged" },
          { kind: "intervention", code: "winback", status: "staged" },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const result = await submitSuggestions(
      config,
      session,
      "nextjs",
      "fp-1",
      manifestPin,
      {
        events: [{ code: "trial_expired", expectedEffect: "More trial conversions" }],
        interventions: [{ code: "winback", expectedEffect: "More recovered users" }],
      },
    );
    assert.equal(result?.staged, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.whisperr.net/wizard/universe/suggestions");
    assert.equal(calls[0]!.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
      target: "nextjs",
      repoFingerprint: "fp-1",
      configVersionId: "arcv_1",
      manifestRevision: "manifest-r1",
      events: [{ code: "trial_expired", expectedEffect: "More trial conversions" }],
      interventions: [{ code: "winback", expectedEffect: "More recovered users" }],
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("submitSuggestions rejects invalid exact codes locally and never rewrites them", async () => {
  const calls: Array<{ body: unknown }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        staged: 1,
        duplicates: 0,
        invalid: 0,
        outcomes: [{ kind: "event", code: "trial_expired", status: "staged" }],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const result = await submitSuggestions(
      config,
      session,
      "nextjs",
      "fp-1",
      manifestPin,
      {
        events: [
          { code: "Payment Failed" },
          { code: "trial_expired" },
        ],
        interventions: [{ code: " support_rescue " }],
      },
    );

    assert.deepEqual(calls[0]?.body, {
      target: "nextjs",
      repoFingerprint: "fp-1",
      configVersionId: "arcv_1",
      manifestRevision: "manifest-r1",
      events: [{ code: "trial_expired" }],
      interventions: [],
    });
    assert.deepEqual(result.outcomes, [
      {
        kind: "event",
        code: "Payment Failed",
        status: "invalid",
        reason: "event code must be exact lowercase snake_case",
      },
      {
        kind: "intervention",
        code: " support_rescue ",
        status: "invalid",
        reason: "intervention code must be exact lowercase snake_case",
      },
      { kind: "event", code: "trial_expired", status: "staged" },
    ]);
    assert.equal(result.staged, 1);
    assert.equal(result.invalid, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("submitSuggestions returns local invalid outcomes without a request", async () => {
  let called = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error("should not be called");
  }) as typeof fetch;

  try {
    const result = await submitSuggestions(
      config,
      session,
      "nextjs",
      "fp-1",
      manifestPin,
      {
        events: [{ code: "Not Snake Case" }],
        interventions: [],
      },
    );
    assert.equal(called, false);
    assert.deepEqual(result, {
      staged: 0,
      duplicates: 0,
      invalid: 1,
      outcomes: [
        {
          kind: "event",
          code: "Not Snake Case",
          status: "invalid",
          reason: "event code must be exact lowercase snake_case",
        },
      ],
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("submitSuggestions rejects when the approval queue is unavailable", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(
      submitSuggestions(
        config,
        session,
        "nextjs",
        "fp-1",
        manifestPin,
        {
          events: [{ code: "trial_expired" }],
          interventions: [],
        },
      ),
      /404/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("submitSuggestions surfaces non-capability backend failures", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "internal" }), { status: 500 })) as typeof fetch;
  try {
    await assert.rejects(
      submitSuggestions(
        config,
        session,
        "nextjs",
        "fp-1",
        manifestPin,
        {
          events: [{ code: "trial_expired" }],
          interventions: [],
        },
      ),
      /500/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchSuggestions returns matching records from the requested statuses", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const realFetch = globalThis.fetch;
  const records = [
    {
      id: "wus_1",
      kind: "event" as const,
      code: "trial_expired",
      status: "approved" as const,
      payload: { code: "trial_expired", expectedEffect: "More conversions" },
    },
  ];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(records), { status: 200 });
  }) as typeof fetch;

  try {
    assert.deepEqual(
      await fetchSuggestions(config, session, ["proposed", "approved"]),
      records,
    );
    assert.equal(
      calls[0]!.url,
      "https://api.whisperr.net/wizard/universe/suggestions?status=proposed,approved",
    );
    assert.deepEqual(calls[0]!.init?.headers, { Authorization: "Bearer wzs_test" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchSuggestions returns an empty list on failure", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
  try {
    assert.deepEqual(await fetchSuggestions(config, session, ["approved"]), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("markSuggestionIntegrated sends only surface identity and returns true on 200", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ status: "integrated" }), { status: 200 });
  }) as typeof fetch;

  try {
    assert.equal(
      await markSuggestionIntegrated(config, session, "wus_1", "nextjs", "fp-1"),
      true,
    );
    assert.equal(
      calls[0]!.url,
      "https://api.whisperr.net/wizard/universe/suggestions/wus_1/integrated",
    );
    assert.equal(calls[0]!.init?.method, "POST");
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
      target: "nextjs",
      repoFingerprint: "fp-1",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("markSuggestionIntegrated returns false on conflict", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 409 })) as typeof fetch;
  try {
    assert.equal(
      await markSuggestionIntegrated(config, session, "wus_1", "nextjs", "fp-1"),
      false,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- post-instrumentation re-verification ---
// The CLI must report the FINAL verify state: if the additions instrumentation
// pass breaks the build after 6b passed, `verified` flips to false, and the
// pre-pass snapshot restores exactly the tree that 6b verified.

const gitExec = promisify(execFile);
const git = (dir: string, ...args: string[]) =>
  gitExec("git", ["-C", dir, "-c", "user.email=wizard@test", "-c", "user.name=wizard", ...args]);

// Mimics a playbook verifyCommand: "the build" fails iff broken.txt exists.
const VERIFY_CMD = `node -e "process.exit(require('fs').existsSync('broken.txt') ? 1 : 0)"`;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("verdictToVerified maps inconclusive verify runs to null", () => {
  assert.equal(verdictToVerified({ ran: true, ok: false, output: "", toolMissing: true }), null);
  assert.equal(verdictToVerified({ ran: true, ok: false, output: "", timedOut: true }), null);
  assert.equal(verdictToVerified({ ran: true, ok: true, output: "" }), true);
  assert.equal(verdictToVerified({ ran: true, ok: false, output: "" }), false);
});
