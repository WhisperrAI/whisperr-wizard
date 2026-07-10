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

export type PostRunReportResult =
  | { ok: true }
  | { ok: false; status?: number; detail?: string };

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
