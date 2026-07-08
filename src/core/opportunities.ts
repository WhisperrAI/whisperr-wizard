import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  IntegrationManifest,
  OpportunityEvent,
  OpportunityIntervention,
  UniverseAdditionsResult,
  UniverseOpportunities,
  WizardConfig,
  WizardSession,
} from "../types.js";

/**
 * Universe opportunities: during the self-review phase the agent may spot real
 * lifecycle moments (events) or messaging strategies (interventions) the
 * onboarding-generated universe misses. It writes them to OPPORTUNITIES_FILE
 * in the repo root; the CLI collects the file (and deletes it — it must never
 * end up in the customer's diff), pre-filters obvious duplicates against the
 * manifest, asks the user which to submit, and posts the confirmed set to
 * whisperr-go, which owns the authoritative merge/dedupe.
 */
export const OPPORTUNITIES_FILE = "whisperr-opportunities.json";

/**
 * Mirrors whisperr-go's NormalizeCode (internal/onboardingimport): lowercase
 * snake_case, non-alphanumerics collapsed to single underscores. Client-side
 * it's only used to pre-filter no-op proposals; the server check is
 * authoritative.
 */
export function normalizeCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Read, validate, and delete the agent's opportunities file. Returns an empty
 * set when the file is absent or unusable — opportunities are additive and
 * must never fail the run.
 */
export async function collectOpportunities(
  repoPath: string,
  manifest: IntegrationManifest,
): Promise<UniverseOpportunities> {
  const path = join(repoPath, OPPORTUNITIES_FILE);
  let rawText: string;
  try {
    rawText = await readFile(path, "utf8");
  } catch {
    return { events: [], interventions: [] };
  }
  // Whatever happens next, the file must not linger in the customer's tree.
  await rm(path, { force: true }).catch(() => {});

  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    return { events: [], interventions: [] };
  }
  return sanitizeOpportunities(raw, manifest);
}

/**
 * Validate the agent's raw JSON into a clean UniverseOpportunities, dropping
 * malformed entries and pre-filtering proposals that duplicate the manifest.
 */
export function sanitizeOpportunities(
  raw: unknown,
  manifest: IntegrationManifest,
): UniverseOpportunities {
  const out: UniverseOpportunities = { events: [], interventions: [] };
  if (typeof raw !== "object" || raw === null) return out;
  const doc = raw as Record<string, unknown>;

  const knownEvents = new Set(manifest.events.map((e) => normalizeCode(e.eventType)));
  const knownInterventions = new Set(
    manifest.events.flatMap((e) => e.interventions ?? []).map((i) => normalizeCode(i.code)),
  );

  const seenEvents = new Set<string>();
  for (const entry of asArray(doc.events)) {
    const ev = coerceEvent(entry);
    if (!ev) continue;
    if (knownEvents.has(ev.code) || seenEvents.has(ev.code)) continue;
    seenEvents.add(ev.code);
    out.events.push(ev);
  }

  const seenInterventions = new Set<string>();
  for (const entry of asArray(doc.interventions)) {
    const iv = coerceIntervention(entry);
    if (!iv) continue;
    if (knownInterventions.has(iv.code) || seenInterventions.has(iv.code)) continue;
    seenInterventions.add(iv.code);
    out.interventions.push(iv);
  }

  return out;
}

/**
 * Post the confirmed opportunities to whisperr-go. Unlike the coverage report
 * this is a real write the user just approved, so failures surface to the
 * caller instead of being swallowed.
 */
export async function submitAdditions(
  config: WizardConfig,
  session: WizardSession,
  target: string,
  repoFingerprint: string,
  opportunities: UniverseOpportunities,
): Promise<UniverseAdditionsResult> {
  const res = await fetch(`${config.apiBaseUrl}/wizard/universe/additions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({
      target,
      repoFingerprint,
      events: opportunities.events,
      interventions: opportunities.interventions,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Submitting universe additions failed (${res.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }
  return (await res.json()) as UniverseAdditionsResult;
}

// --- coercion helpers (tolerant of LLM output noise) ---

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function asWeight(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}

function coerceEvent(entry: unknown): OpportunityEvent | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const code = normalizeCode(asString(e.code) ?? "");
  if (!code) return null;

  const properties: OpportunityEvent["properties"] = [];
  for (const prop of asArray(e.properties)) {
    if (typeof prop === "string") {
      if (prop.trim()) properties.push({ name: prop.trim() });
      continue;
    }
    if (typeof prop !== "object" || prop === null) continue;
    const pr = prop as Record<string, unknown>;
    const name = asString(pr.name);
    if (!name) continue;
    const desc = asString(pr.description);
    properties.push({
      name,
      ...(desc ? { description: desc } : {}),
      ...(pr.required === true ? { required: true } : {}),
    });
  }

  const links: OpportunityEvent["links"] = [];
  for (const link of asArray(e.links)) {
    if (typeof link !== "object" || link === null) continue;
    const l = link as Record<string, unknown>;
    const interventionCode = normalizeCode(asString(l.interventionCode) ?? "");
    if (!interventionCode) continue;
    const weight = asWeight(l.weight);
    links.push({ interventionCode, ...(weight !== undefined ? { weight } : {}) });
  }

  const side = normalizeSide(asString(e.side));
  return {
    code,
    label: asString(e.label),
    description: asString(e.description),
    ...(side ? { side } : {}),
    rationale: asString(e.rationale),
    confidence: asConfidence(e.confidence),
    ...(properties.length ? { properties } : {}),
    ...(links.length ? { links } : {}),
  };
}

function coerceIntervention(entry: unknown): OpportunityIntervention | null {
  if (typeof entry !== "object" || entry === null) return null;
  const i = entry as Record<string, unknown>;
  const code = normalizeCode(asString(i.code) ?? "");
  if (!code) return null;

  const links: OpportunityIntervention["links"] = [];
  for (const link of asArray(i.links)) {
    if (typeof link !== "object" || link === null) continue;
    const l = link as Record<string, unknown>;
    const eventCode = normalizeCode(asString(l.eventCode) ?? "");
    if (!eventCode) continue;
    const weight = asWeight(l.weight);
    links.push({ eventCode, ...(weight !== undefined ? { weight } : {}) });
  }

  return {
    code,
    label: asString(i.label),
    description: asString(i.description),
    rationale: asString(i.rationale),
    confidence: asConfidence(i.confidence),
    ...(links.length ? { links } : {}),
  };
}

function normalizeSide(value?: string): string | undefined {
  switch (value?.toLowerCase()) {
    case "frontend":
      return "frontend";
    case "backend":
      return "backend";
    case "either":
      return "either";
    default:
      return undefined;
  }
}
