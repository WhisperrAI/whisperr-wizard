# Wizard recovery roadmap

> Written after the Zwaeg run (v0.6.0, `5550b01`) and two independent post-mortems.
> Every claim below was re-verified against the code at that commit — plus
> `whisperr-go`, `whisperr-swift`, `whisperr-flutter`, `whisperr-react-native`,
> and `whisperr-spec` — before it was allowed into this plan. Where the
> post-mortems were wrong or out of date, this document says so.

## 1. What is actually broken (verified)

Six root causes. Two live outside this repo.

### RC1 — One long conversation instead of a pipeline

The wiring phase is a single `query()` carrying every planned event across
every file: `maxTurns: 200`, `budgetUsd: 25` (`src/core/config.ts`), one
monotonically growing context (`runTimedPass("Instrumenting planned events", …)`
in `src/core/agent.ts`). Compaction is off (`settingSources: []`). On Zwaeg
this hit the context limit at ~34 minutes and the API returned 400.

Also verified: plan parsing is all-or-nothing — `coerceEventPlan` returns
`null` if **any** entry is malformed, which throws away the entire plan and
falls back to `runDirectEventsPass`, a full re-explore of the repo.

### RC2 — Any throw discards the entire run

`runPass` only swallows turn/budget stops (`isLimitStop`, `src/core/agent.ts`);
anything else rethrows → `cli.ts` `.catch(() => null)` → review, reconcile,
and per-event reporting are skipped. `collectReportEvents` begins with
`if (!outcome) return []`, so the crashed run — the one most worth seeing —
reports **zero events and $0 cost** even though the diff scan is deterministic
and the spend was real. `maybeRevert` then offers to delete all landed work
with `initialValue: true` (default **Yes**).

Ordering bug on top: universe additions are submitted after core but **before**
wiring/review/verify (`agent.ts`, the `onOpportunitiesReady` call). A git
revert does not undo them; nothing rolls them back. Zwaeg's universe was
permanently mutated by a failed run.

There is no `--resume`, no run-state file, no `--dry-run`, no `--json`
(`src/index.ts` parses exactly seven flags).

### RC3 — "Verified" is a lie on 7 of 8 playbooks

Only `flutter.ts` sets `verifyCommand`. Swift/web/node/python/php/RN/Next.js
have none, so the entire verify+repair block in `cli.ts` is skipped, while the
Swift playbook actively instructs *"Do not run xcodebuild, swift build, or
tests"* — three sections after warning that the `JSONValue` wrapper is "the #1
compile error". `ARCHITECTURE.md` step 9 advertises verification as a standard
step. Acceptance is `scanWiredEvents` (`src/core/git.ts`): a regex over changed
files whose fallback counts **any quoted event literal** — a comment or TODO
satisfies "wired".

### RC4 — There is no privacy layer, anywhere

Zero occurrences of PII/privacy/consent/minimization language in this repo, in
the playbooks, or in the manifest contract (grep-verified across all whisperr
repos). `BASE_WIZARD_PROMPT`'s "PROPERTY CAPTURE (this is the craft)" section
instructs maximal capture.

It is worse than the post-mortems said: the production manifest carries **no
per-event properties at all** — `whisperr-go`'s `ManifestEvent` has no
properties field, and `ManifestProperty` is documented "never emitted as part
of an active universe event contract" (`internal/wizard/types.go`). Only the
offline mock manifest has properties. So "populate every listed property" binds
to nothing; on real runs the model **improvises** property capture from
whatever is in scope. On a Swiss nutrition app that produced weight, height,
age, sex, food logs, search queries, and HealthKit state — against a README
promising on-device data.

### RC5 — The SDK contract makes correct integration nearly impossible

Verified in `whisperr-swift`: `Whisperr.shared` is `nil` until `initialize()`'s
`await client.start()` completes, so every generated call stacks three silent
failure modes (`Task { try? await Whisperr.shared?.track(…) }`), and `track()`
throws `missingUserID` until `identify()` runs (`WhisperrClient.swift:238-240`).
The Swift playbook consequently instructs the agent to **skip pre-auth
events** — the acquisition funnel. `whisperr-flutter` has the same contract
(`track() requires a user: call identify() first`).

