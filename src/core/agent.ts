import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type {
  IntegrationManifest,
  Playbook,
  WizardConfig,
  WizardSession,
} from "../types.js";
import type { OpportunityEvent } from "../types.js";
import { changedFiles, scanWiredEvents } from "./git.js";
import { OPPORTUNITIES_FILE } from "./opportunities.js";
import {
  BASE_WIZARD_PROMPT,
  renderEventsBrief,
  renderIdentifyBrief,
  renderOpportunitiesBrief,
} from "./playbooks/shared-prompt.js";
import { evaluateToolUse } from "./toolPolicy.js";

export interface AgentProgress {
  /** A new phase started, e.g. "Installing the SDK". */
  onPhase?(label: string): void;
  /** Free-text activity line, e.g. "Editing lib/main.dart". */
  onActivity?(line: string): void;
}

export interface AgentRunOutcome {
  summary: string;
  costUsd: number;
  durationMs: number;
  /** Wall-clock time spent in each agent pass, in execution order. */
  phaseTimings: Array<{ phase: string; ms: number }>;
  /** Core (install + identify) landed. The bar for "the integration works". */
  coreOk: boolean;
  /** Event instrumentation completed without hitting the step limit. */
  eventsComplete: boolean;
  /** Deterministic per-event result after planning, wiring, and scan reconciliation. */
  eventOutcomes: AgentEventOutcome[];
  /** The read-only repository map from the planner pre-pass, if one was produced. */
  repoMap?: string;
}

export interface AgentEventOutcome {
  event: string;
  outcome: "wired" | "skipped";
  reason?: string;
}

export interface EventPlanEntry {
  event: string;
  decision: "place" | "skip" | "unsure";
  file?: string;
  anchor?: string;
  properties?: string[];
  reason: string;
}

/**
 * Run the integration as map -> core -> plan/wire events -> review. Opus handles
 * repo understanding and placement decisions; Sonnet performs the mechanical
 * edits at those planned sites.
 */
