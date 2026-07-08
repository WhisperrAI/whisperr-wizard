import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  OPPORTUNITIES_FILE,
  collectOpportunities,
  normalizeCode,
  sanitizeOpportunities,
  submitAdditions,
} from "../src/core/opportunities.js";
import {
  takeCheckpoint,
  snapshotChanges,
  snapshotsEqual,
  restoreToSnapshot,
} from "../src/core/git.js";
import { runVerifyCommand, verdictToVerified } from "../src/core/postflight.js";
import type { IntegrationManifest, WizardConfig, WizardSession } from "../src/types.js";

const manifest: IntegrationManifest = {
  appId: "app_1",
  ingestionApiKey: "pk_test",
  ingestionBaseUrl: "https://api.whisperr.net",
  identify: {},
  events: [
    {
      eventType: "subscription_cancelled",
      interventions: [{ code: "retention", weight: 0.8 }],
    },
    { eventType: "viewed_pricing", interventions: [{ code: "monetization" }] },
  ],
};

const config = {
  apiBaseUrl: "https://api.whisperr.net",
  offline: false,
} as WizardConfig;

const session: WizardSession = {
  token: "wzs_test",
  appId: "app_1",
  expiresAt: Date.now() / 1000 + 600,
};

test("normalizeCode mirrors whisperr-go's NormalizeCode", () => {
  assert.equal(normalizeCode("Payment Failed"), "payment_failed");
  assert.equal(normalizeCode("  sub.cancelled/v2  "), "sub_cancelled_v2");
  assert.equal(normalizeCode("__weird--CODE__"), "weird_code");
  assert.equal(normalizeCode("---"), "");
  // Go converts only space/-/./ slash to "_" and DROPS other
  // non-alphanumerics — it does not turn them into underscores.
  assert.equal(normalizeCode("user's plan"), "users_plan");
  assert.equal(normalizeCode("a+b=c"), "abc");
  assert.equal(normalizeCode("café latte"), "caf_latte");
  assert.equal(normalizeCode("foo — bar"), "foo_bar");
});

test("sanitizeOpportunities keeps valid proposals and normalizes codes", () => {
  const out = sanitizeOpportunities(
    {
      events: [
        {
          code: "Payment Failed",
          side: "Backend",
          confidence: 1.4,
          rationale: "billing webhook has no event",
          properties: [{ name: "charge_type", required: true }, "plan", { bogus: true }],
          links: [{ interventionCode: "Retention", weight: 0.6 }, { weight: 0.2 }],
        },
      ],
      interventions: [
        {
          code: "support_rescue",
          links: [{ eventCode: "payment_failed" }],
        },
      ],
    },
    manifest,
  );

  assert.equal(out.events.length, 1);
  const ev = out.events[0]!;
  assert.equal(ev.code, "payment_failed");
  assert.equal(ev.side, "backend");
  assert.equal(ev.confidence, 1); // clamped
  assert.deepEqual(ev.properties, [
    { name: "charge_type", required: true },
    { name: "plan" },
  ]);
  assert.deepEqual(ev.links, [{ interventionCode: "retention", weight: 0.6 }]);

  assert.equal(out.interventions.length, 1);
  assert.deepEqual(out.interventions[0]!.links, [{ eventCode: "payment_failed" }]);
});

test("sanitizeOpportunities drops manifest duplicates, repeats, and junk", () => {
  const out = sanitizeOpportunities(
    {
      events: [
        { code: "subscription_cancelled" }, // already in the manifest
        { code: "Viewed Pricing" }, // manifest duplicate after normalization
        { code: "trial_expired" },
        { code: "trial_expired" }, // repeat within the proposal set
        { code: "   " }, // empty after normalization
        "nonsense",
      ],
      interventions: [
        { code: "retention" }, // existing intervention
        { code: "winback" },
      ],
    },
    manifest,
  );
  assert.deepEqual(
    out.events.map((e) => e.code),
    ["trial_expired"],
  );
  assert.deepEqual(
    out.interventions.map((i) => i.code),
    ["winback"],
  );
});

