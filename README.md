# @whisperr/wizard

Generate and integrate a Whisperr intervention model from your actual codebase.

```bash
npx @whisperr/wizard
```

Run the command in the customer-facing frontend first. The wizard detects the stack, authenticates the app, inspects concrete product behavior, writes the generated model to Whisperr as it works, installs the SDK, and instruments the generated events.

## How It Works

1. A read-only Terra agent maps repository structure, end-user paths, and concrete event call sites.
2. The Sol primary creates only intervention groups, interventions, events, and direct intervention-event links.
3. Each accepted item is written to runtime immediately with a stable idempotency key, so the dashboard can show live progress.
4. Sol installs and configures the stack-specific SDK, then instruments events owned by this project.
5. The host runs the stack's deterministic build or lint verifier when one is defined, before runtime accepts completion.
6. An interrupted run resumes from the runtime snapshot and its OpenAI conversation. Missing conversations restart from the same server snapshot without duplicating rows.

For split repositories, finish the frontend run before running the wizard in backend repositories. A full-stack repository is one project.

## Supported Stacks

Next.js, Web (JavaScript/TypeScript), React Native, Flutter, Swift, Node, Python, and PHP.

## Requirements

- Node.js 22+
- A completed Whisperr onboarding session
- A Git repository with a clean working tree for a new run

An incomplete run may resume with its existing wizard edits still in the working tree. `--force` permits other uncommitted changes; invocation-scoped restore preserves the state that existed before that invocation.

## Usage

```bash
npx @whisperr/wizard
npx @whisperr/wizard path/to/app
```

Options:

```text
--force         Proceed without a clean Git tree
--api <url>     Override the Whisperr API base URL
--model <id>    Override the primary Sol model
-h, --help      Show help
-v, --version   Show version
```

Model defaults are `gpt-5.6-sol` with `high` reasoning and the `priority` service tier, plus `gpt-5.6-terra` with `xhigh` reasoning for read-only exploration.

Development overrides:

- `WHISPERR_WIZARD_API_BASE`
- `WHISPERR_WIZARD_OPENAI_BASE`
- `WHISPERR_WIZARD_PRIMARY_MODEL`
- `WHISPERR_WIZARD_PRIMARY_EFFORT`
- `WHISPERR_WIZARD_SERVICE_TIER`
- `WHISPERR_WIZARD_EXPLORER_MODEL`
- `WHISPERR_WIZARD_EXPLORER_EFFORT`
- `WHISPERR_WIZARD_DIRECT_OPENAI_KEY` or `OPENAI_API_KEY`

## Safety

- Repository tools are host-owned and restricted to the selected repository.
- Secret files are blocked. The host writes ingestion credentials only to local environment files and redacts them from model-visible reads and command output.
- Terra receives only read, list, and search tools.
- Repository commands use parsed arguments without a shell and are limited to approved SDK package installation plus metadata-only Git commands.
- Git and CI configuration writes are blocked.
- The wizard never commits or pushes changes.

See [SECURITY.md](./SECURITY.md) for the complete boundary and residual risks.
