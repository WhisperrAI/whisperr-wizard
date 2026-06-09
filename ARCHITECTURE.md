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
detect stack ─▶ authenticate (browser) ─▶ load manifest ─▶ git checkpoint ─▶ agent edits ─▶ verify first event
```

1. **Detect** the repo's language/framework (Flutter, Web/JS, Next.js, React
   Native, Swift…).
2. **Authenticate** via an OAuth device flow — the browser opens, the user (who
   is already logged in from onboarding) approves, and the CLI gets a short-lived
   session token bound to their app.
3. **Load the integration manifest** from whisperr-go: the ingestion API key, the
   specific snake_case events to instrument, the interventions each event drives,
   and `identify()` guidance — all derived from the user's onboarding.
4. **Checkpoint** with git so the auto-applied edits are reversible.
5. **Run the coding agent** (Claude Agent SDK) inside the repo: add the SDK
   dependency, initialize it, wire `identify()`, and place `track()` calls at the
   correct call sites for each manifest event.
6. **Verify** by polling for the first event — the "Whisperr is receiving
   events ✓" moment, which also lights up the dashboard.

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
      web.ts            (planned)
      nextjs.ts         (planned)
      react-native.ts   (planned)
      swift.ts          (planned)
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

Default model: `claude-opus-4-8` (override with `WHISPERR_WIZARD_MODEL`, e.g.
`claude-sonnet-4-6`).

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
| `POST /wizard/llm/*` | wizard session | Anthropic-compatible gateway: injects Whisperr's real key, streams the response |

whisperr-go env to set:
- `WHISPERR_WIZARD_ANTHROPIC_API_KEY` (or `ANTHROPIC_API_KEY`) — the gateway's real key
- `WHISPERR_WIZARD_ACTIVATE_URL` — the watch approval page (default `https://app.whisperr.net/wizard/activate`)
- `WHISPERR_PUBLIC_API_BASE_URL` — base URL surfaced in the manifest for the SDK (default `https://api.whisperr.net`)
- `WHISPERR_WIZARD_LLM_UPSTREAM` — Anthropic base (default `https://api.anthropic.com`)

Run migration `0010_wizard_device_authorizations.sql` (`whisperr migrate up`).

## Still to build

- The `/wizard/activate` page in **whisperr-watch** (reuse existing Supabase
  login; show the `user_code`, let the user pick an app, POST to
  `/dashboard/wizard/approve`).
- The `@whisperr/web` SDK (then flip the web/nextjs playbooks to `available`).

## Status

- ✅ CLI: detection, playbook registry, terminal UX, agent runner, git
  checkpoint, offline demo manifest. Typechecks + builds; npx-standalone.
- ✅ whisperr-go backend: device auth, manifest (with key minting), first-event,
  LLM gateway, migration. Builds + vets clean.
- ⏳ whisperr-watch activate page.
- ⏳ `@whisperr/web` SDK (Flutter is the first live target — SDK on pub.dev).
