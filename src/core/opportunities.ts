import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { wasTrackedAtCheckpoint, type GitCheckpoint } from "./git.js";
import type {
  IntegrationManifest,
  OpportunityEvent,
  OpportunityIntervention,
  StageResult,
  SuggestionRecord,
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
 * Mirrors whisperr-go's NormalizeCode (internal/onboardingimport) exactly:
 * lowercase, then space/`-`/`.`/`/` become underscores, every other
 * non-alphanumeric is DROPPED, and runs of underscores collapse to one.
 * Client-side it's only used to pre-filter no-op proposals; the server check
 * is authoritative — which is why the semantics must not drift.
 */
export function normalizeCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[ \-./]/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Read, validate, and delete the agent's opportunities file. Returns an empty
 * set when the file is absent or unusable — opportunities are additive and
 * must never fail the run.
 *
 * Trust boundary: only a file the agent wrote during THIS run counts. A
 * whisperr-opportunities.json that was already tracked at the pre-pass
 * checkpoint is the audited repo's own content — attacker-controllable, not
 * agent output — so it is ignored and left untouched.
 */
export async function collectOpportunities(
  repoPath: string,
  manifest: IntegrationManifest,
  checkpoint: GitCheckpoint,
): Promise<UniverseOpportunities> {
  const path = join(repoPath, OPPORTUNITIES_FILE);
  if (await wasTrackedAtCheckpoint(repoPath, checkpoint, OPPORTUNITIES_FILE)) {
    return { events: [], interventions: [] };
  }
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
  // Interventions surface two ways: nested under the events they drive (via
  // weights) AND in the manifest's top-level catalog, which also carries
  // link-less interventions the per-event view misses. Union both so a
  // wizard-added intervention with no links isn't re-proposed every run.
  const knownInterventions = new Set([
    ...manifest.events.flatMap((e) => e.interventions ?? []).map((i) => normalizeCode(i.code)),
    ...(manifest.interventions ?? []).map((i) => normalizeCode(i.code)),
  ]);

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

/** The additions POST does server-side merging + policy regen triggering, so
 *  give it real headroom — but never let it hang the CLI indefinitely. */
const SUBMIT_TIMEOUT_MS = 30_000;

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
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
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

/**
 * Stage confirmed opportunities for dashboard approval. A 404 means the
 * backend predates suggestions, so the caller can use the legacy additions
 * flow. Other failures remain visible because this is a user-approved write.
 */
export async function submitSuggestions(
  config: WizardConfig,
  session: WizardSession,
  target: string,
  repoFingerprint: string,
  opportunities: UniverseOpportunities,
): Promise<StageResult | null> {
  const res = await fetch(`${config.apiBaseUrl}/wizard/universe/suggestions`, {
    method: "POST",
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
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
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Submitting universe suggestions failed (${res.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }
  return (await res.json()) as StageResult;
}

/** Fetch suggestions as non-fatal run enrichment. */
export async function fetchSuggestions(
  config: WizardConfig,
  session: WizardSession,
  statuses: string[],
): Promise<SuggestionRecord[]> {
  if (config.offline) return [];
  try {
    const statusQuery = statuses.map(encodeURIComponent).join(",");
    const url = `${config.apiBaseUrl}/wizard/universe/suggestions${statusQuery ? `?status=${statusQuery}` : ""}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    return Array.isArray(body) && body.every(isSuggestionRecord) ? body : [];
  } catch {
    return [];
  }
}

function isSuggestionRecord(value: unknown): value is SuggestionRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    (record.kind === "event" || record.kind === "intervention") &&
    typeof record.code === "string" &&
    (record.status === "proposed" ||
      record.status === "approved" ||
      record.status === "rejected" ||
      record.status === "integrated") &&
    typeof record.payload === "object" &&
    record.payload !== null
  );
}

/** Mark one approved suggestion integrated without ever disrupting the run. */
export async function markSuggestionIntegrated(
  config: WizardConfig,
  session: WizardSession,
  id: string,
  target: string,
  repoFingerprint: string,
): Promise<boolean> {
  if (config.offline) return false;
  try {
    const res = await fetch(
      `${config.apiBaseUrl}/wizard/universe/suggestions/${encodeURIComponent(id)}/integrated`,
      {
        method: "POST",
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify({ target, repoFingerprint }),
      },
    );
    return res.status === 200;
  } catch {
    return false;
  }
}

// --- coercion helpers (tolerant of LLM output noise) ---

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // These strings are LLM-authored and get rendered verbatim in the terminal
  // confirmation UI — strip ANSI escape sequences and flatten control
  // characters (incl. newlines, which would fake extra UI lines) so they
  // can't restyle or spoof the prompt the user approves.
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI sequences (colors, cursor moves)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "") // OSC sequences (titles, hyperlinks)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, " ") // remaining C0 controls + DEL -> space
    .replace(/ {2,}/g, " ")
    .trim();
  return cleaned ? cleaned : undefined;
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
    expectedEffect: asString(e.expectedEffect),
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
    expectedEffect: asString(i.expectedEffect),
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
