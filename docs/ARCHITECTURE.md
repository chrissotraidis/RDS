# RDS Architecture

> Why RDS exists, what owns each responsibility, and where to make changes.
> Read `docs/COMPONENTS.md` for component import/upgrade details and
> `docs/PIPELINE.md` for stage-level behavior.

## Summary

RDS is a monolithic orchestration repo cloned onto Zo Computer. It turns a
green-field research prompt or a brown-field repo + PRD into a running preview
app by coordinating vendored build components, stack hooks, Zo services,
Playwright QA, taste review, and a bounded repair/iteration loop.

The repo is monolithic by design. Zo needs one durable checkout that contains
the harness, docs, prompts, stacks, and vendored component copies. That keeps
runtime behavior reproducible and makes upstream component upgrades explicit.

## Agent Sessions

Agent Sessions are a separate operator-controlled execution layer beside the
main build pipeline. They let RDS launch Claude Code or Codex against a build's
generated app or any existing repo on Zo without hiding the process inside chat.

The architecture is intentionally conservative: dashboard and chat create
confirmation-gated requests, `bin/rds-agent-*` owns worktree/session lifecycle,
provider command shapes live in `lib/rds-agents/providers/`, and session
records/logs live under `agent-sessions/` or `builds/<id>/agent-sessions/`.
Work happens in git worktrees; merge is local-only and never pushes. See
`docs/AUTONOMY.md`.

## Runtime Boundaries

```text
Zo Computer
├── RDS repo
│   ├── bin/                 # orchestration CLI
│   ├── dashboard/           # operator UI and action API
│   ├── vendor/              # Wiki, Scaffold, Rails starter
│   ├── stacks/              # runtime/build/deploy profiles
│   ├── builds/<id>/         # durable build state, logs, QA artifacts
│   └── docs/                # operating and upgrade docs
├── /srv/rds-projects/<slug>
│   └── generated app        # app destination, outside RDS repo
├── PostgreSQL 15            # local DB, started/verified by service entrypoint
└── Zo hosted services
    ├── rds                  # dashboard
    └── rds-<build>          # generated app previews
```

RDS owns orchestration. Generated apps live outside the RDS repo. Zo owns
external HTTP exposure through registered user services.

## Runtime Data Layout

RDS can run with mutable state inside the source checkout for a simple local
install, but production installs should keep source and runtime data separate.
That lets the Git repo stay a clean source tree while builds, uploads, events,
dashboard chat, and review state persist on the host.

Runtime data written during normal operation:

- `builds/<id>/` — build state, logs, deploy snapshots, QA artifacts, service
  metadata, screenshots, and generated review evidence;
- `inbox/` — operator-provided prompts, PRDs, research docs, uploads;
- `dashboard/chat/` — build-scoped dashboard messages and attachments;
- dashboard state files: dismissals, refresh metadata, audit logs;
- `.env`, `.rds-installed`, local model config;
- generated apps, normally outside the RDS repo entirely.

`.gitignore` already keeps these out of the repository. The production
recommendation is an instance-owned external data root:

```text
/opt/rds/                    # source checkout, example
/var/lib/rds/                # private runtime data, example
  builds/
  inbox/
  dashboard-chat/
  dashboard-state/
  events.jsonl
```

Configured with `RDS_BUILDS_DIR`, `RDS_INBOX_DIR`, `RDS_DASHBOARD_CHAT_DIR`,
`RDS_DASHBOARD_STATE_DIR`, and `RDS_EVENTS_PATH`.

Migrating an existing live instance: back up first, copy with
`rsync -a --dry-run` before `rsync -a`, set the env vars, restart the
dashboard/service, then confirm `rds-status` sees existing builds, the
dashboard loads history and chat, dismissal state is written outside the
checkout, and `./bin/rds-selftest` passes. Do not delete repo-local runtime
data until the external root is verified and backed up.

## Major Subsystems

| Subsystem | Files | Responsibility |
|---|---|---|
| CLI harness | `bin/rds-*`, `bin/lib/*` | Build lifecycle, state, logs, deploy, QA, taste, fix, resume, notify. |
| Dashboard | `dashboard/src/server.ts` | Operator UI, build chat, action cards, live logs, QA views, settings, component inventory. |
| State/events | `builds/<id>/state.json`, `events.jsonl`, `bin/rds-event` | Durable source of truth for stage status, review state, previews, events, and liveness. |
| Components | `vendor/*`, `stacks/*`, `prompts/*` | Imported build substrate and stack-specific behavior. |
| Recovery | `bin/rds-watchdog`, `bin/rds-fix`, `bin/rds-resume`, `bin/rds-iterate` | Detect stuck/failed builds, apply safe fixes, resume stages, and run post-build changes. |
| Verification | `bin/rds-qa`, `bin/rds-qa-verdict`, `bin/rds-mockup`, `bin/rds-taste-review`, `lib/rds-qa/*` | Browser QA, spec coverage, reference-screen fidelity, product-type verdicts, and quality iteration prompts. |
| Agent Sessions | `bin/rds-agent-*`, `lib/rds-agents/providers/*` | Operator-controlled Claude Code/Codex workers in isolated git worktrees with durable tmux/log/diff state. |

## Build Flow

Green-field:

```text
research/input
  → intake
  → Wiki or fallback spec
  → taste brief
  → build plan
  → stack init
  → Scaffold task harness
  → local run
  → Zo deploy
  → Playwright QA
  → taste review
  → bounded iteration if needed
  → pending review
```

Brown-field:

```text
repo + PRD
  → clone repo
  → PRD becomes spec
  → taste brief
  → build plan
  → Scaffold task harness
  → local run
  → Zo deploy
  → Playwright QA
  → taste review
  → bounded iteration if needed
  → pending review
```

