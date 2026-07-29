import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProgressSink } from "../src/engine/output.js";
import { runEngine, type EngineRunResult } from "../src/engine/orchestrator.js";
import type { EngineModelConfig, EngineProvider, RoleInvocation } from "../src/engine/types.js";
import type { WizardConfig, WizardSession } from "../src/types.js";

interface Expectations {
  target: string;
  expectedEvents: Array<{ code: string; anchorFile: string }>;
  forbiddenFiles: string[];
  maxEvents: number;
}

interface FixtureResult {
  fixture: string;
  passed: boolean;
  failures: string[];
  registered: number;
  runKind: string;
}

interface MockRuntimeState {
  items: Array<Record<string, unknown>>;
  completions: Array<Record<string, unknown>>;
  snapshotEvents: Array<Record<string, unknown>>;
  failItems: boolean;
}

function startMockRuntime(state: MockRuntimeState): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const send = (status: number, payload: unknown) => {
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(payload));
      };
      const url = request.url ?? "";
      if (request.method === "POST" && url === "/wizard/runs") {
        send(200, {
          project: { id: "wproj_1", repoFingerprint: "fp", displayName: "Fixture", target: "nextjs", kind: "frontend" },
          run: { id: "wrun_1", status: "running", phase: "authorizing" },
          resumed: false,
          universeMode: "wizard",
          app: {},
          snapshot: { setupStatus: "running", events: state.snapshotEvents },
          ingestion: { apiKey: "pk_eval", baseUrl: "https://api.example.test" },
          onboardingContext: { activation: "first completed checkout" },
        });
        return;
      }
      if (request.method === "POST" && url.endsWith("/items")) {
        if (state.failItems) {
          send(500, { code: "internal", message: "injected failure" });
          return;
        }
        const parsed = JSON.parse(body) as { payload: Record<string, unknown> };
        state.items.push(parsed.payload);
        const id = `aev_${state.items.length}`;
        state.snapshotEvents.push({
          id, code: parsed.payload.code, name: parsed.payload.name,
          reasoning: parsed.payload.reasoning, projectId: "wproj_1",
          payloadSchema: parsed.payload.payloadSchema ?? {},
        });
        send(200, { kind: "event", created: true, item: { id } });
        return;
      }
      if (request.method === "POST" && url.endsWith("/complete")) {
        state.completions.push(JSON.parse(body) as Record<string, unknown>);
        send(200, { setupStatus: "complete" });
        return;
      }
      send(200, { id: "wrun_1", status: "running", phase: "surveying" });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
    });
  });
}

function scriptedProvider(expectations: Expectations): EngineProvider {
  return {
    name: "eval-scripted",
    async invoke(invocation: RoleInvocation) {
      if (invocation.role === "survey") {
        const files = expectations.expectedEvents.map((event) => event.anchorFile).join(", ");
        return { kind: "completed" as const, text: `Anchors: ${files || "none"}`, costUsd: 0, turns: 1 };
      }
      if (invocation.role === "design") {
        const propose = invocation.tools.find((tool) => tool.name === "propose_event");
        for (const event of expectations.expectedEvents) {
          await propose?.handler({
            code: event.code,
            name: event.code.replace(/_/g, " "),
            reasoning: "Deterministic eval proposal.",
            anchorFile: event.anchorFile,
            payloadSchema: { plan: "Plan code" },
          });
        }
        const finish = invocation.tools.find((tool) => tool.name === "finish_selection");
        await finish?.handler({ summary: "eval selection" });
        return { kind: "completed" as const, text: "selected", costUsd: 0, turns: 1 };
      }
      if (invocation.role === "edit") {
        for (const event of expectations.expectedEvents) {
          const anchor = join(invocation.cwd, event.anchorFile);
          const original = readFileSync(anchor, "utf8");
          if (!original.includes(event.code)) {
            writeFileSync(anchor, original + `\n// wired:${event.code}\n`);
          }
        }
        return { kind: "completed" as const, text: "edited", costUsd: 0, turns: 1 };
      }
      return { kind: "completed" as const, text: "VERDICT: pass", costUsd: 0, turns: 1 };
    },
  };
}

const models: EngineModelConfig = {
  survey: { model: "eval", maxTurns: 5, maxMs: 60_000 },
  design: { model: "eval", maxTurns: 5, maxMs: 60_000 },
  edit: { model: "eval", maxTurns: 5, maxMs: 60_000 },
  review: { model: "eval", maxTurns: 5, maxMs: 60_000 },
};

function materializeFixture(fixtureDir: string): string {
  const repo = mkdtempSync(join(tmpdir(), "eval-repo-"));
  cpSync(fixtureDir, repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "eval@example.com");
  git("config", "user.name", "Eval");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return repo;
}

