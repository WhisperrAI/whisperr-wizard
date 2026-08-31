import { isWorkingTreeClean, takeCheckpoint } from "./git.js";
import type { WizardConfig, WizardSession } from "../types.js";

/** Read-only local checks must happen before POST /wizard/runs. --force remains
 * explicit permission to edit a dirty/non-git tree, never an inferred retry. */
export async function preflightIntegration(repoPath: string, force = false): Promise<void> {
  const checkpoint = await takeCheckpoint(repoPath);
  if (!checkpoint.isRepo && !force) throw new Error("Not a git repository. Initialize and commit it, or explicitly rerun with --force before starting integration.");
  if (checkpoint.isRepo && !checkpoint.baseRef) throw new Error("The repository has no commit. Commit a baseline before starting integration.");
  if (checkpoint.isRepo && !force && !await isWorkingTreeClean(repoPath)) {
    throw new Error("The repository has uncommitted changes. Commit or stash them first, or explicitly use --force to resume with those changes.");
  }
}

/** Never outlive a run. Authorization has already completed when this starts. */
export function startIntegrationHeartbeat(config: WizardConfig, session: WizardSession, runID: string): () => void {
  let pending = false;
  const timer = setInterval(() => {
    if (pending) return;
    pending = true;
    void fetch(`${config.apiBaseUrl}/wizard/runs/${encodeURIComponent(runID)}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ phase: "integrating" }), redirect: "error", signal: AbortSignal.timeout(15_000),
    }).catch(() => {}).finally(() => { pending = false; });
  }, 20_000);
  timer.unref();
  return () => clearInterval(timer);
}
