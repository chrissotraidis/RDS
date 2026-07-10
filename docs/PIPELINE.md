# Pipeline

> Walk-through of the RDS stages. Read this after `ARCHITECTURE.md`.
> Per-stage scripts live in `bin/`.

## How stages are managed

`bin/rds-build` is the single entry point. It:

1. Initializes `builds/<id>/state.json` with every stage in `pending`.
2. Runs each stage in sequence, marking it `running`, then `done`, `skipped`, or `failed`.
3. Records the chosen stack and per-build inference provider/model in
   `state.json` so resumed builds use the same builder.
4. Writes `builds/<id>/build.yaml` with stack and skill intent, resolves
   default/requested skills, and installs skill metadata before local-run.
5. On any failure, marks the current stage `failed`, writes an error
   message, and exits non-zero. No cleanup — the failed build dir stays
   for post-mortem.

Status values per stage: `pending`, `running`, `done`, `skipped`, `failed`.

## Autonomous product contract

The intended contract is: once a PRD or research prompt is submitted, RDS
should understand what kind of artifact it is building, choose the right
quality bar, verify the running result in a browser, and run a bounded
iteration when the artifact is technically working but product-weak.

Current behavior:

- `bin/rds-taste` infers a product kind from the spec/research and appends a
  binding quality brief before Scaffold plans work.
- `bin/rds-build-plan` uses the spec and stack to choose task, timeout, and QA
  budgets.
- `bin/rds-qa-scenarios` converts the PRD/spec into a small binding
  `qa-scenarios.json` / `qa-scenarios.md` contract before Scaffold starts.
  Scenarios include explicit browser actions and expectations when RDS can infer
  them. The scenarios are appended to `spec.md`, so implementation, QA, and
  later iterations share the same user-facing acceptance paths.
