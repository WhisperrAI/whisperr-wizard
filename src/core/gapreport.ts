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
  variantCode: string;
  label?: string;
  variantLabel?: string;
  blocked: "fully" | "partially";
  missingEvents: Array<{ code: string; reason?: string }>;
}

export interface GapReport {
  interventionGaps: InterventionGap[];
  hasContent: boolean;
}

export interface ThemeLike {
  bright(text: string): string;
  muted(text: string): string;
}

interface CollectedIntervention {
  code: string;
  variantCode: string;
  label?: string;
  variantLabel?: string;
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
    for (const link of event.variantLinks.filter((candidate) => candidate.role === "required")) {
      const key = `${link.interventionCode}\u0000${link.variantCode}`;
      let collected = interventions.get(key);
      if (!collected) {
        collected = {
          code: link.interventionCode,
          variantCode: link.variantCode,
          label: link.interventionLabel,
          variantLabel: link.variantLabel,
          drivingEvents: [],
          drivingEventSet: new Set(),
        };
        interventions.set(key, collected);
      } else {
        if (!collected.label && link.interventionLabel) {
          collected.label = link.interventionLabel;
        }
        if (!collected.variantLabel && link.variantLabel) {
          collected.variantLabel = link.variantLabel;
        }
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
      variantCode: intervention.variantCode,
      ...(intervention.label ? { label: intervention.label } : {}),
      ...(intervention.variantLabel ? { variantLabel: intervention.variantLabel } : {}),
      blocked: missingEvents.length === plannedEvents.length ? "fully" : "partially",
      missingEvents,
    });
  }

  interventionGaps.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked === "fully" ? -1 : 1;
    return b.missingEvents.length - a.missingEvents.length;
  });

  return {
    interventionGaps,
    hasContent: interventionGaps.length > 0,
  };
}

export function renderGapReport(report: GapReport, theme: ThemeLike): string {
  const lines: string[] = [];

  for (const gap of report.interventionGaps) {
    const status = gap.blocked === "fully" ? "on hold" : "running below potential";
    const parent = gap.label ?? gap.code;
    const variant = gap.variantLabel ?? gap.variantCode;
    lines.push(
      `■ ${theme.bright(`${parent} / ${variant}`)}${theme.muted(` — ${status}`)}`,
    );
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
