import type { IntegrationManifest } from "../types.js";

export interface GapReportInput {
  manifest: IntegrationManifest;
  events: Array<{
    eventType: string;
    status: "wired" | "skipped";
    reason?: string;
  }>;
}

export interface InterventionGap {
  code: string;
  label?: string;
  blocked: "fully" | "partially";
  missingEvents: Array<{ code: string; reason?: string }>;
}

export interface GapReport {
  interventionGaps: InterventionGap[];
  otherSurface: number;
  derived: number;
  hasContent: boolean;
}

export interface ThemeLike {
  bright(text: string): string;
  muted(text: string): string;
}

interface CollectedIntervention {
  code: string;
  label?: string;
  drivingEvents: string[];
  drivingEventSet: Set<string>;
}

export function buildGapReport(input: GapReportInput): GapReport {
  const outcomes = new Map(
    input.events.map((event) => [
      event.eventType,
      {
        status: event.status,
        reason: trimmedReason(event.reason),
      },
    ]),
  );
  const interventions = new Map<string, CollectedIntervention>();

  for (const event of input.manifest.events) {
    for (const intervention of event.interventions ?? []) {
      let collected = interventions.get(intervention.code);
      if (!collected) {
        collected = {
          code: intervention.code,
          label: intervention.label,
          drivingEvents: [],
          drivingEventSet: new Set(),
        };
        interventions.set(intervention.code, collected);
      } else if (!collected.label && intervention.label) {
        collected.label = intervention.label;
      }

      if (!collected.drivingEventSet.has(event.eventType)) {
        collected.drivingEventSet.add(event.eventType);
        collected.drivingEvents.push(event.eventType);
      }
    }
  }

  const interventionGaps: InterventionGap[] = [];
  for (const intervention of interventions.values()) {
    const plannedEvents = intervention.drivingEvents.filter((code) => outcomes.has(code));
    const missingEvents = plannedEvents.flatMap((code) => {
      const outcome = outcomes.get(code);
      if (outcome?.status !== "skipped") return [];
      return [{ code, ...(outcome.reason ? { reason: outcome.reason } : {}) }];
    });
    if (missingEvents.length === 0) continue;

    interventionGaps.push({
      code: intervention.code,
      ...(intervention.label ? { label: intervention.label } : {}),
      blocked: missingEvents.length === plannedEvents.length ? "fully" : "partially",
      missingEvents,
    });
  }

  interventionGaps.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked === "fully" ? -1 : 1;
    return b.missingEvents.length - a.missingEvents.length;
  });

  const otherSurface = input.manifest.universeSummary?.otherSurface ?? 0;
  const derived = input.manifest.universeSummary?.derived ?? 0;
  return {
    interventionGaps,
    otherSurface,
    derived,
    hasContent: interventionGaps.length > 0 || otherSurface > 0,
  };
}

export function renderGapReport(report: GapReport, theme: ThemeLike): string {
  const lines: string[] = [];

  for (const gap of report.interventionGaps) {
    const status = gap.blocked === "fully" ? "on hold" : "running below potential";
    lines.push(`■ ${theme.bright(gap.label ?? gap.code)}${theme.muted(` — ${status}`)}`);
    for (const event of gap.missingEvents) {
      const reason = event.reason ? ` — ${lowercaseFirst(event.reason)}` : "";
      lines.push(
        theme.muted("  · ") +
          theme.bright(event.code) +
          theme.muted(` isn't flowing yet${reason}`),
      );
    }
    lines.push(
      theme.muted(
        gap.blocked === "fully"
          ? "  Ship the missing flow and this play switches on by itself — the strategy is already built for it."
          : "  It works today, but with only part of its signal — every event above sharpens it.",
      ),
    );
  }

  if (report.otherSurface > 0) {
    const suffix = report.otherSurface === 1 ? "" : "s";
    lines.push(
      `■ ${report.otherSurface} more event${suffix} live on another surface (your backend or another app)`,
    );
    lines.push(
      theme.muted(
        "  Run the wizard there and they join the same strategy — nothing to reconfigure.",
      ),
    );
  }

  if (report.derived > 0) {
    const suffix = report.derived === 1 ? "" : "s";
    lines.push(
      theme.muted(
        `${report.derived} derived signal${suffix} (dormancy, anniversaries, expiries) are computed by Whisperr automatically once your raw events flow — nothing to wire.`,
      ),
    );
  }

  lines.push(
    theme.muted(
      "All of this is capacity your strategy already includes. Each item you unlock compounds the rest.",
    ),
  );
  return lines.join("\n");
}

function trimmedReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed || undefined;
}

function lowercaseFirst(value: string): string {
  return value.slice(0, 1).toLowerCase() + value.slice(1);
}
