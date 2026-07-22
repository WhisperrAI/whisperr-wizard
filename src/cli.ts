import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import open from "open";
import { runIntegrationAgent } from "./core/agent.js";
import { startDeviceAuth, startSessionKeepalive } from "./core/auth.js";
import type { CliFlags } from "./core/config.js";
import { resolveConfig } from "./core/config.js";
import { detectStack } from "./core/detect.js";
import { diagnosticErrorData, type WizardDiagnostics } from "./core/diagnostics.js";
import {
  changedFiles,
  hasWhisperrMethodCall,
  isWorkingTreeClean,
  repoFingerprint,
  restoreToSnapshot,
  revertHint,
  snapshotChanges,
  snapshotsEqual,
  takeCheckpoint,
  type ChangesSnapshot,
  type GitCheckpoint,
} from "./core/git.js";
import { playbookByTargetId, ALL_PLAYBOOKS } from "./core/playbooks/index.js";
import { verdictToVerified } from "./core/postflight.js";
import { postRunReport, scrubSummary } from "./core/report.js";
import { clearResumeState, saveResumeState } from "./core/resumeState.js";
import { scrubError } from "./core/scrub.js";
import { WizardRuntimeClient } from "./core/runtime.js";
import { pollFirstEvent } from "./core/verify.js";
import { selectOrCreateRun } from "./core/workflow.js";
import { banner } from "./ui/banner.js";
import { theme } from "./ui/theme.js";
import type { Detection, Playbook, WizardConfig, WizardSession } from "./types.js";

export interface RunOptions extends CliFlags {
  /** Target repo (defaults to cwd). */
  path?: string;
}

export interface RunContext {
  signal?: AbortSignal;
}

