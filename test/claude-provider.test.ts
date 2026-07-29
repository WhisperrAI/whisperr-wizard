import assert from "node:assert/strict";
import test from "node:test";

import { engineModelConfig } from "../src/engine/cli.js";
import { supportsClaudeFastMode } from "../src/engine/providers/claude.js";
import type { WizardConfig } from "../src/types.js";

test("fast mode is enabled only for supported Opus models", () => {
  assert.equal(supportsClaudeFastMode("claude-opus-5"), true);
  assert.equal(supportsClaudeFastMode("claude-opus-4-8"), true);
  assert.equal(supportsClaudeFastMode("claude-sonnet-5"), false);
  assert.equal(supportsClaudeFastMode("claude-opus-4-7"), false);
  assert.equal(supportsClaudeFastMode("custom-opus-model"), false);
});

test("hybrid task defaults route Terra and Opus with the required processing modes", () => {
  const roleKeys = ["SURVEY", "DESIGN", "SDK_SETUP", "CLUSTER_EDIT", "REPAIR", "REVIEW"].map(
    (role) => `WHISPERR_WIZARD_ENGINE_${role}_MODEL`,
  );
  const previous = new Map(roleKeys.map((key) => [key, process.env[key]]));
  for (const key of roleKeys) delete process.env[key];

  try {
    const models = engineModelConfig({
      model: "claude-opus-5",
      plannerModel: "claude-opus-5",
      effort: "high",
    } as WizardConfig);
    for (const task of ["survey", "cluster_edit"] as const) {
      assert.equal(models[task]?.model, "gpt-5.6-terra");
      assert.equal(models[task]?.effort, "medium");
      assert.equal(models[task]?.serviceTier, "priority");
    }
    for (const task of ["design", "sdk_setup", "repair", "review"] as const) {
      assert.equal(models[task]?.model, "claude-opus-5");
      assert.equal(models[task]?.effort, "medium");
      assert.equal(models[task]?.fastMode, true);
      assert.equal(supportsClaudeFastMode(models[task]!.model), true);
    }
    assert.equal(models.cluster_edit?.maxTurns, 30);
    assert.equal(models.cluster_edit?.maxMs, 5 * 60_000);
    assert.equal(models.design?.maxTurns, 80);
    assert.equal(models.sdk_setup?.maxTurns, 60);
    assert.equal(models.review?.maxTurns, 30);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("claude-default remains an Opus-only rollback preset", () => {
  const previous = process.env.WHISPERR_WIZARD_PRESET;
  process.env.WHISPERR_WIZARD_PRESET = "claude-default";
  try {
    const models = engineModelConfig({} as WizardConfig);
    for (const task of ["survey", "design", "sdk_setup", "cluster_edit", "repair", "review"] as const) {
      assert.equal(models[task]?.model, "claude-opus-5");
      assert.equal(models[task]?.fastMode, true);
    }
  } finally {
    if (previous === undefined) delete process.env.WHISPERR_WIZARD_PRESET;
    else process.env.WHISPERR_WIZARD_PRESET = previous;
  }
});
