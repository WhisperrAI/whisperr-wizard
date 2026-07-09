import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type { CliFlags } from "./core/config.js";
import { resolveConfig } from "./core/config.js";
import { detectStack } from "./core/detect.js";
import { playbookByTargetId, ALL_PLAYBOOKS } from "./core/playbooks/index.js";
import { authenticate } from "./core/auth.js";
import { fetchManifest } from "./core/manifest.js";
import { runIntegrationAgent, runAdditionsInstrumentationPass } from "./core/agent.js";
import { collectOpportunities, submitAdditions } from "./core/opportunities.js";
import {
  takeCheckpoint,
  changedFiles,
  revertHint,
  revertToCheckpoint,
  isWorkingTreeClean,
  repoFingerprint,
  scanWiredEvents,
  snapshotChanges,
  snapshotsEqual,
  restoreToSnapshot,
  type ChangesSnapshot,
  type GitCheckpoint,
} from "./core/git.js";
import { pollFirstEvent } from "./core/verify.js";
import { runVerifyCommand, verdictToVerified } from "./core/postflight.js";
import { postRunReport, type ReportEvent } from "./core/report.js";
import { banner } from "./ui/banner.js";
import { theme } from "./ui/theme.js";
import type {
  Detection,
  IntegrationManifest,
  OpportunityEvent,
  Playbook,
  UniverseOpportunities,
  WizardConfig,
  WizardSession,
} from "./types.js";

export interface RunOptions extends CliFlags {
  /** Target repo (defaults to cwd). */
  path?: string;
}