**Correction to post-mortem 1:** this is *not* unreachable-without-ingestion-work.
`whisperr-react-native` already implements the fix client-side: events enqueue
with `externalUserId: null`, are held non-sendable, and `backfillIdentity()`
attributes them on identify — plus a persisted `anon_` id. Porting that pattern
to Swift/Flutter closes the pre-auth gap with **no server-side alias work**.
(Real-time pre-identify ingestion via server-side alias remains a later,
separate feature.)

### RC6 — The universe generator can emit unwireable events; the wizard can't push back

The wizard-side filtering is correct: `filterEventsBySide`
(`whisperr-go/internal/wizard/handler.go`) honors `suggested_wireable_on`.
The garbage was upstream: Zwaeg's universe contained absence-shaped events
(`daily_log_missed`, `tracking_streak_broken`, …) marked raw + frontend-wireable,
so 85 "wireable" events was the wrong denominator, and 42/85 was the wrong
score.

**Both post-mortems are out of date here.** Universe generation moved to the
v2 semantic graph (`internal/universegraph`, prompt 2.0.0, migration `0077`):
`kind` and `derivation_recipe` were **removed** from generation entirely;
`normalizeDerivationRecipe` no longer exists at HEAD. The consequences on HEAD:

- Nothing prevents an absence-shaped event from being generated as an ordinary
  `suggested_wireable_on: ["frontend"]` event. `ValidateComplete`
  (`universegraph/graph.go`) checks shape, not observability. The prompt's
  "Avoid inferred inactivity" line is guidance, not a validator.
- The derive engine (`internal/engine/derive`) **is wired** (ticker → job →
  materialize → evaluate_user) but **starved**: v2 writes
  `metadata_json = '{}'`, so `AppsWithValidRecipes` finds nothing for new apps.
  Derived events simply never fire post-v2. "Wire the derive engine" is the
  wrong fix; the break is upstream metadata production — a product decision.
