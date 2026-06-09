import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  IntegrationManifest,
  Playbook,
  WizardConfig,
  WizardSession,
} from "../types.js";
import { BASE_WIZARD_PROMPT, renderManifestBrief } from "./playbooks/shared-prompt.js";

export interface AgentProgress {
  /** Free-text line, e.g. "Editing lib/main.dart". */
  onActivity?(line: string): void;
  /** Final result summary text from the agent. */
  onResult?(summary: string, costUsd?: number): void;
}

export interface AgentRunOutcome {
  summary: string;
  costUsd?: number;
  durationMs?: number;
  ok: boolean;
}

/**
 * Run the coding agent over `repoPath` to perform the integration.
 *
 * Auth model:
 *  - production: point the Agent SDK at Whisperr's Anthropic-compatible gateway
 *    via ANTHROPIC_BASE_URL, with the short-lived wizard token as
 *    ANTHROPIC_AUTH_TOKEN. The CLI never holds an Anthropic key; the gateway
 *    injects it and meters usage per app.
 *  - local dev: if a direct Anthropic key is configured, use it as-is.
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

  const verifyHint = playbook.verifyCommand
    ? `\n\nWhen finished, run \`${playbook.verifyCommand}\` and fix anything it flags.`
    : "";

  const prompt = [
    `Integrate the Whisperr ${playbook.target.displayName} SDK into this repository.`,
    `Project root: ${repoPath}`,
    "",
    "Here is the integration manifest derived from this customer's Whisperr",
    "onboarding. Wire identify() and instrument every event below at the correct",
    "call site, following the SDK guide in your system prompt.",
    "",
    "----- MANIFEST -----",
    renderManifestBrief(manifest),
    "----- END MANIFEST -----",
    verifyHint,
  ].join("\n");

  const started = Date.now();
  let summary = "";
  let costUsd: number | undefined;
  let ok = false;

  const response = query({
    prompt,
    options: {
      model: config.model,
      cwd: repoPath,
      systemPrompt,
      // Full file-system agent toolset.
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      // Fully autonomous edits (the user opted into auto-apply; the wizard takes
      // a git checkpoint before this runs so revert is one command).
      permissionMode: "bypassPermissions",
      maxTurns: config.maxTurns,
      // Don't pick up the user's own CLAUDE.md / settings — the wizard's prompt
      // is the single source of truth.
      settingSources: [],
    },
  });

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
      costUsd = message.total_cost_usd;
      summary = message.result ?? extractLastText(message) ?? summary;
    }
  }

  progress?.onResult?.(summary, costUsd);
  return { summary, costUsd, ok, durationMs: Date.now() - started };
}

/** Configure where the Agent SDK sends model calls. */
function applyModelAuthEnv(config: WizardConfig, session: WizardSession): void {
  if (config.directAnthropicKey) {
    process.env.ANTHROPIC_API_KEY = config.directAnthropicKey;
    // Make sure a stale gateway base from a prior run doesn't leak in.
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    return;
  }
  // Gateway mode: token is the wizard session token, base is our proxy.
  process.env.ANTHROPIC_BASE_URL = config.llmBaseUrl;
  process.env.ANTHROPIC_AUTH_TOKEN = session.token;
  delete process.env.ANTHROPIC_API_KEY;
}

// --- minimal structural typings over the Agent SDK message stream ---
// We keep these local + permissive so a minor SDK shape change doesn't break the
// build; we only read a handful of fields.
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
