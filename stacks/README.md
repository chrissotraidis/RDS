# RDS Stacks

A **stack** is the runtime + framework profile RDS uses to scaffold,
build, run, and deploy a project. Rails, React + Vite, Next.js,
Python/FastAPI, Astro, Web 3D, playable browser games, browser
extensions, Expo mobile apps, and game asset pipelines are end-to-end enabled today. V1 keeps
canonical stack slugs and `stack.yaml` contracts while preserving the
proven V0 runtime directories where needed. Additional stacks can be
registered as `stub`/`disabled` so operators can see the roadmap without
being allowed to start builds that will get stuck.

## Layout

```
stacks/
├── README.md                 ← this file
├── registry.yml              ← V1 registry: canonical slugs, aliases, roadmap
├── rails/
│   ├── stack.yaml            ← V1 authoring contract (`rails-web`)
│   ├── manifest.json         ← V0 runtime metadata (see schema below)
│   ├── init.sh               ← optional: stage-3 hook (defaults to bin/rds-rails-init)
│   ├── local-run.sh          ← optional: stage-5 hook
│   └── doctor.sh             ← optional: prereq smoke-check (called by bootstrap/verify.sh)
├── react/
│   ├── stack.yaml            ← V1 authoring contract (`react-spa`)
│   ├── manifest.json         ← ready: Vite React browser apps/games
│   ├── init.sh
│   ├── local-run.sh
│   └── doctor.sh
├── nextjs/
    ├── stack.yaml            ← V1 authoring contract (`nextjs-fullstack`)
    ├── manifest.json         ← ready: Next.js App Router apps
    ├── init.sh
    ├── local-run.sh
    └── doctor.sh
├── python-ai-service/
│   ├── stack.yaml
│   ├── manifest.json         ← ready: FastAPI/Python AI services
│   ├── init.sh
│   ├── local-run.sh
│   └── doctor.sh
├── astro-thin-web/
    ├── stack.yaml
    ├── manifest.json         ← ready: Astro content-led web
    ├── init.sh
    ├── local-run.sh
    └── doctor.sh
├── web-3d/
│   ├── stack.yaml
│   ├── manifest.json         ← ready: Vite + React Three Fiber scenes
│   ├── init.sh
│   ├── local-run.sh
│   └── doctor.sh
├── game-engine/
│   ├── stack.yaml
│   ├── manifest.json         ← ready: playable HTML5 canvas game preview
│   ├── init.sh
│   ├── local-run.sh
│   └── doctor.sh
├── browser-extension/
│   ├── stack.yaml
│   ├── manifest.json         ← ready: WXT MV3 extension + zip artifact
│   ├── init.sh
│   ├── local-run.sh
│   └── doctor.sh
├── react-native/
│   ├── stack.yaml            ← V1 authoring contract (`mobile-native`)
│   ├── manifest.json         ← ready: Expo app + Zo fallback preview
│   ├── init.sh
│   ├── local-run.sh
│   └── doctor.sh
└── game-asset-pipeline/
    ├── stack.yaml
    ├── manifest.json         ← ready: Python/uv asset pipeline preview
    ├── init.sh
    ├── local-run.sh
    └── doctor.sh
```

`bin/rds-build --stack=<name>` (also accepted by `bin/rds-start`)
selects the stack at build time. The default is `rails` (override per
session with `RDS_DEFAULT_STACK=<id>`). Unknown stacks fail fast with
a list of registered manifests. The chosen stack id is recorded in
`state.json.stack` and emitted as part of the `build_started` event
so the dashboard can badge it.

Canonical V1 slugs accepted in Phase 0:

| Canonical | Runtime dir |
|---|---|
| `rails-web` | `stacks/rails/` |
| `react-spa` | `stacks/react/` |
| `nextjs-fullstack` | `stacks/nextjs/` |
| `python-ai-service` | `stacks/python-ai-service/` |
| `astro-thin-web` | `stacks/astro-thin-web/` |
| `web-3d` | `stacks/web-3d/` |
| `game-engine` | `stacks/game-engine/` |
| `browser-extension` | `stacks/browser-extension/` |
| `mobile-native` | `stacks/react-native/` |
| `game-asset-pipeline` | `stacks/game-asset-pipeline/` |

`builds/<id>/build.yaml` records the requested, canonical, and runtime stack
ids for every new build. `state.json.stack` intentionally remains the runtime
id in Phase 0 so existing dashboard, deploy, watchdog, and fixer paths keep
working.

Stacks with `"status": "stub"`, `"status": "disabled"`, or `"status": "defer"` are registry
placeholders only. `bin/rds-build` fails fast for them, and the dashboard
New Build form may render them as disabled options, but must not allow
them to start.

Stack helpers live in `bin/lib/common.sh`:

- `stack_list` — prints registered stack ids, one per line.
- `stack_validate <id>` — exits non-zero if the stack is unknown,
  with a friendly message listing what's registered.
- `stack_field <id> <jq-filter>` — reads any manifest field, e.g.
  `stack_field rails .health_path` → `/up`.
- `stack_resolve_id <id>` — resolves a canonical alias to its runtime id.
- `stack_canonical_id <id>` — returns the V1 canonical slug.

Validation and migration commands:

- `bin/rds-port-migrate` — rewrites every stack `manifest.json` and
  `stack.yaml` to the V1 Zo preview port range, `4000-4099`.
- `bin/rds-v1-validate` — verifies the nine ready V1 stacks, required
  contract fields, port ranges, built-in skill scaffolds, and expected skill
  catalog entries.

