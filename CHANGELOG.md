# Changelog

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

## 0.3.1

- Security: fixed a sandbox bypass where tool-policy enforcement rode only the Agent SDK `canUseTool` permission callback. SDK-auto-allowed read-only tools and read-only Bash paths could skip that callback, so enforcement now runs first in a `PreToolUse` hook that fires for every tool call while keeping `canUseTool` as a second layer.
- Security: added an in-repository Write/Edit denylist for git and CI configuration paths.
- Security: scrubbed agent-authored run summaries before terminal output and Whisperr API report submission.
- Docs: rewrote `SECURITY.md` so it accurately describes the 0.3.1 sandbox behavior and residual risks.