test("sanitizeOpportunities strips ANSI escapes and control chars from LLM strings", () => {
  const out = sanitizeOpportunities(
    {
      events: [
        {
          code: "trial_expired",
          description: "\x1b[32m✓ safe, already approved\x1b[0m",
          rationale: "line one\nline two\x07\x1b]0;spoofed title\x07 end",
        },
      ],
      interventions: [],
    },
    manifest,
  );
  assert.equal(out.events.length, 1);
  const ev = out.events[0]!;
  // No escape bytes or newlines survive to the confirmation UI.
  assert.equal(ev.description, "✓ safe, already approved");
  assert.equal(ev.rationale, "line one line two end");
});

test("sanitizeOpportunities tolerates a completely malformed document", () => {
  for (const doc of [null, 42, "hi", [], { events: "nope", interventions: 7 }]) {
    const out = sanitizeOpportunities(doc, manifest);
    assert.deepEqual(out, { events: [], interventions: [] });
  }
});

test("collectOpportunities reads then deletes the proposals file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsp-opps-"));
  const checkpoint = await takeCheckpoint(dir);
  await writeFile(
    join(dir, OPPORTUNITIES_FILE),
    JSON.stringify({ events: [{ code: "trial_expired" }], interventions: [] }),
  );

  const out = await collectOpportunities(dir, manifest, checkpoint);
  assert.deepEqual(
    out.events.map((e) => e.code),
    ["trial_expired"],
  );
  // The file must never linger in the customer's working tree.
  assert.deepEqual(await readdir(dir), []);
});

test("collectOpportunities returns empty when the file is absent or invalid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsp-opps-"));
  const checkpoint = await takeCheckpoint(dir);
  assert.deepEqual(await collectOpportunities(dir, manifest, checkpoint), {
    events: [],
    interventions: [],
  });

  await writeFile(join(dir, OPPORTUNITIES_FILE), "not json {");
  assert.deepEqual(await collectOpportunities(dir, manifest, checkpoint), {
    events: [],
    interventions: [],
  });
  assert.deepEqual(await readdir(dir), []);
});

test("collectOpportunities ignores a proposals file that was already committed pre-pass", async () => {
  // A repo shipping its own whisperr-opportunities.json is attacker-supplied
  // input, not agent output: it must not be trusted and must not be deleted.
  const dir = await mkdtemp(join(tmpdir(), "wsp-opps-tracked-"));
  await git(dir, "init");
  const payload = JSON.stringify({
    events: [{ code: "attacker_event", rationale: "planted in the repo" }],
    interventions: [],
  });
  await writeFile(join(dir, OPPORTUNITIES_FILE), payload);
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "repo ships a planted proposals file");
  const checkpoint = await takeCheckpoint(dir);

  assert.deepEqual(await collectOpportunities(dir, manifest, checkpoint), {
    events: [],
    interventions: [],
  });
  // The customer's own file stays exactly where it was.
  assert.equal(await readFile(join(dir, OPPORTUNITIES_FILE), "utf8"), payload);
});

test("collectOpportunities still accepts a file the agent wrote in a git repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsp-opps-untracked-"));
  await git(dir, "init");
  await writeFile(join(dir, "app.txt"), "app\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "base");
  const checkpoint = await takeCheckpoint(dir);

  // Written after the checkpoint — this is genuine agent output.
  await writeFile(
    join(dir, OPPORTUNITIES_FILE),
    JSON.stringify({ events: [{ code: "trial_expired" }], interventions: [] }),
  );
  const out = await collectOpportunities(dir, manifest, checkpoint);
  assert.deepEqual(
    out.events.map((e) => e.code),
    ["trial_expired"],
  );
  assert.equal(await fileExists(join(dir, OPPORTUNITIES_FILE)), false);
});