export async function run(options: RunOptions): Promise<number> {
  const repoPath = resolve(options.path ?? process.cwd());
  const config = resolveConfig(options);

  // eslint-disable-next-line no-console
  console.log(banner());
  p.intro(theme.signal("Let's wire Whisperr into your app."));

  if (config.offline) {
    p.log.warn(
      theme.warn("offline mode") +
        theme.muted(" — using a demo manifest, no account needed."),
    );
  }

  // 1. Detect the stack.
  const detections = await withSpinner("Scanning your repository", () =>
    detectStack(repoPath),
  );
  const chosen = await chooseTarget(detections);
  if (!chosen) {
    p.cancel("No supported stack selected.");
    return 1;
  }

  if (chosen.playbook.target.availability === "planned") {
    p.note(
      `We can detect ${theme.bright(chosen.playbook.target.displayName)} but the ` +
        `Whisperr SDK for it isn't shipped yet.\n` +
        `Flutter is live today; ${theme.bright(
          chosen.playbook.target.displayName,
        )} is next on the roadmap.`,
      theme.warn("SDK coming soon"),
    );
    const cont = await p.confirm({
      message: "Continue anyway and let the agent scaffold against the planned SDK?",
      initialValue: false,
    });
    if (p.isCancel(cont) || !cont) {
      p.outro(theme.muted("No problem — come back when the SDK lands."));
      return 0;
    }
  } else {
    p.log.success(
      `Detected ${theme.bright(chosen.playbook.target.displayName)} ` +
        theme.muted(`(${chosen.detection?.evidence.join(", ") ?? "selected"})`),
    );
  }

  // 2. Authenticate (device flow opens the browser).
  let session;
  try {
    session = config.offline
      ? await authenticate(config)
      : await withBrowserAuth(config);
  } catch (err) {
    p.cancel(theme.alert((err as Error).message));
    return 1;
  }

  // 3. Pull the integration manifest (events/interventions/key), telling the
  //    backend which surface this is so it can mark what's already covered.
  const fingerprint = await repoFingerprint(repoPath);
  const manifest = await withSpinner("Loading your onboarding context", () =>
    fetchManifest(config, session, chosen.playbook.target.id, fingerprint),
  );
  p.note(
    summarizeManifest(manifest),
    theme.signal(`Plan for ${manifest.appName ?? manifest.appId}`),
  );

  // 4. Git safety. The agent auto-applies edits, so we require a clean repo:
  //    that isolates the wizard's changes and makes a one-command revert
  //    reliable. --force opts out of the safety net.
  const checkpoint = await takeCheckpoint(repoPath);
  if (!checkpoint.isRepo) {
    if (!options.force) {
      p.cancel(
        theme.alert("Not a git repository.") +
          " The wizard edits your code and relies on git to undo safely.\n" +
          theme.muted("Run `git init` and commit first, or re-run with --force to proceed without a safety net."),
      );
      return 1;
    }
    p.log.warn(
      theme.warn("not a git repo") +
        theme.muted(" — proceeding with --force; there is no automatic undo."),
    );
  } else if (!(await isWorkingTreeClean(repoPath))) {
    if (!options.force) {
      p.cancel(
        theme.alert("Your working tree has uncommitted changes.") +
          " Commit or stash them first so the wizard's edits stay isolated and reversible.\n" +
          theme.muted("Or re-run with --force to proceed anyway."),
      );
      return 1;
    }
    p.log.warn(
      theme.warn("uncommitted changes present") +
        theme.muted(" — proceeding with --force; a revert would also drop your own changes."),
    );
  }

  // 5. Run the coding agent.
  const spin = p.spinner();
  let phaseLabel = "Integrating";
  let lastLine = "";
  const startedAt = Date.now();
  spin.start(theme.bright(phaseLabel));
  // Drive the spinner off a ticking clock so it always reads as alive, even
  // while the agent spends 30s+ inside one set of tool calls.
  const tick = setInterval(() => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    spin.message(
      theme.bright(phaseLabel) +
        theme.muted(` · ${secs}s`) +
        (lastLine ? theme.muted(` — ${lastLine}`) : ""),
    );
  }, 1000);

  const outcome = await runIntegrationAgent({
    repoPath,
    config,
    session,
    playbook: chosen.playbook,
    manifest,
    progress: {
      onPhase(label) {
        phaseLabel = label;
        lastLine = "";
      },
      onActivity(line) {
        lastLine = line;
      },
    },
  }).catch((err) => {
    p.log.error((err as Error).message);
    return null;
  });

  clearInterval(tick);
  if (!outcome) {
    spin.stop(theme.alert("Integration stopped"));
    await maybeRevert(repoPath, checkpoint, "The run stopped before finishing.");
    return 1;
  }

  // Honest stop label: the core landing is the bar; events may be partial.
  const stopLabel = !outcome.coreOk
    ? theme.warn("Stopped early — partial setup is in your working tree")
    : outcome.eventsComplete
      ? theme.success("Integration complete")
      : theme.success("Core integration done") +
        theme.muted(" — some events left as follow-ups");
  spin.stop(stopLabel);

  // Collect any universe opportunities the review pass wrote (this also
  // removes the proposals file so it never shows up in the customer's diff).
  const opportunities = await collectOpportunities(repoPath, manifest, checkpoint);

  // 6. Show what changed + cost + the agent's summary.
  const files = await changedFiles(repoPath, checkpoint);
  if (files.length) {
    p.note(files.map((f) => theme.muted("• ") + f).join("\n"), "Files changed");
  }
  if (outcome.summary.trim()) {
    p.log.message(outcome.summary.trim());
  }

  // If the core (install + identify) didn't land, the integration isn't
  // trustworthy — offer to undo rather than leaving broken/partial edits.
  if (!outcome.coreOk) {
    const reverted = await maybeRevert(
      repoPath,
      checkpoint,
      "The core setup didn't complete, so these changes may be incomplete.",
    );
    if (reverted) {
      p.outro(theme.muted("Reverted — nothing was left in your working tree."));
      return 1;
    }
  }

  // 6b. Deterministic guardrail: run the playbook's verify command OURSELVES so
  //     "the agent finished" is backed by "the project still compiles/lints".
  //     The agent is told not to build or run the analyzer — we own that check
  //     rather than trusting its self-report.
  // null = not run / couldn't conclude; true = passed; false = failed.
  let verified: boolean | null = null;
  if (chosen.playbook.verifyCommand && files.length) {
    const cmd = chosen.playbook.verifyCommand;
    const vspin = p.spinner();
    vspin.start(`Verifying the integration — ${theme.muted(cmd)}`);
    const verdict = await runVerifyCommand(repoPath, cmd);
    verified = verdictToVerified(verdict);
    if (verdict.toolMissing) {
      vspin.stop(
        theme.warn("Couldn't verify automatically") +
          theme.muted(` — \`${cmd}\` isn't available here. Run it yourself before committing.`),
      );
    } else if (verdict.timedOut) {
      vspin.stop(
        theme.warn(`Verification timed out — \`${cmd}\``) +
          theme.muted(" — run it yourself before committing."),
      );
    } else if (verdict.ok) {
      vspin.stop(theme.success("Verified ✓") + theme.muted(` (${cmd})`));
    } else {
      vspin.stop(theme.alert(`Verification failed — ${cmd}`));
      if (verdict.output) {
        p.note(verdict.output, theme.warn("Verifier output"));
      }
      const reverted = await maybeRevert(
        repoPath,
        checkpoint,
        "The integration didn't pass its build/lint check, so the edits may be broken.",
      );
      if (reverted) {
        p.outro(theme.muted("Reverted — nothing was left in your working tree."));
        return 1;
      }
    }
  }

  // 6c. Universe opportunities: the agent may have proposed events /
  //     interventions the onboarding plan misses. The user picks which to add;
  //     whisperr-go appends them to the universe (dedupe is server-side), and
  //     accepted events get instrumented in one bounded follow-up pass.
  const { acceptedEvents, instrumentationSnapshot } = await offerOpportunities({
    repoPath,
    config,
    session,
    playbook: chosen.playbook,
    manifest,
    opportunities,
    fingerprint,
    checkpoint,
    remainingBudgetUsd: config.budgetUsd - outcome.costUsd,
  });

  // 6d. The instrumentation pass edits code AFTER the 6b check ran, so that
  //     verdict no longer describes the working tree. Re-run the same verify
  //     command so the reported `verified` reflects the final state — the 6b
  //     result must never claim "verified" for a tree a later pass then broke.
  if (instrumentationSnapshot && chosen.playbook.verifyCommand) {
    const cmd = chosen.playbook.verifyCommand;
    const preInstrumentationVerified = verified;
    const vspin = p.spinner();
    vspin.start(`Re-verifying after instrumenting the new events — ${theme.muted(cmd)}`);
    const verdict = await runVerifyCommand(repoPath, cmd);
    verified = verdictToVerified(verdict);
    if (verdict.toolMissing) {
      vspin.stop(
        theme.warn("Couldn't re-verify automatically") +
          theme.muted(` — \`${cmd}\` isn't available here. Run it yourself before committing.`),
      );
    } else if (verdict.timedOut) {
      vspin.stop(
        theme.warn(`Re-verification timed out — \`${cmd}\``) +
          theme.muted(" — run it yourself before committing."),
      );
    } else if (verdict.ok) {
      vspin.stop(theme.success("Verified ✓") + theme.muted(` (${cmd})`));
    } else {
      vspin.stop(theme.alert(`Verification failed after instrumenting the new events — ${cmd}`));
      if (verdict.output) {
        p.note(verdict.output, theme.warn("Verifier output"));
      }
      // Offer to undo ONLY the instrumentation pass — the integration that
      // passed 6b stays, and the accepted events remain in the universe.
      const doRevert = await p.confirm({
        message:
          "Instrumenting the new events didn't pass the build/lint check. " +
          "Revert just those edits? (The events stay in your universe — wire them on a future run.)",
        initialValue: true,
      });
      if (!p.isCancel(doRevert) && doRevert) {
        if (await restoreToSnapshot(repoPath, checkpoint, instrumentationSnapshot)) {
          verified = preInstrumentationVerified;
          p.log.success(theme.success("Reverted the instrumentation edits."));
        } else {
          p.log.warn(
            theme.warn("Couldn't revert automatically — undo manually: ") +
              (revertHint(checkpoint) ?? "git reset --hard"),
          );
        }
      } else {
        p.log.info(
          theme.muted("Left in your working tree — fix the verifier errors before committing."),
        );
      }
    }
  }

  // Derive which events actually got wired (from the diff) and record coverage
  // so future runs — including on other surfaces — know what this one handled.
  // Recompute the diff: the additions pass may have touched more files.
  const filesForScan = acceptedEvents.length
    ? await changedFiles(repoPath, checkpoint)
    : files;
  const eventTypesToScan = [
    ...manifest.events.map((e) => e.eventType),
    ...acceptedEvents.map((e) => e.code),
  ];
  const wiredMap = await scanWiredEvents(repoPath, filesForScan, eventTypesToScan);
  const reportEvents: ReportEvent[] = eventTypesToScan.map((eventType) => ({
    event_type: eventType,
    status: wiredMap.has(eventType) ? "wired" : "skipped",
    file: wiredMap.get(eventType),
  }));
  const reportResult = await postRunReport(config, session, {
    target: chosen.playbook.target.id,
    repo_fingerprint: fingerprint,
    identify_wired: outcome.coreOk,
    verified,
    cost_usd: outcome.costUsd,
    duration_ms: outcome.durationMs,
    summary: outcome.summary.slice(0, 4000),
    events: reportEvents,
  });
  if (!reportResult.ok) {
    p.log.warn(
      theme.warn("Couldn't record this run's coverage on the server") +
        theme.muted(
          ` (${formatReportFailure(reportResult)}) — ` +
            "future runs may re-propose events already wired here.",
        ),
    );
  }

  p.log.info(
    theme.muted(
      `${wiredMap.size}/${eventTypesToScan.length} events wired · ` +
        `${files.length} file${files.length === 1 ? "" : "s"} changed · ` +
        (verified === true ? "verified · " : verified === false ? "unverified · " : "") +
        `${Math.round(outcome.durationMs / 1000)}s`,
    ),
  );

  // 7. Activation: wait for the first event (skipped offline).
  if (!config.offline) {
    p.log.step(
      theme.bright("Run your app once") +
        theme.muted(" and trigger any tracked action — I'll watch for the first event."),
    );
    const verifySpin = p.spinner();
    verifySpin.start("Waiting for the first event from your app");
    const first = await pollFirstEvent(config, session, { timeoutMs: 120_000 });
    if (first.received) {
      verifySpin.stop(
        theme.success(
          `Whisperr is receiving events ✓` +
            (first.eventType ? theme.muted(`  (first: ${first.eventType})`) : ""),
        ),
      );
    } else {
      verifySpin.stop(
        theme.warn(
          "No events yet — that's fine. They'll flow once you run the app with the changes.",
        ),
      );
    }
  }

  // 8. Outro with next steps + undo.
  const undo = revertHint(checkpoint);
  const nextSteps = [
    `${theme.signal("1.")} Review the diff above.`,
    `${theme.signal("2.")} Run / rebuild your app to start sending events.`,
    `${theme.signal("3.")} Commit & deploy — Whisperr starts working on real users.`,
    undo ? theme.muted(`Undo everything: ${undo}`) : "",
  ]
    .filter(Boolean)
    .join("\n");
  p.note(nextSteps, theme.bright("Next"));
  p.outro(theme.signal("⌁ ") + theme.bright("Whisperr is wired in."));
  return 0;
}