export async function runIntegrationAgent(opts: {
  repoPath: string;
  config: WizardConfig;
  session: WizardSession;
  playbook: Playbook;
  manifest: IntegrationManifest;
  progress?: AgentProgress;
  onPlanReady?: (plan: EventPlanEntry[]) => Promise<EventPlanEntry[] | null>;
}): Promise<AgentRunOutcome> {
  const { repoPath, config, session, playbook, manifest, progress, onPlanReady } = opts;

  applyModelAuthEnv(config, session);
  const systemPrompt = [BASE_WIZARD_PROMPT, playbook.systemPrompt].join("\n\n");

  const started = Date.now();
  let costUsd = 0;
  const summaries: string[] = [];
  let repoMap = "";
  let eventOutcomes: AgentEventOutcome[] = [];
  const phaseTimings: Array<{ phase: string; ms: number }> = [];

  const BUDGET_FLOOR = 0.25;

  // ---- Pre-pass: read-only repository map ----
  if (config.budgetUsd - costUsd > BUDGET_FLOOR) {
    try {
      const map = await runTimedPass("Mapping your codebase", {
        prompt: renderRepoMapPrompt(repoPath),
        systemPrompt,
        repoPath,
        model: config.plannerModel,
        effort: "high",
        maxTurns: 40,
        budgetUsd: Math.min(config.budgetUsd - costUsd, config.budgetUsd * 0.15),
        allowedTools: READ_ONLY_TOOLS,
        progress,
      }, phaseTimings);
      costUsd += map.costUsd;
      repoMap = sliceRepoMap(map.summary);
    } catch (err) {
      debugNote(`repo map pass failed: ${(err as Error).message}`);
      repoMap = "";
    }
  }

  // ---- Phase 1: core (install + initialize + identify) ----
  const corePrompt = [
    `Integrate the Whisperr ${playbook.target.displayName} SDK — CORE SETUP ONLY.`,
    `Project root: ${repoPath}`,
    "",
    "Do exactly these, then stop:",
    `1. Add the Whisperr SDK dependency and install it (${playbook.packageRef}).`,
    "2. Initialize it once at app startup with the key + base URL below.",
    "3. Wire identify() for the END USER — the paying customer/consumer, NEVER an",
    "   admin, staff, operator, seller, or partner (see WHO COUNTS AS \"THE USER\"",
    "   in your instructions). This app likely has several auth paths: enumerate",
    "   them first (grep login/signup/register/authenticate) and instrument the",
    "   end-user one — do NOT just take the first thing named \"login\". A path",
    "   under admin/backoffice/staff/seller/cms is the wrong subject. Sanity",
    "   check: identify() belongs on the SAME surface as account_created — if",
    "   they'd land in different controllers, you've picked the wrong login.",
    "   Wire it at the primary end-user login success and on session restore at",
    "   startup; call reset() on logout. One end-user login path plus session",
    "   restore is enough. Keep channels minimal: email if readily at hand;",
    "   phone/push optional.",
    "",
    "This is a real app — be quick and decisive, aim to finish in ~15 steps.",
    "Do NOT instrument product events yet — that is a separate step. Do not run",
    "the analyzer or build; the human will review the diff.",
    "",
    ...renderRepoMapSection(repoMap),
    "----- IDENTIFY -----",
    renderIdentifyBrief(manifest),
    "----- END -----",
  ].join("\n");

  const core = await runTimedPass("Installing the SDK & wiring identify()", {
    prompt: corePrompt,
    systemPrompt,
    repoPath,
    model: config.model,
    effort: config.effort,
    maxTurns: 50,
    budgetUsd: config.budgetUsd - costUsd,
    progress,
  }, phaseTimings);
  costUsd += core.costUsd;
  if (core.summary) summaries.push(`Core setup:\n${core.summary}`);

  // ---- Phase 2: events (bounded, skip-fast) ----
  // A small floor below which a pass can't do useful work — skip rather than
  // start a query that immediately trips the budget.
  let eventsComplete = true;
  if (manifest.events.length > 0 && config.budgetUsd - costUsd <= BUDGET_FLOOR) {
    eventsComplete = false;
    eventOutcomes = manifest.events.map((event) => ({
      event: event.eventType,
      outcome: "skipped",
      reason: "Spend limit reached during core setup.",
    }));
    summaries.push(
      "Events: skipped — the spend limit was reached during core setup. " +
        "Re-run with a higher WHISPERR_WIZARD_BUDGET_USD to instrument events.",
    );
  } else if (manifest.events.length > 0) {
    const planPass = await runTimedPass("Planning event placements", {
      prompt: renderEventPlanPrompt(repoPath, playbook, manifest, repoMap),
      systemPrompt,
      repoPath,
      model: config.plannerModel,
      effort: "high",
      maxTurns: 40,
      budgetUsd: config.budgetUsd - costUsd,
      allowedTools: READ_ONLY_TOOLS,
      progress,
    }, phaseTimings);
    costUsd += planPass.costUsd;
    const plan = parseEventPlan(planPass.summary);

    if (!plan) {
      debugNote("event plan parse failed; falling back to direct event wiring");
      progress?.onActivity?.("Event plan was not parseable; falling back to direct wiring");
      const direct = await runDirectEventsPass({
        repoPath,
        config,
        systemPrompt,
        playbook,
        manifest,
        repoMap,
        budgetUsd: config.budgetUsd - costUsd,
        progress,
        phaseTimings,
      });
      costUsd += direct.pass.costUsd;
      eventsComplete = !direct.pass.maxedOut;
      eventOutcomes = direct.eventOutcomes;
      if (direct.pass.summary) summaries.push(`Events:\n${direct.pass.summary}`);
    } else {
      let scopedPlan = planForManifest(plan, manifest);
      const reviewedPlan = await onPlanReady?.(scopedPlan);
      if (reviewedPlan !== undefined && reviewedPlan !== null) {
        scopedPlan = planForManifest(reviewedPlan, manifest);
      }
      const placeEntries = scopedPlan.filter((entry) => entry.decision === "place");
      const unsureEntries = scopedPlan.filter((entry) => entry.decision === "unsure");

      let wire: PassResult | undefined;
      if (placeEntries.length && config.budgetUsd - costUsd > BUDGET_FLOOR) {
        wire = await runTimedPass("Instrumenting planned events", {
          prompt: renderEventWirePrompt(repoPath, playbook, repoMap, placeEntries),
          systemPrompt,
          repoPath,
          model: config.model,
          effort: "high",
          maxTurns: config.maxTurns,
          budgetUsd: config.budgetUsd - costUsd,
          progress,
        }, phaseTimings);
        costUsd += wire.costUsd;
        if (wire.summary) summaries.push(`Events:\n${wire.summary}`);
      } else if (!placeEntries.length) {
        summaries.push("Events: no events had a confident placement in this surface.");
      }

      let wired = await scanManifestEvents(repoPath, manifest);
      const missedPlaceEntries = placeEntries.filter((entry) => !wired.has(entry.event));
      const followUpEntries = uniquePlanEntries([...missedPlaceEntries, ...unsureEntries]);
      let followUp: PassResult | undefined;
      if (followUpEntries.length && config.budgetUsd - costUsd > BUDGET_FLOOR) {
        followUp = await runTimedPass("Reconciling missed events", {
          prompt: renderEventReconcilePrompt(repoPath, playbook, repoMap, followUpEntries),
          systemPrompt,
          repoPath,
          model: config.plannerModel,
          effort: "medium",
          maxTurns: 15,
          budgetUsd: config.budgetUsd - costUsd,
          progress,
        }, phaseTimings);
        costUsd += followUp.costUsd;
        if (followUp.summary) summaries.push(`Event reconciliation:\n${followUp.summary}`);
        wired = await scanManifestEvents(repoPath, manifest);
      }

      eventOutcomes = buildEventOutcomes(manifest, scopedPlan, wired);
      eventsComplete =
        !planPass.maxedOut &&
        !(wire?.maxedOut ?? false) &&
        !(followUp?.maxedOut ?? false);
    }
  }

  // ---- Phase 3: self-review (audit own placements against the diff, fix) ----
  // Placement is where this fails, and the agent can catch its own mistakes
  // with fresh eyes on `git diff` far cheaper than a human can. Runs whenever
  // the core landed (so identify() is reviewed even with no events).
  if (core.ok && config.budgetUsd - costUsd > BUDGET_FLOOR) {
    const reviewPrompt = [
      `You wired the Whisperr ${playbook.target.displayName} SDK into this repo.`,
      "Now AUDIT YOUR OWN WORK and fix mistakes before finishing.",
      `Project root: ${repoPath}`,
      "",
      ...renderRepoMapSection(repoMap),
      "Run `git diff` and read the surrounding code to see exactly what you added.",
      "For every identify() and track() call, verify — and FIX in place:",
      "1. Subject — keys to the END USER, never an admin/staff/operator/seller.",
      "   identify() sits on the SAME surface as account_created (same person).",
      "2. Lifecycle — the event fires ONLY on its real moment. A 'first time'",
      "   event (e.g. subscription_started) must NOT fire on a renewal/recurring",
      "   path; look for RENEW_CARD / is_recurring / type branches in the SAME",
      "   handler. If one path handles both cases, branch and emit the right",
      "   event per case.",
      "3. Discriminators — billing/subscription events carry the properties that",
      "   tell cases apart when the code exposes them (charge_type / is_recurring",
      "   / payment_source / amount / plan). Add the ones you missed.",
      "4. Coverage — every gateway/callback path that should emit an event does;",
      "   no recurring or secondary path left as a dead zone.",
      "Change ONLY what is genuinely wrong or incomplete — do not churn correct",
      "calls or re-explore the whole repo. Be surgical.",
      "",
      renderOpportunitiesBrief(manifest, OPPORTUNITIES_FILE),
      "",
      "End with a one-line, plain-text note of what you corrected (or 'No",
      "corrections needed.'), plus one line on what you proposed, if anything.",
    ].join("\n");

    const review = await runTimedPass("Reviewing & correcting placements", {
      prompt: reviewPrompt,
      systemPrompt,
      repoPath,
      model: config.plannerModel,
      effort: "medium",
      maxTurns: 40,
      budgetUsd: config.budgetUsd - costUsd,
      progress,
    }, phaseTimings);
    costUsd += review.costUsd;
    if (review.summary) summaries.push(`Review:\n${review.summary}`);
    if (manifest.events.length) {
      eventOutcomes = refreshWiredOutcomes(
        eventOutcomes,
        manifest,
        await scanManifestEvents(repoPath, manifest),
      );
    }
  }

  return {
    summary: summaries.join("\n\n"),
    costUsd,
    durationMs: Date.now() - started,
    phaseTimings,
    coreOk: core.ok,
    eventsComplete,
    eventOutcomes,
    repoMap: repoMap || undefined,
  };
}

