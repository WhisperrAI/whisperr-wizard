import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  IntegrationManifest,
  Playbook,
  WizardConfig,
  WizardSession,
} from "../types.js";
import {
  BASE_WIZARD_PROMPT,
  renderEventsBrief,
  renderIdentifyBrief,
} from "./playbooks/shared-prompt.js";

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
  /** Core (install + identify) landed. The bar for "the integration works". */
  coreOk: boolean;
  /** Event instrumentation completed without hitting the step limit. */
  eventsComplete: boolean;
}

/**
 * Run the integration in two phases so we ALWAYS deliver the valuable core:
 *   1. Core — install SDK + initialize + identify(). Small, deterministic,
 *      must succeed. Locked in even if phase 2 runs long.
 *   2. Events — instrument product events, highest-impact first, skipping fast
 *      when a client call site doesn't exist (most server-side events won't).
 *
 * Default model is Sonnet (fast + ~5x cheaper than Opus for this mechanical
 * work). The whole design fights the "explore forever, never land" failure mode.
 */
export async function runIntegrationAgent(opts: {
  repoPath: string;
  config: WizardConfig;
  session: WizardSession;
  playbook: Playbook;
  manifest: IntegrationManifest;
  progress?: AgentProgress;
}): Promise<AgentRunOutcome> {
  const { repoPath, config, session, playbook, manifest, progress } = opts;

  applyModelAuthEnv(config, session);
  const systemPrompt = [BASE_WIZARD_PROMPT, playbook.systemPrompt].join("\n\n");

  const started = Date.now();
  let costUsd = 0;
  const summaries: string[] = [];

  // ---- Phase 1: core (install + initialize + identify) ----
  progress?.onPhase?.("Installing the SDK & wiring identify()");
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
    "----- IDENTIFY -----",
    renderIdentifyBrief(manifest),
    "----- END -----",
  ].join("\n");

  const core = await runPass({
    prompt: corePrompt,
    systemPrompt,
    repoPath,
    model: config.model,
    effort: config.effort,
    maxTurns: 50,
    budgetUsd: config.budgetUsd - costUsd,
    progress,
  });
  costUsd += core.costUsd;
  if (core.summary) summaries.push(`Core setup:\n${core.summary}`);

  // ---- Phase 2: events (bounded, skip-fast) ----
  // A small floor below which a pass can't do useful work — skip rather than
  // start a query that immediately trips the budget.
  const BUDGET_FLOOR = 0.25;
  let eventsComplete = true;
  if (manifest.events.length > 0 && config.budgetUsd - costUsd <= BUDGET_FLOOR) {
    eventsComplete = false;
    summaries.push(
      "Events: skipped — the spend limit was reached during core setup. " +
        "Re-run with a higher WHISPERR_WIZARD_BUDGET_USD to instrument events.",
    );
  } else if (manifest.events.length > 0) {
    progress?.onPhase?.("Instrumenting your events");
    const eventsPrompt = [
      `The Whisperr ${playbook.target.displayName} SDK is already installed and`,
      "initialized, and identify() is wired. Now instrument the product events",
      "below with track().",
      "",
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

    const events = await runPass({
      prompt: eventsPrompt,
      systemPrompt,
      repoPath,
      model: config.model,
      effort: config.effort,
      maxTurns: config.maxTurns,
      budgetUsd: config.budgetUsd - costUsd,
      progress,
    });
    costUsd += events.costUsd;
    eventsComplete = !events.maxedOut;
    if (events.summary) summaries.push(`Events:\n${events.summary}`);
  }

  // ---- Phase 3: self-review (audit own placements against the diff, fix) ----
  // Placement is where this fails, and the agent can catch its own mistakes
  // with fresh eyes on `git diff` far cheaper than a human can. Runs whenever
  // the core landed (so identify() is reviewed even with no events).
  if (core.ok && config.budgetUsd - costUsd > BUDGET_FLOOR) {
    progress?.onPhase?.("Reviewing & correcting placements");
    const reviewPrompt = [
      `You wired the Whisperr ${playbook.target.displayName} SDK into this repo.`,
      "Now AUDIT YOUR OWN WORK and fix mistakes before finishing.",
      `Project root: ${repoPath}`,
      "",
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
      "calls or re-explore the whole repo. Be surgical. End with a one-line,",
      "plain-text note of what you corrected, or 'No corrections needed.'.",
    ].join("\n");

    const review = await runPass({
      prompt: reviewPrompt,
      systemPrompt,
      repoPath,
      model: config.model,
      effort: config.effort,
      maxTurns: 40,
      budgetUsd: config.budgetUsd - costUsd,
      progress,
    });
    costUsd += review.costUsd;
    if (review.summary) summaries.push(`Review:\n${review.summary}`);
  }

  return {
    summary: summaries.join("\n\n"),
    costUsd,
    durationMs: Date.now() - started,
    coreOk: core.ok,
    eventsComplete,
  };
}

interface PassResult {
  summary: string;
  costUsd: number;
  ok: boolean;
  /** Stopped early on a limit (turns or budget) rather than finishing cleanly. */
  maxedOut: boolean;
}

/** A thrown error that's really just a turn/budget stop, not a genuine failure. */
function isLimitStop(err: unknown): boolean {
  const msg = (err as Error)?.message ?? "";
  return /max(imum)?[\s_-]*(turn|budget)|budget.*exceeded|number of turns/i.test(msg);
}

async function runPass(opts: {
  prompt: string;
  systemPrompt: string;
  repoPath: string;
  model: string;
  effort: WizardConfig["effort"];
  maxTurns: number;
  /** USD ceiling for THIS pass (remaining budget). Omit/<=0 for no cap. */
  budgetUsd?: number;
  progress?: AgentProgress;
}): Promise<PassResult> {
  const { prompt, systemPrompt, repoPath, model, effort, maxTurns, budgetUsd, progress } =
    opts;

  let summary = "";
  let costUsd = 0;
  let ok = false;
  let maxedOut = false;

  const response = query({
    prompt,
    options: {
      model,
      cwd: repoPath,
      systemPrompt,
      // Adaptive thinking (Claude decides depth per step) + an explicit effort
      // level. Sonnet 4.6 supports both; we set them rather than rely on SDK
      // defaults so the behavior is pinned regardless of SDK version.
      thinking: { type: "adaptive" },
      effort,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
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
          progress?.onActivity?.(firstLine(block.text));
        } else if (isToolUseBlock(block)) {
          progress?.onActivity?.(describeToolUse(block));
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
