import type { AgentEventOutcome } from "./agent.js";
import type {
  ManifestEvent,
  WizardConfig,
  WizardSession,
} from "../types.js";

/** One event's outcome in a run, as reported to the coverage ledger. */
export interface ReportEvent {
  /** Exact pair from the manifest; the server rejects mismatches. */
  event_definition_id: string;
  event_type: string;
  feasibility_status: "confirmed" | "not_found" | "uncertain";
  instrumentation_status:
    | "existing"
    | "added"
    | "declined"
    | "failed"
    | "reverted"
    | "not_attempted";
  placements: Array<{ file: string }>;
  observed_properties: Array<{ name: string; type?: string }>;
  /**
   * The agent's own explanation for a skip. Costs nothing to send and is the
   * difference between "12/28 wired" and knowing why the other 16 weren't.
   */
  reason?: string;
}

/** Wall-clock cost of one agent pass, in execution order. */
export interface ReportPhaseTiming {
  phase: string;
  ms: number;
}

/** How the run ended. Free-form on the wire so a newer CLI can add classes. */
export type ReportExitClass = string;

export interface RunReport {
  /** Pins this report to the exact graph the wizard evaluated. */
  config_version_id: string;
  manifest_revision: string;
  target: string;
  repo_fingerprint: string;
  identify_wired: boolean;
  /**
   * Whether the playbook's verify command (build/lint) passed after the agent
   * ran. `null` when the playbook has no verify command or it couldn't be run
   * (tool missing / timed out) — i.e. "unknown", distinct from a real failure.
   */
  verified?: boolean | null;
  cost_usd: number;
  duration_ms: number;
  summary: string;
  events: ReportEvent[];

  /**
   * Run telemetry. Enough to answer "what ran, on what, how long did each pass
   * take, and how did it end" from the backoffice — deliberately no source, no
   * diffs, no absolute paths.
   */
  wizard_version?: string;
  planner_model?: string;
  editor_model?: string;
  effort?: string;
  exit_class?: ReportExitClass;
  phase_timings?: ReportPhaseTiming[];
  opportunities_proposed?: number;
}

/**
 * Compile deterministic repository scans and planner findings into the exact
 * per-event wire contract. Identity matching uses both database ID and event
 * code, so a stale/mismatched finding cannot be attached to another event.
 */
export function buildReportEvents(
  events: ManifestEvent[],
  outcomes: AgentEventOutcome[],
  currentPlacements: Map<string, string[]>,
  opts: { reverted?: boolean } = {},
): ReportEvent[] {
  const byIdentity = new Map(
    outcomes.map((outcome) => [
      eventIdentity(outcome.eventDefinitionId, outcome.event),
      outcome,
    ]),
  );
  return events.map((event) => {
    const outcome = byIdentity.get(
      eventIdentity(event.eventDefinitionId, event.eventType),
    );
    const currentFiles = currentPlacements.get(event.eventType) ?? [];
    const wasExisting = outcome?.instrumentationStatus === "existing";
    const wasReverted =
      opts.reverted === true && outcome?.instrumentationStatus === "added";
    const instrumentationStatus = wasExisting
      ? "existing"
      : wasReverted
        ? "reverted"
        : currentFiles.length
          ? "added"
          : outcome?.instrumentationStatus === "added"
            ? "failed"
            : (outcome?.instrumentationStatus ?? "not_attempted");

    return {
      event_definition_id: event.eventDefinitionId,
      event_type: event.eventType,
      feasibility_status:
        currentFiles.length || wasExisting || wasReverted
          ? "confirmed"
          : (outcome?.feasibilityStatus ?? "uncertain"),
      instrumentation_status: instrumentationStatus,
      placements: wasExisting && outcome.placements.length
        ? outcome.placements
        : currentFiles.length
        ? currentFiles.map((file) => ({ file }))
        : (outcome?.placements ?? []),
      observed_properties: outcome?.observedProperties ?? [],
      reason:
        instrumentationStatus === "added" || instrumentationStatus === "existing"
          ? undefined
          : outcome?.reason,
    };
  });
}

function eventIdentity(eventDefinitionId: string, eventType: string): string {
  return `${eventDefinitionId}\u0000${eventType}`;
}

export type PostRunReportResult =
  | { ok: true }
  | { ok: false; status?: number; detail?: string };

export function scrubSummary(text: string): string {
  return scrubTerminalControls(text)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/sk-[A-Za-z0-9]{16,}/g, "[redacted]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(
      /\b(ANTHROPIC_(?:AUTH_TOKEN|API_KEY))\s*=\s*["']?[^"'\s]+["']?/gi,
      "$1=[redacted]",
    );
}

/**
 * Post the run report to whisperr-go (`POST /wizard/report`) so the coverage
 * ledger knows what this surface now handles. Best-effort — a failed report
 * must never fail the integration. Skipped in offline mode.
 */
export async function postRunReport(
  config: WizardConfig,
  session: WizardSession,
  report: RunReport,
): Promise<PostRunReportResult> {
  if (config.offline) return { ok: true };
  try {
    const res = await fetch(`${config.apiBaseUrl}/wizard/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify(report),
    });
    if (res.ok) return { ok: true };
    return {
      ok: false,
      status: res.status,
      detail: await responseDetail(res),
    };
  } catch (err) {
    return { ok: false, detail: detailSlice(errorMessage(err)) };
  }
}

async function responseDetail(res: Response): Promise<string | undefined> {
  try {
    return detailSlice(await res.text());
  } catch (err) {
    return detailSlice(errorMessage(err));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function detailSlice(detail: string): string | undefined {
  const sliced = detail.slice(0, 200).trim();
  return sliced || undefined;
}

function scrubTerminalControls(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}