/**
 * One bounded follow-up pass: instrument the events that were just ACCEPTED
 * into the universe as wizard additions. Without this a wizard-added event
 * would exist in the plan but never fire. Same machinery as Phase 2, scoped to
 * only the accepted events.
 */
export async function runAdditionsInstrumentationPass(opts: {
  repoPath: string;
  config: WizardConfig;
  session: WizardSession;
  playbook: Playbook;
  acceptedEvents: OpportunityEvent[];
  budgetUsd: number;
  repoMap?: string;
  progress?: AgentProgress;
}): Promise<{ summary: string; costUsd: number; ran: boolean }> {
  const { repoPath, config, session, playbook, acceptedEvents, budgetUsd, repoMap, progress } =
    opts;
  // `ran: false` = the pass never started (nothing to do / budget exhausted),
  // so the caller must not report the events as instrumented.
  if (!acceptedEvents.length || budgetUsd <= 0) {
    return { summary: "", costUsd: 0, ran: false };
  }

  applyModelAuthEnv(config, session);
  const systemPrompt = [BASE_WIZARD_PROMPT, playbook.systemPrompt].join("\n\n");

  const eventLines: string[] = [];
  for (const e of acceptedEvents) {
    eventLines.push("");
    eventLines.push(`■ ${e.code}${e.label ? `  (${e.label})` : ""}`);
    if (e.description) eventLines.push(`  ${e.description}`);
    if (e.rationale) eventLines.push(`  where: ${e.rationale}`);
    if (e.properties?.length) {
      eventLines.push("  properties to capture if available:");
      for (const prop of e.properties) {
        eventLines.push(`    · ${prop.name}${prop.required ? " (required)" : ""}${prop.description ? ` — ${prop.description}` : ""}`);
      }
    }
  }

  progress?.onPhase?.("Instrumenting the newly added events");
  const prompt = [
    "You proposed these events as universe opportunities while reviewing this",
    "repo, and the user just APPROVED adding them to the plan. Instrument them",
    "now with track(), exactly like the plan's other events: place each at the",
    "real call site (your own rationale tells you where you saw it), attach the",
    "properties available in scope, and skip anything that turns out not to have",
    "a clear trigger after all. The SDK is already installed and initialized.",
    `Project root: ${repoPath}`,
    "",
    ...renderRepoMapSection(repoMap),
    "----- APPROVED NEW EVENTS -----",
    ...eventLines,
    "",
    "----- END -----",
  ].join("\n");

  const pass = await runPass({
    prompt,
    systemPrompt,
    repoPath,
    model: config.model,
    effort: config.effort,
    maxTurns: 25,
    budgetUsd,
    progress,
  });
  return { summary: pass.summary, costUsd: pass.costUsd, ran: true };
}

