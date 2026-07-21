import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { hasWhisperrMethodCall, scanWiredEvents } from "../src/core/git.js";

test("scanWiredEvents detects plain track literal calls", async () => {
  const repo = await fixture({
    "src/app.ts": "whisperr.track('booking_started', { source: 'modal' });\n",
  });

  const wired = await scanWiredEvents(repo, ["src/app.ts"], ["booking_started"]);

  assert.equal(wired.get("booking_started"), "src/app.ts");
});

test("scanWiredEvents rejects unrelated analytics clients", async () => {
  const repo = await fixture({
    "src/app.ts": "analytics.track('booking_started', { source: 'modal' });\n",
  });

  const wired = await scanWiredEvents(repo, ["src/app.ts"], ["booking_started"]);

  assert.equal(wired.has("booking_started"), false);
});

test("identity evidence requires a Whisperr receiver", () => {
  assert.equal(hasWhisperrMethodCall("analytics.identify(user.id);", "identify"), false);
  assert.equal(
    hasWhisperrMethodCall("whisperr && analytics.identify(user.id);", "identify"),
    false,
  );
  assert.equal(
    hasWhisperrMethodCall("condition ? whisperr : analytics.identify(user.id);", "identify"),
    false,
  );
  assert.equal(hasWhisperrMethodCall("whisperr > analytics.identify(user.id);", "identify"), false);
  assert.equal(hasWhisperrMethodCall("whisperr.identify(user.id);", "identify"), true);
  assert.equal(hasWhisperrMethodCall("Whisperr.instance.identify(user.id);", "identify"), true);
  assert.equal(
    hasWhisperrMethodCall("Whisperr\n  .instance\n  .identify(user.id);", "identify"),
    true,
  );
  assert.equal(
    hasWhisperrMethodCall("Whisperr.shared?\n  .identify(user.id);", "identify"),
    true,
  );
});

test("event evidence does not cross operators from an unrelated receiver", async () => {
  const repo = await fixture({
    "src/app.ts": [
      "whisperr && analytics.track('booking_started');",
      "condition ? whisperr : analytics.track('booking_started');",
      "whisperr > analytics.track('booking_started');",
    ].join("\n"),
  });

  const wired = await scanWiredEvents(repo, ["src/app.ts"], ["booking_started"]);

  assert.equal(wired.has("booking_started"), false);
});

test("scanWiredEvents requires the event literal at a concrete SDK call site", async () => {
  const repo = await fixture({
    "src/events.ts": 'export const BOOKING_STARTED = "booking_started";\n',
    "src/app.ts": "analytics.track(BOOKING_STARTED, { source: 'modal' });\n",
  });

  const wired = await scanWiredEvents(
    repo,
    ["src/events.ts", "src/app.ts"],
    ["booking_started"],
  );

  assert.equal(wired.has("booking_started"), false);
});

test("scanWiredEvents ignores inert literals, comments, source strings, and bare track calls", async () => {
  const repo = await fixture({
    "src/inert.ts": [
      'const UNUSED = "booking_started";',
      "// analytics.track('booking_started');",
      'const example = "analytics.track(\\\"booking_started\\\")";',
      "track(userId); const after = 'booking_started';",
      "track('booking_started');",
    ].join("\n"),
  });

  const wired = await scanWiredEvents(repo, ["src/inert.ts"], ["booking_started"]);

  assert.equal(wired.has("booking_started"), false);
});

test("scanWiredEvents detects multiline receiver calls with later event arguments", async () => {
  const repo = await fixture({
    "src/server.ts": [
      "whisperr.track(",
      "  userId,",
      '  "booking_started",',
      "  { source: 'modal' },",
      ");",
    ].join("\n"),
  });

  const wired = await scanWiredEvents(repo, ["src/server.ts"], ["booking_started"]);

  assert.equal(wired.get("booking_started"), "src/server.ts");
});

test("scanWiredEvents leaves absent events skipped", async () => {
  const repo = await fixture({
    "src/app.ts": "analytics.track('checkout_started');\n",
  });

  const wired = await scanWiredEvents(repo, ["src/app.ts"], ["booking_started"]);

  assert.equal(wired.has("booking_started"), false);
});

test("scanWiredEvents does not count substring event literals", async () => {
  const repo = await fixture({
    "src/app.ts": "analytics.track('booking_started_v2');\nconst code = 'booking_started_v2';\n",
  });

  const wired = await scanWiredEvents(repo, ["src/app.ts"], ["booking_started"]);

  assert.equal(wired.has("booking_started"), false);
});

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wsp-scan-"));
  await Promise.all(
    Object.entries(files).map(async ([rel, content]) => {
      const path = join(root, rel);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }),
  );
  return root;
}
