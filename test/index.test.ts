import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseArgs, packageVersion } from "../src/index.js";

test("packageVersion reads package.json instead of drifting", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageVersion(), pkg.version);
});

test("parseArgs handles init, positional path, and overrides", () => {
  assert.deepEqual(parseArgs(["init", "demo-app", "--force", "--api", "https://api.test", "--model", "gpt-test"]), {
    path: "demo-app",
    force: true,
    apiBaseUrl: "https://api.test",
    model: "gpt-test",
  });
  assert.deepEqual(parseArgs(["--version"]), { version: true });
  assert.deepEqual(parseArgs(["--help"]), { help: true });
});
