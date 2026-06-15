import { run, type RunOptions } from "./cli.js";
import { theme } from "./ui/theme.js";

/**
 * Entry point for `npx @whisperr/wizard`.
 *
 * Usage:
 *   npx @whisperr/wizard [init] [path] [--offline] [--api <url>] [--model <id>]
 *
 * `init` is accepted as an optional verb for readability; the wizard runs the
 * same flow with or without it.
 */
function parseArgs(argv: string[]): RunOptions | { help: true } | { version: true } {
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
      case "--offline":
        opts.offline = true;
        break;
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
      "    --offline         Use a demo manifest, no account/browser needed",
      "    --force           Proceed without a clean git tree (no safe undo)",
      "    --api <url>       Override the Whisperr API base URL",
      "    --model <id>      Override the coding-agent model",
      "    -h, --help        Show this help",
      "    -v, --version     Show version",
      "",
      `  ${theme.muted("The wizard detects your stack, authenticates with your")}`,
      `  ${theme.muted("onboarded account, and wires up identify() + your events.")}`,
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if ("help" in parsed) {
    printHelp();
    return;
  }
  if ("version" in parsed) {
    // eslint-disable-next-line no-console
    console.log("0.1.7");
    return;
  }

  try {
    const code = await run(parsed);
    process.exit(code);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("\n" + theme.alert("Unexpected error: ") + (err as Error).message);
    process.exit(1);
  }
}

void main();
