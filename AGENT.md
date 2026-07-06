# AGENT.md — RDS Operator Contract

This file is for coding agents operating RDS. Humans should start with
`README.md`.

## Core Job

RDS turns a product brief, PRD, research note, or existing repo into a running
preview app with inspectable evidence.

As the operator agent, you do three things:

1. Classify the request as green-field or brown-field.
2. Launch the correct `bin/rds-*` command.
3. Report the preview URL, status, blockers, and next action from RDS evidence.

Do not reimplement the pipeline by hand.

## Operating Rules

- Treat RDS as the tool, not the app being built. Do not modify this repo during
  ordinary builds.
- Build work belongs in `builds/<id>/` and the generated app destination, not
  in the RDS source tree.
- Run one build at a time unless the operator explicitly accepts concurrency
  risk.
- Do not write to Notion, email, Slack, GitHub, or other external systems unless
  the operator explicitly asks.
- Do not skip stages. Brown-field builds automatically skip green-field-only
  stages; that is the supported exception.
- Do not approve, merge, push, publish, or tear down production resources
  without explicit human intent.

If the operator asks you to maintain RDS itself, that is RDS development work.
Read `README.md`, `docs/README.md`, and the relevant subsystem docs before
editing.

## Build Modes

### Green-Field

Use this when the operator gives a research note, PRD, prompt, Notion page, or
dashboard upload without an existing repo.

```bash
./bin/rds-build "<local-input-path>" \
  --app-dest="<absolute-path-outside-rds>" \
  --stack="<stack-id>" \
  --app-type="<type>"
```

If the input is a Notion URL, export it to a local markdown file under `inbox/`
first. Shell subprocesses cannot rely on the host agent's Notion session.

### Brown-Field

Use this when the operator gives both an existing repo and a PRD/change request.

```bash
./bin/rds-build \
  --repo="<normalized-repo-url>" \
  --prd="<local-or-raw-prd-path>" \
  --app-dest="<absolute-path-outside-rds>" \
  --branch="<branch-if-specified>" \
  --stack="<stack-id>" \
  --app-type="<type>"
```

Do not clone the repo yourself. `bin/rds-build` owns clone/intake.

## Destination Paths

Generated apps should live outside the RDS source checkout. If the operator does
not provide `--app-dest`, choose a clear path under `RDS_PROJECTS_DIR` when set,
or another obvious projects directory on the host.

Never use a path inside the RDS repo as the generated app destination.

## Stack and App Type

Use canonical stack ids when possible:

- `rails-web`
- `nextjs-fullstack`
- `python-ai-service`
- `astro-thin-web`
- `web-3d`
- `game-engine`
- `game-asset-pipeline`
- `mobile-native`
- `browser-extension`

Legacy aliases such as `rails`, `nextjs`, and `react-native` may still resolve,
but new instructions should prefer canonical ids. `react-spa` is registered but
deferred for new V1 builds.

Set `--app-type` when the product kind is clear: `game`, `website`, `web-app`,
`dashboard`, `internal-tool`, `prototype`, or `hack`.

## Monitoring

Use RDS state, not guesses.

```bash
./bin/rds-status
./bin/rds-status <build-id>
tail -n 100 builds/<id>/logs/<stage>.log
```

For an in-flight build, checking roughly every 30 seconds is enough. Do not spam
the operator with unprompted progress unless they asked for ongoing updates.

## Failure Handling

When a build fails:

1. Read `builds/<id>/state.json`.
2. Read the current stage log.
3. Summarize the failure plainly.
4. Propose one next action: resume, patch, run Goal Mode, or ask for a missing
   decision/credential.

Do not loop indefinitely. If the same retry fails twice, stop and report the
pattern.

Useful recovery commands:

```bash
./bin/rds-resume <build-id> --detach
./bin/rds-fix <build-id>
./bin/rds-goal <build-id> --objective="Make this build review-ready"
```

Goal Mode is the preferred path when the operator says to keep going, make the
build review-ready, or repair a product-quality gap.

## Completion Report

Only report a build complete when all stages are `done` or intentionally
`skipped`, and `preview-url.txt` contains a real URL or the build is explicitly
local-only.

Reply with:

- build id;
- green-field or brown-field;
- preview URL;
- elapsed time when available;
- PO questions or human blockers;
- teardown command when relevant.

Do not call a failed build complete.

## Status Questions

When the operator asks:

| Request | Use |
|---|---|
| "status?" | `./bin/rds-status` |
| "what broke?" | `state.json` plus the failed stage log |
| "preview URL?" | `cat builds/<id>/preview-url.txt` |
| "resume/retry" | `./bin/rds-resume <build-id> --detach` |
| "pause" | `./bin/rds-pause <build-id>` |
| "fix this" | `./bin/rds-fix <build-id>` or Goal Mode |
| "keep going" | `./bin/rds-goal <build-id>` |

## RDS Development Work

When changing RDS itself:

- keep runtime data out of commits;
- update docs only where they are the source of truth;
- run `./bootstrap/verify.sh --fresh-clone` for public-source changes;
- run `./bootstrap/verify.sh` for installed-host changes;
- run `./bin/rds-selftest` for dashboard changes;
- run `./bin/rds-quality-fixtures --keep-going` before changing QA, readiness,
  taste review, skill defaults, or product-quality gates.

Detailed references:

- `docs/CHAT_CONTRACT.md` — chat patterns and dashboard launch behavior.
- `docs/PIPELINE.md` — stage-level behavior and evidence files.
- `docs/AUTONOMY.md` — Goal Mode and Agent Sessions.
- `docs/TROUBLESHOOTING.md` — known failures and recovery paths.
