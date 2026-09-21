import assert from "node:assert/strict";
import test from "node:test";
import { ALL_PLAYBOOKS } from "../src/core/playbooks/index.js";
import { CATALOG_INTEGRATION_GUIDANCE, FLUTTER_CATALOG_GUIDANCE, PHP_CATALOG_GUIDANCE, CATALOG_REVIEW_GUIDANCE } from "../src/core/playbooks/catalog.js";
import { SURVEY_SYSTEM_PROMPT } from "../src/engine/prompts.js";

test("every registered integration target receives the approved-scope catalog contract", () => {
  assert.ok(ALL_PLAYBOOKS.length >= 8);
  for (const playbook of ALL_PLAYBOOKS) {
    assert.ok(playbook.systemPrompt.includes(CATALOG_INTEGRATION_GUIDANCE), playbook.target.id);
  }
  assert.ok(SURVEY_SYSTEM_PROMPT.includes(CATALOG_INTEGRATION_GUIDANCE));
  assert.match(CATALOG_INTEGRATION_GUIDANCE, /Backend catalog work does NOT authorize new frontend screens/);
  assert.match(CATALOG_INTEGRATION_GUIDANCE, /events-only frontend PR adds identify\/reset/);
  for (const requirement of ["event-only runs stay event-only", "unavailable repository", "publication gates", "actual\nowner", "immutable complete snapshots", "original freshness", "integer minor", "flat-shop", "conditional", "server\nproducer credential", "before navigation", "SEPARATE facts"]) {
    assert.ok(CATALOG_INTEGRATION_GUIDANCE.includes(requirement), requirement);
  }
});

test("Flutter and PHP guidance requires usable SDKs and safe lifecycle delivery", () => {
  const flutter = ALL_PLAYBOOKS.find((p) => p.target.id === "flutter")!;
  const php = ALL_PLAYBOOKS.find((p) => p.target.id === "php")!;
  assert.ok(flutter.systemPrompt.includes(FLUTTER_CATALOG_GUIDANCE));
  assert.ok(php.systemPrompt.includes(PHP_CATALOG_GUIDANCE));
  for (const requirement of ["immutable Git commit", "BEFORE draining", "Do not add message action/history SDKs", "explicit\nseparate scope", "Capture the user"]) {
    assert.ok(FLUTTER_CATALOG_GUIDANCE.includes(requirement), requirement);
  }
  for (const requirement of ["PHP 8.0/Laravel 8", "transactional durable outbox", "acknowledged()", "occurredAt", "identifyNow", "missing release is a dependency"]) {
    assert.ok(PHP_CATALOG_GUIDANCE.includes(requirement), requirement);
  }
  assert.match(CATALOG_REVIEW_GUIDANCE, /historical order read is not a new redemption/);
  assert.match(CATALOG_REVIEW_GUIDANCE, /do not invent\nnew review rule IDs/);
});
