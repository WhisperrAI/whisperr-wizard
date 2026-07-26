# Changelog

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