// --- helpers ---

interface AdditionsOutcome {
  /** Events the backend actually applied to the universe. */
  acceptedEvents: OpportunityEvent[];
  /**
   * Pre-instrumentation snapshot of the wizard's changes, set only when the
   * instrumentation pass actually edited files. Non-null tells the caller the
   * 6b verify verdict is stale and gives it the exact state to restore if the
   * re-check fails.
   */
  instrumentationSnapshot: ChangesSnapshot | null;
}

const NO_ADDITIONS: AdditionsOutcome = { acceptedEvents: [], instrumentationSnapshot: null };

/**
 * Present the agent's universe opportunities, submit the confirmed ones to
 * whisperr-go, and instrument the events the backend actually applied.
 * Returns the accepted (applied) events plus a snapshot for undoing the
 * instrumentation edits. Never throws — opportunities are additive and must
 * not fail the run.
 */
async function offerOpportunities(opts: {
  repoPath: string;
  config: WizardConfig;
  session: WizardSession;
  playbook: Playbook;
  manifest: IntegrationManifest;
  opportunities: UniverseOpportunities;
  fingerprint: string;
  checkpoint: GitCheckpoint;
  remainingBudgetUsd: number;
}): Promise<AdditionsOutcome> {
  const { opportunities, manifest, config, session } = opts;
  const total = opportunities.events.length + opportunities.interventions.length;
  if (total === 0) return NO_ADDITIONS;

  const describe = (kind: string, code: string, why?: string) =>
    `${theme.muted(`${kind}: `)}${theme.bright(code)}${why ? theme.muted(` — ${why}`) : ""}`;
  p.note(
    [
      ...opportunities.events.map((e) => describe("event", e.code, e.rationale ?? e.description)),
      ...opportunities.interventions.map((i) =>
        describe("intervention", i.code, i.rationale ?? i.description),
      ),
    ].join("\n"),
    theme.signal("Opportunities found beyond your onboarding plan"),
  );

  if (config.offline) {
    p.log.info(theme.muted("Offline mode — proposals shown only, nothing submitted."));
    return NO_ADDITIONS;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    p.log.info(
      theme.muted("Non-interactive run — proposals were not submitted. Re-run interactively to add them."),
    );
    return NO_ADDITIONS;
  }

  const selection = await p.multiselect({
    message: "Add these to your Whisperr universe? (new interventions start paused)",
    options: [
      ...opportunities.events.map((e) => ({
        value: `e:${e.code}`,
        label: `event · ${e.code}`,
        hint: e.description ?? e.rationale,
      })),
      ...opportunities.interventions.map((i) => ({
        value: `i:${i.code}`,
        label: `intervention · ${i.code}`,
        hint: i.description ?? i.rationale,
      })),
    ],
    // Opt-in per item: nothing is pre-selected, so adding to the universe is an
    // explicit choice rather than an opt-out the user has to notice and undo.
    initialValues: [],
    required: false,
  });
  if (p.isCancel(selection) || selection.length === 0) {
    p.log.info(theme.muted("Skipped — your universe is unchanged."));
    return NO_ADDITIONS;
  }

  const chosenSet = new Set(selection as string[]);
  const knownInterventionCodes = new Set(
    manifest.events.flatMap((e) => e.interventions ?? []).map((i) => i.code),
  );
  const knownEventCodes = new Set(manifest.events.map((e) => e.eventType));
  const pickedEvents = opportunities.events.filter((e) => chosenSet.has(`e:${e.code}`));
  const pickedInterventions = opportunities.interventions.filter((i) =>
    chosenSet.has(`i:${i.code}`),
  );
  // Drop links whose other end wasn't selected and doesn't already exist —
  // the server would reject them as unknown references anyway.
  const pickedInterventionCodes = new Set(pickedInterventions.map((i) => i.code));
  const pickedEventCodes = new Set(pickedEvents.map((e) => e.code));
  const submitted: UniverseOpportunities = {
    events: pickedEvents.map((e) => ({
      ...e,
      links: e.links?.filter(
        (l) => knownInterventionCodes.has(l.interventionCode) || pickedInterventionCodes.has(l.interventionCode),
      ),
    })),
    interventions: pickedInterventions.map((i) => ({
      ...i,
      links: i.links?.filter(
        (l) => knownEventCodes.has(l.eventCode) || pickedEventCodes.has(l.eventCode),
      ),
    })),
  };

  let result;
  try {
    result = await withSpinner("Adding to your universe", () =>
      submitAdditions(config, session, opts.playbook.target.id, opts.fingerprint, submitted),
    );
  } catch (err) {
    p.log.warn(
      theme.warn("Couldn't add the proposals") +
        theme.muted(` — ${(err as Error).message}. Your universe is unchanged.`),
    );
    return NO_ADDITIONS;
  }

  const lines = result.outcomes.map((o) => {
    const mark =
      o.status === "applied"
        ? theme.success("✓")
        : o.status === "duplicate"
          ? theme.muted("=")
          : theme.warn("✗");
    const detail =
      o.status === "duplicate"
        ? theme.muted(` (already in your universe${o.duplicateOf && o.duplicateOf !== o.code ? ` as ${o.duplicateOf}` : ""})`)
        : o.status === "invalid" && o.reason
          ? theme.muted(` (${o.reason})`)
          : "";
    return `${mark} ${o.kind} ${theme.bright(o.code)}${detail}`;
  });
  lines.push(
    theme.muted(
      `${result.applied} added · ${result.duplicates} already present · ${result.invalid} rejected`,
    ),
  );
  if (submitted.interventions.length) {
    lines.push(theme.muted("New interventions start paused — activate them in your dashboard."));
  }
  // The regen leg tells us whether live decisioning will actually see the
  // applied rows — "Universe updated" alone would overpromise when it failed.
  if (result.policyRegen?.status === "pending") {
    lines.push(
      theme.muted("Runtime policy update queued — the additions go live once it completes."),
    );
  }
  if (result.policyRegen?.status === "draft") {
    lines.push(
      theme.muted(
        "A review policy draft was queued — activate it in your dashboard once it finishes generating to take the additions live (your current live policy was left untouched).",
      ),
    );
  }
  p.note(lines.join("\n"), theme.signal("Universe updated"));
  if (result.policyRegen?.status === "failed") {
    p.log.warn(
      theme.warn("Live runtime NOT updated") +
        theme.muted(
          " — the additions were recorded, but the runtime policy wasn't regenerated" +
            (result.policyRegen.reason ? `: ${result.policyRegen.reason}` : "") +
            ". They won't drive live decisions until the policy regenerates.",
        ),
    );
  }

  const appliedEventCodes = new Set(
    result.outcomes
      .filter((o) => o.kind === "event" && o.status === "applied")
      .map((o) => o.code),
  );
  const acceptedEvents = pickedEvents.filter((e) => appliedEventCodes.has(e.code));
  if (!acceptedEvents.length) return NO_ADDITIONS;

  // Wire the newly accepted events now — otherwise they'd exist in the plan
  // but never fire from this surface. Snapshot the tree first: it's the state
  // 6b verified, and the exact point to restore if this pass breaks the build.
  const prePass = await snapshotChanges(opts.repoPath, opts.checkpoint);
  const spin = p.spinner();
  spin.start(theme.bright("Instrumenting the newly added events"));
  try {
    const pass = await runAdditionsInstrumentationPass({
      repoPath: opts.repoPath,
      config,
      session,
      playbook: opts.playbook,
      acceptedEvents,
      budgetUsd: opts.remainingBudgetUsd,
    });
    if (pass.ran) {
      spin.stop(theme.success("New events instrumented"));
      if (pass.summary.trim()) p.log.message(pass.summary.trim());
    } else {
      spin.stop(
        theme.warn("Skipped instrumenting the new events") +
          theme.muted(
            " — the spend limit was reached. They're in your universe; wire them on a future run.",
          ),
      );
    }
  } catch (err) {
    spin.stop(
      theme.warn("Couldn't instrument the new events") +
        theme.muted(` — ${(err as Error).message}. They're in your universe; wire them on a future run.`),
    );
  }
  // Even a failed pass may have left partial edits behind — compare contents,
  // not just the outcome, so the caller re-verifies exactly when needed.
  const edited = !snapshotsEqual(prePass, await snapshotChanges(opts.repoPath, opts.checkpoint));
  return { acceptedEvents, instrumentationSnapshot: edited ? prePass : null };
}

