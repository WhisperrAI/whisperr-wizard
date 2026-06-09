import { resolve } from "node:path";
import * as p from "@clack/prompts";
import type { CliFlags } from "./core/config.js";
import { resolveConfig } from "./core/config.js";
import { detectStack } from "./core/detect.js";
import { playbookByTargetId, ALL_PLAYBOOKS } from "./core/playbooks/index.js";
import { authenticate } from "./core/auth.js";
import { fetchManifest } from "./core/manifest.js";
import { runIntegrationAgent } from "./core/agent.js";
import { takeCheckpoint, changedFiles, revertHint } from "./core/git.js";
import { pollFirstEvent } from "./core/verify.js";
import { banner } from "./ui/banner.js";
import { theme } from "./ui/theme.js";
import type { Detection, Playbook } from "./types.js";

export interface RunOptions extends CliFlags {
  /** Target repo (defaults to cwd). */
  path?: string;
}

export async function run(options: RunOptions): Promise<number> {
  const repoPath = resolve(options.path ?? process.cwd());
  const config = resolveConfig(options);

  // eslint-disable-next-line no-console
  console.log(banner());
  p.intro(theme.signal("Let's wire Whisperr into your app."));

  if (config.offline) {
    p.log.warn(
      theme.warn("offline mode") +
        theme.muted(" — using a demo manifest, no account needed."),
    );
  }

  // 1. Detect the stack.
  const detections = await withSpinner("Scanning your repository", () =>
    detectStack(repoPath),
  );
  const chosen = await chooseTarget(detections);
  if (!chosen) {
    p.cancel("No supported stack selected.");
    return 1;
  }

  if (chosen.playbook.target.availability === "planned") {
    p.note(
      `We can detect ${theme.bright(chosen.playbook.target.displayName)} but the ` +
        `Whisperr SDK for it isn't shipped yet.\n` +
        `Flutter is live today; ${theme.bright(
          chosen.playbook.target.displayName,
        )} is next on the roadmap.`,
      theme.warn("SDK coming soon"),
    );
    const cont = await p.confirm({
      message: "Continue anyway and let the agent scaffold against the planned SDK?",
      initialValue: false,
    });
    if (p.isCancel(cont) || !cont) {
      p.outro(theme.muted("No problem — come back when the SDK lands."));
      return 0;
    }
  } else {
    p.log.success(
      `Detected ${theme.bright(chosen.playbook.target.displayName)} ` +
        theme.muted(`(${chosen.detection?.evidence.join(", ") ?? "selected"})`),
    );
  }

  // 2. Authenticate (device flow opens the browser).
  let session;
  try {
    session = config.offline
      ? await authenticate(config)
      : await withBrowserAuth(config);
  } catch (err) {
    p.cancel(theme.alert((err as Error).message));
    return 1;
  }

  // 3. Pull the integration manifest (events/interventions/key).
  const manifest = await withSpinner("Loading your onboarding context", () =>
    fetchManifest(config, session, chosen.playbook.target.id),
  );
  p.note(
    summarizeManifest(manifest),
    theme.signal(`Plan for ${manifest.appName ?? manifest.appId}`),
  );

  // 4. Git checkpoint so auto-applied edits are reversible.
  const checkpoint = await takeCheckpoint(repoPath);
  if (!checkpoint.isRepo) {
    p.log.warn(
      theme.warn("not a git repo") +
        theme.muted(" — edits will apply with no automatic undo."),
    );
  }

  // 5. Run the coding agent.
  const spin = p.spinner();
  spin.start(theme.bright("Integrating") + theme.muted(" — the agent is working in your code"));
  let lastLine = "";
  const outcome = await runIntegrationAgent({
    repoPath,
    config,
    session,
    playbook: chosen.playbook,
    manifest,
    progress: {
      onActivity(line) {
        lastLine = line;
        spin.message(theme.bright("Integrating") + theme.muted(` — ${line}`));
      },
    },
  }).catch((err) => {
    spin.stop(theme.alert("Integration failed"));
    p.log.error((err as Error).message);
    return null;
  });

  if (!outcome) return 1;
  spin.stop(
    outcome.ok
      ? theme.success("Integration complete")
      : theme.warn("Integration finished with notes"),
  );

  // 6. Show what changed + the agent's summary.
  const files = await changedFiles(repoPath, checkpoint);
  if (files.length) {
    p.note(files.map((f) => theme.muted("• ") + f).join("\n"), "Files changed");
  }
  if (outcome.summary.trim()) {
    p.log.message(outcome.summary.trim());
  }

  // 7. Activation: wait for the first event (skipped offline).
  if (!config.offline) {
    p.log.step(
      theme.bright("Run your app once") +
        theme.muted(" and trigger any tracked action — I'll watch for the first event."),
    );
    const verifySpin = p.spinner();
    verifySpin.start("Waiting for the first event from your app");
    const first = await pollFirstEvent(config, session, { timeoutMs: 120_000 });
    if (first.received) {
      verifySpin.stop(
        theme.success(
          `Whisperr is receiving events ✓` +
            (first.eventType ? theme.muted(`  (first: ${first.eventType})`) : ""),
        ),
      );
    } else {
      verifySpin.stop(
        theme.warn(
          "No events yet — that's fine. They'll flow once you run the app with the changes.",
        ),
      );
    }
  }

  // 8. Outro with next steps + undo.
  const undo = revertHint(checkpoint);
  const nextSteps = [
    `${theme.signal("1.")} Review the diff above.`,
    `${theme.signal("2.")} Run / rebuild your app to start sending events.`,
    `${theme.signal("3.")} Commit & deploy — Whisperr starts working on real users.`,
    undo ? theme.muted(`Undo everything: ${undo}`) : "",
  ]
    .filter(Boolean)
    .join("\n");
  p.note(nextSteps, theme.bright("Next"));
  p.outro(theme.signal("⌁ ") + theme.bright("Whisperr is wired in."));
  void lastLine;
  return 0;
}

