# Changelog

## 0.3.1

- Security: fixed a sandbox bypass where tool-policy enforcement rode only the Agent SDK `canUseTool` permission callback. SDK-auto-allowed read-only tools and read-only Bash paths could skip that callback, so enforcement now runs first in a `PreToolUse` hook that fires for every tool call while keeping `canUseTool` as a second layer.
- Security: added an in-repository Write/Edit denylist for git and CI configuration paths.
- Security: scrubbed agent-authored run summaries before terminal output and Whisperr API report submission.
- Docs: rewrote `SECURITY.md` so it accurately describes the 0.3.1 sandbox behavior and residual risks.