/**
 * One verifier-focused repair pass. The CLI runs this only after its own
 * deterministic verify command fails, and only when budget remains.
 */
export async function runRepairPass(opts: {
  repoPath: string;
  config: WizardConfig;
  session: WizardSession;
  playbook: Playbook;
  verifyCommand: string;
  verifyOutput: string;
  budgetUsd: number;
  progress?: AgentProgress;
}): Promise<{ summary: string; costUsd: number; ran: boolean }> {
  const {
    repoPath,
    config,
    session,
    playbook,
    verifyCommand,
    verifyOutput,
    budgetUsd,
    progress,
  } = opts;
  if (budgetUsd <= 0) return { summary: "", costUsd: 0, ran: false };

  applyModelAuthEnv(config, session);
  const systemPrompt = [BASE_WIZARD_PROMPT, playbook.systemPrompt].join("\n\n");
  progress?.onPhase?.("Repairing verifier failures");
  const prompt = [
    "The Whisperr integration was applied, but the verifier command failed.",
    `Project root: ${repoPath}`,
    "",
    "Verifier command:",
    verifyCommand,
    "",
    "Verifier output tail:",
    tail(verifyOutput, 4000) || "(no output)",
    "",
    "Fix ONLY what the verifier reports; do not refactor. Keep the existing",
    "Whisperr placement intent unless a verifier error directly requires a small",
    "syntax/import/type correction. Do not explore unrelated code.",
  ].join("\n");

  const pass = await runPass({
    prompt,
    systemPrompt,
    repoPath,
    model: config.model,
    effort: "high",
    maxTurns: 20,
    budgetUsd,
    progress,
  });
  return { summary: pass.summary, costUsd: pass.costUsd, ran: true };
}

