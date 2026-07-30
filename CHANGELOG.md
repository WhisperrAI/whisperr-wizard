# Changelog

## 0.10.0

- Give each phase one fixed model owner: a single Opus 5 low/fast conversation
  surveys and designs, Sol medium/priority owns SDK setup, Terra
  medium/priority owns all event insertion, and a separate Sol
  medium/priority conversation owns semantic and verification repair.
- Run SDK setup beside event design after the saved survey, remove wizard
  turn/time/output/spend quotas and model fallbacks, retry transient failures
  with the same owner, and compact or roll context without switching models.
- Serialize complete per-file event work through one Terra conversation, retain
  deterministic validation and final verification, and support non-Git
  repositories through isolated temporary snapshots.
- Persist a lightweight placement manifest and send task/session metadata on
  every model call so the runtime can retain encrypted prompts, exposed
  reasoning, responses, and terminal outcomes.

## 0.8.0

- Make the hybrid router the default: Terra medium with priority processing
  surveys and file-isolated event clusters, while Opus 5 medium with fast mode
  designs events, initializes the SDK, reviews changes, and repairs failures.
- Run four independent Terra clusters concurrently with same-file
  serialization, serial patch merging, per-event server checkpoints, and
  automatic clean rollback plus Opus escalation for incomplete or invalid
  Terra work.
- Batch event design for large universes, replace per-cluster full builds with
  structural checks, and run one final verification followed by targeted Opus
  repair.
- Preserve exact resumable progress across task limits and interruptions,
  improve nested gateway error reporting, and retain `claude-default` as the
  emergency Opus-only preset.

## 0.7.3

- Run every default Wizard engine role on Claude Opus 5 with Anthropic fast
  mode enabled.
- Expand surveying and event selection to cover the complete observable
  end-user lifecycle across every meaningful product area.
- Apply the shared secret-material policy to OpenAI file tools and block reads
  or writes of environment, credential, and service-account files.

## 0.7.2

- Allow only the exact engine MCP tools for the current invocation through the
  tool-policy hooks and permission callback (no `mcp__engine__*` prefix allow).
- Require a successful `finish_selection` before design can proceed; stream
  completion alone is no longer treated as a finished selection.
- Fail clearly during design when selection never finishes or no events are
  accepted, and never POST `/wizard/runs/:id/complete` with an empty design.

## 0.7.1

- Accept both nested and legacy flattened wizard-run snapshots, with clear
  validation errors for malformed runtime responses.
- Fall back to a secure temporary run-state directory when the configured or
  home directory cannot be created.
- Mark runs failed when survey, design, state persistence, or completion fails,
  instead of leaving the dashboard indefinitely stuck on an active phase.

## 0.7.0

- **Engine v2 for wizard-mode apps.** Whisperr apps onboarded in wizard mode get
  the new flow: a read-only survey, event selection you review in the terminal
  before anything is registered, typed event bindings with a queue-until-ready
  adapter, and worktree-isolated instrumentation applied atomically at the end.
- **Cluster-bounded integration.** Events are wired in small file clusters with
  fresh model context, per-cluster verification and review, and honest statuses;
  a context overflow fails one cluster as resumable instead of killing the run.
- **Resumable by design.** Interrupt at any point and rerun: registered events,
  cluster progress, and provider sessions are reconciled from the server and a
  local state file — nothing is redone, nothing duplicates.
- **Provider presets.** `WHISPERR_WIZARD_PRESET=sol-design` routes survey,
  selection, and review through gpt-5.6-sol via the server-side OpenAI gateway;
  edits stay on Claude. Default remains all-Claude.
- **Automatic fallback.** Generated-mode apps get the unchanged 0.6 flow — the
  server decides per app, the command stays `npx @whisperr/wizard`.
- Mock eval harness under `evals/` (`npm run eval:mock`) gates engine changes.

## 0.6.0

- **One run, no interruptions.** The placement plan is printed and the run keeps
  going instead of stopping to ask. `--review-plan` restores the confirmation
  step for a repo you want to watch closely.
- **Proposals go into your universe and get wired in the same run.** What the
  agent spots beyond your onboarding plan is added directly (server-side dedupe;
  new interventions still start paused and a live policy still only gets a
  review draft). `--propose-only` restores staging for dashboard approval.
- **One planning pass instead of three reads.** Repo map, event placements, and
  proposals now come out of a single read-only pass on `claude-opus-5` at high
  effort — one fewer model session per run, and the plan is made before any edit.
- **The manifest finally carries your business context.** whisperr-go now sends
  the onboarding-derived picture of the product — who the paying end user is,
  how it charges, what churn looks like — which is what keeps `identify()` off
  the admin login and grounds every proposal.
- Runs report much more: models used, reasoning effort, per-phase timings, how
  the run ended, opportunity counts, and the agent's own reason for each skipped
  event. Failed and reverted runs now report too, instead of going dark.
- The self-review pass is cheaper (editor model, `git diff` only) and still runs
  on every integration; `--strict-review` promotes it to the planner model.

## 0.4.0

- Opportunities now stage for **dashboard approval** instead of merging from
  the terminal: the multiselect consent sends proposals to your Whisperr
  dashboard's Approvals queue, and the next wizard run wires whatever gets
  approved (and marks it integrated). Backends without the suggestions API
  fall back to the previous immediate-merge flow.
- Proposals carry a new `expectedEffect` line (what improves if adopted),
  rendered on the dashboard approval cards.
- After staging, the CLI prints how many proposals were sent and the direct
  approvals-queue link; blocked re-proposes of recently rejected items show
  the reviewer's decision note.
- Device auth always prints the verification URL + code, so SSH/headless
  users can approve from any device (the browser open stays best-effort).
- Sessions survive long runs: the server now slides the session window on
  activity, and the CLI keeps it alive while you sit on interactive prompts.
- Discovery digs deeper: the review pass now sweeps your product's whole
  lifecycle (auth, billing, engagement, support, expiry) instead of noticing
  gaps incidentally — and verifies each proposal against the actual code
  before suggesting it.
- New end-of-run "What you could be doing" report: strategy plays blocked by
  missing product features are framed as opportunities, with the honest
  reason each signal isn't flowing yet.

## 0.3.1

- Security: fixed a sandbox bypass where tool-policy enforcement rode only the Agent SDK `canUseTool` permission callback. SDK-auto-allowed read-only tools and read-only Bash paths could skip that callback, so enforcement now runs first in a `PreToolUse` hook that fires for every tool call while keeping `canUseTool` as a second layer.
- Security: added an in-repository Write/Edit denylist for git and CI configuration paths.
- Security: scrubbed agent-authored run summaries before terminal output and Whisperr API report submission.
- Docs: rewrote `SECURITY.md` so it accurately describes the 0.3.1 sandbox behavior and residual risks.
