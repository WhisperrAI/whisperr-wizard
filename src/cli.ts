import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import open from "open";
import { runIntegrationAgent } from "./core/agent.js";
import { startDeviceAuth, startSessionKeepalive } from "./core/auth.js";
import type { CliFlags } from "./core/config.js";
import { resolveConfig } from "./core/config.js";
import { detectStack } from "./core/detect.js";
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

export async function run(options: RunOptions): Promise<number> {
  const repoPath = resolve(options.path ?? process.cwd());
  const config = resolveConfig(options);

  // eslint-disable-next-line no-console
  console.log(banner());
  p.intro(theme.signal("Let's build and wire your Whisperr intervention model."));

  const detections = await withSpinner("Scanning your repository", () =>
    detectStack(repoPath),
  );
  const chosen = await chooseTarget(detections);
  if (!chosen) {
    p.cancel("No supported stack selected.");
    return 1;
  }
  if (chosen.playbook.target.availability === "planned") {
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
    session = await withBrowserAuth(config);
  } catch (error) {
    p.cancel(theme.alert(scrubError(error)));
    return 1;
  }
  const stopKeepalive = startSessionKeepalive(config, session);
  const fingerprint = await repoFingerprint(repoPath);
  const runtime = new WizardRuntimeClient(config, session);

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
    p.cancel(theme.alert(scrubError(error, [session.token, config.directOpenAIKey ?? ""])));
    return 1;
  }

  const abortController = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedBy = signal;
    abortController.abort(new Error(`Interrupted by ${signal}`));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

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
    if (!(await enforceGitSafety(repoPath, checkpoint, selected.resumed, options.force))) {
      await runtime
        .updateRun(selected.snapshot.run.id, {
          status: "failed",
          error: "Repository is not in a safe state for automatic edits.",
          message: "Repository is not in a safe state for automatic edits.",
        })
        .catch(() => {});
      stopKeepalive();
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
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
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    p.cancel(theme.alert(safeError));
    return interruptedBy === "SIGINT" ? 130 : 1;
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
      signal: abortController.signal,
      async saveConversationId(conversationId) {
        await saveResumeState(selected.statePath, {
          runId: selected.snapshot.run.id,
          conversationId,
        });
      },
      progress: {
        onPhase(label) {
          phase = label;
          if (useSpinner) spin.message(theme.bright(label));
          else p.log.step(theme.bright(label));
        },
        onActivity(message) {
          if (useSpinner) spin.message(`${theme.bright(phase)}${theme.muted(` - ${message}`)}`);
        },
      },
    });
    runtimeCompleted = true;

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

    p.log.step(
      theme.bright("Run your app once") +
        theme.muted(" and trigger a tracked action so Whisperr can confirm ingestion."),
    );
    const first = await pollFirstEvent(config, session, {
      timeoutMs: 120_000,
      signal: abortController.signal,
    });
    if (interruptedBy) {
      p.log.info(theme.muted("The integration is complete; first-event polling was interrupted."));
      return 130;
    }
    if (first.received) {
      p.log.success(
        theme.success("Whisperr is receiving events") +
          (first.eventType ? theme.muted(` (${first.eventType})`) : ""),
      );
    } else {
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
      return interruptedBy === "SIGINT" ? 130 : 1;
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
    return interruptedBy === "SIGINT" ? 130 : 1;
  } finally {
    clearInterval(heartbeat);
    stopKeepalive();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function enforceGitSafety(
  repoPath: string,
  checkpoint: GitCheckpoint,
  resumed: boolean,
  force = false,
): Promise<boolean> {
  if (!checkpoint.isRepo) {
    if (!force) {
      p.cancel(
        "Not a git repository. Run `git init` and commit first, or use --force without automatic undo.",
      );
      return false;
    }
    p.log.warn("Not a git repository; automatic undo is unavailable.");
    return true;
  }
  if (await isWorkingTreeClean(repoPath)) return true;
  if (force) {
    p.log.warn(
      theme.warn("Uncommitted changes present") +
        theme.muted("; this invocation will preserve them if it is reverted."),
    );
    return true;
  }
  if (resumed) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
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
    if (p.isCancel(confirmed) || !confirmed) return false;
    return true;
  }
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

async function withBrowserAuth(config: WizardConfig): Promise<WizardSession> {
  p.log.step(theme.bright("Authenticate") + theme.muted(" - opening device approval"));
  const auth = await startDeviceAuth(config);
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
  } catch {
    // The printed URL supports headless environments.
  }
  const spin = p.spinner();
  spin.start("Waiting for browser approval");
  try {
    const session = await auth.poll();
    spin.stop(theme.success("Authenticated"));
    return session;
  } catch (error) {
    spin.stop(theme.alert("Authentication failed"));
    throw error;
  }
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