export async function run(
  options: RunOptions,
  diagnostics?: WizardDiagnostics,
  context: RunContext = {},
): Promise<number> {
  const repoPath = resolve(options.path ?? process.cwd());
  const config = resolveConfig(options);
  const signal = context.signal ?? new AbortController().signal;
  let interruptedBy = signal.aborted ? handledSignal(signal.reason) : undefined;
  signal.addEventListener(
    "abort",
    () => {
      interruptedBy = handledSignal(signal.reason);
    },
    { once: true },
  );
  diagnostics?.registerSecrets(config.directOpenAIKey);

  // eslint-disable-next-line no-console
  console.log(banner());
  p.intro(theme.signal("Let's build and wire your Whisperr intervention model."));

  const detections = await withSpinner("Scanning your repository", () =>
    detectStack(repoPath),
  );
  if (signal.aborted) return signalExitCode(interruptedBy);
  const chosen = await chooseTarget(detections);
  if (!chosen) {
    diagnostics?.log("run_failed", { stage: "stack_selection", reason: "cancelled" });
    p.cancel("No supported stack selected.");
    return 1;
  }
  diagnostics?.log("stack_selected", {
    stack: chosen.playbook.target.id,
    detected: Boolean(chosen.detection),
  });
  if (chosen.playbook.target.availability === "planned") {
    diagnostics?.log("run_failed", { stage: "stack_selection", reason: "unavailable" });
    p.cancel(
      `The ${chosen.playbook.target.displayName} SDK is not available yet, so the wizard cannot safely instrument this repository.`,
    );
    return 1;
  }
  p.log.success(
    `Detected ${theme.bright(chosen.playbook.target.displayName)} ` +
      theme.muted(`(${chosen.detection?.evidence.join(", ") ?? "selected"})`),
  );

  let session: WizardSession;
  try {
    session = await withBrowserAuth(config, diagnostics, signal);
    diagnostics?.registerSecrets(session.token);
  } catch (error) {
    const safeError = scrubError(error, [config.directOpenAIKey ?? ""]);
    diagnostics?.log("run_failed", {
      stage: "authentication",
      ...diagnosticErrorData(error),
    });
    p.cancel(theme.alert(safeError));
    return interruptedBy ? signalExitCode(interruptedBy) : 1;
  }
  const stopKeepalive = startSessionKeepalive(config, session);
  const fingerprint = await repoFingerprint(repoPath);
  const runtime = new WizardRuntimeClient(
    config,
    session,
    globalThis.fetch,
    diagnostics,
    signal,
  );

  let selected;
  try {
    selected = await withSpinner("Loading your wizard run", () =>
      selectOrCreateRun({
        apiBaseUrl: config.apiBaseUrl,
        repoPath,
        repoFingerprint: fingerprint,
        session,
        playbook: chosen.playbook,
        runtime,
      }),
    );
  } catch (error) {
    stopKeepalive();
    const safeError = scrubError(error, [session.token, config.directOpenAIKey ?? ""]);
    diagnostics?.log("run_failed", {
      stage: "run_selection",
      ...diagnosticErrorData(error),
    });
    p.cancel(theme.alert(safeError));
    return interruptedBy ? signalExitCode(interruptedBy) : 1;
  }
  diagnostics?.registerSecrets(selected.snapshot.ingestion.apiKey);
  diagnostics?.log("run_selected", {
    resumed: selected.resumed,
    appId: selected.snapshot.app.id,
    projectId: selected.snapshot.project.id,
    runId: selected.snapshot.run.id,
  });

  let phase = selected.resumed ? "resuming" : "exploring";
  const spin = p.spinner();
  const useSpinner = Boolean(process.stdout.isTTY);
  let checkpoint: GitCheckpoint;
  let invocationSnapshot: ChangesSnapshot;
  let heartbeat: ReturnType<typeof setInterval>;
  try {
    checkpoint = await takeCheckpoint(repoPath);
    invocationSnapshot = checkpoint.isRepo
      ? await snapshotChanges(repoPath, checkpoint)
      : new Map<string, Buffer | null>();
    if (
      !(await enforceGitSafety(
        repoPath,
        checkpoint,
        selected.resumed,
        options.force,
        diagnostics,
      ))
    ) {
      await runtime
        .updateRun(selected.snapshot.run.id, {
          status: "failed",
          error: "Repository is not in a safe state for automatic edits.",
          message: "Repository is not in a safe state for automatic edits.",
        })
        .catch(() => {});
      stopKeepalive();
      diagnostics?.log("run_failed", { stage: "git_safety", runId: selected.snapshot.run.id });
      return 1;
    }

    p.note(
      [
        `${selected.resumed ? "Resuming" : "Starting"} run ${selected.snapshot.run.id}`,
        `Project: ${selected.snapshot.project.displayName} (${selected.snapshot.project.kind})`,
        `Existing model: ${selected.snapshot.model.groups.length} groups, ${selected.snapshot.model.interventions.length} interventions, ${selected.snapshot.model.events.length} events, ${selected.snapshot.model.links.length} links`,
      ].join("\n"),
      theme.signal(selected.snapshot.app.name ?? selected.snapshot.app.id),
    );

    if (useSpinner) spin.start(theme.bright(phase));
    else p.log.step(theme.bright(phase));
    diagnostics?.log("phase", { phase: safeProgressText(phase) });
    heartbeat = setInterval(() => {
      void runtime.updateRun(selected.snapshot.run.id, {}).catch(() => {});
    }, 15_000);
    heartbeat.unref?.();
  } catch (error) {
    const safeError = scrubError(error, [
      session.token,
      config.directOpenAIKey ?? "",
      selected.snapshot.ingestion.apiKey,
    ]);
    await runtime
      .updateRun(selected.snapshot.run.id, {
        status: "failed",
        error: safeError,
        message: `failed during repository setup: ${safeError}`,
      })
      .catch(() => {});
    stopKeepalive();
    diagnostics?.log("run_failed", {
      stage: "repository_setup",
      runId: selected.snapshot.run.id,
      interrupted: Boolean(interruptedBy),
      ...diagnosticErrorData(error),
    });
    p.cancel(theme.alert(safeError));
    return interruptedBy ? signalExitCode(interruptedBy) : 1;
  }

  let runtimeCompleted = false;
  try {
    const outcome = await runIntegrationAgent({
      repoPath,
      config,
      session,
      playbook: chosen.playbook,
      snapshot: selected.snapshot,
      runtime,
      checkpoint,
      conversationId: selected.snapshot.run.modelConversationId,
      signal,
      async saveConversationId(conversationId) {
        await saveResumeState(selected.statePath, {
          runId: selected.snapshot.run.id,
          conversationId,
        });
      },
      progress: {
        onPhase(label) {
          phase = label;
          diagnostics?.log("phase", { phase: safeProgressText(label) });
          if (useSpinner) spin.message(theme.bright(label));
          else p.log.step(theme.bright(label));
        },
        onActivity(message) {
          diagnostics?.log("activity", {
            phase: safeProgressText(phase),
            activity: activityCategory(message),
          });
          if (useSpinner) spin.message(`${theme.bright(phase)}${theme.muted(` - ${message}`)}`);
        },
      },
    });
    runtimeCompleted = true;
    diagnostics?.log("integration_completed", {
      runId: selected.snapshot.run.id,
      durationMs: outcome.durationMs,
      wiredEventCount: outcome.wiredEvents.filter((event) => event.status === "wired").length,
      eventCount: outcome.wiredEvents.length,
    });

    clearInterval(heartbeat);
    if (useSpinner) spin.stop(theme.success("Integration complete"));
    else p.log.success(theme.success("Integration complete"));
    await clearResumeState(selected.statePath);

    const files =
      outcome.snapshot.run.integrationEvidence?.changedFiles ??
      (await changedFiles(repoPath, checkpoint));
    if (files.length) {
      p.note(files.map((file) => `${theme.muted("-")} ${file}`).join("\n"), "Files changed");
    }
    const summary = scrubSummary(outcome.summary).trim();
    if (summary) p.log.message(summary);
    if (outcome.wiredEvents.length) {
      p.note(
        outcome.wiredEvents
          .map((event) =>
            event.status === "wired"
              ? `${theme.success("+")} ${event.code}${event.file ? theme.muted(` - ${event.file}`) : ""}`
              : `${theme.muted("o")} ${event.code} - no call was detected in changed files`,
          )
          .join("\n"),
        "Events",
      );
    }

    const report = await postRunReport(config, session, {
      target: chosen.playbook.target.id,
      repo_fingerprint: fingerprint,
      identify_wired:
        outcome.snapshot.run.integrationEvidence?.identifyWired ??
        (await hasIdentifyCall(repoPath, files)),
      verified: outcome.verification
        ? verdictToVerified(outcome.verification)
        : null,
      cost_usd: 0,
      duration_ms: outcome.durationMs,
      summary: summary.slice(0, 4000),
      events: outcome.wiredEvents.map((event) => ({
        event_type: event.code,
        status: event.status,
        file: event.file,
      })),
    });
    if (!report.ok) {
      p.log.warn(theme.warn("The integration completed, but coverage reporting failed."));
    }
    diagnostics?.log("coverage_report", { ok: report.ok });

    p.log.step(
      theme.bright("Run your app once") +
        theme.muted(" and trigger a tracked action so Whisperr can confirm ingestion."),
    );
    const first = await pollFirstEvent(config, session, {
      timeoutMs: 120_000,
      signal,
    });
    if (interruptedBy) {
      diagnostics?.log("first_event", { outcome: "interrupted" });
      p.log.info(theme.muted("The integration is complete; first-event polling was interrupted."));
      return signalExitCode(interruptedBy);
    }
    if (first.received) {
      diagnostics?.log("first_event", {
        outcome: "received",
        eventTypePresent: Boolean(first.eventType),
      });
      p.log.success(
        theme.success("Whisperr is receiving events") +
          (first.eventType ? theme.muted(` (${first.eventType})`) : ""),
      );
    } else {
      diagnostics?.log("first_event", { outcome: "not_received" });
      p.log.info(theme.muted("No event received yet; events will flow when the app runs."));
    }

    const undo = invocationSnapshot.size === 0 ? revertHint(checkpoint) : undefined;
    p.note(
      [
        "1. Review the diff.",
        "2. Run or rebuild the app.",
        "3. Commit and deploy the integration.",
        undo ? `Undo the wizard changes: ${undo}` : "",
        !undo && checkpoint.isRepo
          ? "Pre-existing changes were preserved; review the diff to undo wizard edits selectively."
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "Next",
    );
    p.outro(theme.signal("Whisperr is wired in."));
    return 0;
  } catch (error) {
    clearInterval(heartbeat);
    const safeError = scrubError(error, [
      session.token,
      config.directOpenAIKey ?? "",
      selected.snapshot.ingestion.apiKey,
    ]);
    const failurePhase = interruptedBy ? "interrupted" : "failed";
    diagnostics?.log("run_failed", {
      stage: safeProgressText(phase),
      runId: selected.snapshot.run.id,
      interrupted: Boolean(interruptedBy),
      runtimeCompleted,
      ...diagnosticErrorData(error),
    });
    if (!runtimeCompleted) {
      const authoritative = await runtime
        .getRun(selected.snapshot.run.id)
        .catch(() => null);
      if (authoritative?.run.status === "completed") {
        runtimeCompleted = true;
        await clearResumeState(selected.statePath);
      }
    }
    if (runtimeCompleted) {
      p.log.error(
        theme.alert("The integration completed, but final reporting stopped: ") + safeError,
      );
      return interruptedBy ? signalExitCode(interruptedBy) : 1;
    }
    await runtime
      .updateRun(selected.snapshot.run.id, {
        status: "failed",
        error: safeError,
        message: `${failurePhase}: ${safeError}`,
      })
      .catch(() => {});
    if (useSpinner) spin.stop(theme.alert(interruptedBy ? "Integration interrupted" : "Integration stopped"));
    else p.log.error(theme.alert(interruptedBy ? "Integration interrupted" : "Integration stopped"));
    p.log.error(safeError);
    if (!interruptedBy) {
      await maybeRestoreInvocation(
        repoPath,
        checkpoint,
        invocationSnapshot,
        "This invocation stopped before completion.",
      );
    } else {
      p.log.info(theme.muted("Generated rows and repository edits were preserved for resume."));
    }
    return interruptedBy ? signalExitCode(interruptedBy) : 1;
  } finally {
    clearInterval(heartbeat);
    stopKeepalive();
  }
}

async function enforceGitSafety(
  repoPath: string,
  checkpoint: GitCheckpoint,
  resumed: boolean,
  force = false,
  diagnostics?: WizardDiagnostics,
): Promise<boolean> {
  if (!checkpoint.isRepo) {
    if (!force) {
      logGitSafety(diagnostics, checkpoint, resumed, force, false, false);
      p.cancel(
        "Not a git repository. Run `git init` and commit first, or use --force without automatic undo.",
      );
      return false;
    }
    logGitSafety(diagnostics, checkpoint, resumed, force, false, true);
    p.log.warn("Not a git repository; automatic undo is unavailable.");
    return true;
  }
  const clean = await isWorkingTreeClean(repoPath);
  if (clean) {
    logGitSafety(diagnostics, checkpoint, resumed, force, clean, true);
    return true;
  }
  if (force) {
    logGitSafety(diagnostics, checkpoint, resumed, force, clean, true);
    p.log.warn(
      theme.warn("Uncommitted changes present") +
        theme.muted("; this invocation will preserve them if it is reverted."),
    );
    return true;
  }
  if (resumed) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      logGitSafety(diagnostics, checkpoint, resumed, force, clean, false);
      p.cancel(
        "The resumed repository has uncommitted changes. Re-run with --force after confirming they are safe to edit.",
      );
      return false;
    }
    const confirmed = await p.confirm({
      message:
        "This resumed repository has uncommitted changes. Confirm they are the wizard edits you want to continue.",
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      logGitSafety(diagnostics, checkpoint, resumed, force, clean, false);
      return false;
    }
    logGitSafety(diagnostics, checkpoint, resumed, force, clean, true);
    return true;
  }
  logGitSafety(diagnostics, checkpoint, resumed, force, clean, false);
  p.cancel(
    "Your working tree has uncommitted changes. Commit or stash them first, or use --force.",
  );
  return false;
}

