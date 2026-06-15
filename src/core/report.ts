import type { WizardConfig, WizardSession } from "../types.js";

/** One event's outcome in a run, as reported to the coverage ledger. */
export interface ReportEvent {
  event_type: string;
  status: "wired" | "skipped";
  file?: string;
}

export interface RunReport {
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
): Promise<void> {
  if (config.offline) return;
  try {
    await fetch(`${config.apiBaseUrl}/wizard/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify(report),
    });
  } catch {
    /* coverage is best-effort telemetry; never block on it */
  }
}
