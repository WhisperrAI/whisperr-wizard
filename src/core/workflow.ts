import { basename } from "node:path";
import type { Playbook, WizardSession } from "../types.js";
import {
  clearResumeState,
  loadResumeState,
  resumeStatePath,
  saveResumeState,
} from "./resumeState.js";
import {
  RuntimeRequestError,
  type WizardProjectKind,
  type WizardRunSnapshot,
  type WizardRuntimeClient,
} from "./runtime.js";
import { scrubError } from "./scrub.js";

export interface SelectRunOptions {
  apiBaseUrl: string;
  repoPath: string;
  repoFingerprint: string;
  session: WizardSession;
  playbook: Playbook;
  runtime: WizardRuntimeClient;
  env?: NodeJS.ProcessEnv;
}

export interface SelectedRun {
  snapshot: WizardRunSnapshot;
  statePath: string;
  resumed: boolean;
}

export async function selectOrCreateRun(options: SelectRunOptions): Promise<SelectedRun> {
  const statePath = resumeStatePath(
    {
      apiBaseUrl: options.apiBaseUrl,
      appId: options.session.appId,
      repoFingerprint: options.repoFingerprint,
    },
    options.env,
  );
  const local = await loadResumeState(statePath);
  let failedLocalConversation: { runId: string; conversationId?: string } | null = null;
  if (local) {
    try {
      const snapshot = await options.runtime.getRun(local.runId);
      if (isMatchingIncompleteRun(snapshot, options)) {
        const conversationId = snapshot.run.modelConversationId ?? local.conversationId;
        await saveResumeState(statePath, {
          runId: snapshot.run.id,
          ...(conversationId ? { conversationId } : {}),
        });
        return {
          snapshot: {
            ...snapshot,
            run: {
              ...snapshot.run,
              ...(conversationId ? { modelConversationId: conversationId } : {}),
            },
            resumed: true,
          },
          statePath,
          resumed: true,
        };
      }
      assertRunOwnership(snapshot, options);
      if (snapshot.run.status === "failed") {
        failedLocalConversation = local;
      } else {
        await clearResumeState(statePath);
      }
    } catch (error) {
      if (!(error instanceof RuntimeRequestError) || error.status !== 404) throw error;
      await clearResumeState(statePath);
    }
  }

  let snapshot = await options.runtime.createOrResumeRun({
    repoFingerprint: options.repoFingerprint,
    displayName: basename(options.repoPath),
    target: options.playbook.target.id,
    kind: projectKindForTarget(options.playbook.target.id),
  });
  try {
    assertRunOwnership(snapshot, options);
    const conversationId =
      snapshot.run.modelConversationId ??
      (failedLocalConversation?.runId === snapshot.run.id
        ? failedLocalConversation.conversationId
        : undefined);
    if (conversationId) {
      snapshot = {
        ...snapshot,
        run: { ...snapshot.run, modelConversationId: conversationId },
      };
    }
    await saveResumeState(statePath, {
      runId: snapshot.run.id,
      ...(conversationId ? { conversationId } : {}),
    });
  } catch (error) {
    await options.runtime
      .updateRun(snapshot.run.id, {
        status: "failed",
        error: scrubError(error, [options.session.token]),
        message: "Failed to initialize local wizard resume state.",
      })
      .catch(() => {});
    throw error;
  }
  const resumed = snapshot.resumed === true || snapshot.run.status === "failed";
  return {
    snapshot: { ...snapshot, resumed },
    statePath,
    resumed,
  };
}

export function projectKindForTarget(target: string): WizardProjectKind {
  if (["node", "python", "php"].includes(target)) return "backend";
  if (target === "nextjs") return "fullstack";
  return "frontend";
}

function isMatchingIncompleteRun(
  snapshot: WizardRunSnapshot,
  options: SelectRunOptions,
): boolean {
  assertRunOwnership(snapshot, options);
  return snapshot.run.status === "pending" || snapshot.run.status === "running";
}

function assertRunOwnership(
  snapshot: WizardRunSnapshot,
  options: SelectRunOptions,
): void {
  if (snapshot.app.id !== options.session.appId) {
    throw new Error("Runtime returned a wizard run for a different app.");
  }
  if (snapshot.project.repoFingerprint !== options.repoFingerprint) {
    throw new Error("Runtime returned a wizard run for a different repository.");
  }
}