async function maybeRestoreInvocation(
  repoPath: string,
  checkpoint: GitCheckpoint,
  before: ChangesSnapshot,
  reason: string,
): Promise<boolean> {
  if (!checkpoint.isRepo) return false;
  const current = await snapshotChanges(repoPath, checkpoint);
  if (snapshotsEqual(before, current)) return false;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    p.log.info(theme.muted("Partial edits were preserved for resume."));
    return false;
  }
  const answer = await p.confirm({
    message: `${reason} Revert only the edits made by this invocation?`,
    initialValue: false,
  });
  if (p.isCancel(answer) || !answer) return false;
  const restored = await restoreToSnapshot(repoPath, checkpoint, before);
  if (restored) p.log.success("Restored the repository to its pre-invocation state.");
  else p.log.warn("Automatic restore failed; inspect the working tree manually.");
  return restored;
}

interface Chosen {
  playbook: Playbook;
  detection?: Detection;
}

async function chooseTarget(detections: Detection[]): Promise<Chosen | null> {
  const top = detections[0];
  if (top && (detections.length === 1 || top.confidence >= 0.9)) {
    const playbook = playbookByTargetId(top.target.id);
    if (playbook) return { playbook, detection: top };
  }
  const seen = new Set<string>();
  const choices: Array<{ value: string; label: string; hint?: string }> = [];
  for (const detection of detections) {
    if (seen.has(detection.target.id)) continue;
    seen.add(detection.target.id);
    choices.push({
      value: detection.target.id,
      label: detection.target.displayName,
      hint: `${Math.round(detection.confidence * 100)}% match`,
    });
  }
  for (const playbook of ALL_PLAYBOOKS) {
    if (seen.has(playbook.target.id)) continue;
    choices.push({
      value: playbook.target.id,
      label: playbook.target.displayName,
      hint: playbook.target.availability === "available" ? undefined : "coming soon",
    });
  }
  const answer = await p.select({
    message: detections.length
      ? "Which detected stack should Whisperr integrate?"
      : "Which stack should Whisperr integrate?",
    options: choices,
  });
  if (p.isCancel(answer)) return null;
  const playbook = playbookByTargetId(answer as string);
  return playbook
    ? { playbook, detection: detections.find((item) => item.target.id === answer) }
    : null;
}

