import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run, type RunContext, type RunOptions } from "./cli.js";
import { diagnosticErrorData, WizardDiagnostics } from "./core/diagnostics.js";
import { scrubError } from "./core/scrub.js";
import { theme } from "./ui/theme.js";

/**
 * Entry point for `npx @whisperr/wizard`.
 *
 * Usage:
 *   npx @whisperr/wizard [init] [path] [--api <url>] [--model <id>]
 *
 * `init` is accepted as an optional verb for readability; the wizard runs the
 * same flow with or without it.
 */
const modulePath = fileURLToPath(import.meta.url);

export function packageVersion(): string {
  const packagePath = join(dirname(modulePath), "..", "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

export function parseArgs(argv: string[]): RunOptions | { help: true } | { version: true } {
  const args = [...argv];
  const opts: RunOptions = {};

  // Drop a leading "init" verb.
  if (args[0] === "init") args.shift();

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "-h":
      case "--help":
        return { help: true };
      case "-v":
      case "--version":
        return { version: true };
      case "--force":
        opts.force = true;
        break;
      case "--api":
        opts.apiBaseUrl = args[++i];
        break;
      case "--model":
        opts.model = args[++i];
        break;
      default:
        if (a && !a.startsWith("-") && !opts.path) {
          opts.path = a; // positional: target repo path
        }
    }
  }
  return opts;
}

type HandledSignal = "SIGINT" | "SIGTERM";

export interface InvocationDependencies {
  createDiagnostics?: (repoPath: string) => WizardDiagnostics;
  run?: (
    options: RunOptions,
    diagnostics: WizardDiagnostics,
    context: RunContext,
  ) => Promise<number>;
  addSignalListener?: (signal: HandledSignal, listener: () => void) => void;
  removeSignalListener?: (signal: HandledSignal, listener: () => void) => void;
  setExitCode?: (code: number) => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      `  ${theme.bright("Whisperr Wizard")} — integrate Whisperr into your app.`,
      "",
      `  ${theme.bright("Usage")}`,
      "    npx @whisperr/wizard [init] [path] [options]",
      "",
      `  ${theme.bright("Options")}`,
      "    --force           Permit existing changes and preserve them on failed-run restore",
      "    --api <url>       Override the Whisperr API base URL",
      "    --model <id>      Override the coding-agent model",
      "    -h, --help        Show this help",
      "    -v, --version     Show version",
      "",
      `  ${theme.muted("The wizard detects your stack, authenticates with your")}`,
      `  ${theme.muted("onboarded account, generates its model, and wires the SDK.")}`,
      "",
    ].join("\n"),
  );
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if ("help" in parsed) {
    printHelp();
    return;
  }
  if ("version" in parsed) {
    // eslint-disable-next-line no-console
    console.log(packageVersion());
    return;
  }

  await runInvocation(parsed);
}

export async function runInvocation(
  options: RunOptions,
  dependencies: InvocationDependencies = {},
): Promise<void> {
  const createDiagnostics =
    dependencies.createDiagnostics ?? ((repoPath: string) => WizardDiagnostics.create(repoPath));
  const runWizard = dependencies.run ?? run;
  const addSignalListener =
    dependencies.addSignalListener ??
    ((signal: HandledSignal, listener: () => void) => process.once(signal, listener));
  const removeSignalListener =
    dependencies.removeSignalListener ??
    ((signal: HandledSignal, listener: () => void) =>
      process.removeListener(signal, listener));
  const setExitCode = dependencies.setExitCode ?? ((code: number) => (process.exitCode = code));
  const log = dependencies.log ?? console.log;
  const reportError = dependencies.error ?? console.error;
  const repoPath = resolve(options.path ?? process.cwd());

  let diagnostics: WizardDiagnostics;
  try {
    diagnostics = createDiagnostics(repoPath);
  } catch {
    reportError("Unable to create secure diagnostics. The wizard did not run.");
    setExitCode(1);
    return;
  }

  diagnostics.log("invocation_start", {
    version: packageVersion(),
    forced: Boolean(options.force),
  });
  log(`Diagnostics: ${diagnostics.path}`);

  const abortController = new AbortController();
  let receivedSignal: HandledSignal | undefined;
  const handlers: Record<HandledSignal, () => void> = {
    SIGINT: () => handleSignal("SIGINT"),
    SIGTERM: () => handleSignal("SIGTERM"),
  };

  function handleSignal(signal: HandledSignal): void {
    if (receivedSignal) return;
    receivedSignal = signal;
    diagnostics.log("termination_requested", { signal });
    abortController.abort(signal);
  }

  addSignalListener("SIGINT", handlers.SIGINT);
  addSignalListener("SIGTERM", handlers.SIGTERM);

  let exitCode = 1;
  try {
    const code = await runWizard(options, diagnostics, {
      signal: abortController.signal,
    });
    exitCode = receivedSignal ? signalExitCode(receivedSignal) : code;
    diagnostics.log("invocation_end", {
      outcome: receivedSignal ? "signal" : code === 0 ? "completed" : "failed",
      exitCode,
      signal: receivedSignal,
    });
  } catch (err) {
    if (receivedSignal) {
      exitCode = signalExitCode(receivedSignal);
      diagnostics.log("invocation_end", {
        outcome: "signal",
        exitCode,
        signal: receivedSignal,
      });
    } else {
      diagnostics.log("invocation_failure", diagnosticErrorData(err));
      reportError("\n" + theme.alert("Unexpected error: ") + scrubError(err));
    }
  } finally {
    removeSignalListener("SIGINT", handlers.SIGINT);
    removeSignalListener("SIGTERM", handlers.SIGTERM);
    diagnostics.close();
    setExitCode(exitCode);
  }
}

function signalExitCode(signal: HandledSignal): 130 | 143 {
  return signal === "SIGINT" ? 130 : 143;
}

function isCliEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(modulePath) === realpathSync(process.argv[1]);
  } catch {
    return modulePath === process.argv[1];
  }
}

if (isCliEntry()) {
  void main();
}
