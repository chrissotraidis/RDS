# RDS Autonomy Layers

RDS has two agentic execution layers above the core build pipeline. Both stay
inside RDS's evidence contracts: RDS owns orchestration, Claude/Codex are
bounded workers, and the operator owns merge/approval.

- **Goal Mode** is the long-running supervisor loop for one build: refresh
  evidence, repair, redeploy, re-verify, repeat until the build is review-ready
  or a precise human blocker remains.
- **Agent Sessions** are durable operator-controlled coding-agent runs: one
  isolated git worktree, one provider, explicit lifecycle commands, never
  auto-merged.

## Goal Mode

RDS Goal Mode is the long-running supervisor layer for a build. It is modeled
after `/goal`-style agent loops, but it stays inside RDS's evidence contracts:
RDS owns orchestration, Claude/Codex are bounded workers, and the operator owns
merge/approval.

### Contract

A goal run:

- targets one build;
- writes `builds/<id>/goal.json`;
- writes detailed run artifacts under `builds/<id>/goals/<goal-id>/`;
- refreshes `quality-ledger.json`, `readiness.json`, `evidence-ledger.json`,
  and `truth.json`;
- chooses the next action from evidence, not from generic model confidence;
- uses existing primitives: `rds-fix`, `rds-iterate`, `rds-agent-start`;
- never auto-merges, auto-pushes, or approves a build.

The default objective is:

```text
Make this build review-ready.
```

### Command

```bash
bin/rds-goal <build-id> \
  --objective="Make this build review-ready" \
  --max-cycles=12 \
  --max-agent-reviews=2
```

Useful flags:

| Flag | Default | Meaning |
|---|---:|---|
| `--objective=<text>` | `Make this build review-ready.` | Human-readable goal shown in the dashboard and repair prompt. |
| `--max-cycles=<n>` | `12` | Maximum evidence -> repair -> evidence cycles before handoff. |
| `--max-agent-reviews=<n>` | `2` | Maximum isolated Claude/Codex review-worker escalations after repair cycles are exhausted. |
| `--max-minutes=<n>` | `240` | Wall-clock cap for a single goal run. |
| `--no-agent-review` | off | Disable Claude/Codex agent-session escalation. |
| `--fresh` | off | Start a fresh goal directory instead of resuming `goal.json`. |
| `--dry-run` | off | Write planned artifacts/logs without running repair actions. |
| `--provider=<claude\|codex>` | build's current | Pin the inference provider for this goal. Persists to `state.inference`, so every cycle, `rds-fix`, `rds-iterate`, and worker escalation use it. |
| `--model=<id>` | provider default | Pin the model for the selected provider (e.g. `claude-opus-4-8`). Persists to the provider's model field in `state.inference`. |

### Loop Semantics

Each cycle:

1. Refreshes canonical evidence.
2. Re-reads first-party source context: original local PRD when available,
   `spec.md`, `research.md`, `taste-brief.md`, `qa-scenarios.md`, product-owner
   questions, latest PRD/persona/workflow/truth/scenario verdicts, and latest
   repair convergence.
3. Stops successfully on `pending_review` or `approved`.
4. Runs `rds-fix` for missing/stale/deploy/runtime evidence blockers.
5. Runs `rds-iterate` for product-quality, PRD coverage, workflow, truth,
   persona, taste, design, and skill-impact blockers.
6. Refreshes evidence again.
7. Writes `turn-NNN.json` with before/after verdicts, blocker signature,
   command, prompt, logs, and produced artifacts.
8. Repeats until pass, cycle cap, time cap, or precise human handoff.

If the same blocker signature survives a turn, the next prompt explicitly tells
the builder that the blocker repeated and includes the PRD/spec/evidence context
again. Repeated blockers are escalation signals, not reasons to silently stop.

By default, rerunning `bin/rds-goal <build-id>` resumes the existing
`builds/<id>/goal.json` unless the prior goal passed/approved or `--fresh` is
provided.

If the repair loop exhausts and agent review is enabled, Goal Mode launches one
isolated worker through `rds-agent-start --mode=print`. By default it picks the
alternate provider for a second opinion. When a provider is pinned (via
`--provider` or the dashboard engine picker), the worker uses that same provider,
so an operator who switches off an exhausted provider is never bounced back onto
it. That worker runs in a git worktree and may produce a diff, but RDS does not
merge it.

#### Automatic provider fallback on usage limits

If a cycle fails because the **active** provider hit its usage/quota limit, Goal
Mode falls back to the other provider instead of burning the rest of the cycle
budget against the same wall. Detection looks for the provider's quota signature
(`usage limit` together with `try again at` or `purchase more credits`) in both
the cycle log **and** the fresh provider apply logs (`iterate-*.apply.log`,
`fixer-apply-*.log`, `fixer-*.md`) — necessary because `rds-iterate` writes the
quota text to its apply log, not stdout.

On detection, the loop:

- records the exhausted provider in `goal.json.exhaustedProviders`;
- flips `state.inference.provider` to the alternate via `apply_engine_override`
  (provider-specific model fields are preserved), so every later cycle, `rds-fix`,
  `rds-iterate`, and the escalation worker honor the switch — this overrides an
  operator pin, since the pinned provider is the one that ran out;
- appends a `provider_switch` action (`from`/`to`/`reason: usage_limit`) and emits
  a `goal_provider_switched` event;
- continues the loop on the new provider.

If **both** providers are exhausted, or the alternate's CLI is not installed, the
run stops with `status=needs_review`, `phase=provider_usage_limit`, and a
`goal_provider_limit_stop` event rather than looping uselessly.

