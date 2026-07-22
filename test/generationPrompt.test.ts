import assert from "node:assert/strict";
import test from "node:test";
import { GENERATION_PROMPT } from "../src/core/generationPrompt.js";

test("generation prompt defines only the four concepts and actively limits inflation", () => {
  assert.match(GENERATION_PROMPT, /intervention group is a family/i);
  assert.match(GENERATION_PROMPT, /intervention is one distinct action/i);
  assert.match(GENERATION_PROMPT, /event is one concrete product occurrence/i);
  assert.match(GENERATION_PROMPT, /link says that one event is direct evidence/i);
  assert.match(GENERATION_PROMPT, /Prefer the smallest useful taxonomy/i);
  assert.match(GENERATION_PROMPT, /Do not create an intervention just because an event exists/i);
  assert.match(GENERATION_PROMPT, /customer-facing frontend is the first and preferred owner/i);
  assert.match(GENERATION_PROMPT, /complete only after the tool succeeds/i);
  assert.doesNotMatch(GENERATION_PROMPT, /opportunit|suggestion|expected effect|manifest/i);
});