async function withBrowserAuth(
  config: WizardConfig,
  diagnostics?: WizardDiagnostics,
  signal?: AbortSignal,
): Promise<WizardSession> {
  diagnostics?.log("auth_stage", { stage: "authorization_started" });
  p.log.step(theme.bright("Authenticate") + theme.muted(" - opening device approval"));
  const auth = await startDeviceAuth(config, signal);
  diagnostics?.registerSecrets(
    auth.userCode,
    auth.verificationUrl,
    auth.verificationUrlComplete,
  );
  diagnostics?.log("auth_stage", { stage: "device_authorization_created" });
  p.note(
    [
      `Code: ${auth.userCode}`,
      `Approval URL: ${auth.verificationUrl}`,
      "Use the URL and code if the browser does not open.",
    ].join("\n"),
    "Approve this device",
  );
  try {
    await open(auth.verificationUrlComplete ?? auth.verificationUrl);
    diagnostics?.log("auth_stage", { stage: "browser_opened" });
  } catch {
    diagnostics?.log("auth_stage", { stage: "browser_open_failed" });
    // The printed URL supports headless environments.
  }
  const spin = p.spinner();
  spin.start("Waiting for browser approval");
  try {
    const session = await auth.poll();
    diagnostics?.registerSecrets(session.token);
    diagnostics?.log("auth_stage", { stage: "approved" });
    spin.stop(theme.success("Authenticated"));
    return session;
  } catch (error) {
    diagnostics?.log("auth_stage", {
      stage: "failed",
      ...diagnosticErrorData(error),
    });
    spin.stop(theme.alert("Authentication failed"));
    throw error;
  }
}