- The Go manifest never sends `universeSummary` (the field exists only on the
  wizard's TS type), so the CLI's "wired here" denominator silently equals the
  (unvalidated) generator's wireable list.

### The meta-failure

PR #20 shipped with its own warning in the description: *"the merged planning
prompt has not yet faced a real model … Worth running against a pilot repo
before this goes near a customer."* It became v0.6.0 and ran on a customer app.
All 91 unit tests pass and typecheck is clean — they cover parsing, auth, and
the tool-policy sandbox, not whether the wizard integrates a repository. The
process gap is as real as the code gaps.

## 2. Corrections to the two post-mortems

| Post-mortem claim | Reality |
|---|---|
| "Fix the generator classification (raw vs derived), regenerate universes" (PM1) | v2 removed `kind`/recipes from generation. The fix is a graph-level observability validator + honest `universeSummary`, and a deliberate product decision on derived events (restore recipes or retire the executor). |
| "Anonymous identity + server-side alias… without it that third is unreachable forever" (PM1) | RN SDK already has client-side anon buffering + backfill. Port it; server-side alias is optional and later. |
| Privacy not mentioned at all (PM2) | The single largest trust/regulatory exposure in the Zwaeg run. Front-loaded in this plan. |
| "Add OpenAI Responses provider" as a drop-in (PM2) | The CLI has no tool loop of its own (Claude Agent SDK owns it), and the `whisperr-go` LLM gateway is an Anthropic-only reverse proxy with one injected key (`internal/wizard/gateway.go`). A second provider = own agent loop + gateway routing/metering work. Doable, but it is a project, not a config change. |
| "Runs report nothing on failure" (both) | Reports **are** sent on every post-auth exit (`reportRun(exitClass)`), but with empty events and `cost_usd: 0` when the agent throws — the report exists and is hollow. |
| Manifest events carry properties the wizard should respect | Production manifests carry **no** properties. There is currently no property contract to enforce at all. |

## 3. The plan

Five workstreams. W = this repo, G = whisperr-go, S = SDKs, E = evals.
Order inside a workstream is strict; workstreams marked ∥ can run in parallel.

### Phase 0 — stop active harm (small, surgical, no architecture)

**W1. A failed run must keep its work, its telemetry, and its universe intact.** ∥
- Passes return `{ok, error}` instead of throwing (`runPass` catch-all → result);
  `runIntegrationAgent` always returns an outcome with whatever landed + cost.
- `collectReportEvents` and cost reporting work without `outcome` (the diff
  scan is deterministic; accumulate cost as passes finish, not at return).
- `maybeRevert` defaults to **No** whenever anything landed; default Yes only
  when the core never landed and the diff is trivial.
- Move `onOpportunitiesReady` to **after** wiring + review + verify. Failure
  path expires/never-submits proposals. (`--propose-only` semantics become the
  internal default shape: stage, then promote on success.)
- Persist `.whisperr/run.json` (plan, per-event/per-file state, phase timings)
  and add `--resume`. Add `--json` NDJSON progress for non-TTY.
- When no verifier ran, say **unverified** loudly in the outro and summary;
  never let the model's "everything looks correct" stand alone.

**G1. Honest universe + honest denominator.** ∥
- Add an observability validator to `universegraph.ValidateComplete`:
  absence/time-window-shaped events (name + description heuristics, plus an
  explicit LLM-side declaration in the generation schema) either fail
  generation or are forced non-wireable. This is the cheapest coverage-score
  fix on the board.
- Send `universeSummary` (total / wireableHere / derived / otherSurface) in the
  manifest so the CLI reports coverage against a real denominator.
- Regenerate or patch affected existing universes (Zwaeg first).

**W2. Deterministic verification.** ∥ (prereq for W4's per-shard gates)
- `verifyCommand?: string` → `verifySteps` resolved from the repo per playbook:
  Swift `swiftc -typecheck` over changed files (or `xcodebuild` when
  available), TS `tsc --noEmit` when a tsconfig exists, `php -l`,
  `python -m compileall`, `node --check`, `dart analyze`.
- A wizard-owned diff linter that parses **our own** call sites in the diff and
  validates arg shapes per playbook (the `JSONValue` class of failure) and
  extracts property keys (feeds W3). No customer toolchain required.
- Statuses: applied / literal-detected / syntax-ok / typecheck-ok / build-ok /
  reviewed / unverified / failed. Grep alone is only ever "literal detected".
- Delete "Do not run xcodebuild"-style prompt lines; the CLI owns verification.

**W3. Privacy layer v1 (deterministic; no backend dependency).** ∥
- Deny/bucket list on property keys everywhere model-authored properties flow:
  plan entries, opportunity proposals, and the W2 linter's extracted keys
  (`email|phone|dob|weight|height|age|sex|query|search_term|barcode|note|content|lat|lng|token|health…`).
  Strip or bucket unless allow-listed.
- Placement plan prints properties grouped by sensitivity; the sensitive group
  is an explicit confirm (default No).
- Planner reads README/PRIVACY/store copy and emits `privacyPosture`;
  on-device/local-only/no-analytics claims → hard stop with an explicit
  override flag.
- Add minimization language to `BASE_WIZARD_PROMPT` and every playbook (capture
  discriminators, not payloads).

### Phase 1 — the structural fix

**S1. SDK facade v1 (Swift first, then Flutter), spec-pinned.**
Non-optional, synchronous, non-throwing `Whisperr.track(_:properties:)`;
`initialize()` returns immediately and buffers in memory; pre-identify events
buffer persistently and backfill on identify (port the RN
`backfillIdentity` pattern); `trackOnce(key:)` with persistent dedupe;
literal-friendly property coercion. Encode all four behaviors as
`whisperr-spec` conformance fixtures (the spec's `behavior.json` currently pins
only queue-retention cases) so all eight SDKs converge.
*Sequenced before W4's prompt rewrite so the wiring prompts are written once
against the final call shape.*

**W4. Shard the wiring: plan → per-file jobs → merge.**
- Group plan entries by file; each job gets a fresh bounded context (repo map ≤
  8KB + the file + its 1–5 event specs + playbook), 3–8 turns, per-job budget.
- Sequential first, then bounded concurrency on disjoint files once evals are
  green. Per-file W2 verification; failed file = one failed file, recorded in
  `run.json`; `--resume` skips completed shards.
- Per-entry plan salvage: drop malformed entries with a warning instead of
  nulling the plan (removes the expensive re-explore fallback).
- Real progress (`wiring 12/23 · Features/Diary/AddFoodView.swift`) + a stall
  detector (>45s with no block → "still thinking on <file>").
- Planner submits plan entries incrementally via a tool rather than one giant
  fenced JSON block (possible in the current Agent SDK; no provider switch
  needed).

**W5 + G2. Typed event bindings.**
- Reintroduce a property contract server-side: per-event property specs with
  sensitivity tags (`none|personal|sensitive|prohibited`) — generated or
  curated — shipped in the manifest (G2).
- Generate `WhisperrEvents.<ext>` from the manifest (one typed function per
  event); the editor places one-line calls. Event names and property policy
  live in one file; `scanWiredEvents` keys on the module instead of guessing;
  re-runs diff a module; customers get a test seam. The compiler now enforces
  the property contract.

### Phase 2 — measure, then choose models

**E1. Behavioral eval harness (before any model debate).**
- Pin a Zwaeg-shaped fixture first (SwiftUI + XcodeGen + strict property typing
  + an on-device privacy README), then: Next.js dual-auth, Stripe
  initial-vs-renewal, RN pre-auth, Flutter, monorepo, and a
  half-the-manifest-belongs-elsewhere case.
- Deterministic assertions: builds/typechecks, calls in expected symbols,
  absent from forbidden paths (admin/renewal), property policy respected,
  identity correct, no duplicate instrumentation, bounded diff, no context
  failure, resume idempotent, universe unchanged on failure. LLM judge only
  for genuinely semantic placement calls.
- Make the offline E2E + the pinned fixture a **release gate**. A version whose
  planning prompt has not faced a real model does not ship again.

**E2. Provider abstraction + bakeoff (after E1 baselines).**
- `plan/edit/review` provider interface; the sharded editor jobs are small and
  bounded, which is what makes a second provider tractable.
- Scope honestly: own tool loop for the Responses API **and** gateway routing/
  metering in `whisperr-go`.
- Benchmark current Opus 5 planner + Sonnet 5 editor against GPT-5.6 Sol
  planner + GPT-5.3-Codex editor (and cross-provider review). Pick defaults
  from eval results, not intuition.

### Later (explicitly deferred)
- Server-side anonymous alias for real-time pre-identify ingestion.
- Derived-events product decision: restore recipes + feed the (already-wired)
  derive engine, or retire the executor and express absence in the policy
  layer. Either way, "you wire the raw events, Whisperr computes the rest" only
  becomes a story once one of these is true.
- Map/plan caching by `fingerprint+HEAD` sha; precomputed deterministic repo
  index; prompt-prefix caching across shards; isolated-worktree + atomic apply.

## 4. Definition of "fully operational"

1. A run can crash anywhere and lose at most one file's work, no telemetry, and
   no universe state; `--resume` completes it.
2. No event is reported "wired" without at least typecheck-level verification
   or an explicit, loud "unverified".
3. No sensitive property reaches customer code without an explicit opt-in; a
   privacy-posture conflict stops the run.
4. Pre-auth funnel events are wireable on every mobile SDK.
5. The universe cannot contain wireable events that cannot be wired.
6. Every release passes the pinned fixture evals, including the Zwaeg fixture.