const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;
const FULL_TOOLS = ["Read", "Edit", "Write", "Bash", "Glob", "Grep"] as const;

export function parseEventPlan(text: string): EventPlanEntry[] | null {
  const parsed = parseFirstJsonArray(text);
  if (!Array.isArray(parsed)) return null;

  const entries: EventPlanEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const obj = item as Record<string, unknown>;
    const event = typeof obj.event === "string" ? obj.event.trim() : "";
    const decision = obj.decision;
    if (
      !event ||
      (decision !== "place" && decision !== "skip" && decision !== "unsure")
    ) {
      return null;
    }

    const entry: EventPlanEntry = {
      event,
      decision,
      reason: typeof obj.reason === "string" ? obj.reason.trim() : "",
    };
    if (typeof obj.file === "string" && obj.file.trim()) {
      entry.file = obj.file.trim();
    }
    if (typeof obj.anchor === "string" && obj.anchor.trim()) {
      entry.anchor = obj.anchor.trim();
    }
    if (Array.isArray(obj.properties)) {
      entry.properties = obj.properties
        .filter((prop): prop is string => typeof prop === "string" && !!prop.trim())
        .map((prop) => prop.trim());
    }
    entries.push(entry);
  }
  return entries;
}

function parseFirstJsonArray(text: string): unknown | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  const json = sliceJsonArray(text, start);
  if (!json) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function sliceJsonArray(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function renderRepoMapPrompt(repoPath: string): string {
  return [
    "Map this repository for a Whisperr SDK integration. This is READ-ONLY.",
    `Project root: ${repoPath}`,
    "",
    "Produce a concise structured repo map as final text with these exact sections:",
    "- framework + entry points",
    "- auth flows enumerated: END-USER vs admin/staff, with precise file paths",
    "- billing/payment/webhook surfaces",
    "- analytics/tracking wrapper if any",
    "- state management",
    "- directory guide: which dirs hold pages/controllers/services",
    "",
    "This map guides event placement. List file paths precisely. No prose beyond the map.",
  ].join("\n");
}

function sliceRepoMap(map: string): string {
  return map.trim().slice(0, 8000);
}

function renderRepoMapSection(repoMap: string | undefined): string[] {
  const map = repoMap?.trim();
  if (!map) return [];
  return ["----- REPO MAP -----", map, "----- END REPO MAP -----", ""];
}

function renderEventPlanPrompt(
  repoPath: string,
  playbook: Playbook,
  manifest: IntegrationManifest,
  repoMap: string,
): string {
  return [
    `Plan Whisperr ${playbook.target.displayName} event placements. This is READ-ONLY.`,
    `Project root: ${repoPath}`,
    "",
    ...renderRepoMapSection(repoMap),
    "Use the repo map and the events brief to decide where each event belongs.",
    "Return ONLY a JSON code block containing an array with this shape:",
    '[{"event":"event_name","decision":"place|skip|unsure","file":"path","anchor":"function/route/handler","properties":["prop"],"reason":"short reason"}]',
    "",
    "Rules:",
    "- decision=place only when there is a concrete end-user call site in this repo.",
    "- decision=skip when the event clearly lives on another surface or does not exist here.",
    "- decision=unsure when there is a plausible surface but the exact anchor is not proven.",
    "- For place decisions, include file and anchor precisely.",
    "- properties should list only properties likely available at that anchor.",
    "- No prose beyond the JSON code block.",
    "",
    "----- EVENTS -----",
    renderEventsBrief(manifest),
    "----- END EVENTS -----",
  ].join("\n");
}

function renderEventWirePrompt(
  repoPath: string,
  playbook: Playbook,
  repoMap: string,
  entries: EventPlanEntry[],
): string {
  return [
    `The Whisperr ${playbook.target.displayName} SDK is installed and initialized.`,
    "Wire only the planned event placements below with track().",
    `Project root: ${repoPath}`,
    "",
    ...renderRepoMapSection(repoMap),
    "For each: open the file, find the anchor, add track() with the listed",
    "properties. If an anchor is genuinely absent, mark it unsure in your",
    "summary and move on. Do not re-plan skipped or unsure events in this pass.",
    "",
    "----- EVENT WIRING PLAN -----",
    ...renderPlanEntryLines(entries),
    "----- END EVENT WIRING PLAN -----",
  ].join("\n");
}

function renderEventReconcilePrompt(
  repoPath: string,
  playbook: Playbook,
  repoMap: string,
  entries: EventPlanEntry[],
): string {
  return [
    `One targeted follow-up for Whisperr ${playbook.target.displayName} events.`,
    `Project root: ${repoPath}`,
    "",
    ...renderRepoMapSection(repoMap),
    "The events below were either planned for placement but not detected in the",
    "changed files, or were marked unsure. For each one, make one focused attempt",
    "at the listed file/anchor. If the anchor is absent or still not clear, skip",
    "it and say why in the summary. Do not search broadly or refactor.",
    "",
    "----- TARGET EVENTS -----",
    ...renderPlanEntryLines(entries),
    "----- END TARGET EVENTS -----",
  ].join("\n");
}

function renderPlanEntryLines(entries: EventPlanEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    lines.push("");
    lines.push(`- event: ${entry.event}`);
    lines.push(`  decision: ${entry.decision}`);
    if (entry.file) lines.push(`  file: ${entry.file}`);
    if (entry.anchor) lines.push(`  anchor: ${entry.anchor}`);
    if (entry.properties?.length) {
      lines.push(`  properties: ${entry.properties.join(", ")}`);
    }
    if (entry.reason) lines.push(`  reason: ${entry.reason}`);
  }
  return lines;
}

