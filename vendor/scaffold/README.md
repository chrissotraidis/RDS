# Scaffold

[![Built for Claude Code](https://img.shields.io/badge/built%20for-Claude%20Code-6F4CEB)](https://claude.com/claude-code)

**Scaffold compiles a product spec into an autonomous build environment
that [Claude Code](https://claude.com/claude-code) can execute task-by-task,
under budget, with deterministic verification gates at every step.**

```
spec.md  ──►  scaffold.sh  ──►  project/  ──►  ./launch-build.sh --auto --batch
                                                    │
                                                    ├── one Claude session per task
                                                    ├── each task must pass a gate
                                                    └── runbook grows as tasks complete
```

**New here?** Skim [What Scaffold does](#what-scaffold-does), then run
[Quickstart](#quickstart).
**Ready to run a build?** Jump to [Quickstart](#quickstart) and
[The build loop](#the-build-loop).
**Curious how it works?** Read [How it works](#how-it-works) and
[Behavioral verification](#behavioral-verification-beats-structural-checks).
**Want to extend it?** See [Recipes, domains, personas](#recipes-domains-personas)
and the [`library/`](library/) directory.

---

## What Scaffold does

You write a spec. Scaffold classifies it (recipe, domain, persona), breaks it
into a dependency-ordered task DAG, emits per-task verification gates, and
hands the whole thing to a harness (`launch-build.sh`) that runs one isolated
Claude session per task.

The thesis is narrow and stubborn: **prompts are suggestions, gates are not.**
Most AI-coding harnesses try to make agents reliable by writing longer prompts.
Scaffold takes a different road — an agent can fail a task, but it cannot mark
a task done without a passing deterministic check (HTTP probe, seed load, test
run, migration check, route smoke). Structural checks (did the file get
written?) are treated as necessary but not sufficient. Behavioral checks (can
a user reach this page through normal navigation?) are required.

The closest analogies:

- **`make` for AI agents.** The spec compiles to a task DAG; each task has a
  verification rule; the build stops when a rule fails; the agent cannot
  self-declare completion.
- **CI for a spec.** Guidance without a check is a suggestion, and suggestions
  drift. Every task ships with the shell command that proves it.
- **A bootstrapper, not a template engine.** It composes recipes + domains +
  personas against your spec; it doesn't stamp out a fixed tree.

## What Scaffold is not

- **Not a code generator.** It doesn't write your app. It writes the
  environment your coding agent builds the app inside.
- **Not a chat UI or copilot.** Scaffold runs on the command line and hands
  off to Claude Code. It has no chat surface of its own.
- **Not a template engine.** Output is not a fixed file tree — it's a pipeline
  of tasks and gates composed from the recipe, detected stacks, and spec.
- **Not opinionated about your stack.** Recipes cover Rails, Rails-API, mobile
  (iOS/Android/RN), CLI, and bot agents. Adapters render framework-specific
  proofs from shared verification primitives.

---

## Quickstart

You need Ruby (stdlib only, no gems), `bash`, `git`, and the
[Claude CLI](https://claude.com/claude-code) on your `$PATH`.

Optional, only needed for specific flags:
- [`codex` CLI](https://github.com/openai/codex), authenticated — required
  by `--codex-review` / `--codex-review-strict`; used opportunistically by
  `--codex-preflight-review` (falls back to "unavailable" if missing).

```bash
# Auto-detect recipe + domain from the spec
./scaffold.sh path/to/spec.md --output ./my-project

# Explicit recipe + domain
./scaffold.sh spec.md --recipe web_app --domain productivity --output ./my-project

# Multi-stack (primary + supporting recipes)
./scaffold.sh spec.md --recipe web_app,mobile_app --output ./my-project

# With a product wiki — inlines real entity names, routes, and risk flags
# into each task's dossier at build time
./scaffold.sh spec.md --wiki ./product-wiki --output ./my-project

# Fast mode: skip rule extraction (step 3) and task generation (step 5)
./scaffold.sh spec.md --output ./my-project --skip-rules --skip-tasks

# Fully offline: also skip the Claude-backed classifier in step 1
SCAFFOLD_SKIP_CLAUDE_CLASSIFY=1 ./scaffold.sh spec.md --output ./my-project \
  --recipe web_app --skip-rules --skip-tasks
```

Then build:

```bash
cd my-project
./launch-build.sh --auto --batch                 # one Claude session per task
./launch-build.sh --auto --batch --codex-review  # + post-verification review
./launch-build.sh                                # interactive: drive with /build
```

Watch `bin/task status` for progress; `git log` for one commit per completed
task; `runbook.md` for what the app can now do.

---

## How it works

```
┌────────────────────────────────────────────────────────────────────────────┐
│                                                                            │
│  spec.md                                                                   │
│    │                                                                       │
│    ▼                                                                       │
│  1. Classify ──► 2. Configure ──► 3. Extract rules ──► 4. Generate         │
│     recipe         config.yml        (optional Claude      CLAUDE.md       │
│     domain         verify + hooks    call)                                 │
│     persona                                                                │
│                                                                            │
│                                                                    ──►     │
│  5. Break into tasks ──► 6. Copy templates ──► 7. Generate ──► 8. Finalize │
│     tasks.json +            launch-build.sh      settings.json    runbook  │
│     task-details/           bin/task +           (Claude Code     gitignore│
│     (one per task)          slash commands       permissions)     git init │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

Each step is owned by a small Ruby script in [`lib/`](lib/):

| Step | Script | What it produces |
|------|--------|------------------|
| 1. Classify | [`lib/classify_spec.rb`](lib/classify_spec.rb) (Claude) or [`lib/match_library.rb`](lib/match_library.rb) (keyword fallback) | Recipe, domain, persona selection |
| 2. Configure | [`lib/generate_config_yml.rb`](lib/generate_config_yml.rb) | `config.yml` — verification, hooks, MCP capabilities |
| 3. Extract rules | [`lib/extract_rules.rb`](lib/extract_rules.rb) | Architectural constraints from the spec |
| 4. CLAUDE.md | [`lib/generate_claude_md.rb`](lib/generate_claude_md.rb) | Lean project index — spec/tasks/config pointers |
| 5. Tasks | [`lib/render_prompt.rb`](lib/render_prompt.rb) → `claude -p`, validated by [`lib/validate_tasks.rb`](lib/validate_tasks.rb); [`lib/generate_task_skeleton_chunks.rb`](lib/generate_task_skeleton_chunks.rb) for specs ≥50KB | `tasks.json` (thin skeleton; per-task bundles are hydrated later by `bin/task prepare`) |
| 6. Templates | [`templates/`](templates/) | `launch-build.sh`, `bin/task`, slash commands |
| 7. Settings | [`lib/generate_settings_json.rb`](lib/generate_settings_json.rb) | Framework-appropriate Claude Code permissions |
| 8. Finalize | `scaffold.sh` | Runbook template, `.gitignore`, `git init` |

Large specs (≥50KB) route through a two-phase task generator: thin skeletons
first, details hydrated in batches. Malformed Claude output is retried,
chunked by spec section, and — if all else fails — preserved in
`.scaffold-debug/` so the failure is inspectable, not a ParserError.

### Optional: product wiki

`--wiki DIR` is a second input alongside the spec. A wiki is a markdown tree
containing the product's canonical entity model, routes, risk register, and
design decisions. When supplied, it shapes the build in four places:

- Step 2 writes `wiki_bridge.wiki_dir` into `config.yml`
- Step 5 passes wiki context into the task-generation prompt (entity names
  bleed into task titles and `done_when` prose)
- At build time, `bin/task dossier` pre-resolves each task's
  `entities_touched` against the wiki, inlining real field names and
  `⚠️ Risk Flag` entries into the context the agent reads
- After a successful build, `publish_to_wiki.rb` can push evidence back

The wiki is strictly optional. The spec alone is enough; the wiki just
reduces how much the agent has to guess.

---

## Behavioral verification beats structural checks

The pervasive failure mode in AI-assisted builds is **verified green, broken
for users**: all 38 tasks pass, every model file exists, every route resolves,
but navigation is broken, buttons are dead, and the feature works only at a
direct URL nobody knows.

Scaffold rejects structural-only proof. Every task's `done_when` has to encode
observable behavior, and the harness ships the shell command that checks it.

```
BAD:  "Survey report page displays chart with category averages"
GOOD: "Coach visits client page, clicks 'Survey Imports', sees list.
       Clicks import row, sees 'View Report' link. Clicks it, sees chart."
```

### Three verification layers

| Layer | What it proves | Source |
|-------|----------------|--------|
| **Task-local gates** | Behavior this task claims to add | `.scaffold/task-details/{position}.json` |
| **Global gates** | Project-wide safety net (boot, routes, migrations, tests) across all detected stacks | `config.yml` |
| **Runtime-backed checks** | HTTP flows against a harness-owned running app — not a stale `localhost:3000` | `launch-build.sh` + `APP_BASE_URL` |

Each verification command is a shell primitive — nothing clever:

```bash
# Page contains expected content
curl -sf "$APP_BASE_URL/clients/1" | grep -q "Alice Johnson"

# Navigation link exists
curl -sf "$APP_BASE_URL/" | grep -q 'href="/clients/'

# API returns valid JSON
curl -sf "$APP_BASE_URL/api/users" | python3 -c "import sys,json; d=json.load(sys.stdin); assert len(d)>0"

# Form endpoint accepts POST
curl -sf -X POST "$APP_BASE_URL/sessions" -d "email=admin@example.com&password=password" \
  -o /dev/null -w "%{http_code}" | grep -q "^[23]"
```

Task bundles describe what must be proven; **adapters** render the right
command for Rails, Node, Python, iOS, Android, or Flutter. The harness owns
runtime startup on a free port and exports `APP_BASE_URL` so verification
runs against its own server, not whatever happens to be up.

Optional [Codex review](https://github.com/openai/codex) adds a fourth,
slower layer after deterministic verification passes.

---

## The build loop

`launch-build.sh` runs one task per fresh Claude session — no shared memory
between tasks. State lives on disk: `tasks.json`, `config.yml`, `runbook.md`,
`.scaffold/task-details/`, git history.

### Modes

```bash
./launch-build.sh                     # interactive — opens Claude, you type /build
./launch-build.sh --auto              # one task, then stop
./launch-build.sh --auto --batch      # all tasks, one session each (recommended)
./launch-build.sh --headless          # non-interactive, CI-friendly
```

### Flags

| Flag | Default | What |
|------|---------|------|
| `--max-turns N` | 150 | Max tool invocations per task |
| `--max-budget USD` | 10.00 | Max API spend per task |
| `--codex-preflight-review` | off | Advisory Codex review during `bin/task prepare`, injected into the executor prompt (requires authenticated `codex` CLI; falls back to unavailable if missing) |
| `--codex-review` | off | Post-verification Codex review + bounded remediation (requires authenticated `codex` CLI; `launch-build.sh` exits at startup if missing) |
| `--codex-review-strict` | off | Treat unresolved review findings as blockers (same `codex` requirement as `--codex-review`) |

### What happens per task

1. `bin/task next` returns the next eligible task.
2. `bin/task prepare` builds the task bundle — implementation guidance,
   verification primitives, optional Codex preflight review.
3. `bin/task dossier {position}` prints the consolidated context — `done_when`,
   workflow gates, predecessor runbook in dependency-closure order, wiki
   entity excerpts + risk flags, verification commands. The agent reads this
   before writing a line of code.
4. A fresh Claude session implements the task, specialist skills activated
   from task labels (e.g., `integration` → integration-specialist skill).
5. The harness starts an isolated runtime on a free port, exports
   `APP_BASE_URL`, runs task-local + global verification.
6. On failure, the harness classifies by stage and may run one bounded
   remediation pass before stopping. Optional Codex review adds another
   bounded remediation loop.
7. On success, the runbook entry is appended; task is marked done; commit
   lands as `Task {position}: {title}`.

The agent can also invoke `bin/task verify {position} --skip-runtime-deps`
during iteration — a TDD-style probe. Telemetry splits these
agent self-verifies from harness retries so the attempt counter reflects real
struggle, not cautious iteration.

### Iterating on the spec

After the initial build, `spec.md` will change — new features, refined
contracts, dropped features. `bin/task sync` compiles spec-level edits
into task-level proposals:

```bash
git add spec.md && git commit -m "spec: add password reset flow"
bin/task sync                      # produces .scaffold/sync-proposal.md
# review + edit the proposal (accept | reject | edit per change block)
bin/task sync --apply              # mutates tasks.json, commits
bin/task sync --show-drift         # audit: completed tasks whose probes no longer pass
```

Key properties:

- Completed tasks are immutable — changes affecting built work become
  new pending tasks via `inject-against-completed`
- Every proposal block carries provenance (the exact spec diff hunk)
  and a confidence level; medium/low-confidence entries are double-
  sampled with a critic pass before the proposal is written
- Apply-time cycle detection + transitive reduction keep the
  `depends_on` graph minimal
- Dirty-spec gate refuses uncommitted `spec.md` (override with
  `--allow-dirty-spec`); batched-sync warning fires when >10 spec
  commits have accumulated since last sync

Full reference: **[`docs/sync.md`](docs/sync.md)** — the five
classifications with examples, proposal-file anatomy, flag surface,
apply semantics, and a cookbook for common iteration scenarios.

---

## Recipes, domains, personas

Three dimensions of classification live in [`library/`](library/).

- **Recipes** ([`library/recipes/`](library/recipes/)) — what kind of software.
  `web_app`, `api_service`, `mobile_app`, `cli_tool`, `bot_agent`,
  `landing_page`, `generic`. Each recipe specifies the stack, verification
  adapters, guidance sections, and finalization commands.
  [`web_app.yml`](library/recipes/web_app.yml) is the canonical example.
- **Domain types** ([`library/domain_types/`](library/domain_types/)) — what
  problem space. `productivity`, `fintech`, `health`, `education`, `creative`,
  `marketplace`, `analytics`, `social`, `game`, `iot`, `content`, `service`,
  `generic`. Shapes CLAUDE.md emphasis, watch-for lists, domain terminology.
- **Personas** ([`library/personas/`](library/personas/)) — who's planning.
  `software_architect`, `testing_specialist`, `domain_expert`,
  `frontend_engineer`, `qa_analyst`, `general_analyst`. Influences the task
  breakdown perspective; does not alter runtime behavior.

Multi-recipe is supported: the first recipe is primary (drives config);
additional recipes contribute guidance sections. A Rails + iOS project uses
`--recipe web_app,mobile_app`.

To author a new recipe, copy an existing YAML from `library/recipes/`, edit
its keywords, framework, verification adapters, and section guidance, then
run a dry-build against a sample spec:

```bash
./scaffold.sh sample-spec.md --recipe your_recipe --output /tmp/test --skip-tasks --skip-rules
cat /tmp/test/config.yml   # verification wired correctly?
cat /tmp/test/CLAUDE.md    # guidance sections present?
cat /tmp/test/.gitignore   # stack-appropriate ignores?
```

---

## Honest limitations

- **Output is only as good as the spec.** Vague specs produce vague tasks.
  Scaffold will try — the task generator retries and chunks — but it cannot
  manufacture clarity that isn't there. If the spec doesn't say what "done"
  means, neither will `done_when`.
- **It costs money.** Each task is a Claude session. Budgets are bounded per
  task (`--max-budget`, default $10) but a 30-task build can run $30–$200
  depending on spec size and retry pressure.
- **Non-determinism is real.** Two runs against the same spec produce
  different task breakdowns. Gates make task-level outcomes reproducible;
  they don't make plans identical. Commit `tasks.json` and treat it as code.
- **Stacks supported are the stacks in `library/recipes/`.** No Go, Elixir,
  Rust, or Java recipe yet. Recipes are stdlib-Ruby YAML + ERB — contributions
  welcome.
- **The harness assumes git.** Every task is a commit; the runbook is rebuilt
  from completed-task metadata. Non-git workflows are not supported.
- **Claude CLI is required.** Scaffold shells out to the `claude` binary for
  classification, rule extraction, task generation, and mockup generation.
  No API key means no run.

---

## Deeper reading

The README is a router. Details live next to the code:

- **Pipeline orchestrator:** [`scaffold.sh`](scaffold.sh)
- **Build harness:** [`templates/launch-build.sh`](templates/launch-build.sh)
- **Task state manager:** [`templates/bin/task`](templates/bin/task)
- **Task schema + validator:** [`lib/validate_tasks.rb`](lib/validate_tasks.rb)
- **Verification adapters:** [`lib/generate_config_yml.rb`](lib/generate_config_yml.rb)
- **Task generation prompts:** [`prompts/`](prompts/)
- **CLAUDE.md template:** [`templates/CLAUDE.md.erb`](templates/CLAUDE.md.erb)
- **Smoke test harness:** [`test/smoke.rb`](test/smoke.rb)

### Mock mode (optional)

Generate an interactive HTML mockup from the spec before writing any code.
Collect stakeholder feedback in `mockup-feedback.md`, feed it back to update
the spec, regenerate tasks + mockup, iterate until approved.

```bash
./scaffold.sh spec.md --output ./my-project --mock
./scaffold.sh --feedback mockup-feedback.md --output ./my-project --mock
```

The mockup is a single HTML file (Tailwind CDN + Alpine.js, no build step).

---

## Contributing

Scaffold is pre-1.0 and changing actively. Before submitting a PR:

```bash
ruby test/smoke.rb             # fast tier (runs in CI)
SCAFFOLD_SMOKE_FULL=1 ruby test/smoke.rb   # full tier (calls Claude; local-only)
```

Recipes, domains, and personas are all stdlib-Ruby YAML. No gems, no bundler
— that constraint is load-bearing and won't change.

## License

MIT. See `LICENSE`.
