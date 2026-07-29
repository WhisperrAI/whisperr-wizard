# @whisperr/wizard

Integrate [Whisperr](https://whisperr.net) into your app with one command.

```bash
npx @whisperr/wizard
```

Run it in your project's root. The wizard detects your stack, signs you in,
**maps your codebase, plans every event placement, shows you the plan, and
wires it in** — then verifies the build, watches for your first event, and
hands you a clean diff to review and commit.

## How it works

The wizard is an agentic integrator with task-aware hybrid routing:

1. **Survey** — Opus 5 low/fast maps the stack, feature areas, auth lifecycle,
   existing analytics, and integratable call sites into a source-free run
   artifact.
2. **Design** — a separate Opus 5 low/fast session designs and validates the
   complete event batch from that saved survey. The batch is frozen and
   registered atomically; there is no terminal event-approval prompt.
3. **Set up** — another isolated Opus 5 low/fast session installs and initializes
   the SDK, binds generated wrappers, wires `identify()` for login/restoration,
   and wires `reset()` for logout.
4. **Wire** — Terra 5.6 medium/priority runs a rolling queue of up to four
   file-isolated edit clusters, with no more than four events per cluster and
   no concurrent edits to the same file.
5. **Review** — Sol 5.6 medium/priority reviews file-isolated event placements
   for outcome timing, deduplication, payload correctness, PII safety, and
   wrapper usage, repairing only failed files.
6. **Verify** — the wizard runs the repository's available typecheck, lint, and
   build scripts. Sol gets at most two targeted repair cycles. Every event ends
   the run as `✓ wired @ file` or `○ skipped — reason`.

Multi-surface aware: run it in your web app, then your mobile app, then your
backend — the wizard knows what each surface already covers and never
re-proposes what another run wired.

## Supported stacks

Next.js · Web (JS/TS) · React Native · Flutter · Swift · Node · Python · PHP

## Requirements

- Node.js 18.17+
- A Whisperr account with onboarding completed (or use `--offline` to demo)

## Usage

```bash
# in your project root
npx @whisperr/wizard

# or point it somewhere
npx @whisperr/wizard path/to/app
```

Options:

```
--offline       Demo run with a mock manifest — no account or browser needed
--force         Proceed without a clean git tree (disables the safe undo)
--api <url>     Point at a specific Whisperr API (advanced)
--model <id>    Override the editor model (WHISPERR_WIZARD_MODEL)
-h, --help      Show help
-v, --version   Show version
```

Environment knobs: `WHISPERR_WIZARD_ENGINE_<TASK>_MODEL` (for example
`WHISPERR_WIZARD_ENGINE_DESIGN_MODEL`), `WHISPERR_WIZARD_BUDGET_USD`
(default 25), `WHISPERR_WIZARD_EFFORT`.
Set `WHISPERR_WIZARD_PRESET=claude-default` for the Opus-only rollback preset.

## Safety

- **Clean-tree contract** — the wizard requires a clean git working tree and
  gives you a one-command revert; your code is never uncommitted-mixed with
  its changes.
- **Restricted agent sandbox** — the agent cannot read secret material
  (`.env*`, keys, credentials) and can only run an allowlisted set of package
  -manager commands. Details in [SECURITY.md](./SECURITY.md).
- **Nothing merges itself** — the wizard's output is a working-tree diff for
  you to review and commit.

---

Whisperr — predict churn, automate interventions, recover revenue.
[whisperr.net](https://whisperr.net)
