import type {
  IntegrationManifest,
  OpportunityEvent,
  OpportunityIntervention,
  StageOutcome,
  StageResult,
  SuggestionRecord,
  UniverseOpportunities,
  WizardConfig,
  WizardSession,
} from "../types.js";

/**
 * Universe opportunities: while planning, the agent spots real lifecycle
 * moments (events) or messaging strategies (interventions) the
 * onboarding-generated universe misses. They come back in the planning pass's
 * JSON, get sanitized here against the manifest, and are posted to whisperr-go,
 * which owns the authoritative merge/dedupe.
 */

const exactCodePattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Match the runtime graph's exact, non-normalizing code contract. */
export function isExactCode(value: string): boolean {
  return exactCodePattern.test(value);
}

/**
 * Attach approved event-placement evidence to matching manifest events for this
 * process only. The backend manifest remains the graph contract; suggestion
 * evidence is planning context and must never be posted back as graph fields.
 */
export function enrichManifestWithApprovedSuggestions(
  manifest: IntegrationManifest,
  suggestions: SuggestionRecord[],
): IntegrationManifest {
  const evidenceByCode = new Map<
    string,
    NonNullable<IntegrationManifest["events"][number]["reviewEvidence"]>
  >();

  for (const suggestion of suggestions) {
    if (suggestion.status !== "approved" || suggestion.kind !== "event") continue;
    const payload = suggestion.payload as OpportunityEvent;
    if (payload.code !== suggestion.code) continue;

    const properties = Array.isArray(payload.properties)
      ? payload.properties.flatMap((property) => {
          if (!property || typeof property.name !== "string" || !property.name.trim()) {
            return [];
          }
          const description =
            typeof property.description === "string" && property.description.trim()
              ? property.description.trim()
              : undefined;
          return [{
            name: property.name.trim(),
            ...(description ? { description } : {}),
            ...(property.required === true ? { required: true } : {}),
          }];
        })
      : [];

    evidenceByCode.set(suggestion.code, {
      suggestionId: suggestion.id,
      ...(typeof payload.side === "string" && payload.side
        ? { side: payload.side }
        : {}),
      ...(typeof payload.rationale === "string" && payload.rationale
        ? { rationale: payload.rationale }
        : {}),
      ...(typeof payload.expectedEffect === "string" && payload.expectedEffect
        ? { expectedEffect: payload.expectedEffect }
        : {}),
      ...(typeof payload.confidence === "number" && Number.isFinite(payload.confidence)
        ? { confidence: Math.min(1, Math.max(0, payload.confidence)) }
        : {}),
      ...(properties.length ? { properties } : {}),
    });
  }

  return {
    ...manifest,
    events: manifest.events.map((event) => {
      const reviewEvidence = evidenceByCode.get(event.eventType);
      return reviewEvidence ? { ...event, reviewEvidence } : event;
    }),
  };
}

/**
 * Select approved suggestions whose instrumentation lifecycle may advance.
 * Event suggestions require proof on the current surface. Intervention
 * suggestions advance only after every required typed link in the exact
 * post-approval manifest has coverage. The manifest is authoritative because a
 * link may have been declared from either suggestion payload direction.
 */