/**
 * Offer to undo the wizard's changes when a run didn't finish cleanly. Returns
 * true if the working tree was reverted. No-op when there's nothing to revert.
 */
async function maybeRevert(
  repoPath: string,
  checkpoint: GitCheckpoint,
  reason: string,
): Promise<boolean> {
  if (!checkpoint.isRepo) return false;
  const files = await changedFiles(repoPath, checkpoint);
  if (files.length === 0) return false;

  const doRevert = await p.confirm({
    message: `${reason} Revert all of the wizard's changes now?`,
    initialValue: true,
  });
  if (p.isCancel(doRevert) || !doRevert) {
    const hint = revertHint(checkpoint);
    if (hint) p.log.info(theme.muted(`Left in your working tree. Undo anytime: ${hint}`));
    return false;
  }

  const ok = await revertToCheckpoint(repoPath, checkpoint);
  if (ok) {
    p.log.success(theme.success("Reverted to your pre-wizard state."));
  } else {
    p.log.warn(
      theme.warn("Couldn't revert automatically — undo manually: ") +
        (revertHint(checkpoint) ?? "git reset --hard"),
    );
  }
  return ok;
}

interface Chosen {
  playbook: Playbook;
  detection?: Detection;
}

async function chooseTarget(detections: Detection[]): Promise<Chosen | null> {
  const top = detections[0];
  // Strong single match -> auto-pick.
  if (top && (detections.length === 1 || top.confidence >= 0.9)) {
    const playbook = playbookByTargetId(top.target.id);
    if (playbook) return { playbook, detection: top };
  }

  // Ambiguous or none -> ask, seeded by detections then all targets.
  const seen = new Set<string>();
  const options: { value: string; label: string; hint?: string }[] = [];
  for (const d of detections) {
    if (seen.has(d.target.id)) continue;
    seen.add(d.target.id);
    options.push({
      value: d.target.id,
      label: d.target.displayName,
      hint:
        (d.target.availability === "available" ? "" : "coming soon · ") +
        `${Math.round(d.confidence * 100)}% match`,
    });
  }
  for (const pb of ALL_PLAYBOOKS) {
    if (seen.has(pb.target.id)) continue;
    options.push({
      value: pb.target.id,
      label: pb.target.displayName,
      hint: pb.target.availability === "available" ? undefined : "coming soon",
    });
  }

  const answer = await p.select({
    message: detections.length
      ? "I found more than one possible stack — which should I integrate?"
      : "I couldn't auto-detect your stack. Which are you using?",
    options,
  });
  if (p.isCancel(answer)) return null;
  const playbook = playbookByTargetId(answer as string);
  if (!playbook) return null;
  return {
    playbook,
    detection: detections.find((d) => d.target.id === answer),
  };
}

