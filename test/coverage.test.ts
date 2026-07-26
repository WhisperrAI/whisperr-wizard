import assert from "node:assert/strict";
import test from "node:test";
import { isInstrumentedCoverageStatus } from "../src/core/coverage.js";

test("only added and existing coverage mean an event is instrumented", () => {
  assert.equal(isInstrumentedCoverageStatus("existing"), true);
  assert.equal(isInstrumentedCoverageStatus("added"), true);
  for (const status of [
    "declined",
    "failed",
    "reverted",
    "not_attempted",
    "wired",
  ]) {
    assert.equal(isInstrumentedCoverageStatus(status), false);
  }
});
