# Pipeline Components

> How RDS vendors, calls, and upgrades the systems it is built on. Read this
> before refreshing Wiki, Scaffold, the Rails starter, or adding a
> new referenced pipeline.

## Component Contract

RDS is the orchestration layer. It does not fetch the latest Wiki, Scaffold, or
template code at build time. Every build uses the copies and manifests checked
into this repo at the moment the build starts.

That contract is deliberate:

- builds are reproducible from the RDS repo;
- Zo can run RDS from one clone without submodule setup;
- upgrades are explicit, reviewable diffs;
- in-flight builds are not changed by upstream churn.

The cost is drift: when Wiki, Scaffold, or a template changes outside
RDS, someone must import the new version into this repo, verify RDS still works,
and push that RDS change.

RDS itself is hosted at `https://github.com/chrissotraidis/RDS`.

## Components

| Component | Location | Runtime role | Upgrade scope |
|---|---|---|---|
| Wiki | `vendor/wiki/` | Green-field research-to-spec path. Loaded by `bin/rds-spec` as a Claude plugin when the selected spec provider is Claude. Codex builds use a deterministic fallback unless `RDS_SPEC_CODEX_INFER=1`. | Future green-field specs only. Brown-field builds use the supplied PRD. |
| Scaffold | `vendor/scaffold/` | Core implementation planner and task runner. `bin/rds-build` calls `vendor/scaffold/scaffold.sh`, which writes `launch-build.sh`, `CLAUDE.md`, `.claude/`, `.scaffold/`, and task plans into the generated app. | Future builds after Scaffold is invoked. In-flight builds keep their copied harness. |
| Rails starter | `vendor/rails-starter/` | Rails green-field starter. `bin/rds-rails-init` copies it into the app destination, then runs `bin/template-setup --app-name --yes`. | Future Rails green-field apps. Existing generated Rails apps do not update automatically. |
| Stack manifests | `stacks/<id>/manifest.json` | Select stack status, init hook, Scaffold recipe, local runner, health path, service entrypoint, and Zo service env. | Future builds for that stack. Existing builds keep their recorded `state.json.stack`. |
| RDS harness | `bin/rds-*`, `bin/lib/*`, `dashboard/` | Owns state, events, deploy, QA, taste review, chat actions, watchdog/fixer, notifications, and the operator UI. | New runtime behavior after the managed `rds` service or watchdog is restarted. |

## How the Components Connect

Green-field build:

1. Operator submits research through chat or the dashboard.
2. RDS writes a build directory under `builds/<id>/` and a generated app path
   outside the RDS repo, normally `/srv/rds-projects/<slug>`.
3. `bin/rds-spec` turns research into `builds/<id>/spec.md` using
   Wiki or the Codex fallback.
4. `bin/rds-taste` appends a product-quality brief to `spec.md`.
5. `bin/rds-build-plan` classifies complexity and writes `build-plan.json`.
6. The selected stack init hook creates the app. Rails uses
   the Rails starter; React uses `stacks/react/init.sh`.
7. Scaffold receives the spec, wiki workspace, stack recipe, and budget plan,
   then copies its task harness into the generated app and executes tasks.
8. RDS boots the app locally, registers a Zo service, runs Playwright QA,
   runs taste review, and may run bounded autonomous iterations.

Brown-field build:

1. RDS clones the target repo into the app destination.
2. RDS treats the supplied PRD as `spec.md`.
3. Wiki and template init are skipped.
4. Taste, build planning, Scaffold, local-run, deploy, QA, taste review, and
   iteration follow the same path as green-field.

## Upgrade Workflow

Use this checklist whenever a component changes outside RDS.

1. Read the upstream changelog or diff first. Identify whether the change is
   spec generation, implementation planning, templates, stack runtime, QA, or
   dashboard/operator UX.
2. Import the component into the matching path:
   - `vendor/wiki/`
   - `vendor/scaffold/`
   - `vendor/rails-starter/`
   - `stacks/<id>/`
3. Re-apply RDS patches with `./bootstrap/install.sh`.
4. Update `config/versions.lock` with the source commit or copy date.
5. Update Settings component metadata in `dashboard/src/server.ts` if the
   operator-facing inventory changed.
