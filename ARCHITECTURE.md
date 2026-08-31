# Whisperr Wizard

> One command to integrate Whisperr into any app. The user pastes a command,
> authenticates with their onboarded account, and an AI coding agent wires up
> `identify()` and the exact business events Whisperr needs — then they push and
> deploy. Inspired by the PostHog wizard, but onboarding-aware.

Run it in your project root. No install, no setup — `npx` fetches the wizard and
its dependencies (including the coding-agent runtime) and runs it from the
current directory. The only thing you do is authenticate.

```bash
cd your-app
npx @whisperr/wizard
```

## What it does (the flow)

```
detect ─▶ authenticate ─▶ manifest ─▶ checkpoint ─▶ plan ─▶ install ─▶ wire ─▶ review ─▶ verify ─▶ report
```

1. **Detect** the repo's language/framework (Flutter, Web/JS, Next.js, React
   Native, Swift…).
2. **Authenticate** via an OAuth device flow — the browser opens, the user (who
   is already logged in from onboarding) approves, and the CLI gets a short-lived
   session token bound to their app.
3. **Load the integration manifest** from whisperr-go: the ingestion API key, the
   specific snake_case events to instrument, the interventions each event drives,
   `identify()` guidance, and the **business context** from onboarding (who the
   paying end user is, how the product charges, what churn looks like here).
4. **Checkpoint** with git so the auto-applied edits are reversible.
5. **Plan** in one read-only pass on the planner model: map the repo, decide
   where each event belongs, and note what the onboarding plan is missing. The
   plan is printed; `--review-plan` turns it into a confirmation step.
6. **Add** what the planner proposed to the app's universe (`--propose-only`
   stages it for dashboard approval instead), so accepted events get wired in
   this same run rather than the next one.
7. **Install & wire** on the editor model: add the SDK, initialize it, wire
   `identify()`, then place every planned `track()` call — manifest events and
   newly added ones in a single pass.
8. **Review** the resulting `git diff` and fix wrong subjects, wrong lifecycle
   moments, and missing discriminators. `--strict-review` runs this deeper.
9. **Verify** by running the playbook's build/lint command ourselves, then
   polling for the first event — the "Whisperr is receiving events ✓" moment.
10. **Report** the run to `POST /wizard/report`: per-event coverage with skip
    reasons, phase timings, models, and how the run ended.

## Why it's better than a generic wizard

Whisperr already knows **what the app needs to track** (from onboarding), so the
agent doesn't just install a snippet — it instruments the *specific named events*
that drive this customer's churn interventions, at the right places in their code.

## Architecture (SDK-agnostic)

The core is dumb about any specific SDK. All SDK knowledge lives in **playbooks**
(`src/core/playbooks/`). Each playbook carries:

- a `detect()` function (how to recognize the stack),
- the package reference,
- an SDK-specific **system prompt** (the best-practice integration guide), and
- an optional verify command.

**Adding a new SDK = adding one playbook file** and registering it in
`playbooks/index.ts`. Nothing else changes.

```
src/
  index.ts              CLI entry + arg parsing
  cli.ts                orchestration + terminal UX (@clack/prompts)
  types.ts              shared contracts
  ui/                   theme + banner (signal-blue, tasteful)
  core/
    config.ts           env/flag resolution
    detect.ts           runs all playbook detectors
    auth.ts             device-authorization flow (+ offline stub)
    manifest.ts         fetch integration manifest (+ mock)
    agent.ts            Claude Agent SDK runner (file edits)
    git.ts              checkpoint + diff + revert hint
    verify.ts           first-event activation poll
    playbooks/          ← the only SDK-aware code
      shared-prompt.ts  base wizard prompt + manifest renderer
      flutter.ts        (available)
      web.ts            (available)
      nextjs.ts         (available)
      node.ts           (available)
      python.ts         (available)
      php.ts            (available)
      react-native.ts   (available)
      swift.ts          (available)
```

## Model & auth

The agent runs on Claude via the **Claude Agent SDK**. The CLI **never ships an
Anthropic key**:

