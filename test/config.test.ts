import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfig, stripTrailingSlashes } from "../src/core/config.js";

test("stripTrailingSlashes handles long untrusted values in linear time", () => {
  const prefix = "https://api.whisperr.net";
  assert.equal(stripTrailingSlashes(`${prefix}${"/".repeat(100_000)}`), prefix);
  assert.equal(stripTrailingSlashes(prefix), prefix);
});

test("config defaults to the locked Sol and Terra topology", () => {
  const names = [
    "WHISPERR_WIZARD_API_BASE",
    "WHISPERR_WIZARD_OPENAI_BASE",
    "WHISPERR_WIZARD_PRIMARY_MODEL",
    "WHISPERR_WIZARD_PRIMARY_EFFORT",
    "WHISPERR_WIZARD_SERVICE_TIER",
    "WHISPERR_WIZARD_EXPLORER_MODEL",
    "WHISPERR_WIZARD_EXPLORER_EFFORT",
    "WHISPERR_WIZARD_DIRECT_OPENAI_KEY",
    "OPENAI_API_KEY",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const config = resolveConfig();
    assert.equal(config.primaryModel, "gpt-5.6-sol");
    assert.equal(config.primaryEffort, "high");
    assert.equal(config.primaryServiceTier, "priority");
    assert.equal(config.explorerModel, "gpt-5.6-terra");
    assert.equal(config.explorerEffort, "xhigh");
    assert.equal(config.openAIBaseUrl, "https://api.whisperr.net/wizard/openai");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("direct OpenAI development key switches only the provider base", () => {
  const previous = process.env.WHISPERR_WIZARD_DIRECT_OPENAI_KEY;
  process.env.WHISPERR_WIZARD_DIRECT_OPENAI_KEY = "local-secret";
  try {
    const config = resolveConfig();
    assert.equal(config.directOpenAIKey, "local-secret");
    assert.equal(config.openAIBaseUrl, "https://api.openai.com/v1");
  } finally {
    if (previous === undefined) delete process.env.WHISPERR_WIZARD_DIRECT_OPENAI_KEY;
    else process.env.WHISPERR_WIZARD_DIRECT_OPENAI_KEY = previous;
  }
});