async function runFixture(name: string, fixtureDir: string): Promise<FixtureResult> {
  const expectations = JSON.parse(
    readFileSync(join(fixtureDir, "expectations.json"), "utf8"),
  ) as Expectations;
  const failures: string[] = [];

  const repo = materializeFixture(fixtureDir);
  const state: MockRuntimeState = { items: [], completions: [], snapshotEvents: [], failItems: false };
  const { server, port } = await startMockRuntime(state);

  const result = await runEngine({
    repoPath: repo,
    repoFingerprint: `eval-${name}`,
    config: { apiBaseUrl: `http://127.0.0.1:${port}` } as WizardConfig,
    session: { token: "tok", appId: `app_${name}`, expiresAt: Date.now() / 1000 + 3600 } as WizardSession,
    provider: scriptedProvider(expectations),
    models,
    target: expectations.target,
    projectKind: "frontend",
    playbookSystemPrompt: "eval",
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }),
    callbacks: { reviewEvents: async (proposed) => proposed },
  });
  server.close();

  const check = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };

  check(
    state.items.length === expectations.expectedEvents.length,
    `registered ${state.items.length} events, expected ${expectations.expectedEvents.length}`,
  );
  check(state.items.length <= expectations.maxEvents || expectations.maxEvents === 0
    ? state.items.length <= Math.max(expectations.maxEvents, expectations.expectedEvents.length)
    : true, "anti-inflation bound exceeded");
  for (const expected of expectations.expectedEvents) {
    check(
      state.items.some((item) => item.code === expected.code),
      `missing registration for ${expected.code}`,
    );
    const anchor = readFileSync(join(repo, expected.anchorFile), "utf8");
    check(anchor.includes(expected.code), `anchor ${expected.anchorFile} not instrumented`);
  }
  for (const forbidden of expectations.forbiddenFiles) {
    const original = readFileSync(join(fixtureDir, forbidden), "utf8");
    const after = readFileSync(join(repo, forbidden), "utf8");
    check(original === after, `forbidden file ${forbidden} was modified`);
  }
  if (expectations.expectedEvents.length === 0) {
    check(result.kind === "aborted", `sparse fixture ended ${result.kind}, expected aborted`);
    check(state.completions.length === 0, "sparse fixture must not call /complete");
    check(state.items.length === 0, "sparse fixture must not register events");
  } else {
    check(result.kind === "completed", `run ended ${result.kind}`);
    const completion = state.completions[0] as { events?: Array<{ status: string }> } | undefined;
    check(
      (completion?.events?.length ?? 0) === expectations.expectedEvents.length,
      "completion evidence does not cover expected events",
    );
  }

  const listing = readdirSync(repo);
  if (expectations.expectedEvents.length > 0) {
    check(listing.includes("whisperr-events.ts"), "bindings module missing from applied patch");
  }

  return {
    fixture: name,
    passed: failures.length === 0,
    failures,
    registered: state.items.length,
    runKind: (result as EngineRunResult).kind,
  };
}

async function runFailureInjection(): Promise<FixtureResult> {
  const failures: string[] = [];
  const fixtureDir = join(process.cwd(), "evals", "fixtures", "webapp");
  const repo = materializeFixture(fixtureDir);
  const state: MockRuntimeState = { items: [], completions: [], snapshotEvents: [], failItems: true };
  const { server, port } = await startMockRuntime(state);
  const expectations = JSON.parse(readFileSync(join(fixtureDir, "expectations.json"), "utf8")) as Expectations;

  const result = await runEngine({
    repoPath: repo,
    repoFingerprint: "eval-failure",
    config: { apiBaseUrl: `http://127.0.0.1:${port}` } as WizardConfig,
    session: { token: "tok", appId: "app_failure", expiresAt: Date.now() / 1000 + 3600 } as WizardSession,
    provider: scriptedProvider(expectations),
    models,
    target: expectations.target,
    projectKind: "frontend",
    playbookSystemPrompt: "eval",
    sink: createProgressSink({ json: false, isTTY: false, write: () => {} }),
    callbacks: { reviewEvents: async (proposed) => proposed },
  });
  server.close();

  if (result.kind === "completed") failures.push("registration failure did not stop the run");
  if (state.completions.length !== 0) failures.push("failed run still completed server-side");
  const original = readFileSync(join(fixtureDir, "src", "checkout.ts"), "utf8");
  const after = readFileSync(join(repo, "src", "checkout.ts"), "utf8");
  if (original !== after) failures.push("failed run modified the user tree");

  return { fixture: "failure-injection", passed: failures.length === 0, failures, registered: state.items.length, runKind: result.kind };
}

async function main(): Promise<void> {
  const fixturesRoot = join(process.cwd(), "evals", "fixtures");
  const results: FixtureResult[] = [];
  for (const name of readdirSync(fixturesRoot)) {
    results.push(await runFixture(name, join(fixturesRoot, name)));
  }
  results.push(await runFailureInjection());

  const scorecard = {
    mode: "mock",
    generatedAt: new Date().toISOString(),
    results,
    passed: results.every((result) => result.passed),
  };
  const out = join(process.cwd(), "evals", "scorecard-mock.json");
  writeFileSync(out, JSON.stringify(scorecard, null, 2) + "\n");
  for (const result of results) {
    const status = result.passed ? "PASS" : "FAIL";
    console.log(`${status} ${result.fixture} (${result.registered} events, run ${result.runKind})`);
    for (const failure of result.failures) {
      console.log(`  - ${failure}`);
    }
  }
  if (!scorecard.passed) {
    process.exitCode = 1;
  }
}

void main();
