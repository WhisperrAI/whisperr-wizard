import assert from "node:assert/strict";
import test from "node:test";
import { fetchManifest, mockManifest } from "../src/core/manifest.js";
import type { WizardConfig, WizardSession } from "../src/types.js";

test("offline manifest uses the focused graph contract", () => {
  const manifest = mockManifest("app_1", {
    apiBaseUrl: "https://api.whisperr.net",
  } as WizardConfig);

  assert.equal(manifest.configVersionId, "arcv_offline_demo");
  assert.equal(manifest.manifestRevision, "offline-demo-v2");
  assert.equal(manifest.events[0]?.eventDefinitionId, "ared_offline_trial_started");
  assert.deepEqual(manifest.events[0]?.suggestedWireableOn, ["frontend", "backend"]);
  assert.deepEqual(manifest.events[0]?.variantLinks, [
    {
      interventionCode: "onboarding_nudge",
      interventionLabel: "Onboarding nudge",
      variantCode: "default",
      variantLabel: "Default",
      role: "required",
      rationale: "Starting a trial makes the onboarding nudge relevant.",
    },
  ]);

  const event = manifest.events[0] as unknown as Record<string, unknown>;
  for (const forbidden of [
    "aliases",
    "properties",
    "interventions",
    "importance",
    "side",
    "kind",
    "derived",
    "payloadContract",
  ]) {
    assert.equal(forbidden in event, false, `${forbidden} must stay out of the manifest`);
  }
});

test("fetchManifest preserves exact event identity and revision pins", async () => {
  const exact = mockManifest("app_1", {
    apiBaseUrl: "https://api.whisperr.net",
  } as WizardConfig);
  exact.events[0]!.eventType = "Trial.Started/V2";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(exact), { status: 200 })) as typeof fetch;

  try {
    const result = await fetchManifest(
      {
        apiBaseUrl: "https://api.whisperr.net",
        offline: false,
      } as WizardConfig,
      session(),
      "nextjs",
      "repo-1",
    );
    assert.equal(result.events[0]?.eventType, "Trial.Started/V2");
    assert.equal(result.manifestRevision, "offline-demo-v2");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchManifest rejects events without exact database identity", async () => {
  const invalid = mockManifest("app_1", {
    apiBaseUrl: "https://api.whisperr.net",
  } as WizardConfig) as unknown as Record<string, unknown>;
  const events = invalid.events as Array<Record<string, unknown>>;
  delete events[0]!.eventDefinitionId;

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(invalid), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(
      fetchManifest(
        {
          apiBaseUrl: "https://api.whisperr.net",
          offline: false,
        } as WizardConfig,
        session(),
      ),
      /eventDefinitionId/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

function session(): WizardSession {
  return {
    token: "wzs_test",
    appId: "app_1",
    expiresAt: Date.now() / 1000 + 600,
  };
}