Wiki and template init are skipped in brown-field mode. Everything after the
spec exists is shared.

## Why Vendor Components?

RDS vendors Wiki, Scaffold, and the Rails starter instead of
fetching them dynamically because:

- a Zo install should be one clone plus bootstrap;
- submodule setup is easy to miss and hard for agents to repair reliably;
- RDS patches can be applied during bootstrap;
- GitHub diffs show exactly what changed when a component is upgraded;
- builds remain reproducible.

The tradeoff is explicit upgrade work. `docs/COMPONENTS.md` is the contract for
that work.

## State Model

Each build owns `builds/<id>/`.

Important files:

- `state.json` — canonical build status, stack, app type, inference provider,
  display name, review state, preview URL, current stage, and per-stage status.
- `events.jsonl` — durable timeline of stage, QA, fix, notify, and review
  events.
- `logs/<stage>.log` — durable stdout/stderr for each stage.
- `playwright/iter-NNN/` — QA summaries, screenshots, gaps, spec verdicts, and
  type-specific verdicts.
- `preview-url.txt` — latest preview URL.
- `service.json` — Zo service metadata when registered.
- `actions/action-*.json` — dashboard chat/action state.

Live service logs under `/dev/shm/` are useful for runtime debugging but are
volatile. Durable build evidence lives under `builds/<id>/`.

Logging principles:

1. Raw subprocess logs are immutable evidence. RDS never rewrites Codex,
   Claude, Rails, Playwright, or framework output in place.
2. Derived metadata belongs beside logs, not inside them.
3. Every operator-visible artifact has one durable path and one dashboard link.
4. Events are for timeline facts; logs are for verbose evidence.
5. Volatile `/dev/shm` logs are acceptable only as mirrors, never as the only
   copy. A build should be diagnosable from `builds/<id>/` even after a host
   restart.

## Deployment Model

Zo runs inside gVisor. RDS does not use Docker or systemd.

Generated apps boot natively on a local port selected from
`RDS_LOCAL_PORT_RANGE_START..RDS_LOCAL_PORT_RANGE_END`. `bin/rds-deploy` then
registers a Zo HTTP service through `bin/rds-zo-register` and waits for the
public URL to respond before QA continues.

Deploy targets:

- `zo` — default; durable public Zo service.
- `none` — local-only preview for harness debugging.
- `teardown` — stop the app preview process and clean preview metadata.

`RDS_ZO_AUTO_REGISTER=0` restores the legacy pending-sentinel path for
debugging only. Normal builds should end with a real `https://*.zocomputer.io`
URL.

## Dashboard Runtime

The dashboard is a managed Zo HTTP service named `rds`. Its entrypoint
is `bin/rds-service-entrypoint`, which:

1. verifies or starts PostgreSQL 15;
2. optionally starts the watchdog;
3. claims port 4000 from a stale listener if needed;
4. launches `dashboard/src/server.ts` with Bun.

The dashboard implements its own HTTP Basic Auth gate. All routes except
`/healthz` require `RDS_DASHBOARD_PASSWORD`; if the password is unset, the
dashboard returns `503` rather than serving an unprotected control surface.
Write endpoints also require `X-RDS-Token`.

## Operator Console Contract

Build Detail is an operating surface, not a raw artifact browser. The first
screen should answer, in order:

1. Can I open the app?
2. Is RDS still running, blocked, paused, or awaiting review?
3. What should I press next?
4. Why is that the correct next action?

Raw state, source documents, logs, and per-gate evidence stay reachable, but
they live behind disclosures or secondary tabs unless they are needed to choose
the next action. For blocked builds, the primary action is Goal Mode. One-off
iteration and chat are secondary controls.

Use operator-facing names on the default page. Internal artifact names like
"quality ledger", `truth.json`, and `evidence-ledger.json` can appear in raw
data links or docs, but the main UI should translate them into what the operator
needs to know: QA evidence, approval blockers, source files, and next action.

Pipeline stage chips must always update a visible stage inspector. Do not wire
stage controls to content hidden inside a closed disclosure; that makes the UI
look broken even when the data exists.

## Extending RDS

Use the narrowest extension point that matches the change:

- new upstream build substrate → `vendor/<component>/` plus
  `docs/COMPONENTS.md`;
- new runtime/framework → `stacks/<id>/manifest.json`, `init.sh`,
  `local-run.sh`, and optional template under `vendor/`;
- new product-quality bar → `bin/rds-taste`, `bin/rds-qa`,
  `bin/rds-taste-review`, and `lib/rds-qa/`;
- new operator action → dashboard action API plus `bin/rds-*` command;
- new failure recovery → `bin/rds-fix` deterministic diagnosis/apply path and
  `docs/TROUBLESHOOTING.md`.

Avoid scattering direct calls to a new pipeline across dashboard code and shell
scripts. Add one clear hook or command, document it, and add a smoke test.

### Design Evidence Contract

Design inputs are first-party product requirements, not decorative context.
When intake/spec/taste mention Stitch, mockups, screenshots, Figma, or visual
references, downstream verification must prove three things before review:

1. the build preserved the reference assets or an explicit analog;
2. the live preview was compared against the reference surface;
3. the latest QA iteration has a `design-review.json` verdict.

Missing or skipped design review is a blocker. A copied `mockup-screens/`
folder, whether in the app or build evidence tree, without live-vs-reference
evidence is also a blocker. This keeps RDS from declaring quality on paperwork
while the actual app ignores the design brief.

## Non-Goals

- Multi-tenant SaaS.
- Parallel build scheduler.
- General CI replacement.
- Automatic upstream component updating.
- Docker-based deployment.
- Silent public-facing mutations without operator review.
