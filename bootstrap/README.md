# bootstrap/

One-shot scripts that prepare a fresh Zo VM (or any Linux box) to run RDS.

Run order:

1. `./bootstrap/install.sh` — install dependencies, wire up vendored components, apply patches, write `.rds-installed`.
2. `./bootstrap/verify.sh` — smoke-test every component. Exits 0 on green.

All three scripts are idempotent. Re-running `install.sh` after pulling a new
RDS commit reapplies any patches and refreshes the version stamp.

## Scripts

### `install.sh`

The entry point. Checks OS prerequisites, confirms `claude` is present, applies
`patches/*.patch` to vendored code, ensures `.env` exists, and writes
`.rds-installed` with commit hashes. If `arnold` is missing and `ARNOLD_REMOTE`
is set, it also builds Arnold from source; otherwise it warns and continues.

It does **not** install system packages. If a prerequisite (`git`, `ruby`,
`bundle`, `curl`, `jq`, `rsync`) is missing, the script prints
what's missing and exits non-zero. Zo normally has all of these already.

### `verify.sh`

Runs a ticked list of smoke checks. Use this after install, and any time the
install state looks wrong. It is safe to re-run.

### `build-arnold.sh`

Clones and builds Arnold into `/opt/arnold`, then installs a wrapper at
`/usr/local/bin/arnold`. Called automatically by `install.sh` only when
`arnold` is not already on `PATH` and `ARNOLD_REMOTE` is set.

Arnold is optional. It gives Wiki a deterministic codebase context bundle for
brown-field analysis, but Wiki can fall back to direct file reading when Arnold
is unavailable.

If the Arnold repo layout changes and the script's entrypoint detection
(`exe/arnold` → `bin/arnold`) no longer matches, fix it here. As a last
resort, `docs/TROUBLESHOOTING.md` documents how to replace Arnold with a
no-op shim.

## What install.sh does NOT do

- It does not install `docker`, `ruby`, `claude`, or other system-level tools.
  Zo provides these.
- It does not configure Notion MCP — that's Zo-level config.
- It does not manage Claude authentication; configure the relevant CLI or host
  environment before running model-backed builds.
- It does not run a build. Use `bin/rds-build` for that.
