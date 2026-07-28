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

test("every default Claude engine role uses fast-capable Opus 5", () => {
  const roleKeys = ["SURVEY", "DESIGN", "EDIT", "REVIEW"].map(
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
    for (const role of Object.values(models)) {
      assert.equal(role.model, "claude-opus-5");
      assert.equal(supportsClaudeFastMode(role.model), true);
    }
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
