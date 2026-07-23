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

The wizard is an agentic integrator with a planner/editor split:

1. **Map** — a read-only pass charts your repo: entry points, end-user vs
   admin auth flows, billing surfaces, existing analytics wrappers.
2. **Plan** — a reasoning model decides, per event, exactly where it belongs
   (`file @ anchor`) with the properties available in scope — or says
   honestly that it doesn't exist on this surface.
3. **Review the plan** — you see every placement before a single line
   changes, and pick what gets wired.
4. **Wire** — a fast editor model executes the approved plan mechanically.
5. **Verify** — placements are scanned back out of the diff, your build/lint
   command runs, and failures get one automatic repair pass. Every event ends
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

Environment knobs: `WHISPERR_WIZARD_PLANNER_MODEL`,
`WHISPERR_WIZARD_BUDGET_USD` (default 25), `WHISPERR_WIZARD_EFFORT`.

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
