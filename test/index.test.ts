import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WizardDiagnostics } from "../src/core/diagnostics.js";
import { parseArgs, packageVersion, runInvocation } from "../src/index.js";

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

for (const [signal, expectedExitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`${signal} keeps diagnostics open through cleanup and exits conventionally`, async () => {
    const root = await mkdtemp(join(tmpdir(), "wizard-lifecycle-"));
    const repo = join(root, "repo");
    const logs = join(root, "logs");
    await mkdir(repo);

    const listeners = new Map<string, Set<() => void>>();
    const sequence: string[] = [];
    let diagnosticsPath = "";
    let closeCalls = 0;
    let exitCode: number | undefined;
    let startRun: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      startRun = resolve;
    });

    const invocation = runInvocation(
      { path: repo },
      {
        createDiagnostics() {
          const diagnostics = WizardDiagnostics.create(repo, {
            WHISPERR_WIZARD_LOG_DIR: logs,
          });
          diagnosticsPath = diagnostics.path;
          const close = diagnostics.close.bind(diagnostics);
          diagnostics.close = () => {
            closeCalls += 1;
            sequence.push("diagnostics_closed");
            close();
          };
          return diagnostics;
        },
        async run(_options, diagnostics, context) {
          sequence.push("run_started");
          startRun?.();
          await new Promise<void>((resolve) => {
            context.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          diagnostics.log("cleanup_after_signal", { signal });
          sequence.push("run_stopped");
          return 1;
        },
        addSignalListener(name, listener) {
          const registered = listeners.get(name) ?? new Set();
          registered.add(listener);
          listeners.set(name, registered);
        },
        removeSignalListener(name, listener) {
          listeners.get(name)?.delete(listener);
        },
        setExitCode(code) {
          exitCode = code;
        },
        log() {},
        error(message) {
          assert.fail(message);
        },
      },
    );

    await runStarted;
    assert.equal(listeners.get("SIGINT")?.size, 1);
    assert.equal(listeners.get("SIGTERM")?.size, 1);
    for (const listener of listeners.get(signal) ?? []) listener();
    await invocation;

    assert.equal(exitCode, expectedExitCode);
    assert.equal(closeCalls, 1);
    assert.deepEqual(sequence, ["run_started", "run_stopped", "diagnostics_closed"]);
    assert.equal(listeners.get("SIGINT")?.size, 0);
    assert.equal(listeners.get("SIGTERM")?.size, 0);

    const records = (await readFile(diagnosticsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; exitCode?: number });
    assert.deepEqual(
      records.map((record) => record.event),
      ["invocation_start", "termination_requested", "cleanup_after_signal", "invocation_end"],
    );
    assert.equal(records.at(-1)?.exitCode, expectedExitCode);
  });
}

test("diagnostics creation fails closed without leaking path details", async () => {
  const leakedPath = "/private/customer/repository?token=opaque-secret";
  const errors: string[] = [];
  let runCalled = false;
  let exitCode: number | undefined;

  await runInvocation(
    { path: "/target/repository" },
    {
      createDiagnostics() {
        throw new Error(`EACCES: ${leakedPath}`);
      },
      async run() {
        runCalled = true;
        return 0;
      },
      setExitCode(code) {
        exitCode = code;
      },
      error(message) {
        errors.push(message);
      },
    },
  );

  assert.equal(runCalled, false);
  assert.equal(exitCode, 1);
  assert.deepEqual(errors, ["Unable to create secure diagnostics. The wizard did not run."]);
  assert.equal(errors.join(" ").includes(leakedPath), false);
  assert.equal(errors.join(" ").includes("opaque-secret"), false);
});
