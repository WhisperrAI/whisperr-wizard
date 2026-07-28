import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { EngineRunState } from "./types.js";
import { ENGINE_PHASES } from "./types.js";

export function stateDirectory(): string {
  const override = process.env.WHISPERR_WIZARD_STATE_DIR?.trim();
  const preferred = override || join(homedir(), ".whisperr", "wizard-runs");
  if (canCreateStateDirectory(preferred)) {
    return preferred;
  }

  // CLI runs can have a synthetic or read-only home directory (for example in
  // a dev container). A per-user temp directory keeps resumable state working
  // without making the integration itself fail after the read-only survey.
  const user = typeof process.getuid === "function" ? process.getuid() : "user";
  const fallback = join(tmpdir(), `whisperr-${user}`, "wizard-runs");
  if (canCreateStateDirectory(fallback)) {
    return fallback;
  }

  throw new Error("Whisperr Wizard could not create a directory for run state");
}

export function stateKey(apiBaseUrl: string, appId: string, repoFingerprint: string): string {
  return createHash("sha256")
    .update(`${apiBaseUrl}\n${appId}\n${repoFingerprint}`)
    .digest("hex")
    .slice(0, 24);
}

export function statePath(apiBaseUrl: string, appId: string, repoFingerprint: string): string {
  return join(stateDirectory(), `${stateKey(apiBaseUrl, appId, repoFingerprint)}.json`);
}

export function saveRunState(state: EngineRunState): void {
  const directory = stateDirectory();
  const path = join(directory, `${stateKey(state.apiBaseUrl, state.appId, state.repoFingerprint)}.json`);
  const payload = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, payload, { mode: 0o600 });
  renameSync(temporary, path);
}

function canCreateStateDirectory(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

export function loadRunState(
  apiBaseUrl: string,
  appId: string,
  repoFingerprint: string,
): EngineRunState | undefined {
  const path = statePath(apiBaseUrl, appId, repoFingerprint);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isEngineRunState(parsed)) {
    return undefined;
  }
  if (
    parsed.apiBaseUrl !== apiBaseUrl ||
    parsed.appId !== appId ||
    parsed.repoFingerprint !== repoFingerprint
  ) {
    return undefined;
  }
  return parsed;
}

function isEngineRunState(value: unknown): value is EngineRunState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.apiBaseUrl === "string" &&
    typeof candidate.appId === "string" &&
    typeof candidate.repoFingerprint === "string" &&
    typeof candidate.runId === "string" &&
    typeof candidate.phase === "string" &&
    (ENGINE_PHASES as readonly string[]).includes(candidate.phase) &&
    typeof candidate.designComplete === "boolean" &&
    Array.isArray(candidate.tombstonedCodes) &&
    Array.isArray(candidate.clusters) &&
    typeof candidate.providerSessions === "object" &&
    candidate.providerSessions !== null
  );
}