- **Production:** the SDK is pointed at Whisperr's Anthropic-compatible gateway
  via `ANTHROPIC_BASE_URL`, with the wizard session token as
  `ANTHROPIC_AUTH_TOKEN`. The gateway injects the real key server-side and meters
  usage per app.
- **Local dev:** set `WHISPERR_WIZARD_DIRECT_ANTHROPIC_KEY` (or `ANTHROPIC_API_KEY`)
  and run `--offline` to exercise the whole flow against a real model + a mock
  manifest, with no backend.

The default preset routes by task:

- **Terra medium + priority** — repository survey and first-pass cluster edits
  (four concurrent file-isolated clusters, at most four events each).
- **Opus 5 medium + fast mode** — event design, SDK setup, review, final repair,
  and any clean retry after a Terra failure (at most two concurrent tasks).

Cluster patches merge serially and progress is checkpointed per event. The
wizard runs structural checks inside each cluster worktree, one full verifier
after merging, and an Opus repair pass only when that final verifier fails.
`WHISPERR_WIZARD_PRESET=claude-default` retains the Opus-only rollback path.

## Contributing / local dev

Only needed if you're working **on** the wizard (not using it). End users just
run `npx @whisperr/wizard`.

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...        # local dev only
npm run dev:local -- --offline ../some-flutter-app
```

`--offline` uses a demo manifest (trial_started, feature_activated,
payment_failed, subscription_cancelled) so you can watch the agent integrate a
real repo end-to-end without the backend.

To publish: `npm publish` (the package is scoped `@whisperr` with restricted
access; `prepublishOnly` runs the build). Once published, `npx @whisperr/wizard`
works for anyone with access.

## Backend (whisperr-go — IMPLEMENTED)

The wizard talks to these endpoints on the runtime API (default
`https://api.whisperr.net`), all implemented in `whisperr-go/internal/wizard/`:

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /wizard/device/authorize` | public | Start device flow → `device_code`, `user_code`, `verification_uri` |
| `POST /wizard/device/token` | public (polled) | → `{ token, app_id, expires_at }` once approved (`428` while pending) |
| `POST /dashboard/wizard/approve` | Supabase JWT | The whisperr-watch approval page binds a `user_code` to the user's app |
| `GET /wizard/manifest` | wizard session | → `IntegrationManifest`: **mints the ingestion key** + events + interventions + identify |
| `GET /wizard/first-event` | wizard session | → `{ received, event_type? }` for the activation poll |
| `POST /wizard/report` | wizard session | Coverage ledger: per-event wired/skipped status for this surface |
| `POST /wizard/universe/additions` | wizard session | Append user-confirmed opportunity events/interventions to the app's active universe (server-side dedupe; new interventions start paused) |
| `POST /wizard/llm/*` | wizard session | Anthropic-compatible gateway: injects Whisperr's real key, streams the response |

whisperr-go env to set:
- `WHISPERR_WIZARD_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`) — the gateway's real key
- `WHISPERR_WIZARD_ACTIVATE_URL` — the watch approval page (default `https://app.whisperr.net/wizard/activate`)
- `WHISPERR_PUBLIC_API_BASE_URL` — base URL surfaced in the manifest for the SDK (default `https://api.whisperr.net`)
- `WHISPERR_WIZARD_LLM_UPSTREAM` — Anthropic base (default `https://api.anthropic.com`)

Run migration `0010_wizard_device_authorizations.sql` (`whisperr migrate up`).

## Status

- ✅ CLI: detection, playbook registry, terminal UX, single-pass planner, agent
  runner, git checkpoint, run reporting, offline demo manifest.
- ✅ whisperr-go backend: device auth, manifest (key minting + business
  context), first-event, universe additions/suggestions, run ledger with
  telemetry, LLM gateway.
- ✅ whisperr-watch activate page; backoffice wizard-run view.
- ⏳ `@whisperr/web` SDK (Flutter is the first live target — SDK on pub.dev).
