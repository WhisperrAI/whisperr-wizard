import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyFailure,
  MAX_CLUSTER_ATTEMPTS,
  nextClusterStatusAfterFailure,
} from "../src/engine/budgets.js";
import {
  clustersComplete,
  deriveClusters,
  nextConcurrentClusters,
  nextPendingCluster,
  transitionCluster,
} from "../src/engine/clusters.js";
import { createProgressSink, formatProgressLine } from "../src/engine/output.js";
import { itemIdempotencyKey, normalizeRunBootstrap, RunsApiError } from "../src/engine/runs.js";
import type { EventPlacement } from "../src/engine/types.js";

function placement(code: string, file: string): EventPlacement {
  return { eventId: `aev_${code}`, eventCode: code, file, status: "planned" };
}

test("classifyFailure maps overflow, transient, and fatal messages", () => {
  assert.equal(classifyFailure("Prompt is too long"), "context_overflow");
  assert.equal(classifyFailure("input is too long for this model"), "context_overflow");
  assert.equal(classifyFailure("429 rate limit exceeded"), "transient");
  assert.equal(classifyFailure("upstream 503 overloaded"), "transient");
  assert.equal(classifyFailure("invalid tool arguments"), "fatal");
});

test("failure classes decide cluster status honestly", () => {
  assert.equal(nextClusterStatusAfterFailure("context_overflow", 1), "failed_resumable");
  assert.equal(nextClusterStatusAfterFailure("transient", 1), "pending");
  assert.equal(
    nextClusterStatusAfterFailure("transient", MAX_CLUSTER_ATTEMPTS),
    "failed_resumable",
  );
  assert.equal(nextClusterStatusAfterFailure("fatal", 1), "blocked");
});

test("deriveClusters creates one complete cluster per file", () => {
  const placements: EventPlacement[] = [];
  for (let index = 0; index < 11; index += 1) {
    placements.push(placement(`diary_event_${index}`, `Features/Diary/File${index % 2}.swift`));
  }
  placements.push(placement("lonely_event", "Features/Profile/ProfileView.swift"));
  placements.push(placement("second_lonely", "Features/Help/HelpView.swift"));

  const clusters = deriveClusters(placements);
  for (const cluster of clusters) {
    assert.equal(cluster.status, "pending");
    assert.equal(cluster.attempts, 0);
  }
  const totalEvents = clusters.reduce((sum, cluster) => sum + cluster.events.length, 0);
  assert.equal(totalEvents, placements.length);
  const diaryClusters = clusters.filter((cluster) =>
    cluster.files.some((file) => file.includes("Diary")),
  );
  assert.equal(diaryClusters.length, 2, "each diary file is owned by one cluster");
});

test("clusters never mix repository files", () => {
  const clusters = deriveClusters([
    placement("alpha_started", "src/alpha/a.ts"),
    placement("beta_started", "src/beta/b.ts"),
    placement("gamma_started", "src/gamma/c.ts"),
    placement("delta_started", "src/delta/d.ts"),
  ]);
  assert.equal(clusters.length, 4);
  assert.ok(clusters.every((cluster) => cluster.files.length === 1));
});

test("cluster IDs stay unique and one Terra session schedules files serially", () => {
  const placements = Array.from({ length: 10 }, (_, index) =>
    placement(`same_file_${index}`, "src/shared.ts")
  );
  placements.push(
    placement("other_a", "src/a.ts"),
    placement("other_b", "src/b.ts"),
    placement("other_c", "src/c.ts"),
    placement("other_d", "src/d.ts"),
  );
  const clusters = deriveClusters(placements);
  assert.equal(new Set(clusters.map((cluster) => cluster.id)).size, clusters.length);
  const wave = nextConcurrentClusters(clusters);
  assert.equal(wave.length, 1);
  const files = wave.flatMap((cluster) => cluster.files);
  assert.equal(new Set(files).size, files.length, "a file may be owned by only one concurrent worker");
  assert.ok(wave.every((cluster) => cluster.files.length === 1));
  assert.ok(
    clusters.filter((cluster) => cluster.files.includes("src/shared.ts")).length === 1,
    "all same-file events must remain in one Terra-owned cluster",
  );
});

