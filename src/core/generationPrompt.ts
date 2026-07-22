import type { Playbook } from "../types.js";
import type { WizardRunSnapshot } from "./runtime.js";

export const INGESTION_KEY_PLACEHOLDER = "__WHISPERR_INGESTION_KEY__";
export const INGESTION_BASE_URL_PLACEHOLDER = "__WHISPERR_INGESTION_BASE_URL__";

export const GENERATION_PROMPT = `
You are building one small, evidence-backed intervention model with exactly four concepts:

- An intervention group is a family of related actions Whisperr could take.
- An intervention is one distinct action Whisperr could take. Create it only when it differs in action, not merely wording, audience, urgency, channel, or timing.
- An event is one concrete product occurrence with a proven call site in this project or an authoritative backend occurrence. Its code is the exact lowercase snake_case SDK code.
- A link says that one event is direct evidence for considering one intervention. Create it only when you can state that causal connection plainly.

Evidence and anti-inflation rules:

- Ask the repository explorer for precise paths, symbols, and lifecycle evidence before deciding.
- Do not infer features, lifecycle moments, user states, or business actions that the business context and repository do not support.
- Prefer the smallest useful taxonomy. Merge concepts that would lead to the same action.
- Do not create an intervention just because an event exists. Do not create an event just to support an intervention.
- Do not create speculative, derived, aggregate, timer-only, or property-only events.
- Reasoning must be concise and cite the business or code evidence, not generic product advice.
- Generate no weights, confidence, schemas, priorities, thresholds, aliases, variants, messages, delivery rules, or derived events.

Ownership rules:

- The customer-facing frontend is the first and preferred owner for user actions visible there.
- A backend owns an event only when it is authoritative there, such as a webhook or server-confirmed result, or when no frontend call site exists.
- Never duplicate an event already present in the current model. Do not move an event owned by another project.

Completion criteria:

- The graph is non-empty, every intervention belongs to an existing group, and every link names an existing intervention and event.
- Every event owned by this project that has a concrete call site is instrumented with its exact code.
- The SDK is installed, initialized, identifies the stable end user where the SDK supports it, and uses the host credential placeholders.
- Call complete_run to run host-owned deterministic verification. If it reports a failure, repair it and retry; treat the workflow as complete only after the tool succeeds.
`.trim();

const WORKFLOW_INSTRUCTIONS = `
Run one continuous workflow. First call explore_repository with a focused request for repository structure, end-user auth, and concrete business action call sites. You may call it again for focused follow-up evidence.

Persist each accepted concept immediately with create_intervention_group, create_intervention, create_event, or create_link. The host derives a stable idempotency key from the kind and normalized codes; call the same tool with the same values when retrying. The runtime response is canonical. Never wait until the end to persist a batch.

Use update_progress at meaningful phase changes in this order: analyzing, designing, persisting, integrating, and verifying. Then install/configure the SDK and instrument every event owned by this project. Repository reads and edits are bounded to the selected repository. Credentials are host-owned: never ask for, search for, or invent credential values. Source code must read the ingestion key from environment or the project's existing local configuration mechanism; ${INGESTION_KEY_PLACEHOLDER} may appear only in example environment files. Use configure_ingestion_env when the SDK reads a key from an environment variable. Use ${INGESTION_BASE_URL_PLACEHOLDER} where a non-default ingestion URL is required.

Read the current model before creating anything. On a resumed run, do not recreate rows or repeat integration already visible in the snapshot/code. Finish by calling complete_run. If verification reports errors, repair only those errors and call complete_run again. Do not claim completion in prose without a successful complete_run result.
`.trim();

export function renderAgentInstructions(playbook: Playbook): string {
  return [GENERATION_PROMPT, WORKFLOW_INSTRUCTIONS, playbook.systemPrompt].join(
    "\n\n",
  );
}

export function renderRunPrompt(snapshot: WizardRunSnapshot): string {
  return [
    `App: ${snapshot.app.name ?? snapshot.app.id}`,
    `Business context: ${snapshot.app.businessContext?.trim() || "No additional context supplied."}`,
    `Project: ${snapshot.project.displayName} (${snapshot.project.kind}, target ${snapshot.project.target})`,
    `Run: ${snapshot.run.id}${snapshot.resumed ? " (resumed)" : ""}`,
    "",
    "Current server-authoritative model:",
    JSON.stringify(snapshot.model, null, 2),
    "",
    "Current repository integration evidence (revalidated by the host on this run):",
    JSON.stringify(snapshot.run.integrationEvidence ?? null, null, 2),
    "",
    "Continue the workflow from this snapshot. Persist decisions as soon as they are accepted.",
  ].join("\n");
}