Set `RDS_GOAL_PROVIDER_LIMIT_FALLBACK=0` to disable this and let quota failures
surface as ordinary cycle failures (default `1`). This mirrors `rds-fix`'s
`RDS_FIX_PROVIDER_LIMIT_FALLBACK`, which covers the scaffold/build stage.

### Dashboard

Build Detail Overview now includes an **RDS Goal** panel showing:

- objective;
- current status and phase;
- goal graph nodes: Goal, Evidence, Repair loop, Claude/Codex worker review,
  Operator review;
- cycle and agent-review budget;
- turn count, resume count, repeated-blocker count;
- blocker class;
- current blockers;
- recent goal actions and linked artifacts;
- an **engine** chip showing the active provider/model — tinted and annotated
  `(was <provider>)` when Goal Mode auto-switched off an exhausted provider — and
  a `provider_switch` action row rendered as `<from> → <to> · Usage Limit`.

The panel's Start/Continue button calls `POST /b/:id/goal`, which is token-gated
and audit-logged like the existing fix/iterate routes. In the dashboard, the
primary Continue RDS Goal control uses the default review-ready objective
without asking the operator to restate it; the confirmation dialog is the safety
boundary before RDS edits/redeploys the generated app.

When a build exposes a Goal/iteration action, the command center also shows a
compact **Engine** picker: a provider select (Claude Code / Codex) plus a
free-text model field (datalist-suggested, but any id such as
`claude-opus-4-8` is accepted). Continue RDS Goal forwards the choice to
`rds-goal --provider/--model`; one-off iteration writes it straight into
`state.inference` before spawning `rds-iterate`. The confirmation dialog names
the selected engine so the operator can confirm before RDS runs. This is how an
operator switches providers when one is rate-limited or pins the latest model.

### Safety

Goal Mode is intentionally more agentic than the normal build pipeline but less
free than a raw coding-agent session.

- It does not replace `rds-build`.
- It does not replace `rds-iterate`.
- It does not run two write-capable workers in the same worktree.
- It does not approve the build.
- It escalates Claude/Codex only after bounded repair cycles.
- It preserves logs, repair jobs, convergence summaries, and agent-session
  metadata for operator review.

## Agent Sessions

RDS Agent Sessions are durable operator-controlled coding-agent runs on Zo.
They do not replace the build pipeline. They give RDS a control plane for real
Claude Code and Codex workers against an existing repo, generated app, or build.

### V1 Contract

An agent session:

- creates or reuses one isolated git worktree for one task;
- launches one provider: `claude-code` or `codex`;
- records session JSON, tmux name, logs, branch, worktree, and changed files;
- exposes stop, diff, review, handoff, merge, and discard commands;
- never auto-merges or auto-pushes.

Build-attached sessions live under:

```text
builds/<build-id>/agent-sessions/<session-id>.json
builds/<build-id>/agent-sessions/<session-id>.log
```

Repo-level sessions live under:

```text
agent-sessions/<session-id>.json
agent-sessions/<session-id>.log
```

Every worktree receives `.agent-session/context.md`, giving Claude Code and
Codex the same task, build state, repo, branch, constraints, and spec excerpt
when available.

### Commands

```bash
bin/rds-agent-start \
  --provider=claude-code \
  --mode=interactive \
  --repo=/srv/rds-projects/foo \
  --task="Fix mobile nav and run tests" \
  --base-branch=main

bin/rds-agent-list
bin/rds-agent-list --build-id=<build-id>
bin/rds-agent-status <session-id>
bin/rds-agent-diff <session-id>
bin/rds-agent-stop <session-id>
bin/rds-agent-review <session-id> --provider=codex
bin/rds-agent-handoff <session-id> --to=claude-code --task="Continue from the review"
bin/rds-agent-merge <session-id> --confirm=MERGE
bin/rds-agent-discard <session-id> --confirm=DISCARD
bin/rds-agent-fixture --provider=codex
```

Attach manually:

```bash
tmux attach -t <tmux_session>
```

`merge` is local-only. It switches the original repo to the recorded base branch
and merges the session branch. It does not push.

`rds-agent-fixture` is the cheap regression check for this subsystem. It creates
a throwaway repo, starts a batch-mode session, verifies `.agent-session/context.md`
is excluded from git status, checks status/diff/discard, and removes the smoke
artifacts. It does not launch an interactive provider process.

### Dashboard

Build Detail includes an **Agent Sessions** panel on Overview. It shows provider,
mode, status, task, branch, worktree path, tmux attach command, log tail, changed
files, and review/handoff/stop/discard controls.

The top-level `/agents` page launches repo-level workers against any absolute
repo path on Zo and lists build-attached plus repo-level sessions together.

Settings shows Agent Sessions health for Claude Code, Codex, tmux, and git
worktree support.

### Chat Contract

Build chat recognizes requests like:

- `Start a Claude worker to fix this.`
- `Start a Codex worker to review the diff.`
- `Launch Claude Code agent session for this build.`

Chat proposes a confirmation-gated action card. Model output alone never
launches a worker.

### Safety Rules

- Default to one worktree per task.
- Never run two write-capable agents in the same worktree.
- Never auto-merge.
- Never auto-push.
- Preserve logs after discard.
- Require explicit confirmation for launch, stop, discard, merge, review, and handoff.
- Treat the RDS repo itself as read-only unless the task explicitly says to modify RDS.

Provider adapters live in `lib/rds-agents/providers/`. Dashboard code shells out
to `bin/rds-agent-*`; it does not know provider command shapes.