export function suggestionsReadyToMarkIntegrated(
  suggestions: SuggestionRecord[],
  manifest: Pick<IntegrationManifest, "events">,
  integratedEventCodes: ReadonlySet<string>,
  provenEventCodes: ReadonlySet<string>,
): SuggestionRecord[] {
  const requiredEventsByIntervention = new Map<string, Set<string>>();
  for (const event of manifest.events) {
    for (const link of event.variantLinks) {
      if (link.role !== "required") continue;
      const requiredEvents =
        requiredEventsByIntervention.get(link.interventionCode) ?? new Set<string>();
      requiredEvents.add(event.eventType);
      requiredEventsByIntervention.set(link.interventionCode, requiredEvents);
    }
  }

  return suggestions.filter((suggestion) => {
    if (suggestion.status !== "approved") return false;
    if (suggestion.kind === "event") {
      return integratedEventCodes.has(suggestion.code);
    }

    const payload = suggestion.payload as OpportunityIntervention;
    if (payload.code !== suggestion.code) return false;
    const requiredEventCodes = requiredEventsByIntervention.get(suggestion.code);
    return (
      requiredEventCodes !== undefined &&
      requiredEventCodes.size > 0 &&
      [...requiredEventCodes].every((eventCode) => provenEventCodes.has(eventCode))
    );
  });
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

  const knownEvents = new Set(manifest.events.map((e) => e.eventType));
  // Interventions surface two ways: in typed variant links AND in the
  // manifest's top-level catalog, which also carries
  // link-less interventions the per-event view misses. Union both so a
  // wizard-added intervention with no links isn't re-proposed every run.
  const knownInterventions = new Set([
    ...manifest.events
      .flatMap((e) => e.variantLinks)
      .map((link) => link.interventionCode),
    ...(manifest.interventions ?? []).map((i) => i.code),
  ]);
  const knownVariants = collectKnownVariants(manifest);

  const seenEvents = new Set<string>();
  for (const entry of asArray(doc.events)) {
    const ev = coerceEvent(entry);
    if (!ev) continue;
    if (knownEvents.has(ev.code) || seenEvents.has(ev.code)) continue;
    if (ev.links) {
      ev.links = ev.links.filter((link) => {
        const variants = knownVariants.get(link.interventionCode);
        if (!variants?.size) return true;
        if (!link.variantCode) return variants.size === 1;
        return variants.has(link.variantCode);
      });
    }
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

/** Suggestion writes need real headroom, but must never hang the CLI indefinitely. */
const SUBMIT_TIMEOUT_MS = 30_000;

/**
 * Stage confirmed opportunities for dashboard approval. There is deliberately
 * no direct-additions fallback: only a human-approved graph patch may change
 * the universe.
 */
export async function submitSuggestions(
  config: WizardConfig,
  session: WizardSession,
  target: string,
  repoFingerprint: string,
  manifestPin: Pick<IntegrationManifest, "configVersionId" | "manifestRevision">,
  opportunities: UniverseOpportunities,
): Promise<StageResult> {
  const localInvalid: StageOutcome[] = [
    ...opportunities.events
      .filter((event) => !isExactCode(event.code))
      .map((event) => ({
        kind: "event" as const,
        code: event.code,
        status: "invalid" as const,
        reason: "event code must be exact lowercase snake_case",
      })),
    ...opportunities.interventions
      .filter((intervention) => !isExactCode(intervention.code))
      .map((intervention) => ({
        kind: "intervention" as const,
        code: intervention.code,
        status: "invalid" as const,
        reason: "intervention code must be exact lowercase snake_case",
      })),
  ];
  const validOpportunities: UniverseOpportunities = {
    events: opportunities.events.filter((event) => isExactCode(event.code)),
    interventions: opportunities.interventions.filter((intervention) =>
      isExactCode(intervention.code),
    ),
  };

  if (
    validOpportunities.events.length === 0 &&
    validOpportunities.interventions.length === 0
  ) {
    return {
      staged: 0,
      duplicates: 0,
      invalid: localInvalid.length,
      outcomes: localInvalid,
    };
  }

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
      configVersionId: manifestPin.configVersionId,
      manifestRevision: manifestPin.manifestRevision,
      events: validOpportunities.events,
      interventions: validOpportunities.interventions,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Submitting universe suggestions failed (${res.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }
  const result = (await res.json()) as StageResult;
  if (localInvalid.length === 0) return result;
  return {
    ...result,
    invalid: result.invalid + localInvalid.length,
    outcomes: [...localInvalid, ...result.outcomes],
  };
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

/** Codes are identity: retain the model's exact bytes and validate later. */
function asCode(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asConfidence(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function coerceEvent(entry: unknown): OpportunityEvent | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  const code = asCode(e.code);
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
    const interventionCode = asCode(l.interventionCode);
    const role = normalizeRole(asString(l.role));
    if (!interventionCode || !role) continue;
    const variantCode = asCode(l.variantCode);
    const rationale = asString(l.rationale);
    links.push({
      interventionCode,
      ...(variantCode !== undefined ? { variantCode } : {}),
      role,
      ...(rationale ? { rationale } : {}),
    });
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
  const code = asCode(i.code);
  if (!code) return null;

  const links: OpportunityIntervention["links"] = [];
  for (const link of asArray(i.links)) {
    if (typeof link !== "object" || link === null) continue;
    const l = link as Record<string, unknown>;
    const eventCode = asCode(l.eventCode);
    const role = normalizeRole(asString(l.role));
    if (!eventCode || !role) continue;
    const variantCode = asCode(l.variantCode);
    const rationale = asString(l.rationale);
    links.push({
      eventCode,
      ...(variantCode !== undefined ? { variantCode } : {}),
      role,
      ...(rationale ? { rationale } : {}),
    });
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

function normalizeRole(
  value?: string,
): "required" | "optional" | "outcome" | undefined {
  switch (value?.toLowerCase()) {
    case "required":
      return "required";
    case "optional":
      return "optional";
    case "outcome":
      return "outcome";
    default:
      return undefined;
  }
}

function collectKnownVariants(
  manifest: IntegrationManifest,
): Map<string, Set<string>> {
  const variants = new Map<string, Set<string>>();
  const add = (interventionCode: string, variantCode: string) => {
    if (!interventionCode || !variantCode) return;
    const bucket = variants.get(interventionCode) ?? new Set<string>();
    bucket.add(variantCode);
    variants.set(interventionCode, bucket);
  };
  for (const intervention of manifest.interventions ?? []) {
    for (const variant of intervention.variants ?? []) {
      add(intervention.code, variant.code);
    }
  }
  for (const event of manifest.events) {
    for (const link of event.variantLinks) {
      add(link.interventionCode, link.variantCode);
    }
  }
  return variants;
}
