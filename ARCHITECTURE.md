# Whisperr Wizard Architecture

The wizard is one Sol-led generation and integration workflow. Runtime is authoritative for the generated model and run lifecycle; the customer repository is authoritative for instrumentation code.

## Flow

```text
detect stack
  -> device auth
  -> create or resume runtime run
  -> Git invocation snapshot
  -> Sol workflow with read-only Terra exploration
  -> realtime runtime item writes and repository edits
  -> deterministic verification
  -> runtime completion
  -> coverage report and first-event check
```

`POST /wizard/runs` returns app context, project identity, the run, the current generated model, and ingestion credentials. The old manifest, opportunity, suggestion, and additions flows are not part of the active or compatibility path.

## Agent Topology

The OpenAI Agents SDK runs two configured agents:

- Sol: `gpt-5.6-sol`, `high` reasoning, `priority` service tier. It owns taxonomy, runtime writes, repository edits, and completion.
- Terra: `gpt-5.6-terra`, `xhigh` reasoning. It is exposed to Sol as `explore_repository` and receives read, list, and search tools only.

The generation prompt is independent of legacy universe prompts. It defines four concepts, evidence requirements, anti-inflation constraints, frontend-first ownership, and completion criteria. SDK playbooks add factual installation and API guidance only.

## Host-Owned Tools

Runtime tools:

- `create_intervention_group`
- `create_intervention`
- `create_event`
- `create_link`
- `update_progress`
- `complete_run`

Every item call carries a stable `idempotencyKey` and is sent immediately to `POST /wizard/runs/{runId}/items`. Runtime returns the canonical row.

Repository tools:

- Read, bounded list, and literal search
- Exact replacement and new-file creation
- Host-owned ingestion environment configuration
- Allowlisted package-manager and read-only Git commands

`complete_run` invokes the playbook's deterministic verifier, when defined, before calling runtime completion. A real verification failure is returned to Sol for a focused repair in the same workflow.

## Resume

Runtime owns run status, phase, heartbeat, generated rows, and the model conversation ID. Local state stores only `runId` and `conversationId` in a mode-0600 file under the user state directory, keyed by API base, app ID, and repository fingerprint.

Startup prefers a matching local incomplete run and otherwise lets `POST /wizard/runs` select the latest matching run. If OpenAI conversation state is missing, the wizard creates a new conversation and prompts Sol with the current runtime snapshot. Idempotent item writes prevent duplicates.

Before each invocation, the wizard snapshots existing working-tree changes. Restoring a failed resumed invocation returns to that snapshot instead of resetting earlier wizard work.

## Runtime Contract

All routes use the wizard session bearer:

| Endpoint | Purpose |
|---|---|
| `POST /wizard/runs` | Create or resume a project run and return its full snapshot |
| `GET /wizard/runs/{runId}` | Fetch the authoritative resume snapshot |
| `PATCH /wizard/runs/{runId}` | Update status, monotonic phase, activity message, model conversation, or scrubbed error; every patch refreshes the heartbeat |
| `POST /wizard/runs/{runId}/items` | Idempotently persist one generated item |
| `POST /wizard/runs/{runId}/complete` | Validate and complete the graph |
| `POST /wizard/openai/v1/*` | OpenAI-compatible Sol/Terra gateway |

Coverage reporting and first-event polling remain best-effort post-completion operations.

## Source Map

```text
src/
  index.ts                 argument parsing and executable entry
  cli.ts                   terminal flow, Git safety, heartbeat, and signals
  types.ts                 stack, session, and model configuration contracts
  core/
    agent.ts               Agents SDK provider, Sol/Terra topology, resume fallback
    agentTools.ts          realtime runtime tools and host verification
    generationPrompt.ts    fresh model semantics and workflow prompt
    runtime.ts             wizard run HTTP client and contracts
    workflow.ts            run selection and project classification
    resumeState.ts         external identifier-only local state
    repositoryTools.ts     bounded host filesystem and command tools
    toolPolicy.ts          path, secret, command, Git, and CI policy
    git.ts                 checkpoints, invocation snapshots, diff scanning
    postflight.ts          deterministic verifier
    playbooks/             stack detectors and factual SDK guidance
```
