# Changelog

## 0.5.1

- Added private per-run JSONL diagnostics with strict secret redaction and safe lifecycle, progress, and request-correlation events.
- Added bounded request IDs and safe runtime error reporting without recording response bodies or model and repository content.
- Improved signal handling so interrupted runs finish cleanup and close diagnostics with conventional exit codes.

## 0.5.0

- Replaced the manifest-first Claude workflow with one OpenAI Agents SDK run led by Sol and supported by a read-only Terra repository explorer.
- Generated intervention groups, interventions, events, and links are persisted to runtime immediately with host-derived idempotency keys.
- Added runtime-authoritative resume, identifier-only local state, conversation fallback, heartbeat/error reporting, and invocation-scoped Git restore.
- Removed the inactive manifest, opportunity, suggestion, additions, and offline flows.
- Raised the runtime requirement to Node.js 22.

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