async function runDirectEventsPass(opts: {
  repoPath: string;
  config: WizardConfig;
  systemPrompt: string;
  playbook: Playbook;
  manifest: IntegrationManifest;
  repoMap: string;
  budgetUsd: number;
  progress?: AgentProgress;
  phaseTimings: Array<{ phase: string; ms: number }>;
}): Promise<{ pass: PassResult; eventOutcomes: AgentEventOutcome[] }> {
  const {
    repoPath,
    config,
    systemPrompt,
    playbook,
    manifest,
    repoMap,
    budgetUsd,
    progress,
    phaseTimings,
  } = opts;
  const eventsPrompt = [
    `The Whisperr ${playbook.target.displayName} SDK is already installed and`,
    "initialized, and identify() is wired. Now instrument the product events",
    "below with track().",
    "",
    ...renderRepoMapSection(repoMap),
    "Work in importance order. Place each event at the real call site where the",
    "END USER performs the action (not an admin/staff path — see WHO COUNTS AS",
    "\"THE USER\"), and attach the properties you can source from what's in scope",
    "there (see the property-capture rule). These events describe the same",
    "person identify() did, so they live on the same end-user surface. Skip fast",
    "when an event has no clear trigger here — spend steps placing, not exploring.",
    "Stop once the events that clearly exist in this app are wired.",
    "",
    "----- EVENTS -----",
    renderEventsBrief(manifest),
    "----- END -----",
  ].join("\n");

  const pass = await runTimedPass("Instrumenting your events", {
    prompt: eventsPrompt,
    systemPrompt,
    repoPath,
    model: config.model,
    effort: config.effort,
    maxTurns: config.maxTurns,
    budgetUsd,
    progress,
  }, phaseTimings);
  const wired = await scanManifestEvents(repoPath, manifest);
  return {
    pass,
    eventOutcomes: manifest.events.map((event) =>
      wired.has(event.eventType)
        ? { event: event.eventType, outcome: "wired" }
        : {
            event: event.eventType,
            outcome: "skipped",
            reason: "No track() call was detected after the direct wiring pass.",
          },
    ),
  };
}

function planForManifest(
  plan: EventPlanEntry[],
  manifest: IntegrationManifest,
): EventPlanEntry[] {
  const known = new Set(manifest.events.map((event) => event.eventType));
  return uniquePlanEntries(plan.filter((entry) => known.has(entry.event)));
}

function uniquePlanEntries(entries: EventPlanEntry[]): EventPlanEntry[] {
  const seen = new Set<string>();
  const unique: EventPlanEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.event)) continue;
    seen.add(entry.event);
    unique.push(entry);
  }
  return unique;
}

async function scanManifestEvents(
  repoPath: string,
  manifest: IntegrationManifest,
): Promise<Map<string, string>> {
  return scanEvents(repoPath, manifest.events.map((event) => event.eventType));
}

