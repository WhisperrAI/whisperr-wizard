import { resolve } from "node:path";
import * as p from "@clack/prompts";
import open from "open";
import type { CliFlags } from "./core/config.js";
import { resolveConfig } from "./core/config.js";
import { detectStack } from "./core/detect.js";
import { playbookByTargetId, ALL_PLAYBOOKS } from "./core/playbooks/index.js";
import { authenticate, startDeviceAuth } from "./core/auth.js";
import { fetchManifest } from "./core/manifest.js";
import {
  runIntegrationAgent,
  runAdditionsInstrumentationPass,
  runRepairPass,
  type AgentEventOutcome,
  type EventPlanEntry,
} from "./core/agent.js";
import {
  collectOpportunities,
  fetchSuggestions,
  markSuggestionIntegrated,
  normalizeCode,
  submitAdditions,
  submitSuggestions,
} from "./core/opportunities.js";
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
import { postRunReport, scrubSummary, type ReportEvent } from "./core/report.js";
import { banner } from "./ui/banner.js";
import { theme } from "./ui/theme.js";
import type {
  Detection,
  IntegrationManifest,
  OpportunityEvent,
  Playbook,
  StageResult,
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
  // Approval immediately merges suggestions into the manifest. Fetch the
  // approved records in parallel with the run so the end-of-run bookkeeping
  // only has to reconcile what this surface actually wired.
  const approvedSuggestionsPromise = config.offline
    ? null
    : fetchSuggestions(config, session, ["approved"]);
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
  const useIntegrationSpinner = Boolean(process.stdout.isTTY);
  let phaseLabel = "Integrating";
  let lastLine = "";
  let lastActivityLine = "";
  const startedAt = Date.now();
  const nextIntegrationMessage = createMessageDeduper();
  const updateIntegrationMessage = () => {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    const message =
      theme.bright(phaseLabel) +
      theme.muted(` · ${secs}s`) +
      (lastLine ? theme.muted(` — ${lastLine}`) : "");
    const next = nextIntegrationMessage(message);
    if (next) spin.message(next);
  };
  if (useIntegrationSpinner) {
    spin.start(theme.bright(phaseLabel));
  } else {
    p.log.step(theme.bright(phaseLabel));
  }
  // In a TTY, keep the spinner visibly alive during long tool calls. In
  // non-TTY output this ticker would print repeated lines, so phase changes are
  // logged explicitly instead.
  const tick = useIntegrationSpinner ? setInterval(updateIntegrationMessage, 1000) : undefined;

  const outcome = await runIntegrationAgent({
    repoPath,
    config,
    session,
    playbook: chosen.playbook,
    manifest,
    ...(process.stdout.isTTY && process.stdin.isTTY
      ? {
          async onPlanReady(plan: EventPlanEntry[]) {
            if (useIntegrationSpinner) {
              spin.stop(theme.success("Placement plan ready"));
            }
            p.note(renderPlacementPlan(plan), "Placement plan");

            const placeEntries = plan.filter((entry) => entry.decision === "place");
            let selectedEvents = placeEntries.map((entry) => entry.event);
            if (placeEntries.length) {
              const selection = await p.multiselect({
                message: "Wire these events?",
                options: placeEntries.map((entry) => ({
                  value: entry.event,
                  label: entry.event,
                  hint: `${entry.file ?? "unknown file"}@${entry.anchor ?? "unknown anchor"}`,
                })),
                initialValues: selectedEvents,
                required: false,
              });
              selectedEvents = p.isCancel(selection) ? [] : (selection as string[]);
            }

            if (useIntegrationSpinner) {
              spin.start(theme.bright("Continuing integration"));
            }
            return filterEventPlan(plan, selectedEvents);
          },
        }
      : {}),
    progress: {
      onPhase(label) {
        phaseLabel = label;
        lastLine = "";
        lastActivityLine = "";
        if (useIntegrationSpinner) {
          updateIntegrationMessage();
        } else {
          p.log.step(theme.bright(label));
        }
      },
      onActivity(line) {
        if (line === lastActivityLine) return;
        lastActivityLine = line;
        lastLine = line;
        if (useIntegrationSpinner) updateIntegrationMessage();
      },
    },
  }).catch((err) => {
    p.log.error((err as Error).message);
    return null;
  });

  if (tick) clearInterval(tick);
  if (!outcome) {
    if (useIntegrationSpinner) {
      spin.stop(theme.alert("Integration stopped"));
    } else {
      p.log.error(theme.alert("Integration stopped"));
    }
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
  if (useIntegrationSpinner) {
    spin.stop(stopLabel);
  } else if (!outcome.coreOk) {
    p.log.warn(stopLabel);
  } else {
    p.log.success(stopLabel);
  }

  // Collect any universe opportunities the review pass wrote (this also
  // removes the proposals file so it never shows up in the customer's diff).
  const opportunities = await collectOpportunities(repoPath, manifest, checkpoint);

  // 6. Show what changed + the agent's summary.
  let files = await changedFiles(repoPath, checkpoint);
  if (files.length) {
    p.note(files.map((f) => theme.muted("• ") + f).join("\n"), "Files changed");
  }
  logAgentSummary(outcome.summary);
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
    let verdict = await runVerifyCommand(repoPath, cmd);
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
      const remainingBudgetUsd = config.budgetUsd - outcome.costUsd;
      if (remainingBudgetUsd >= 0.5) {
        vspin.stop(
          theme.warn(`Verification failed — ${cmd}`) +
            theme.muted(" — attempting one repair pass"),
        );
        const repairSpin = p.spinner();
        repairSpin.start(`Repairing verifier failures — ${theme.muted(cmd)}`);
        try {
          const repair = await runRepairPass({
            repoPath,
            config,
            session,
            playbook: chosen.playbook,
            verifyCommand: cmd,
            verifyOutput: verdict.output.slice(-4000),
            budgetUsd: remainingBudgetUsd,
          });
          outcome.costUsd += repair.costUsd;
          if (repair.summary.trim()) {
            outcome.summary = [outcome.summary, `Repair:\n${repair.summary}`]
              .filter(Boolean)
              .join("\n\n");
            logAgentSummary(repair.summary);
          }
          repairSpin.stop(theme.success("Repair pass finished"));
        } catch (err) {
          repairSpin.stop(
            theme.warn("Repair pass failed") +
              theme.muted(` — ${(err as Error).message}`),
          );
        }

        files = await changedFiles(repoPath, checkpoint);
        const reverifySpin = p.spinner();
        reverifySpin.start(`Re-verifying the integration — ${theme.muted(cmd)}`);
        verdict = await runVerifyCommand(repoPath, cmd);
        verified = verdictToVerified(verdict);
        if (verdict.toolMissing) {
          reverifySpin.stop(
            theme.warn("Couldn't verify automatically") +
              theme.muted(` — \`${cmd}\` isn't available here. Run it yourself before committing.`),
          );
        } else if (verdict.timedOut) {
          reverifySpin.stop(
            theme.warn(`Verification timed out — \`${cmd}\``) +
              theme.muted(" — run it yourself before committing."),
          );
        } else if (verdict.ok) {
          reverifySpin.stop(theme.success("Verified ✓") + theme.muted(` (${cmd})`));
        } else {
          reverifySpin.stop(theme.alert(`Verification still failed — ${cmd}`));
        }
      } else {
        vspin.stop(
          theme.alert(`Verification failed — ${cmd}`) +
            theme.muted(" — skipped repair because less than $0.50 budget remains"),
        );
      }

      if (!verdict.ok && !verdict.toolMissing && !verdict.timedOut) {
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
  }

  // 6c. Universe opportunities: the agent may have proposed events /
  //     interventions the onboarding plan misses. The user picks which to send
  //     for dashboard approval. Older backends retain their additions +
  //     bounded follow-up instrumentation behavior through capability fallback.
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
    repoMap: outcome.repoMap,
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
    summary: scrubSummary(outcome.summary).slice(0, 4000),
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

  // Approved events are already part of the normal manifest/instrumentation
  // flow. Reconcile only after final per-event outcomes are known; this is
  // deliberately best-effort so bookkeeping can never fail an otherwise good
  // integration run.
  try {
    const approvedSuggestions = await approvedSuggestionsPromise;
    if (approvedSuggestions?.length) {
      const integratedEventCodes = new Set(
        reportEvents
          .filter((event) => event.status === "wired")
          .map((event) => normalizeCode(event.event_type)),
      );
      for (const event of manifest.events) {
        if (event.coverage?.some((entry) => entry.sameSurface && entry.status === "wired")) {
          integratedEventCodes.add(normalizeCode(event.eventType));
        }
      }

      const toMark = approvedSuggestions.filter(
        (suggestion) =>
          suggestion.status === "approved" &&
          (suggestion.kind === "intervention" ||
            integratedEventCodes.has(normalizeCode(suggestion.code))),
      );
      const marked = (
        await Promise.all(
          toMark.map((suggestion) =>
            markSuggestionIntegrated(
              config,
              session,
              suggestion.id,
              chosen.playbook.target.id,
              fingerprint,
            ),
          ),
        )
      ).filter(Boolean).length;
      if (marked > 0) {
        p.log.info(
          theme.muted(
            `${marked} approved suggestion${marked === 1 ? "" : "s"} marked integrated.`,
          ),
        );
      }
    }
  } catch {
    // Enrichment only: fetch/mark helpers already swallow failures, and this
    // guard also protects the run from unexpected response-shape issues.
  }

  const eventLines = renderEventOutcomeLines(outcome.eventOutcomes, wiredMap);
  if (eventLines) {
    p.note(eventLines, "Events");
  }
  const eventDenominator = manifest.universeSummary?.wireableHere ?? eventTypesToScan.length;
  const eventStatsLabel = manifest.universeSummary ? "events wired here" : "events wired";
  const timingDetails = outcome.phaseTimings
    .map(({ phase, ms }) => `${shortPhaseLabel(phase)} ${formatDuration(ms)}`)
    .join(" · ");

  // Cost is internal telemetry (it rides the run report) — never show the
  // customer what a run costs us.
  p.log.info(
    theme.muted(
      `${wiredMap.size}/${eventDenominator} ${eventStatsLabel} · ` +
        `${files.length} file${files.length === 1 ? "" : "s"} changed · ` +
        (verified === true ? "verified · " : verified === false ? "unverified · " : "") +
        formatDuration(outcome.durationMs) +
        (timingDetails ? ` (${timingDetails})` : ""),
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
 * Present the agent's universe opportunities and stage the confirmed ones for
 * dashboard approval. A backend without suggestions falls through to the
 * legacy additions + same-run instrumentation path. Never throws —
 * opportunities are additive and must not fail the run.
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
  repoMap?: string;
}): Promise<AdditionsOutcome> {
  const { manifest, config, session } = opts;
  const openSuggestions = await fetchSuggestions(config, session, ["proposed", "approved"]);
  const openSuggestionKeys = new Set(
    openSuggestions.map(
      (suggestion) => `${suggestion.kind}:${normalizeCode(suggestion.code)}`,
    ),
  );
  const opportunities: UniverseOpportunities = {
    events: opts.opportunities.events.filter(
      (event) => !openSuggestionKeys.has(`event:${normalizeCode(event.code)}`),
    ),
    interventions: opts.opportunities.interventions.filter(
      (intervention) =>
        !openSuggestionKeys.has(`intervention:${normalizeCode(intervention.code)}`),
    ),
  };
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
    message: "Send these to your dashboard for approval?",
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
    // Opt-in per item: nothing is pre-selected, so submitting a suggestion is
    // an explicit choice rather than an opt-out the user has to notice and undo.
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

  let stageResult: StageResult | null;
  try {
    stageResult = await withSpinner("Sending suggestions for approval", () =>
      submitSuggestions(config, session, opts.playbook.target.id, opts.fingerprint, submitted),
    );
  } catch (err) {
    p.log.warn(
      theme.warn("Couldn't send the proposals") +
        theme.muted(` — ${(err as Error).message}. Nothing was submitted.`),
    );
    return NO_ADDITIONS;
  }

  if (stageResult) {
    const lines = stageResult.outcomes.map((outcome) => {
      const mark =
        outcome.status === "staged"
          ? theme.success("✓")
          : outcome.status === "duplicate"
            ? theme.muted("=")
            : theme.warn("✗");
      const reason =
        outcome.reason ??
        (outcome.duplicateOf && outcome.duplicateOf !== outcome.code
          ? `already queued as ${outcome.duplicateOf}`
          : undefined);
      const detail = reason ? theme.muted(` (${reason})`) : "";
      return `${mark} ${outcome.kind} ${theme.bright(outcome.code)}${detail}`;
    });
    lines.push(
      theme.muted(
        `${stageResult.staged} staged · ${stageResult.duplicates} already queued · ${stageResult.invalid} rejected`,
      ),
    );
    p.note(lines.join("\n"), theme.signal("Suggestions submitted"));
    p.log.info(
      theme.muted(
        "Approve them in your Whisperr dashboard — the next wizard run wires whatever you approve.",
      ),
    );
    return NO_ADDITIONS;
  }

  // Capability fallback for older backends. Keep the established additions
  // merge and same-run instrumentation behavior intact below this point.
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
      repoMap: opts.repoMap,
    });
    if (pass.ran) {
      spin.stop(theme.success("New events instrumented"));
      logAgentSummary(pass.summary);
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
  const auth = await startDeviceAuth(config);
  p.note(
    [
      theme.bright(`Your code: ${auth.userCode}`),
      `${theme.muted("Approval URL:")} ${auth.verificationUrl}`,
      theme.muted(
        "We tried to open your browser. If it didn't open, visit that link on any device and enter the code.",
      ),
    ].join("\n"),
    theme.signal("Approve this device"),
  );

  try {
    await open(auth.verificationUrlComplete ?? auth.verificationUrl);
  } catch {
    /* headless / no browser — the printed URL and code cover it */
  }

  const spin = p.spinner();
  spin.start("Waiting for you to approve in the browser");
  try {
    const session = await auth.poll();
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

export function createMessageDeduper(): (message: string) => string | null {
  let last = "";
  return (message: string) => {
    if (message === last) return null;
    last = message;
    return message;
  };
}

export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.round(safeMs / 1000);
  if (safeMs < 60_000) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}m${seconds}s`;
}

export function filterEventPlan(
  plan: EventPlanEntry[],
  selectedEvents: readonly string[],
): EventPlanEntry[] {
  const selected = new Set(selectedEvents);
  return plan.map((entry) =>
    entry.decision === "place" && !selected.has(entry.event)
      ? { ...entry, decision: "skip", reason: "Deselected in plan review." }
      : entry,
  );
}

function renderPlacementPlan(plan: EventPlanEntry[]): string {
  return plan
    .map((entry) => {
      if (entry.decision === "place") {
        return (
          theme.success("✓ ") +
          entry.event +
          theme.muted(
            ` — ${entry.file ?? "unknown file"} @ ${entry.anchor ?? "unknown anchor"}`,
          )
        );
      }
      const reason = entry.reason || "No reason provided.";
      const line = `${entry.decision === "skip" ? "○" : "?"} ${entry.event} — ${reason}`;
      return entry.decision === "skip" ? theme.muted(line) : theme.warn(line);
    })
    .join("\n");
}

function renderEventOutcomeLines(
  outcomes: AgentEventOutcome[],
  wiredMap: Map<string, string>,
): string {
  const maxLines = 40;
  const visibleCount = outcomes.length > maxLines ? maxLines - 1 : outcomes.length;
  const lines = outcomes.slice(0, visibleCount).map((outcome) => {
    if (outcome.outcome === "wired") {
      const file = wiredMap.get(outcome.event);
      return theme.success("✓ ") + outcome.event + (file ? theme.muted(` — ${file}`) : "");
    }
    return theme.muted(
      `○ ${outcome.event} — ${outcome.reason || "No track() call was detected."}`,
    );
  });
  const remainder = outcomes.length - visibleCount;
  if (remainder > 0) lines.push(theme.muted(`… ${remainder} more events`));
  return lines.join("\n");
}

function logAgentSummary(summary: string): void {
  const cleaned = scrubSummary(summary).trim();
  if (cleaned) p.log.message(cleaned);
}

function shortPhaseLabel(phase: string): string {
  switch (phase) {
    case "Mapping your codebase":
      return "map";
    case "Installing the SDK & wiring identify()":
      return "core";
    case "Planning event placements":
      return "plan";
    case "Instrumenting planned events":
    case "Instrumenting your events":
      return "wire";
    case "Reconciling missed events":
      return "reconcile";
    case "Reviewing & correcting placements":
      return "review";
    default:
      return phase;
  }
}

export function summarizeManifest(m: {
  events: { eventType: string; importance?: number }[];
  identify: { channels?: string[] };
  universeSummary?: {
    total: number;
    wireableHere: number;
    derived: number;
    otherSurface: number;
  };
}): string {
  const events = [...m.events]
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
    .map((e) => theme.muted("• ") + e.eventType);
  const channels = m.identify.channels?.length
    ? theme.muted(`channels: ${m.identify.channels.join(", ")}`)
    : "";
  const firstLine = m.universeSummary
    ? theme.bright(`${m.universeSummary.total} events in your universe`) +
      theme.muted(
        ` — ${m.universeSummary.wireableHere} wireable here · ` +
          `${m.universeSummary.derived} computed by Whisperr from your raw events · ` +
          `${m.universeSummary.otherSurface} live on other surfaces`,
      )
    : theme.bright("identify()") +
      theme.muted(" + ") +
      theme.bright(`${m.events.length} events`);
  return [
    firstLine,
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