test("submitAdditions posts the whisperr-go contract and returns its result", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        additionId: "wua_1",
        configVersionId: "arcv_1",
        applied: 2,
        duplicates: 0,
        invalid: 0,
        outcomes: [
          { kind: "event", code: "trial_expired", status: "applied" },
          { kind: "link", code: "trial_expired -> retention", status: "applied" },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  try {
    const result = await submitAdditions(config, session, "nextjs", "fp-1", {
      events: [
        { code: "trial_expired", links: [{ interventionCode: "retention", weight: 0.4 }] },
      ],
      interventions: [],
    });
    assert.equal(result.applied, 2);
    assert.equal(result.outcomes.length, 2);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://api.whisperr.net/wizard/universe/additions");
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer wzs_test");
    const body = JSON.parse(String(calls[0]!.init.body));
    assert.deepEqual(body, {
      target: "nextjs",
      repoFingerprint: "fp-1",
      events: [
        { code: "trial_expired", links: [{ interventionCode: "retention", weight: 0.4 }] },
      ],
      interventions: [],
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// --- post-instrumentation re-verification ---
// The CLI must report the FINAL verify state: if the additions instrumentation
// pass breaks the build after 6b passed, `verified` flips to false, and the
// pre-pass snapshot restores exactly the tree that 6b verified.

const gitExec = promisify(execFile);
const git = (dir: string, ...args: string[]) =>
  gitExec("git", ["-C", dir, "-c", "user.email=wizard@test", "-c", "user.name=wizard", ...args]);

// Mimics a playbook verifyCommand: "the build" fails iff broken.txt exists.
const VERIFY_CMD = `node -e "process.exit(require('fs').existsSync('broken.txt') ? 1 : 0)"`;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("instrumentation pass that breaks the build makes the reported verified=false", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wsp-reverify-"));
  await git(dir, "init");
  await writeFile(join(dir, "app.txt"), "original\n");
  await writeFile(join(dir, "pristine.txt"), "pristine\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "base");
  const checkpoint = await takeCheckpoint(dir);

  // Integration pass edits, then 6b verifies them: passes.
  await writeFile(join(dir, "app.txt"), "integrated\n");
  await writeFile(join(dir, "wired.txt"), "track('trial_expired')\n");
  assert.equal(verdictToVerified(await runVerifyCommand(dir, VERIFY_CMD)), true);

  // The instrumentation pass then breaks the build (and touches files both
  // inside and outside the earlier diff).
  const prePass = await snapshotChanges(dir, checkpoint);
  await writeFile(join(dir, "broken.txt"), "syntax error\n");
  await writeFile(join(dir, "wired.txt"), "track('trial_expired')\ntrack('payment_failed')\n");
  await writeFile(join(dir, "pristine.txt"), "instrumented\n");

  // The pass edited files, so the CLI re-verifies — and must now report false.
  assert.equal(snapshotsEqual(prePass, await snapshotChanges(dir, checkpoint)), false);
  assert.equal(verdictToVerified(await runVerifyCommand(dir, VERIFY_CMD)), false);

  // The failure-path revert restores exactly the tree 6b verified: pass edits
  // are gone, the integration edits stay.
  assert.equal(await restoreToSnapshot(dir, checkpoint, prePass), true);
  assert.equal(await fileExists(join(dir, "broken.txt")), false);
  assert.equal(await readFile(join(dir, "wired.txt"), "utf8"), "track('trial_expired')\n");
  assert.equal(await readFile(join(dir, "pristine.txt"), "utf8"), "pristine\n");
  assert.equal(await readFile(join(dir, "app.txt"), "utf8"), "integrated\n");
  assert.equal(verdictToVerified(await runVerifyCommand(dir, VERIFY_CMD)), true);
  t.diagnostic("snapshot round-trip verified");
});

test("a no-op instrumentation pass leaves the snapshot equal, so no re-verify is needed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wsp-noop-"));
  await git(dir, "init");
  await writeFile(join(dir, "app.txt"), "original\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "base");
  const checkpoint = await takeCheckpoint(dir);

  await writeFile(join(dir, "wired.txt"), "track('trial_expired')\n");
  const prePass = await snapshotChanges(dir, checkpoint);
  assert.equal(snapshotsEqual(prePass, await snapshotChanges(dir, checkpoint)), true);
});

test("verdictToVerified maps inconclusive verify runs to null", () => {
  assert.equal(verdictToVerified({ ran: true, ok: false, output: "", toolMissing: true }), null);
  assert.equal(verdictToVerified({ ran: true, ok: false, output: "", timedOut: true }), null);
  assert.equal(verdictToVerified({ ran: true, ok: true, output: "" }), true);
  assert.equal(verdictToVerified({ ran: true, ok: false, output: "" }), false);
});

test("submitAdditions surfaces backend failures", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "onboarding_incomplete" }), { status: 409 })) as typeof fetch;
  try {
    await assert.rejects(
      submitAdditions(config, session, "nextjs", "fp-1", {
        events: [{ code: "trial_expired" }],
        interventions: [],
      }),
      /409/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
