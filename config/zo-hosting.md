# Zo Public Hosting

How RDS exposes generated apps and the dashboard on Zo Computer.

## Current Mechanism

RDS uses Zo hosted user services. Generated apps boot locally on `HOST_PORT`;
`bin/rds-deploy --target=zo` calls `bin/rds-zo-register`, which asks Zo to
register or reuse a durable HTTP service and then waits for the public URL to
respond.

Typical generated-app URL:

```text
https://rds-<build-label>-<zo-owner>.zocomputer.io
```

Dashboard URL:

```text
https://rds-<zo-owner>.zocomputer.io
```

## Runtime Requirements

- The app must bind to the `PORT` environment variable when running as a Zo
  service.
- Stack manifests provide the service entrypoint and service env.
- `ZO_CLIENT_IDENTITY_TOKEN` must be present in the dashboard/watchdog/fixer
  environment when a new service registration is required.
- If a matching service already exists, `RDS_ZO_REUSE_EXISTING=1` allows deploy
  to reuse it without a fresh registration.

## Deploy Targets

- `zo` — default, durable public Zo service.
- `none` — local-only preview, useful for harness debugging.
- `teardown` — stop local preview process and clear preview state.

`RDS_ZO_AUTO_REGISTER=0` restores the legacy
`pending-zo-registration://port=<HOST_PORT>;build_id=<id>;app_dir=<path>`
sentinel for debugging only. Normal builds should not finish with a sentinel.

## Cleanup

Generated preview services are recorded in `builds/<id>/service.json`.
Use `bin/rds-zo-deregister --build-id=<id>` or the dashboard's guarded Delete
Zo service action to take one offline.

Use `bin/rds-stop <id>` for local preview process cleanup.

## If the Mechanism Changes

Update these in lockstep:

1. `bin/rds-deploy`
2. `bin/rds-zo-register`
3. stack `service_entrypoint` fields
4. this file
5. `docs/RUNNING_ON_ZO.md`
6. `docs/TROUBLESHOOTING.md`