for (const eventCount of [20, 100, 200]) {
  test(`${eventCount}-event fixture schedules without loss, duplication, or same-file overlap`, () => {
    const placements = Array.from({ length: eventCount }, (_, index) =>
      placement(`fixture_event_${index}`, `src/feature_${index % 37}.ts`)
    );
    let clusters = deriveClusters(placements);
    const scheduled: string[] = [];
    while (!clustersComplete(clusters)) {
      const wave = nextConcurrentClusters(clusters);
      assert.equal(wave.length, 1);
      const files = wave.flatMap((cluster) => cluster.files);
      assert.equal(new Set(files).size, files.length);
      for (const cluster of wave) {
        scheduled.push(...cluster.events.map((event) => event.eventId));
        clusters = transitionCluster(clusters, cluster.id, "reviewed");
      }
    }
    assert.equal(scheduled.length, eventCount);
    assert.equal(new Set(scheduled).size, eventCount);
    assert.deepEqual(new Set(scheduled), new Set(placements.map((event) => event.eventId)));
  });
}

test("cluster queue transitions and completion", () => {
  let clusters = deriveClusters([
    placement("one_started", "src/a/a.ts"),
    placement("two_started", "src/a/b.ts"),
    placement("three_started", "src/a/c.ts"),
  ]);
  assert.equal(clusters.length, 3);
  const first = nextPendingCluster(clusters);
  assert.ok(first);
  clusters = transitionCluster(clusters, first.id, "editing");
  assert.equal(clusters[0].attempts, 1);
  clusters = transitionCluster(clusters, first.id, "verified");
  clusters = transitionCluster(clusters, first.id, "reviewed");
  assert.ok(nextPendingCluster(clusters));
  for (const cluster of clusters.filter((candidate) => candidate.id !== first.id)) {
    clusters = transitionCluster(clusters, cluster.id, "verified");
  }
  assert.equal(nextPendingCluster(clusters), undefined);
  assert.ok(clustersComplete(clusters));
  clusters = transitionCluster(clusters, first.id, "failed_resumable", "context overflow");
  assert.ok(clustersComplete(clusters));
  assert.equal(clusters[0].note, "context overflow");
});

test("progress lines follow the phase · cluster · file · action protocol", () => {
  assert.equal(
    formatProgressLine({
      phase: "integrating",
      action: "placing events",
      cluster: { index: 3, total: 9 },
      file: "src/a/a.ts",
    }),
    "integrating · cluster 3/9 · src/a/a.ts · placing events",
  );
  assert.equal(
    formatProgressLine({ phase: "surveying", action: "mapping repository" }),
    "surveying · mapping repository",
  );
});

test("progress sink dedupes repeats off-TTY, streams JSON, and heartbeats", () => {
  const lines: string[] = [];
  let clock = 0;
  const sink = createProgressSink({
    json: false,
    isTTY: false,
    write: (line) => lines.push(line),
    heartbeatIntervalMs: 1000,
    now: () => clock,
  });
  sink.emit({ phase: "surveying", action: "mapping repository" });
  sink.emit({ phase: "surveying", action: "mapping repository" });
  assert.equal(lines.length, 1);
  sink.heartbeat("surveying", "waiting on model");
  assert.equal(lines.length, 1);
  clock = 2000;
  sink.heartbeat("surveying", "waiting on model");
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes("still working"));

  const jsonLines: string[] = [];
  const jsonSink = createProgressSink({
    json: true,
    isTTY: false,
    write: (line) => jsonLines.push(line),
  });
  jsonSink.emit({ phase: "designing", action: "persisting item" });
  const parsed = JSON.parse(jsonLines[0]);
  assert.equal(parsed.kind, "progress");
  assert.equal(parsed.phase, "designing");
});

