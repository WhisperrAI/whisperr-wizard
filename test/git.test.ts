import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { scanWiredEvents } from "../src/core/git.js";

test("scanWiredEvents detects plain track literal calls", async () => {
  const repo = await fixture({
    "src/app.ts": "analytics.track('booking_started', { source: 'modal' });\n",
  });

  const wired = await scanWiredEvents(repo, ["src/app.ts"], ["booking_started"]);

  assert.equal(wired.get("booking_started"), "src/app.ts");
});

test("scanWiredEvents detects constants that carry event literals", async () => {
  const repo = await fixture({
    "src/events.ts": 'export const BOOKING_STARTED = "booking_started";\n',
    "src/app.ts": "analytics.track(BOOKING_STARTED, { source: 'modal' });\n",
  });

  const wired = await scanWiredEvents(
    repo,
    ["src/events.ts", "src/app.ts"],
    ["booking_started"],
  );

  assert.equal(wired.get("booking_started"), "src/events.ts");
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