6. Run verification:
   - `./bootstrap/verify.sh`
   - `(cd dashboard && bun run selftest)`
   - at least one small build for the affected path
7. Restart the managed `rds` service so dashboard/runtime changes are
   live.
8. Add a changelog entry and, if the change affects operations, update
   `docs/TROUBLESHOOTING.md` or the relevant architecture/pipeline doc.

## Modification Decision Table

Use this table before changing stack behavior. Most mistakes come from editing
the template when the real behavior is owned by the stack manifest, or editing
the stack when the real behavior is copied from Scaffold.

| Goal | Change | Also check | Applies to |
|---|---|---|---|
| Change the starter files for new Rails apps | `vendor/rails-starter/` | `stacks/rails/manifest.json`, `vendor/scaffold/library/recipes/web_app.yml` | Future Rails green-field builds only |
| Change how Rails apps boot locally during RDS builds | `stacks/rails/manifest.json` and/or a new `stacks/rails/local-run.sh` | `docs/PIPELINE.md`, `docs/TROUBLESHOOTING.md` | Future Rails builds and resumptions before local-run |
| Change how Rails apps run after Zo deploy | `stacks/rails/manifest.json.service_entrypoint` and `service_env` | `config/zo-hosting.md`, `bin/rds-deploy`, `bin/rds-zo-register` | Future deploys/redeploys |
| Change Rails build instructions given to Scaffold | `vendor/scaffold/library/recipes/web_app.yml` | `vendor/scaffold/templates/`, `docs/PIPELINE.md` | Future Scaffold runs |
| Change the generated Scaffold task harness | `vendor/scaffold/templates/` | `docs/PIPELINE.md`, `docs/TROUBLESHOOTING.md` | Future Scaffold runs only |
| Change the research-to-spec behavior | `vendor/wiki/`, `prompts/wiki-prd-from-research.md`, `bin/rds-spec` | `docs/PIPELINE.md` Stage 2 | Future green-field specs |
| Add a non-Rails web stack | `stacks/<id>/`, optional `vendor/<template>/`, Scaffold recipe | `stacks/README.md`, dashboard Settings component inventory | Future builds with `--stack=<id>` |
| Change QA expectations for a product type | `bin/rds-qa`, `bin/rds-taste-review`, `lib/rds-qa/` | `docs/PIPELINE.md`, `docs/TROUBLESHOOTING.md` | Future QA and iterations |

## Rails Stack Modification Checklist

When Rails changes outside RDS, decide which layer changed:

1. **Template changed** — UI kit, Gemfile, Rails config, generators, seed data,
   default controllers, or styleguide files.
   - Import into `vendor/rails-starter/`.
   - Re-run `./bootstrap/install.sh`.
   - Update `config/versions.lock`.
   - Run a Rails green-field smoke build.
2. **Runtime changed** — Ruby version, Postgres env, boot command, health path,
   host allowlist, Solid Queue behavior, or deploy command.
   - Update `stacks/rails/manifest.json`.
   - Add or update `stacks/rails/local-run.sh` if local build boot no longer
     matches the Zo service boot path.
   - Update `stacks/rails/doctor.sh` if prerequisites changed.
   - Run `./bootstrap/verify.sh` and a deploy/redeploy smoke.
3. **Build guidance changed** — how Scaffold should use Rails, Hotwire,
   Bootstrap, UI kit partials, tests, or app architecture.
   - Update `vendor/scaffold/library/recipes/web_app.yml`.
   - If the task harness itself changed, update `vendor/scaffold/templates/`.
   - Remember: in-flight builds keep copied Scaffold harness files.
4. **Verification changed** — what counts as a good Rails app.
   - Update `bin/rds-qa`, `bin/rds-qa-verdict`, `bin/rds-taste-review`, or
     `lib/rds-qa/`.
   - Add the new artifact names to dashboard/log docs if operators need them.

Minimum verification for Rails stack changes:

```bash
./bootstrap/verify.sh
./bin/rds-build ./inbox/fixture-research.md \
  --app-dest=/srv/rds-projects/rds-rails-smoke \
  --stack=rails \
  --app-type=web-app
```

For deploy-path changes, also redeploy an existing Rails build from the
dashboard or with `bin/rds-deploy --build-id=<id> --target=zo`.

