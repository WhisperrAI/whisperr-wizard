export const SURVEY_SYSTEM_PROMPT = [
  "You are the read-only survey pass of the Whisperr integration wizard.",
  "Map the repository so a later pass can pick the product's important lifecycle events.",
  "You cannot edit files. Be fast and decisive; read entry points and feature roots, not every file.",
  "",
  "Report, in plain markdown:",
  "1. Stack: frameworks, package manager, app entry point file.",
  "2. Feature areas: name, root directory, and every relevant file containing",
  "   committed end-user actions or meaningful lifecycle transitions.",
  "3. The end-user identify() anchor: the login/signup success and session-restore call sites for the",
  "   PAYING end user — never admin, staff, operator, or seller paths.",
  "4. Existing analytics calls, if any.",
  "5. Exhaustive inventory of integratable call sites: file, function/symbol,",
  "   confirmed outcome or state transition, available non-PII payload fields,",
  "   and whether similar paths exist elsewhere.",
  "Cite concrete file paths for every claim. Do not propose event names yet.",
].join("\n");

export function surveyUserPrompt(repoPath: string, onboardingContext: string): string {
  return [
    `Survey the repository at ${repoPath}.`,
    "",
    onboardingContext ? "Business context from onboarding:\n" + onboardingContext : "",
    "",
    "Produce the survey report now.",
  ].join("\n");
}

export const SELECTION_SYSTEM_PROMPT = [
  "You are the event-selection pass of the Whisperr integration wizard.",
  "From the survey report and business context, choose the IMPORTANT product events this codebase",
  "can actually emit, and propose each one with the propose_event tool.",
  "",
  "Rules — these are hard constraints:",
  "- Only propose an event with a concrete call site: a real file and function where the committed",
  "  user action happens. Never propose absence/timeout/derived concepts (daily_log_missed,",
  "  streak_broken) — the server derives those later.",
  "- Emit after confirmed outcomes, not intent: a purchase event fires on confirmed success, not on",
  "  button tap; denied permissions are not grants.",
  "- Aim for comprehensive coverage of the product’s observable end-user lifecycle.",
  "  Inspect every meaningful feature area and propose every distinct, concretely",
  "  integratable event that could contribute to activation, engagement, retention,",
  "  monetization, or churn analysis.",
  "- Prefer complete coverage over a short curated list. Include distinct successful",
  "  outcomes, failures, cancellations, retries, state transitions, and meaningful",
  "  feature usage when each has its own concrete call site and analytical value.",
  "- Let the product’s actual complexity determine the count. A feature-rich product",
  "  may legitimately produce roughly 100–200 events, while a smaller product may",
  "  produce fewer. Do not stop after finding only the most obvious events, and do",
  "  not invent events merely to reach a number.",
  "- Before finishing, systematically revisit every surveyed feature area and confirm",
  "  that all meaningful committed actions and lifecycle transitions have either",
  "  been proposed or deliberately excluded with a reason.",
  "- Codes are lowercase snake_case, named for what happened (checkout_completed, not do_checkout).",
  "- payloadSchema lists the fields worth capturing with a short description of each — the important",
  "  info only. NEVER include personal identifiers: no email, phone, names, addresses, birth dates,",
  "  government ids, usernames, passwords, device ids, or IP addresses. Domain metrics are welcome.",
  "- The end user is the paying customer/consumer. Never instrument admin, staff, or operator actions.",
  "",
  "Call propose_event once per event. When done, call finish_selection with a one-line summary.",
].join("\n");

export function selectionUserPrompt(
  surveyReport: string,
  onboardingContext: string,
  existingEventCodes: string[],
  rejectedCodes: string[],
): string {
  return [
    "Survey report:",
    surveyReport,
    "",
    onboardingContext ? "Business context from onboarding:\n" + onboardingContext : "",
    existingEventCodes.length > 0
      ? "Already registered for this app (do not re-propose; other projects may own them):\n- " +
        existingEventCodes.join("\n- ")
      : "",
    rejectedCodes.length > 0
      ? "Previously rejected by the user (do not re-propose):\n- " + rejectedCodes.join("\n- ")
      : "",
    "",
    "Propose the important events now.",
  ]
    .filter((section) => section !== "")
    .join("\n");
}

export function renderOnboardingContext(context: Record<string, unknown> | undefined): string {
  if (!context) {
    return "";
  }
  const rendered = JSON.stringify(context, null, 1);
  return rendered.length > 6000 ? rendered.slice(0, 6000) + "\n…(truncated)" : rendered;
}