async function withBrowserAuth(config: ReturnType<typeof resolveConfig>) {
  p.log.step(
    theme.bright("Authenticate") +
      theme.muted(" — opening your browser to approve this device…"),
  );
  const spin = p.spinner();
  spin.start("Waiting for you to approve in the browser");
  try {
    const session = await authenticate(config);
    spin.stop(theme.success("Authenticated ✓"));
    return session;
  } catch (err) {
    spin.stop(theme.alert("Authentication failed"));
    throw err;
  }
}

async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const spin = p.spinner();
  spin.start(label);
  try {
    const result = await fn();
    spin.stop(theme.muted(label) + " " + theme.success("✓"));
    return result;
  } catch (err) {
    spin.stop(theme.alert(`${label} — failed`));
    throw err;
  }
}

function summarizeManifest(m: {
  events: { eventType: string; importance?: number }[];
  identify: { channels?: string[] };
}): string {
  const events = [...m.events]
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
    .map((e) => theme.muted("• ") + e.eventType);
  const channels = m.identify.channels?.length
    ? theme.muted(`channels: ${m.identify.channels.join(", ")}`)
    : "";
  return [
    theme.bright("identify()") + theme.muted(" + ") + theme.bright(`${m.events.length} events`),
    ...events,
    channels,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatReportFailure(result: { status?: number; detail?: string }): string {
  const detail = result.detail?.replace(/\s+/g, " ").trim();
  if (result.status !== undefined) {
    return `HTTP ${result.status}${detail ? `: ${detail}` : ""}`;
  }
  return detail || "request failed";
}
