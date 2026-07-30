import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { EventIntegrationStatus } from "./types.js";

export interface VerifyStep {
  kind: "analyze" | "typecheck" | "lint" | "build";
  command: string;
  args: string[];
}

export interface VerifyStepResult extends VerifyStep {
  ok: boolean;
  output: string;
}

const JS_TARGETS = new Set(["web-js", "nextjs", "node", "react-native"]);

export function resolveVerifySteps(repoPath: string, target: string): VerifyStep[] {
  if (target === "flutter") {
    return [{ kind: "analyze", command: "flutter", args: ["analyze", "--no-pub"] }];
  }
  if (JS_TARGETS.has(target)) {
    const scripts = packageScripts(repoPath);
    const steps: VerifyStep[] = [];
    if (scripts.typecheck) {
      steps.push({ kind: "typecheck", command: npmCommand(), args: ["run", "typecheck"] });
    } else if (hasTsconfig(repoPath)) {
      steps.push({ kind: "typecheck", command: "npx", args: ["--no-install", "tsc", "--noEmit"] });
    }
    if (scripts.lint) {
      steps.push({ kind: "lint", command: npmCommand(), args: ["run", "lint"] });
    }
    if (scripts.build) {
      steps.push({ kind: "build", command: npmCommand(), args: ["run", "build"] });
    }
    return steps;
  }
  return [];
}

function packageScripts(repoPath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function hasTsconfig(repoPath: string): boolean {
  try {
    readFileSync(join(repoPath, "tsconfig.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function runVerifyStep(
  cwd: string,
  step: VerifyStep,
  timeoutMs = 300_000,
): Promise<VerifyStepResult> {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const capture = (chunk: unknown) => {
      if (output.length < 20_000) {
        output += String(chunk);
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ...step, ok: false, output: String(error) });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const timeoutDetail = timedOut
        ? `\nVerification timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        : "";
      resolve({ ...step, ok: exitCode === 0 && !timedOut, output: output + timeoutDetail });
    });
  });
}

export async function runVerifySteps(
  cwd: string,
  steps: VerifyStep[],
): Promise<VerifyStepResult[]> {
  const results: VerifyStepResult[] = [];
  for (const step of steps) {
    results.push(await runVerifyStep(cwd, step));
  }
  return results;
}

// verifiedStatus reports the highest honest per-event status the executed steps
// support. No steps -> the event stays applied; a failing step keeps it applied
// (never inflated); passing analyze/typecheck/build raise the ceiling.
export function verifiedStatus(results: VerifyStepResult[]): EventIntegrationStatus {
  if (results.length === 0) {
    return "applied";
  }
  if (results.some((result) => !result.ok)) {
    return "applied";
  }
  if (results.some((result) => result.kind === "build")) {
    return "build_verified";
  }
  if (results.some(
    (result) => result.kind === "typecheck" || result.kind === "lint" || result.kind === "analyze",
  )) {
    return "type_verified";
  }
  return "syntax_verified";
}

export function runVerificationStatus(results: VerifyStepResult[]): "pending" | "passed" | "failed" | "unavailable" {
  if (results.length === 0) {
    return "unavailable";
  }
  return results.every((result) => result.ok) ? "passed" : "failed";
}

export function verificationCommand(results: VerifyStepResult[]): string | undefined {
  const relevant = results.find((result) => !result.ok) ?? results[results.length - 1];
  return relevant ? [relevant.command, ...relevant.args].join(" ") : undefined;
}