async function scanEvents(
  repoPath: string,
  eventTypes: string[],
): Promise<Map<string, string>> {
  let files: string[] = [];
  try {
    files = await changedFiles(repoPath, { isRepo: true });
  } catch {
    return new Map();
  }
  if (!files.length) return new Map();
  return scanWiredEvents(repoPath, files, eventTypes);
}

function buildEventOutcomes(
  manifest: IntegrationManifest,
  plan: EventPlanEntry[],
  wired: Map<string, string>,
): AgentEventOutcome[] {
  const byEvent = new Map(plan.map((entry) => [entry.event, entry]));
  return manifest.events.map((event) => {
    if (wired.has(event.eventType)) {
      return { event: event.eventType, outcome: "wired" };
    }
    const entry = byEvent.get(event.eventType);
    if (entry?.decision === "skip") {
      return {
        event: event.eventType,
        outcome: "skipped",
        reason: entry.reason || "Planner skipped this event for this surface.",
      };
    }
    if (entry?.decision === "unsure") {
      return {
        event: event.eventType,
        outcome: "skipped",
        reason: entry.reason || "Planner could not confirm a concrete anchor.",
      };
    }
    if (entry?.decision === "place") {
      return {
        event: event.eventType,
        outcome: "skipped",
        reason: "No track() call was detected after wiring and one targeted follow-up.",
      };
    }
    return {
      event: event.eventType,
      outcome: "skipped",
      reason: "No placement decision was returned.",
    };
  });
}

function refreshWiredOutcomes(
  current: AgentEventOutcome[],
  manifest: IntegrationManifest,
  wired: Map<string, string>,
): AgentEventOutcome[] {
  const byEvent = new Map(current.map((outcome) => [outcome.event, outcome]));
  return manifest.events.map((event) => {
    if (wired.has(event.eventType)) {
      return { event: event.eventType, outcome: "wired" };
    }
    return (
      byEvent.get(event.eventType) ?? {
        event: event.eventType,
        outcome: "skipped",
        reason: "No track() call was detected.",
      }
    );
  });
}

function tail(s: string, max: number): string {
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(-max) : trimmed;
}

function debugNote(message: string): void {
  if (process.env.WHISPERR_WIZARD_DEBUG) {
    // eslint-disable-next-line no-console
    console.error(`[whisperr-wizard] ${message}`);
  }
}

interface PassResult {
  summary: string;
  costUsd: number;
  ok: boolean;
  /** Stopped early on a limit (turns or budget) rather than finishing cleanly. */
  maxedOut: boolean;
}

interface RunPassOptions {
  prompt: string;
  systemPrompt: string;
  repoPath: string;
  model: string;
  effort: WizardConfig["effort"];
  maxTurns: number;
  /** USD ceiling for THIS pass (remaining budget). Omit/<=0 for no cap. */
  budgetUsd?: number;
  allowedTools?: readonly string[];
  progress?: AgentProgress;
}

async function runTimedPass(
  phase: string,
  opts: RunPassOptions,
  phaseTimings: Array<{ phase: string; ms: number }>,
): Promise<PassResult> {
  opts.progress?.onPhase?.(phase);
  const started = Date.now();
  try {
    return await runPass(opts);
  } finally {
    phaseTimings.push({ phase, ms: Date.now() - started });
  }
}

/** A thrown error that's really just a turn/budget stop, not a genuine failure. */
function isLimitStop(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /max(imum)?[\s_-]*(turn|budget)|budget.*exceeded|number of turns/i.test(msg);
}