## Subtree Import

Preferred when upstream history is available:

```bash
git subtree pull --prefix=vendor/scaffold \
  <component-repo-url> main --squash
```

Then:

```bash
./bootstrap/install.sh
./bootstrap/verify.sh
```

## Plain-Copy Import

Use this when the source is a local checkout or subtree metadata is missing:

```bash
rsync -a --delete --exclude='.git' /path/to/scaffold/ vendor/scaffold/
rsync -a --delete --exclude='.git' /path/to/wiki/ vendor/wiki/
rsync -a --delete --exclude='.git' /path/to/rails-starter/ vendor/rails-starter/
./bootstrap/install.sh
./bootstrap/verify.sh
```

Record `copied-from-local` plus the date in `config/versions.lock` if there is
no reliable commit SHA.

## What Changes Apply to Existing Builds?

| Change | Existing running build | Failed build resumed with `bin/rds-resume` | New build |
|---|---|---|---|
| `bin/rds-*` orchestration | Usually yes after restart/resume | Yes | Yes |
| Dashboard UI/API | Yes after `rds` restart | Yes | Yes |
| Watchdog/fixer logic | Yes after watchdog restart | Yes | Yes |
| Wiki | No if `spec` is already done | Only if spec reruns | Yes |
| Scaffold templates | No after Scaffold copied the harness into the app | No unless Scaffold stage reruns from scratch | Yes |
| Rails template | No after app init | No unless init reruns from scratch | Yes |
| Stack manifest/local-run/deploy entrypoint | Later stages may use updated RDS stack hooks, but app files already copied remain unchanged | Yes for stages not yet completed | Yes |

If a live generated app needs the new Scaffold or template behavior, patch the
generated app directly or start a fresh build. Do not assume vendor updates
retrofit copied app code.

## Adding a New Referenced Pipeline

Treat each new pipeline like a first-class component, not an ad-hoc script.

1. Decide whether it is a vendored component (`vendor/<name>/`), a stack
   (`stacks/<id>/`), a prompt set (`prompts/`), or RDS harness code (`bin/`).
2. Add a short component card to this document with role, inputs, outputs, and
   limitations.
3. Add a stack manifest if it changes runtime/build/deploy behavior.
4. Wire it through one narrow script or hook instead of scattering calls across
   the dashboard and build loop.
5. Record its version/provenance in `config/versions.lock`.
6. Add dashboard Settings metadata so operators can see what version RDS is
   using.
7. Add one smoke build or selftest that proves the new pipeline is actually
   exercised.

## Known Limitations

- RDS is single-operator and effectively single-build. Parallel builds can race
  on ports, service labels, and app destinations.
- Component upgrades are not automatic. This is a feature until there is a
  reliable upstream release/version contract.
- Scaffold snapshots its harness into each generated app. Template fixes do
  not repair in-flight builds.
- Wiki only affects green-field research inputs.
- V1 ready stacks are `rails-web`, `nextjs-fullstack`, `python-ai-service`,
  `astro-thin-web`, `web-3d`, `game-engine`, `game-asset-pipeline`,
  `mobile-native`, and `browser-extension`. `react-spa` remains as a legacy
  compatibility stack but is deferred for new V1 builds.
- QA has product-type awareness, but full workflow UAT is still evolving. See
  `docs/PIPELINE.md` and `docs/TROUBLESHOOTING.md`.

## Third-Party Notices and Licensing

RDS vendors selected components so builds are reproducible from the checked-in
repository rather than from upstream code at runtime.

| Component | Path | Notice |
|---|---|---|
| Scaffold | `vendor/scaffold/` | RDS-owned vendored build planner/executor. MIT license at `vendor/scaffold/LICENSE`. |
| Wiki | `vendor/wiki/` | Vendored research-to-spec component. MIT license at `vendor/wiki/LICENSE`. |
| Rails starter | `vendor/rails-starter/` | RDS-owned starter generated from stock Rails 8.1.2, customized only for non-interactive RDS/Zo setup. MIT license at `vendor/rails-starter/LICENSE`. |

Do not publish a release package until every vendored component has either a
compatible license file in this repository, been replaced by RDS-owned code, or
been removed from the public distribution.