test("item idempotency keys are stable and kind-scoped", () => {
  const first = itemIdempotencyKey("event", "food_logged");
  assert.equal(first, itemIdempotencyKey("event", "food_logged"));
  assert.notEqual(first, itemIdempotencyKey("intervention", "food_logged"));
  assert.notEqual(first, itemIdempotencyKey("event", "food_logged", "link:extra"));
  assert.equal(first.length, 32);
});

test("run bootstrap accepts nested and legacy snapshots, and rejects malformed responses", () => {
  const base = {
    project: { id: "project", repoFingerprint: "fp", displayName: "App", target: "swift", kind: "frontend" },
    run: {
      id: "run",
      status: "running",
      phase: "surveying",
      integrationEvidence: {
        changedFiles: ["src/a.ts"],
        identifyWired: true,
        verificationStatus: "pending",
        events: [{ eventId: "event", eventCode: "saved", file: "src/a.ts", status: "reviewed" }],
      },
    },
    ingestion: { apiKey: "pk", baseUrl: "https://api.example.test" },
  };
  const event = {
    id: "event", code: "saved", name: "Saved", reasoning: "r", projectId: "project",
    anchorFile: "src/a.ts", anchorSymbol: "save", payloadSchema: {},
  };
  const normalized = normalizeRunBootstrap({
    ...base,
    snapshot: { setupStatus: "running", events: [event] },
  });
  assert.equal(normalized.snapshot.events[0].anchorFile, "src/a.ts");
  assert.equal(normalized.run.integrationEvidence?.events[0].status, "reviewed");
  assert.equal(normalizeRunBootstrap({ ...base, setupStatus: "running", events: [event] }).snapshot.events[0].code, "saved");
  assert.throws(() => normalizeRunBootstrap({ ...base, events: "not-an-array" }), RunsApiError);
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPatchToRepo,
  createWorktree,
  removeWorktree,
  savePartialPatch,
  worktreePatch,
  WorktreeError,
} from "../src/engine/worktree.js";

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "wizard-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return repo;
}

test("worktree isolates edits and applies them atomically", async () => {
  const repo = initRepo();
  const handle = await createWorktree(repo);
  writeFileSync(join(handle.path, "app.ts"), "export const a = 2;\n");
  writeFileSync(join(handle.path, "events.ts"), "export const EVENTS = [\"checkout_started\"];\n");

  const untouched = await readFile(join(repo, "app.ts"), "utf8");
  assert.equal(untouched, "export const a = 1;\n");

  const patch = await worktreePatch(handle);
  assert.ok(patch.includes("events.ts"));
  await applyPatchToRepo(handle, patch);
  assert.equal(await readFile(join(repo, "app.ts"), "utf8"), "export const a = 2;\n");
  assert.ok(existsSync(join(repo, "events.ts")));

  await removeWorktree(handle);
  assert.ok(!existsSync(handle.path));
});

test("dirty repositories are refused without force", async () => {
  const repo = initRepo();
  writeFileSync(join(repo, "app.ts"), "export const a = 99;\n");
  await assert.rejects(
    () => createWorktree(repo),
    (error: unknown) => error instanceof WorktreeError && error.code === "dirty_repo",
  );
  const forced = await createWorktree(repo, true);
  assert.ok(existsSync(forced.path));
  await removeWorktree(forced);
});

test("server-recorded dirty files seed a resumable worktree", async () => {
  const repo = initRepo();
  writeFileSync(join(repo, "app.ts"), "export const a = 99;\n");
  const handle = await createWorktree(repo, false, ["app.ts"]);
  assert.equal(await readFile(join(handle.path, "app.ts"), "utf8"), "export const a = 99;\n");
  await removeWorktree(handle);
});

test("partial patches persist for failed runs", async () => {
  const repo = initRepo();
  const handle = await createWorktree(repo);
  writeFileSync(join(handle.path, "partial.ts"), "export const partial = true;\n");
  const dest = join(mkdtempSync(join(tmpdir(), "wizard-partial-")), "partial.patch");
  const saved = await savePartialPatch(handle, dest);
  assert.equal(saved, dest);
  assert.ok((await readFile(dest, "utf8")).includes("partial.ts"));
  await removeWorktree(handle);
});