async function runPass(opts: RunPassOptions): Promise<PassResult> {
  const {
    prompt,
    systemPrompt,
    repoPath,
    model,
    effort,
    maxTurns,
    budgetUsd,
    allowedTools = FULL_TOOLS,
    progress,
  } = opts;

  let summary = "";
  let costUsd = 0;
  let ok = false;
  let maxedOut = false;
  let lastActivityLine = "";
  const emitActivity = (line: string) => {
    if (!line || line === lastActivityLine) return;
    lastActivityLine = line;
    progress?.onActivity?.(line);
  };

  const response = query({
    prompt,
    options: {
      model,
      cwd: repoPath,
      systemPrompt,
      // Adaptive thinking (Claude decides depth per step) + an explicit effort
      // level. Sonnet 5 supports both; we set them rather than rely on SDK
      // defaults so the behavior is pinned regardless of SDK version.
      thinking: { type: "adaptive" },
      effort,
      tools: [...allowedTools],
      canUseTool: createToolPermissionCallback(repoPath),
      maxTurns,
      // Native SDK hard cost cap. Stops this pass with an `error_max_budget_usd`
      // result once spend exceeds the remaining budget — this, not maxTurns, is
      // the real limiter. Omitted when there's no positive budget left.
      ...(budgetUsd && budgetUsd > 0 ? { maxBudgetUsd: budgetUsd } : {}),
      settingSources: [],
    },
  });

  try {
    for await (const message of response as AsyncIterable<AgentMessage>) {
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (isTextBlock(block) && block.text?.trim()) {
            emitActivity(firstLine(block.text));
          } else if (isToolUseBlock(block)) {
            emitActivity(describeToolUse(block));
          }
        }
      } else if (message.type === "result") {
        ok = message.subtype === "success";
        // Either limit (turns or the USD budget cap) is a graceful early stop, not
        // a failure: keep whatever landed and let the caller report partial.
        const sub = message.subtype ?? "";
        maxedOut = sub.includes("max_turns") || sub.includes("max_budget");
        costUsd = message.total_cost_usd ?? 0;
        summary = message.result ?? extractLastText(message) ?? summary;
      }
    }
  } catch (err) {
    // A turn/budget stop that surfaces as a throw must NOT bubble up and abort
    // the whole integration (which would revert good work) — treat it as a
    // graceful early stop. Genuine errors still propagate.
    if (isLimitStop(err)) {
      maxedOut = true;
    } else {
      throw err;
    }
  }

  return { summary, costUsd, ok, maxedOut };
}

function createToolPermissionCallback(repoPath: string): CanUseTool {
  return async (toolName, input, options) => {
    const decision = evaluateToolUse(toolName, input, { repoPath });
    return decision.behavior === "allow"
      ? { behavior: "allow", toolUseID: options.toolUseID }
      : {
          behavior: "deny",
          message: decision.message,
          toolUseID: options.toolUseID,
        };
  };
}

/** Configure where the Agent SDK sends model calls (gateway or direct key). */
function applyModelAuthEnv(config: WizardConfig, session: WizardSession): void {
  if (config.directAnthropicKey) {
    process.env.ANTHROPIC_API_KEY = config.directAnthropicKey;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    return;
  }
  process.env.ANTHROPIC_BASE_URL = config.llmBaseUrl;
  process.env.ANTHROPIC_AUTH_TOKEN = session.token;
  delete process.env.ANTHROPIC_API_KEY;
}

// --- minimal structural typings over the Agent SDK message stream ---
interface AgentTextBlock {
  type: "text";
  text?: string;
}
interface AgentToolUseBlock {
  type: "tool_use";
  name?: string;
  input?: Record<string, unknown>;
}
type AgentBlock = AgentTextBlock | AgentToolUseBlock | { type: string };

function isTextBlock(b: AgentBlock): b is AgentTextBlock {
  return b.type === "text";
}
function isToolUseBlock(b: AgentBlock): b is AgentToolUseBlock {
  return b.type === "tool_use";
}

interface AgentMessage {
  type: "assistant" | "result" | string;
  subtype?: string;
  result?: string;
  total_cost_usd?: number;
  message?: { content?: AgentBlock[] };
}

function describeToolUse(block: AgentToolUseBlock): string {
  const file =
    (block.input?.file_path as string) ??
    (block.input?.path as string) ??
    (block.input?.pattern as string) ??
    "";
  switch (block.name) {
    case "Edit":
      return `Editing ${short(file)}`;
    case "Write":
      return `Writing ${short(file)}`;
    case "Read":
      return `Reading ${short(file)}`;
    case "Bash":
      return `Running ${short((block.input?.command as string) ?? "command")}`;
    case "Grep":
      return `Searching for ${short(file)}`;
    case "Glob":
      return `Scanning ${short(file)}`;
    default:
      return `${block.name ?? "Working"}…`;
  }
}

function extractLastText(message: AgentMessage): string | undefined {
  const blocks = message.message?.content ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i] as AgentTextBlock;
    if (b?.type === "text" && b.text) return b.text;
  }
  return undefined;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? text;
  return short(line.trim(), 100);
}

function short(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
