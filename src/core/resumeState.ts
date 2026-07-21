import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface LocalResumeState {
  runId: string;
  conversationId?: string;
}

export interface ResumeStateIdentity {
  apiBaseUrl: string;
  appId: string;
  repoFingerprint: string;
}

export function resumeStatePath(
  identity: ResumeStateIdentity,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root =
    env.WHISPERR_WIZARD_STATE_DIR ??
    join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "whisperr-wizard");
  const key = createHash("sha256")
    .update(
      [identity.apiBaseUrl.replace(/\/+$/, ""), identity.appId, identity.repoFingerprint].join(
        "\n",
      ),
    )
    .digest("hex");
  return join(root, `${key}.json`);
}

export async function loadResumeState(path: string): Promise<LocalResumeState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.runId !== "string" || !parsed.runId.trim()) return null;
    if (
      parsed.conversationId !== undefined &&
      (typeof parsed.conversationId !== "string" || !parsed.conversationId.trim())
    ) {
      return null;
    }
    return {
      runId: parsed.runId,
      ...(typeof parsed.conversationId === "string"
        ? { conversationId: parsed.conversationId }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function saveResumeState(
  path: string,
  state: LocalResumeState,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(state)}\n`;
  try {
    await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function clearResumeState(path: string): Promise<void> {
  await rm(path, { force: true });
}