function handledSignal(value: unknown): "SIGINT" | "SIGTERM" | undefined {
  return value === "SIGINT" || value === "SIGTERM" ? value : undefined;
}

function signalExitCode(signal: "SIGINT" | "SIGTERM" | undefined): 130 | 143 {
  return signal === "SIGTERM" ? 143 : 130;
}

function logGitSafety(
  diagnostics: WizardDiagnostics | undefined,
  checkpoint: GitCheckpoint,
  resumed: boolean,
  force: boolean,
  clean: boolean,
  allowed: boolean,
): void {
  diagnostics?.log("git_safety", {
    isRepository: checkpoint.isRepo,
    clean,
    forced: force,
    resumed,
    allowed,
    automaticUndo: checkpoint.isRepo,
  });
}

function safeProgressText(value: string): string {
  return scrubError(value).replace(/\s+/g, " ").slice(0, 160);
}

function activityCategory(value: string): string {
  const categories: Array<[string, string]> = [
    ["Edited ", "repository_edit"],
    ["Created ", "repository_create"],
    ["Configured ", "ingestion_configured"],
    ["Running ", "command_started"],
    ["Reading ", "repository_read"],
    ["Scanning ", "repository_scan"],
    ["Searching ", "repository_search"],
    ["Persisted ", "model_item_persisted"],
    ["Verification failed", "verification_failed"],
    ["The stable end-user identity", "identity_wiring_pending"],
    ["Generated events", "event_wiring_pending"],
    ["Runtime model", "runtime_completed"],
    ["The previous model conversation", "conversation_restarted"],
  ];
  return categories.find(([prefix]) => value.startsWith(prefix))?.[1] ?? "progress_update";
}

async function withSpinner<T>(label: string, action: () => Promise<T>): Promise<T> {
  const spin = p.spinner();
  spin.start(label);
  try {
    const result = await action();
    spin.stop(`${label} ${theme.success("ok")}`);
    return result;
  } catch (error) {
    spin.stop(theme.alert(`${label} failed`));
    throw error;
  }
}

async function hasIdentifyCall(repoPath: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    try {
      if (hasWhisperrMethodCall(await readFile(join(repoPath, file), "utf8"), "identify")) {
        return true;
      }
    } catch {
      // Ignore binary, deleted, or concurrently changed files.
    }
  }
  return false;
}