- `bin/rds-scenario-gate` validates that generated scenarios are concrete
  enough to guide implementation. It writes `qa-scenario-gate.json` and blocks
  scaffold when scenarios are too few, vague, non-binding, not executable, or
  generic enough to pass by clicking any Save/Submit/Create-style button or by
  finding placeholder PRD text. It validates against the **PRD-only** portion of
  `spec.md` — the appended taste brief and QA-scenarios sections are stripped
  first, so generated scenarios cannot be self-validating against the very text
  they added. It blocks action targets whose domain nouns do not appear in the
  PRD/spec, so an unrelated baseline workflow cannot send a financial dashboard
  through an order-submission scenario. It also blocks action targets whose
  domain noun appears in the PRD **only inside a negating clause** (e.g. a
  "Submit order" scenario against a PRD that says "there is no order/trade …
  read-only by construction"), so a scenario cannot test a capability the spec
  explicitly forbids. It also blocks missing product-type criteria such as
  board/legal-move/capture/victory paths for POLIS-like games.
- Build-resolved skill guides are installed into the app before Scaffold runs,
  so the builder can use stack/default skill contracts while planning and
  implementing instead of discovering them after the app is already built.
- `bin/rds-qa` runs Playwright browser QA against the deployed URL and writes
  crawl, screenshot, gap, and spec-verdict artifacts.
- **Self-healing scenario contract:** `qa-scenarios.json` is generated once at
  build time and then frozen, so a PRD that evolves — or a build-time generator
  bug — can leave QA grading the app against stale or bogus scenarios forever.
  Before crawling, `bin/rds-qa` re-gates the contract against the current PRD; if
  the gate fails, it regenerates the contract from `spec.md` via
  `bin/rds-qa-scenarios`, re-gates, copies the before/after gate reports into the
  iteration dir (`scenario-gate-pre.json` / `scenario-gate-post.json`), and emits
  a `qa_scenarios_selfhealed` event. This keeps targeted iteration aimed at what
  the PRD now promises instead of spinning on blockers the spec no longer
  contains. Disable with `RDS_QA_SCENARIO_SELFHEAL=0`.
- QA also runs a visual/layout audit on desktop and mobile. It writes
  `visual-verdict.json` and blocks review on horizontal overflow, overlapping
  controls, clipped control text, and blank canvas output.
- When `RDS_DESIGN_REVIEW_ENABLED=1` and Zo API identity is available, QA runs
  a screenshot-backed design review. It writes `design-review.json` and blocks
  review when the result looks broken, generic, debug-like, misaligned, or not
  compelling enough for operator review. A skipped/unparsable design review is
  missing required evidence, not a pass.
- QA now selects a typed UAT profile from `state.json.app_type`.
  - `game` runs start/play/fail/restart checks and writes `game-verdict.json`.
  - `website` checks first-screen clarity, CTA/nav/link click-through, and
    responsive layout, then writes `website-verdict.json`.
  - `web-app`, `dashboard`, and `internal-tool` exercise visible workflow
    controls, same-origin route navigation, route-level controls, layout, state
    changes, and console health, then write `workflow-verdict.json`.
- Typed UAT also executes `qa-scenarios.json` as named browser journeys and
  writes `scenario-verdict.json` with per-step transcripts. Scenario failures
  are blocking evidence, not advisory notes.
- `bin/rds-taste-review` reviews source plus QA outputs and can trigger one
  controlled `bin/rds-iterate` pass before final review.
- `bin/rds-iterate` edits only the generated app, runs checks and QA, and
  redeploys only after the iteration stays green. Its prompt embodies the
  targeted-iteration loop: read the full original PRD (RDS-appended taste/QA
  addenda stripped, capped by characters rather than truncated to a fixed line
  count) plus the binding QA scenarios, compare them against the actual code,
  enumerate what is implemented vs. missing/faked, then implement the real gaps
  — making the smallest coherent change for a narrow tweak but building promised
  workflows end-to-end when the goal is review-readiness. It must leave the app
  building and bootable so Playwright QA can click through the scenarios. Before
  each provider edit it writes `iterate-<ts>.repair-plan.json` from the current
  quality ledger, taste review, and failing QA verdicts. After QA it writes
  `iterate-<ts>.repair-convergence.json`, recording which repair targets closed
  and which remain. Nested autonomous repair passes carry that convergence
  report forward instead of blindly repeating a broad polish prompt.
- `bin/rds-readiness` runs after QA, taste review, quality ledger refresh, cost,
  and speed telemetry. It is the final autonomous gate before pending operator
  review. It writes `readiness.json` and blocks review if required stages are
  incomplete, QA/taste were skipped, preview URL is missing, crawler/spec/
  visual/scenario/typed UAT/taste verdicts are missing or blocking, or the
  quality ledger still has blockers. Every issue includes a recovery hint.
- `bin/rds-fix` consumes `readiness.json` first when the final gate fails.
  Missing evidence is deterministic: reset the smallest affected stage range
  and resume. Product-quality blockers are not blindly retried; they stay in the
  provider diagnosis/app-iteration path with readiness evidence included.

What is still not strong enough:

- Product type is now durable as `state.json.app_type`, and QA/taste review now
  consume typed UAT verdicts. The typed profiles are still first-pass
  deterministic checks, not complete human-equivalent product review.
- `scenario-verdict.json` now proves generated scenarios were executed with
  action/expectation transcripts, but the executor is still deterministic. It
  can validate straightforward links, buttons, form controls, URL/text/state
  changes, visible first-screen evidence, and semantic business-state assertions
  for approval/status workflows. It now records per-scenario screenshots beside
  failed/passing checks plus URL before/after fields so iteration and review can
  inspect the exact journey state. Richer PRD extraction still needs setup data,
  semantic selectors, and broader business-state assertions.
- Game QA performs deterministic multi-action play plus a timed scripted
  playtest. It records start/movement/primary-action/sustained-play/restart
  phases, state deltas, screenshots, and subscores for clarity, control feel,
  feedback, challenge, progression, replayability, and visual specificity. It
  is still not a human-equivalent qualitative design review, but it now proves
  the browser actually played through a session instead of only poking the
  first screen.
- Website/app QA now has typed UAT, structured scenario execution, and
  same-origin route/control coverage. It now also writes
  `truthfulness-verdict.json`, `persona-verdict.json`, and
  `prd-coverage-verdict.json` so generated apps must disclose review-mode
  sample/stub data, prove operator login/authenticated navigation, and cover
  promised PRD route families/actions. It still cannot prove every multi-step
  business workflow end to end without more PRD-derived setup data, selectors,
  and expected business states.
- Stack skill defaults are now stronger, but many individual skills remain
  guide/materialization contracts rather than deep installers. Repeated real
  builds should promote high-value skills into stack-specific installer and
  verifier logic.
- RDS now writes `quality-ledger.json` and the dashboard shows scenario status,
  sample transcripts, and `skillImpact` rows from `skills/scorecard.json`.
  Selected skills that fail or only partially affect the generated app are
  visible in the same quality surface as persona/workflow failures.
- RDS now has a final readiness gate with recovery hints, but that gate is only
  as strong as the upstream artifacts. The next autonomy work is making every
  stage emit richer evidence and making `rds-fix` handle more blockers without
  a human prompt.
- Auto-iteration is intentionally capped at one pass. That prevents runaway
  subjective loops, but it means a second weak result must be reviewed or
  iterated manually.
- `bin/rds-quality-ledger` writes `quality-ledger.json` after QA/taste
  checkpoints. It records resolved/installed/skipped skills, generated
  scenarios, scenario execution status, latest typed UAT verdicts,
  visual/design verdicts, mockup status, and any blocking gates.

### Goal Mode

`bin/rds-goal <build-id>` is the long-running supervisor for a single build. It
does not add new build stages and does not replace the normal pipeline. Instead
it repeatedly:

1. refreshes `quality-ledger.json`, `readiness.json`, `evidence-ledger.json`,
   and `truth.json`;
2. re-reads the original local PRD/source when available, `spec.md`, research,
   taste/scenario contracts, latest QA verdicts, and repair convergence;
3. chooses the next action from the current blocker class and repeated-blocker
   signature;
4. runs `bin/rds-fix` for missing/stale/deploy/runtime evidence blockers or
   `bin/rds-iterate` for product-quality blockers;
5. refreshes evidence again;
6. writes per-turn JSON artifacts;
7. stops at `pending_review`/`approved`, a budget cap, action failure, or a
   human-review handoff.

After the configured repair cycles are exhausted, Goal Mode can launch one
isolated alternate-provider worker through `bin/rds-agent-start --mode=print`.
That Claude/Codex worker may produce a worktree diff, but RDS does not merge,
push, or approve it automatically.

Artifacts:

- `builds/<id>/goal.json` — latest compact goal state for dashboard/chat;
- `builds/<id>/goals/<goal-id>/goal.json` — immutable copy of the completed
  run;
- `builds/<id>/goals/<goal-id>/turn-*.json` — before/after verdict,
  blocker signature, selected action, prompt path, command, logs, and produced
  artifacts;
- `builds/<id>/goals/<goal-id>/cycle-*.log` and prompt files;
- ordinary `iterate-*.repair-jobs.json`, `iterate-*.repair-convergence.json`,
  QA, readiness, truth, and agent-session artifacts.

The near-term target is to make `app_type` first-class and select type-specific
QA profiles:

| Type | Required autonomous checks |
|---|---|
| `game` | Start/play/fail/restart loop, keyboard/pointer controls, scoring/progression, enemy or hazard pressure, visual feedback, screenshot/pixel deltas, and a game verdict. |
| `website` | First-viewport clarity, navigation/CTA click-through, responsive screenshots, broken/empty sections, visual specificity, and content hierarchy. |
| `web-app` / `dashboard` | Primary workflow completion, filters/search/forms, empty/loading/error/success states, realistic data, status/history signals, and responsive layout. |
| `internal-tool` | Repeatable operator workflow, dense information hierarchy, audit/progress visibility, destructive-action confirmation, and export/status paths. |

### Next product-quality upgrade

The next upgrade should prove RDS can catch POLIS-class failures repeatedly,
not just document why they happened once:

1. Upgrade `bin/rds-qa-scenarios` and `bin/rds-scenario-gate` beyond baseline
   action schemas into richer PRD-derived setup, selectors/text targets,
   expected business state, required screenshots, and calibrated blocking
   criteria.
2. Extend game playtesting from deterministic scripted evidence into richer
   qualitative scoring: control feel, difficulty curve, collision/failure loop,
   mobile controls, audio/visual feedback, and distinctive hook.
3. Keep expanding `bin/rds-quality-fixtures` whenever a product-quality failure
   slips through. The current suite covers broken links, no-op workflow
   controls, mobile overlap, playable game positive control, and no-progression
   gameplay; future incidents should add a small fixture before or alongside
   the fix.
4. Promote high-leverage skills from guidance to installers/verifiers. The
   first candidates are design-system/polish, game-feel/playtesting, workflow
   testing, and browser-extension permission checks.
5. Add deeper dashboard UI for `quality-ledger.json` so the operator can see
   skill efficacy evidence, screenshots/verdicts that blocked review, and the
   iteration prompt without opening raw artifacts.

### Complexity planning

After intake/spec and before stack init, `bin/rds-build` runs
`bin/rds-build-plan --spec builds/<id>/spec.md --stack=<id> --provider=<builder>`.
The output is written to `builds/<id>/build-plan.json` and copied into
`state.json.build_plan`.

The plan classifies the requested build as `tiny`, `simple`, `standard`,
or `complex`, then sets proportional limits:

- maximum Scaffold implementation tasks;
- per-task Codex timeout / Claude turn and budget caps;
- QA crawl page/depth limits;
- target time range and any operator questions/risks.

This is intentionally deterministic and cheap. Small React/Vite games
such as Pong should be classified as `tiny` and capped at 3 implementation
tasks; complex Rails apps with auth, billing, data models, and integrations
get a larger budget. The dashboard shows the selected plan on the build
page before Scaffold starts.

Do not tune Claude budgets down to toy values. Opus-based Scaffold tasks
need realistic per-task ceilings even for "simple" apps, because the first
task receives the spec, runbook, task dossier, and project context. As of
2026-05-04, build-plan floors are `$1`/`$2`/`$3`/`$5` for tiny/simple/
standard/complex, and large React game specs are promoted out of `simple`.
If a live build still fails with `Exceeded USD budget` or
`session_exhausted`, `bin/rds-fix` treats that as deterministic auto-heal:
raise the build plan, reset errored Scaffold tasks, and resume without a
manual click.

### Taste loop

RDS treats "working" and "good" as separate gates.

After `spec`, `bin/rds-build` runs `bin/rds-taste <build-id>`. This writes
`builds/<id>/taste-brief.json`, `builds/<id>/taste-brief.md`, and appends a
binding "RDS Taste Brief" to `spec.md` before build planning and Scaffold.
The brief classifies the request as a game, website, app, or interactive web
surface, then adds quality-bar, anti-goal, and acceptance criteria that push
the builder away from generic demos.

After browser QA, `bin/rds-build` runs `bin/rds-taste-review <build-id>`.
The review reads the generated app source, latest Playwright summary, spec
verdict, and taste brief. It writes `builds/<id>/taste-review.json` and
`builds/<id>/taste-iteration-prompt.md`.

Defaults:

- `RDS_TASTE_ENABLED=1`
- `RDS_TASTE_REQUIRED=1`
- `RDS_TASTE_AUTO_ITERATE=1`
- `RDS_SKIP_TASTE_REVIEW=0`

When the review fails and auto-iteration is enabled, RDS runs a bounded
`bin/rds-iterate <build-id> --yes` pass using the generated improvement
prompt, then re-runs taste review. Iteration remains capped so subjective QA
does not become an infinite loop, but the cap is high enough for one targeted
QA-gap recovery path.

### Autonomy evidence spine

RDS now separates the operator verdict from raw artifact sprawl:

- `builds/<id>/truth.json` is the compact current verdict used by CLI, chat,
  approval gates, and the dashboard command center.
- `builds/<id>/evidence-ledger.json` is the folded evidence ledger across
  state, events, readiness, quality, skills, deploy identity, runtime marker,
  and latest QA artifacts.
- `builds/<id>/autonomy/evidence.json` is the per-stage sidecar. It records
  normalized stage status, confidence, evidence paths, blockers, and next
  actions for intake through operator review.

The sustainable rule is: add evidence to the stage sidecar first, then decide
whether the dashboard needs to surface a summary. Do not add another
always-visible build-page panel for every new proof.

### Builder selection

`bin/rds-build` accepts `--provider=claude|codex`, `--claude-model=<id>`,
and `--codex-model=<id>`. These values are written to
`state.json.inference` and exported into Scaffold's `launch-build.sh`, so
the implementation tasks use the builder selected at build start rather
than whatever the dashboard Settings page says later. `bin/rds-resume`
replays those same values.

Build-scoped chat and `bin/rds-fix` also read `state.json.inference`, so
operator questions and watchdog repair attempts use the same provider as
the build. For green-field Codex builds, the spec stage uses a deterministic
provider-native fallback by default instead of hard-requiring Claude in the
service PATH; set `RDS_SPEC_CODEX_INFER=1` to let Codex generate the spec
text. Vendored Scaffold task-planning helpers may still use Claude-specific
helper calls where that upstream tooling requires Claude Code.

The dashboard Settings page controls defaults for future builds only. It now
surfaces builder defaults, active model field, local Claude/Codex CLI health,
V1 stack/skill registry status, runtime/auth paths, theme, and vendored
component inventory in one operator view.

Provider-specific model controls are mutually exclusive in dashboard forms. If
Claude is selected, Codex model fields are hidden/disabled and are not submitted
for a new build. If Codex is selected, Claude model fields are hidden/disabled
and are not submitted for a new build. This prevents stale provider-specific
model values from leaking into the wrong build path.

### Stack selection

`bin/rds-build --stack=<id>` is selected at build start and recorded in
`state.json.stack`. End-to-end enabled V1 stacks today:

- `rails-web` / `rails`
- `nextjs-fullstack` / `nextjs`
- `python-ai-service`
- `astro-thin-web`
- `web-3d`
- `game-engine`
- `browser-extension`
- `mobile-native` / `react-native`
- `game-asset-pipeline`

`react-spa` / `react` remains in the registry for legacy V0 compatibility, but
is deferred for V1. Use `nextjs-fullstack` as the default modern-web stack
unless a Vite-only SPA is explicitly requested and re-enabled.

Each ready stack has a `manifest.json`, `stack.yaml`, `init.sh`,
`local-run.sh`, `doctor.sh`, and Scaffold recipe. Mobile Native and Game Asset
Pipeline have honest runtime caveats: Expo/EAS credentials and physical-device
preview are external to Zo, and Blender/bpy transforms are optional until
Blender is installed.

### Skill resolution and install

`bin/rds-build --skills=default|none|slug,slug` controls the V1 skill layer.
Default resolves stack-compatible RDS built-ins from `skills/registry.json`;
`none` preserves V0 behavior. `skill-resolve` writes
`builds/<id>/skills/resolved.json` for the installer and
`builds/<id>/skills-resolved.yaml` for operators/agents, then updates
`build.yaml`. `skill-install` writes `.rds/skills/*.json` plus any ready
built-in guide files into the app tree. Every entry in `skills/registry.json`
(91 at last count — the registry is authoritative) compiles as a ready
RDS-owned skill guide with source links, stack applicability, rationale,
app-local materialization, and verify hooks. This is a guide/verification
contract, not a promise that external services can be used without credentials:
deploy, payments, app-store, OAuth, and hosted-service skills still require the
human/account setup described in their mounted guides. See
`docs/STACKS_AND_SKILLS.md`.

The dashboard `/new` page adds a pre-build recommendation layer before
`POST /new` launches anything. The explicit Analyze source button calls
`POST /new/analyze`, which shells into the shared `bin/rds-analyze-source`
analyzer. That analyzer classifies the PRD/brief into stack, app type,
confidence, clarification questions, and ready skills by stack and intent.
`bin/rds-build` also calls this analyzer before stack/app-type selection, so
chat/CLI builds and dashboard builds share the same front-door contract. It
always starts from the core safety skills:

- `rds-context7-mount`
- `rds-mockup-fidelity`
- `rds-secrets-broker`

Then it adds ready specialized skills when the PRD mentions matching concerns
such as auth, tests, browser QA, databases, analytics, observability, evals,
3D assets, polished Next.js UI, payments, email, jobs, storage, LLM features,
or vector search. It ignores Non-Goals/out-of-scope sections for classification,
so a game PRD that says "no native iOS/Android app" does not get misrouted to
`mobile-native`. Curated skills remain manual in the UI. Once the build starts,
the submitted `--skills=<slug,...>` remains authoritative. Run
`bin/rds-analysis-fixture` before changing analysis, stack defaults, app-type
inference, or default skill recommendation behavior. Run
`bin/rds-autonomy-fixture` before changing the dashboard launch endpoint,
analyzer, skill resolver, or readiness handoff; it verifies dashboard/CLI
analysis parity, skill resolution, missing-evidence readiness blocking, and
fixer decisions for missing evidence versus product-quality blockers.

`bin/rds-v1-validate` checks the V1 registry, required stack contract fields,
port range migration, built-in skill scaffolds, and expected catalog slugs.
`bin/rds-port-migrate` normalizes every `manifest.json` and `stack.yaml` to the
Zo preview port range `4000-4099`.

`bin/rds-mockup verify --build-dir=<dir> --app-dir=<dir> --stack=<slug>
[--url=<preview-url>]` runs the stack's declared `mockup_analog` check and
writes `builds/<id>/mockup-diff/report.json`. When reference screenshots exist
under the app or build evidence tree (`mockup-screens/`, `references/`, or
build attachments), it captures the live preview and compares the live
screenshot against those references instead of treating screenshot presence as
enough. QA invokes this automatically after the Playwright crawl unless
`RDS_MOCKUP_FIDELITY_ENABLED=0`.

### Resuming a failed build

`bin/rds-build --resume --build-id=<id>` skips every stage already
marked `done` or `skipped`, resets the failed/running stage to
`pending`, emits a `build_resumed` event, and continues. Stage outputs
that already exist on disk (cloned `app/`, generated `spec.md`,
populated build dir) are not regenerated. `bin/rds-resume <id>` is the
operator-friendly wrapper — it reads `state.json` to reconstruct the
original `bin/rds-build` invocation (mode, app_dest, stack, repo/PRD or
green-field trigger) so the operator only has to pass the build id.
`bin/rds-resume <id> --detach` writes `builds/<id>/run.pid`, matching
`bin/rds-start`, so watchdog liveness checks continue to work after an
auto-retry.

### Pausing builds

`bin/rds-pause <id>` is the supported operator pause path and is exposed
from the dashboard Builds and Build Detail pages. It terminates the active
build runner process group, removes `builds/<id>/run.pid`, sets
`state.json.status` to `paused`, records `paused_at` and
`paused_from_stage`, resets the active stage to `pending`, and emits a
`build_paused` event. Completed and skipped stages are left intact, so
`bin/rds-resume <id> --detach` later continues from the paused stage.
The dashboard Resume controls call the same wrapper with `--detach`, so
the page returns immediately while the build continues in the background.

The watchdog intentionally skips builds whose top-level
`state.json.status` is `paused`; a paused build must not be treated as a
stuck orphan or auto-fixed until an operator resumes it.

After resume, Scaffold task files are part of the liveness contract. The
dashboard and watchdog both treat `<app_dest>/tasks.json`,
`.scaffold/events.jsonl`, `.scaffold/state.json`, and
`.scaffold/telemetry/*.json` as activity. This prevents a resumed build from
being marked stuck just because the terminal stream or old stage log is quiet
while task execution is still advancing.

### Auto-recovery on failure

When `bin/rds-watchdog` is running, a `failed` build with `state.json.status
== "failed"` (and no fresh fixer attempt) gets picked up after
`--fail-after` seconds (default 30) and `bin/rds-fix` is spawned. The
fixer then runs three phases (diagnose → apply → retry) and the third
phase calls `bin/rds-resume <id> --detach`, so a fix-and-go for common
failures like stale PIDs or missing migrations needs zero operator
clicks. Capped at `--max-fix-attempts` (default 3) per build to prevent
infinite fix→retry→fail loops. The cap is computed from parsed
`events.jsonl` records, not raw grep over log text, because stage failure
events can contain large escaped log tails that themselves mention event
names. Full knob list in `README.md` ("Auto-recovery loop").
`bin/rds-watchdog --status`, `--stop`, and `--detach` reconcile real watchdog
processes as well as `/dev/shm/rds-watchdog.pid`, so a stale or overwritten
pidfile does not leave duplicate auto-fix loops racing each other.

For Scaffold failures, `bin/rds-fix` checks the task ledger before downstream
readiness evidence. If `<app_dest>/tasks.json` contains
`blocked`/`error`/`in_progress` tasks, the fixer resets those task entries to
`pending`, resets Scaffold plus downstream `local-run`/deploy/QA/taste-review
stages, and resumes from Scaffold. This prevents a blocked task from being
misdiagnosed as `preview_missing` and retried against a stale deploy.

The watchdog also handles orphaned running state: if `state.json` says a
stage is `running`, but `run.pid` is absent/dead and logs have been silent
past `--stuck-after`, it emits `watchdog_resume_started` and calls
`bin/rds-resume <id> --detach` directly. This covers killed shells and
interrupted one-shot resumes where no stage failure event was emitted.

## Stage 1 — Intake

**Script:** `bin/rds-intake` (+ `bin/rds-clone-repo` in brown-field).
**Green-field inputs:** Notion URL (pre-fetched by Claude Code) or local `.md` path.
**Brown-field inputs:** `--repo=<url>` and `--prd=<source>`.
**Green-field outputs:** `builds/<id>/research.md`.
**Brown-field outputs:** `builds/<id>/app/` (cloned repo), `builds/<id>/spec.md`.
**Log:** `logs/intake.log`.
**Typical duration:** seconds (green-field) or seconds-to-minutes (brown-field, depending on repo size).

Failure modes and responses:

- **Source URL is Notion but file wasn't pre-fetched.** `rds-intake` exits
  with a FATAL and a pointer to AGENT.md §4/§5. Fix: Claude Code must
  fetch the page via MCP first.
- **Raw GitHub URL 404.** curl fails. Fix: confirm the URL is a raw file
  path (not a GitHub HTML view).
- **Clone fails (brown-field).** Usually auth. Fix: ensure Zo has the
  SSH key or PAT for this repo.
- **Destination already exists and is non-empty.** The script refuses to
  overwrite. Fix: pick a fresh `--build-id`.

## Stage 2 — Spec (green-field only; skipped in brown-field)

**Script:** `bin/rds-spec`.
**Inputs:** `research.md`.
**Outputs:** `spec.md` (+ optional `po-questions.md`).
**Log:** `logs/spec.log`.
**Typical duration:** 3–15 minutes.

`bin/rds-spec`:

1. Copies `research.md` into `builds/<id>/wiki/research.md`.
2. Selects the spec generator from `RDS_SPEC_PROVIDER`, falling back to the
   build provider in `state.json.inference.provider`.
3. For Claude builds, invokes
   `claude --plugin-dir vendor/wiki --print "<prompt>"`.
4. For Codex builds, writes a deterministic Scaffold-compatible spec fallback
   unless `RDS_SPEC_CODEX_INFER=1` is set, in which case it first attempts a
   Codex inference pass and falls back deterministically on failure.
5. Asserts the resulting `spec.md` is non-empty.
6. If Wiki wrote `wiki/review/product-owner-questions.md`, copies it to
   `builds/<id>/po-questions.md` and records the path in `state.json`.

The build does **not** pause for PO questions. AGENT.md §9 covers what
Claude does with them at report time.

Failure modes:

- **`claude --plugin-dir` unsupported on a Claude build.** Upgrade the Claude
  CLI or patch RDS to shell out differently. See `docs/TROUBLESHOOTING.md`.
- **`claude: command not found` on a Codex build.** This should no longer fail
  the spec stage. `bin/lib/common.sh` normalizes standard binary paths, and
  Codex builds use the deterministic fallback unless explicitly configured for
  Codex inference.
- **Wiki produces a degenerate spec.** The prompt guardrails in §4 of the
  prompt file still force *some* spec. If it's unusable, the operator iterates
  on the prompt and retries.

Brown-field: this stage is marked `skipped` — the provided PRD is
authoritative.

## Stage 3 — Taste Brief

**Scripts:** `bin/rds-taste`, `bin/rds-qa-scenarios`,
`bin/rds-scenario-gate`, then `bin/rds-taste-gate`.
**Inputs:** `spec.md`, `research.md` when present, and `state.json`.
**Outputs:** `taste-brief.json`, `taste-brief.md`, `qa-scenarios.json`,
`qa-scenarios.md`, `qa-scenario-gate.json`, `taste-gate.json`, and appended
sections in `spec.md`.
**Log:** `logs/taste.log`.
**Typical duration:** seconds.

This is the pre-build taste layer. It reviews the raw prompt/spec and adds
binding acceptance criteria for depth, feedback, progression, polish, and
anti-generic behavior before Scaffold sees the spec.

`bin/rds-scenario-gate` and `bin/rds-taste-gate` make that contract enforceable
before expensive builder work starts. The scenario gate blocks scaffold when QA
paths are generic smoke checks instead of binding executable acceptance paths.
The taste gate blocks scaffold if the brief is too thin, too generic, missing
domain-specific PRD language, missing first-screen/workflow/interaction/visual
shape, missing enough QA scenarios, or weak for the detected product type. For
games, the gates require concrete game-loop/rule/feedback/board/control/restart
criteria; a POLIS-like board game must mention board/turn/legal-move/capture/
victory/mobile expectations before Scaffold is allowed to run.

Failure modes:

- **No spec exists.** Earlier intake/spec failed or was skipped incorrectly.
- **Taste disabled.** Set `RDS_TASTE_ENABLED=0` only for harness debugging.
- **Taste gate fails.** Strengthen the product/taste brief and regenerate
  domain-specific QA scenarios before running scaffold.

## Stage 4 — Stack-init (green-field only; skipped in brown-field)

**Script:** stack init hook from `stacks/<id>/manifest.json`; Rails uses
`bin/rds-rails-init`.
**Inputs:** `spec.md` (to derive app name), empty app destination.
**Outputs:** app destination with stack starter contents, `HOST_PORT` set in
`.env`, and initial git commits when the stack supports them.
**Log:** `logs/rails-init.log`.
**Typical duration:** 10–60 seconds.

For Rails, `bin/rds-rails-init` copies `vendor/rails-starter/` and runs
`bin/template-setup` with `--app-name=<derived>` and `--yes`, so it does not
block on stdin.

Failure modes:

- **Starter setup failed.** `template-setup` exits non-zero.
  Fix: read `logs/rails-init.log`, then run the same command inside the app
  destination to see the Rails setup error.
- **Port range exhausted.** `next_free_port` fails to find one between
  `RDS_LOCAL_PORT_RANGE_START` and `RDS_LOCAL_PORT_RANGE_END`. Fix:
  stop a previous build, or widen the range in `.env`.

## Stage 5 — Scaffold

**Script:** `vendor/scaffold/scaffold.sh` + the `launch-build.sh` it generates.
**Inputs:** `spec.md`, `builds/<id>/app/`.
**Outputs:** built-out app, copied Scaffold harness, and a
`builds/<id>/scaffold-out/` dir containing the generated build plan.
**Log:** `logs/scaffold.log`.
**Typical duration:** 15–90 minutes depending on spec size.

This stage invokes Scaffold twice:

1. `./scaffold.sh <spec.md> --wiki <wiki-dir> --output <scaffold-out>` —
   produces `launch-build.sh` and the task plan.
2. From `APP_DEST`, `IS_SANDBOX=1 ./launch-build.sh --headless --batch` —
   executes the plan against the app.

Scaffold internally spawns provider-specific implementation sessions. Those
sessions receive stack recipe context so Rails, React, and future stacks do not
share the same assumptions.

Failure modes:

- **Scaffold gate repeatedly fails.** Inspect the gate's shell check in
  `vendor/scaffold/`. Usually a bin/rails command failing in the app.
- **Claude session hits an API error.** Scaffold retries a few times.
  Persistent failures bubble up.
- **Task generation produces nonsense.** Re-run with `--max-turns=8` or
  iterate on `spec.md`.

## Stage 6 — Local-run

**Script:** stack hook from `stacks/<id>/manifest.json.local_run`, or the
inline Rails runner when no hook is defined.
**Inputs:** `builds/<id>/app/` with `HOST_PORT` set.
**Outputs:** running native Rails server; `/up` returning HTTP 200.
**Log:** `logs/local-run.log`.
**Typical duration:** 20 seconds – 2 minutes (`bundle install` is the
slow part on a fresh app).

Steps:

1. Ensure `.env` has `HOST_PORT` (brown-field safety — green-field
   already set this in stage 3).
2. Run the stack-specific dependency/setup command.
3. Run the stack-specific database/build preparation command when needed.
4. Boot the app natively on `HOST_PORT`, with PID written to
   `tmp/pids/server.pid`.
5. Poll the stack health path up to `RDS_WAIT_HEALTH_TIMEOUT_SEC`.
6. Mark stage `done` on first 200.

> Zo runs inside a gVisor sandbox — there is no Docker daemon. The
> pipeline runs Rails directly. If you've worked on a previous version
> of RDS, the old `docker compose up` step is gone and isn't coming
> back unless Zo's runtime story changes.

Failure modes:

- **`HOST_PORT` collision.** Rails fails to bind. Fix: pick a free
  port (or `bin/rds-stop <id>` to tear down a previous build first).
- **Stack setup fails.** Typically a bad package/Gemfile/lockfile or a missing
  native dependency. Fix: read `logs/local-run.log`, fix the generated app, and
  retry the stage.
- **Health check times out.** Server booted but the health path doesn't
  respond. Fix: tail `logs/local-run.log` for the runtime error.

## Stage 7 — Deploy

**Script:** `bin/rds-deploy`.
**Inputs:** running Rails server on `HOST_PORT`.
**Outputs:** `builds/<id>/preview-url.txt`.
**Log:** `logs/deploy.log`.
**Typical duration:** seconds.

Three targets:

- `zo` — calls `bin/rds-zo-register`, which asks Zo to register a durable
  public HTTP service for an immutable `builds/<id>/deploy-snapshot/` copy of
  the app, waits for the public URL to return a 2xx/3xx response, then writes
  the real `https://*.zocomputer.io` URL to `preview-url.txt`. Set
  `RDS_ZO_AUTO_REGISTER=0` only to restore the old pending-sentinel behavior
  while debugging.
  The snapshot matters: multiple builds may reuse the same
  `/srv/rds-projects/<slug>` app directory, but a deployed preview must
  not change or break when a later build mutates that source directory.
  For legacy React/Web-3D Vite apps, deploy also patches `vite.config.*` to
  allow Zo's public host before registration. Without this, Vite 7 can serve
  locally while returning public HTTP 403 with `Blocked request. This host
  ("ts*.zocomputer.io") is not allowed`.
- `none` — leaves Rails running locally; `preview-url.txt` is set to
  `http://localhost:<HOST_PORT>` (reachable from Zo itself).
- `teardown` — kills the Rails process via `tmp/pids/server.pid`,
  removes the URL sentinel.

The `fly` target was removed on 2026-04-25 (was never wired up to a
real account). Bring it back when there's a concrete need.

## Stage 8 — QA

**Script:** `bin/rds-qa`, followed by `bin/rds-mockup verify` when enabled.
**Inputs:** deployed preview URL. If a legacy pending Zo registration
sentinel is present, QA falls back to localhost for debugging only.
**Outputs:** `builds/<id>/playwright/iter-NNN/summary.json`, screenshots,
`gaps.json`, `spec-verdict.json`, `visual-verdict.json`,
`mockup-diff/report.json`, and typed UAT verdicts such as
`game-verdict.json`, `website-verdict.json`, or `workflow-verdict.json`.
After QA/taste/readiness evidence changes, RDS also refreshes
`builds/<id>/quality-ledger.json` and `builds/<id>/evidence-ledger.json`.
**Log:** `logs/qa.log`.

By default, QA is required (`RDS_QA_REQUIRED=1`). A crawler result with
gaps marks the QA stage failed and blocks the approval gate. Set
`RDS_QA_REQUIRED=0` only when iterating on the harness itself.

Defaults:

- `RDS_QA_MAX_PAGES=40`
- `RDS_QA_DEPTH=3`

The current crawler is still anonymous browser QA. Persona-aware login and
full customer UAT flows are not complete yet. For `app_type=game`,
`lib/rds-qa/game-uat.ts` adds deterministic browser play evidence: load the
page, run PRD scenario journeys, click or press likely start controls, send
keyboard/pointer input, run a timed scripted playtest through start, movement,
primary action, sustained pressure, and restart phases, compare observable
DOM/canvas state changes, capture screenshots, and score clarity, control feel,
feedback, challenge, progression, replayability, visual specificity, restart
loop, and console cleanliness. For `website`, `web-app`, `dashboard`, and
`internal-tool`, typed UAT checks first-screen clarity, CTA/nav click-through,
workflow controls, observable state changes, responsive layout, and console
health. These profiles are required evidence, but they are still not a
substitute for the scenario-execution upgrade described above.

Failure modes:

- **Sentinel left in place after `zo` target.** Means auto-registration was
  disabled or regressed. Treat this as a deploy failure for normal
  end-to-end builds.

## Stage 9 — Taste Review

**Script:** `bin/rds-taste-review`.
**Inputs:** generated app source, `spec.md`, `taste-brief.json`, latest
Playwright iteration, and `spec-verdict.json`.
**Outputs:** `taste-review.json`, `taste-iteration-prompt.md`, and optionally a
bounded `rds-iterate` pass.
**Log:** `logs/taste-review.log`.

This is the post-build taste gate. It asks whether the actual artifact has
enough depth to avoid being a merely functional demo. For games it looks for
signals like scoring, progression, pressure, failure/retry, feedback, and a
hook. For apps it looks for primary workflow depth, real states, realistic
data, operator confidence, and responsive polish. Missing or skipped
`design-review.json` is blocking evidence, not an unknown/pass state; a build
with screenshots but no screenshot-backed design verdict must iterate or stop
for operator review.

## Evidence Ledger

**Script:** `bin/rds-evidence-ledger`.
**Outputs:** `builds/<id>/evidence-ledger.json` and
`builds/<id>/truth.json`.

The evidence ledger is the first-pass autonomy truth layer. It folds the build's
scattered artifacts into one operator-facing verdict:

- `building` — a stage is actively running.
- `recovering` — fixer/iterate recovery is active.
- `blocked` — evidence says the build should not be approved.
- `pending_review` — required evidence passes and the operator should inspect.
- `approved` / `failed` — terminal review or failure state.

Inputs include `state.json`, `events.jsonl`, `readiness.json`,
`quality-ledger.json`, `skills/scorecard.json`, `service.json`,
`preview-url.txt`, and the latest Playwright iteration. The payload records
confidence, blocker class, blocker source paths, recovery guidance, preview
truth, and recovery-attempt counts. The dashboard renders this as the "Current
truth" panel above the older Quality Ledger so operators do not have to infer
state from stage chips, logs, and partial verdict files.

The ledger is also responsible for blocker consolidation. Repeated raw gates
must collapse into one actionable blocker per underlying issue. For example,
`quality-ledger.json` may list `game`, `scenarios`, and `design`, but the
operator-facing ledger should emit one `quality_ledger_blocking` entry with the
source path and recovery hint. The detailed file can keep per-gate detail; the
default dashboard should not become a raw artifact browser.

`bin/rds-status <build-id>` refreshes and prints this same canonical truth before
dumping `state.json` and logs. That keeps chat/CLI status reports aligned with
the dashboard instead of reintroducing a second interpretation path.

`bin/rds-readiness` now writes its normal readiness report, refreshes the
evidence ledger, and fails if the ledger finds blocker-grade issues that the
older readiness checks missed. This keeps skill-impact failures and split-brain
truth from slipping into operator review just because QA files look green.

Pre-scaffold scenario/taste quality is also evidence-gated. `bin/rds-build`
writes `qa-scenario-gate.json` and `taste-gate.json` during the taste stage, and
readiness/evidence-ledger block `qa_scenario_gate_blocking` or
`taste_gate_blocking` if a disabled or legacy path leaves a failed gate artifact
near a terminal build. This catches generic acceptance paths and generic product
direction before scaffold instead of relying on late QA/design review to
discover that the app has no opinionated product shape.

History Imagined added two concrete guards to this contract: generic web-app
scenarios such as `Save|Submit|Create|Approve|Apply` are blocking, and PRD
promise scenarios that only search for text are blocking unless they also carry
an executable action or route expectation. A scenario must prove a user-facing
path, not merely that marketing copy exists somewhere in the DOM.

History Imagined also added three late-stage QA contracts. Truthfulness audit
fails opaque seeded/fallback data, fake spend/costs, stubbed integrations, and
placeholder workflows unless the UI discloses them. Persona UAT attempts the
review-mode operator login and then visits authenticated route families.
Workflow UAT writes an `actionGraph` with sampled route controls and click/fill
outcomes. PRD coverage compares promised route/action families against crawler,
scenario, workflow, persona, and action-graph evidence. It also maps changed
controls back to promised actions and personas, so an app cannot satisfy an
"operator approves X" PRD with only anonymous route clicks. The scenario engine
also supports `business-state` expectations, so approval/status scenarios can
require a named record to reach a named state. `rds-readiness`,
`rds-quality-ledger`, `rds-evidence-ledger`, and `rds-taste-review` all consume
these verdicts.
`rds-iterate` also embeds failing verdict details into the next provider prompt
as structured repair context, so autonomous recovery targets the concrete
product defects instead of making another generic polish pass. Each pass now
also persists an explicit `repair-plan.json` and post-QA
`repair-convergence.json`, so the loop can distinguish "the targeted blocker
closed" from "QA failed again for the same reason" before deciding whether to
run another bounded autonomous iteration or hold for operator/product review.
Scenario failures are calibrated before they reach that loop:
`scenario-verdict.json` records `assertionType`, `failureKind`, and
`recoveryHint` per failed check, plus a `failureBreakdown` summary. The repair
loop preserves those fields in both prompt context and `repair-plan.json`, so a
missing business-state transition becomes an app repair target while a brittle
selector or vague scenario can be regenerated instead of treated as product
truth.

Skill impact is now generated by the pipeline, not only by manual inspection.
`bin/rds-build` refreshes `skills/scorecard.json` after scaffold, after QA, and
before the final readiness gate; `bin/rds-iterate` refreshes it after the app
edit and again before the final ledger refresh. The scorecard verifies
materialized skill guides via `RDS_APP_DEST` and runs source-shape probes for
contract-bearing skills such as `shadcn-add`,
`browser-game-product-quality`, `playwright-canvas-snapshot`, and
`zustand-game-state`. UI builds now prove shadcn component adoption, not only
installer artifacts. Browser-game builds now prove game-product signals such as
a dominant play surface, turn/rule/state language, feedback states,
restart/replay affordances, responsive layout, and tests. A terminal build with
selected skills but no scorecard is blocked with `skill_scorecard_missing`.

Approval is also truth-gated. `bin/rds-approve` and the dashboard approve API
refresh the ledger and refuse `blocked`, `failed`, `recovering`, or `building`
verdicts. The UI may hide the active Approve button, but the server and CLI are
the actual enforcement boundary.

The dashboard exposes both forms:

- `/b/<id>/truth.json` — compact status contract for chat, fixer, and UI.
- `/b/<id>/evidence-ledger.json` — full evidence fold with gate/source detail.

The ledger also detects split-brain states:

- pending operator review with blocking QA/taste evidence remains `blocked`;
- stale `state.json`/`run.pid` combinations become `blocked` with
  `orphaned_running_state`;
- app-changing work after the latest browser evidence becomes `blocked` with
  `qa_evidence_stale`;
- taste and quality evidence that predates the latest QA/taste inputs becomes
  `blocked` with `taste_review_stale` or `quality_ledger_stale`;
- deployed artifact identity mismatches become `blocked` with
  `deploy_fingerprint_mismatch`. `bin/rds-deploy` writes
  `deploy-fingerprint.json`; `bin/rds-qa` copies that fingerprint into the QA
  iteration folder; readiness compares the two before allowing review.
- live runtime identity mismatches become `blocked` with
  `service_runtime_missing`, `service_runtime_failed`, or
  `service_runtime_stale`. Marker-enabled deploys write
  `/.well-known/rds-deploy-fingerprint.json` into the served app, curl the
  public preview for that marker, and store the result in `service-runtime.json`.
  `bin/rds-qa` snapshots that runtime proof into each QA iteration so review is
  blocked if the URL is healthy but serving a different artifact. When Zo
  credentials are available, deploy goes back through `bin/rds-zo-register` for
  matching services so the service is updated/restarted instead of silently
  adopting a stale running process.
- active fixer/iterate starts become `recovering` so operators do not spawn
  duplicate recovery loops.

`bin/rds-fix` now consults `truth.json` before the older readiness-only
fallback. Missing/stale evidence classes can trigger deterministic stage resets;
product-quality and skill-impact classes stop as diagnosis-only and require a
targeted app iteration.

Failure modes:

- **Taste review still fails after bounded auto-iteration.** The build is parked
  as failed with `taste-review.json` and `taste-iteration-prompt.md` as the
  concrete critique. Either manually iterate from the dashboard/chat, or set
  `RDS_TASTE_REQUIRED=0` for advisory-only behavior.
- **Iteration fails checks/QA/deploy.** `rds-iterate` leaves the previous
  deployed service untouched and the taste-review stage fails.

---

## State.json shape

Every transition above updates `state.json`. Canonical shape:

```json
{
  "build_id": "acme-20260425-142030",
  "mode": "green",
  "app_type": "game",
  "trigger": "inbox/acme-research.md",
  "repo_url": null,
  "prd_source": null,
  "started_at": "2026-04-25T14:20:30Z",
  "updated_at": "2026-04-25T14:37:12Z",
  "current_stage": "scaffold",
  "stages": {
    "intake":       { "status": "done",    "started_at": "…", "ended_at": "…" },
    "spec":         { "status": "done",    "started_at": "…", "ended_at": "…" },
    "taste":        { "status": "done",    "started_at": "…", "ended_at": "…" },
    "rails-init":   { "status": "done",    "started_at": "…", "ended_at": "…" },
    "scaffold":     { "status": "running", "started_at": "…" },
    "local-run":    { "status": "pending" },
    "deploy":       { "status": "pending" },
    "qa":           { "status": "pending" },
    "taste-review": { "status": "pending" }
  },
  "preview_url": null,
  "po_questions_file": "builds/acme-20260425-142030/po-questions.md",
  "error": null
}
```

Brown-field state has `mode: "brown"`, `repo_url` + `prd_source` set, and
`spec` / `rails-init` marked `skipped`.

---

## Typical end-to-end timings

- **Green-field** (small research doc, 1–2 entity spec): 20–45 minutes.
- **Green-field** (rich research, 5+ entity spec, complex routes):
  60–120 minutes.
- **Brown-field** (tight PRD, few tasks): 10–30 minutes.
- **Brown-field** (broad PRD, many tasks): 30–90 minutes.

These are order-of-magnitude estimates. Scaffold latency dominates —
anything else is rounding error.