// --- helpers ---

interface Chosen {
  playbook: Playbook;
  detection?: Detection;
}

async function chooseTarget(detections: Detection[]): Promise<Chosen | null> {
  const top = detections[0];
  // Strong single match -> auto-pick.
  if (top && (detections.length === 1 || top.confidence >= 0.9)) {
    const playbook = playbookByTargetId(top.target.id);
    if (playbook) return { playbook, detection: top };
  }

  // Ambiguous or none -> ask, seeded by detections then all targets.
  const seen = new Set<string>();
  const options: { value: string; label: string; hint?: string }[] = [];
  for (const d of detections) {
    if (seen.has(d.target.id)) continue;
    seen.add(d.target.id);
    options.push({
      value: d.target.id,
      label: d.target.displayName,
      hint:
        (d.target.availability === "available" ? "" : "coming soon · ") +
        `${Math.round(d.confidence * 100)}% match`,
    });
  }
  for (const pb of ALL_PLAYBOOKS) {
    if (seen.has(pb.target.id)) continue;
    options.push({
      value: pb.target.id,
      label: pb.target.displayName,
      hint: pb.target.availability === "available" ? undefined : "coming soon",
    });
  }

  const answer = await p.select({
    message: detections.length
      ? "I found more than one possible stack — which should I integrate?"
      : "I couldn't auto-detect your stack. Which are you using?",
    options,
  });
  if (p.isCancel(answer)) return null;
  const playbook = playbookByTargetId(answer as string);
  if (!playbook) return null;
  return {
    playbook,
    detection: detections.find((d) => d.target.id === answer),
  };
}

async function withBrowserAuth(config: ReturnType<typeof resolveConfig>) {
  p.log.step(
    theme.bright("Authenticate") +
      theme.muted(" — opening your browser to approve this device…"),
  );
  const spin = p.spinner();
  spin.start("Waiting for you to approve in the browser");
  try {
    const session = await authenticate(config);
    spin.stop(theme.success("Authenticated ✓"));
    return session;
  } catch (err) {
    spin.stop(theme.alert("Authentication failed"));
    throw err;
  }
}

async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const spin = p.spinner();
  spin.start(label);
  try {
    const result = await fn();
    spin.stop(theme.muted(label) + " " + theme.success("✓"));
    return result;
  } catch (err) {
    spin.stop(theme.alert(`${label} — failed`));
    throw err;
  }
}

function summarizeManifest(m: {
  events: { eventType: string; importance?: number }[];
  identify: { channels?: string[] };
}): string {
  const events = [...m.events]
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
    .map((e) => theme.muted("• ") + e.eventType);
  const channels = m.identify.channels?.length
    ? theme.muted(`channels: ${m.identify.channels.join(", ")}`)
    : "";
  return [
    theme.bright("identify()") + theme.muted(" + ") + theme.bright(`${m.events.length} events`),
    ...events,
    channels,
  ]
    .filter(Boolean)
    .join("\n");
}