## manifest.json schema

```jsonc
{
  "id":            "rails",                   // matches directory name
  "name":          "Rails 8 + Hotwire",       // human label for the dashboard
  "language":      "ruby",
  "runtime":       { "min": "4.0.1" },
  "framework":     { "name": "rails", "version": "8.0" },
  "database":      "postgresql-15",
  "default_port_range": [4000, 4099],
  "health_path":   "/up",
  "stages": ["intake", "spec", "init", "scaffold", "local-run", "deploy"],
  "init":          "stacks/rails/init.sh",    // optional; default = bin/rds-rails-init
  "local_run":     "stacks/rails/local-run.sh", // optional; default = inline rails-server logic
  "doctor":        "stacks/rails/doctor.sh",  // optional; called by bootstrap/verify.sh
  "scaffold_recipe": "web_app",               // optional Scaffold recipe hint
  "service_entrypoint": "bash -c '... %(ENV_PORT)s ...'",
  "service_env": { "RAILS_ENV": "development" },
  "status":        "ready",                   // ready | stub | disabled | defer
  "supports_modes": ["green", "brown"],
  "notes":         "Default stack. Drop a PRD in inbox/ → bin/rds-start runs end-to-end."
}
```

## How a stack hooks into the build

`bin/rds-build` consults the manifest before each stack-specific
stage:

1. **init**: if `manifest.init` is a path that exists, run it with
   `(app_name, app_dest)`. Otherwise default to `bin/rds-rails-init`.
2. **scaffold**: if `manifest.scaffold_recipe` is set, pass it to
   `vendor/scaffold/scaffold.sh --recipe`. Rails uses `web_app`, React
   uses `react_web`, Next.js uses `nextjs_fullstack`, Python AI services
   use `python_ai_service`, Astro uses `astro_thin_web`, Web 3D uses
   `web_3d`, Game Engine uses `game_engine`, Browser Extension uses
   `browser_extension`, Mobile Native uses `mobile_native`, and Game Asset
   Pipeline uses `game_asset_pipeline`.
3. **local-run**: if `manifest.local_run` is set, run it with
   `(app_dest, build_dir)` and expect a `tmp/pids/server.pid`. Otherwise default
   to the inline Rails+Puma loop in `bin/rds-build`.
4. **deploy**: shared (`bin/rds-deploy`) — every stack that wants to
   deploy on Zo today does so by registering a user service. The stack
   must expose `health_path`, `service_entrypoint`, and optional
   `service_env` in its manifest.

That's it. A new stack adds a directory and three small shell scripts;
no `bin/rds-*` rewrite required.

## Modifying an existing stack

Do this when the framework/runtime behavior changes but the stack identity stays
the same, for example "Rails should now use a different boot command" or "React
should deploy with a production static server instead of Vite."

| Change | File |
|---|---|
| Human label, enabled/disabled status, supported modes | `stacks/<id>/manifest.json` |
| Runtime prerequisites | `stacks/<id>/doctor.sh` |
| Starter creation for green-field builds | `manifest.init` target, e.g. `stacks/react/init.sh` or `bin/rds-rails-init` |
| Local build preview boot | `manifest.local_run` target, e.g. `stacks/react/local-run.sh` |
| Public Zo service boot | `manifest.service_entrypoint` and `manifest.service_env` |
| Health check URL | `manifest.health_path` |
| Scaffold build instructions | `manifest.scaffold_recipe` plus `vendor/scaffold/library/recipes/<recipe>.yml` |

Rules:

- Keep app destinations outside the RDS repo.
- Local-run must write `tmp/pids/server.pid`.
- Local-run must leave a reachable app on `HOST_PORT`.
- Zo service entrypoints must bind to `%(ENV_PORT)s`.
- Mark the stack `"status": "stub"` or `"disabled"` until init, local-run,
  deploy entrypoint, health check, and QA all work.
- Update `docs/COMPONENTS.md` when the stack change depends on a vendored
  component such as the Rails starter or Scaffold.

Rails-specific example:

- Rails starter changed: update `vendor/rails-starter/`.
- Rails boot/deploy changed: update `stacks/rails/manifest.json`.
- Rails local preview changed: add or update `stacks/rails/local-run.sh`.
- Rails build guidance changed: update
  `vendor/scaffold/library/recipes/web_app.yml`.
- Rails prerequisites changed: update `stacks/rails/doctor.sh`.

## Adding a new stack (checklist)

1. Drop `stacks/<id>/manifest.json` matching the schema above.
2. Add `init.sh` (clones a template repo / runs `create-next-app` /
   etc.) — must leave a buildable project tree at `$APP_DEST`.
3. Add `local-run.sh` — must boot the app on `${HOST_PORT}` and
   write `tmp/pids/server.pid`.
4. (Optional) Add `doctor.sh` — checks for required CLIs / runtimes;
   `bootstrap/verify.sh` shells out per registered stack.
5. Add `service_entrypoint` and any `service_env` needed for Zo service
   registration.
6. (Optional) Add a `vendor/<id>-template/` template repo if your
   `init.sh` rsyncs from one.
7. Run stack smoke (`init.sh` + `local-run.sh`) and then
   `bin/rds-build --stack=<id> ...` end-to-end. If both work,
   you're done.

## Why a registry instead of one-off flags

So the dashboard, watchdog, fixer, and notifier all see the same
metadata and can render stack-aware copy ("Rails app booting…",
"Next.js build in progress…", "FastAPI venv resolved…") without
hard-coded ladders.
