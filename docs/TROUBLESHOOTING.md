# Troubleshooting

Start with evidence, not guesses.

```bash
./bin/rds-status
./bin/rds-status <build-id>
```

For a failed build, read in this order:

1. `builds/<id>/state.json`
2. the failed stage log under `builds/<id>/logs/`
3. `builds/<id>/events.jsonl`
4. the dashboard build detail page

The live terminal stream is useful while work is running. Durable evidence lives
in the build folder.

## Fast Triage

| Symptom | First command | Likely next step |
|---|---|---|
| Install or verify fails | `./bootstrap/verify.sh` | Install missing host dependency or fix `.env` |
| Build failed | `./bin/rds-status <id>` | Read the failed stage log |
| Build looks stuck | `cat builds/<id>/run.pid` | Check if the process is alive, then resume |
| Preview is missing | `cat builds/<id>/preview-url.txt` | Re-run deploy for that build |
| Dashboard is unavailable | `curl -i http://127.0.0.1:$PORT/healthz` | Check dashboard env and logs |
| QA failed | read `qa-*`, `scenario-*`, `visual-*` artifacts | Fix app behavior, not the verdict text |
| Agent Session is quiet | `./bin/rds-agent-status <session-id>` | Check tmux/session log |

## Install And Verify

### Missing prerequisite

`bootstrap/install.sh` does not install system packages. Install the missing
tool on the host, then re-run:

```bash
./bootstrap/install.sh
./bootstrap/verify.sh
```

Core requirements are listed in the root `README.md`.

### Arnold is missing

Arnold is optional. Wiki uses it for richer codebase context when available,
but can fall back to direct file reading.

If you want Arnold, set `ARNOLD_REMOTE` and rerun:

```bash
./bootstrap/install.sh
```

If Arnold is absent, `./bootstrap/verify.sh --fresh-clone` should report it as
skipped, not failed.

### Patch does not apply

`bootstrap/install.sh` handles already-applied patches. If a patch no longer
applies cleanly, the vendored component has drifted.

1. Read `patches/<name>.patch`.
2. Edit the relevant `vendor/<component>/...` file by hand.
3. Regenerate the patch against a fresh upstream copy.
4. Verify with `git apply --check patches/<name>.patch`.

## Build Failures

### Stage 1: Intake

**Notion URL gives `FATAL: source is a Notion URL but <dest> is empty`.**

The shell pipeline cannot use the host chat agent's Notion session. Export the
page to a local Markdown file under `inbox/`, then run `bin/rds-build` against
that file.

**Brown-field clone fails.**

This is usually host git auth. Configure SSH keys or a PAT at the OS/git level.
RDS does not manage external repository credentials.

### Stage 2: Spec

**Wiki produces an unusable spec.**

Thin input can produce thin output. Add detail to the research/PRD, or write
the PRD by hand and use the brown-field path.

**`claude: command not found` on a Codex build.**

Check `builds/<id>/logs/spec.log`. Current RDS chooses the spec provider from
`RDS_SPEC_PROVIDER` or the build provider and should not require Claude for
Codex-only green-field builds. If it does, the running service may be on older
code or PATH may be wrong.

### Stage 3: Stack Init

**Rails init/template setup fails.**

Read `builds/<id>/logs/rails-init.log`, then run the failing setup command in
the generated app destination. Typical causes are missing Ruby dependencies,
database setup, or a starter-template assumption that changed.

**Port range exhausted.**

Stop an old build or widen the range:

```bash
./bin/rds-stop <build-id>
# or set RDS_LOCAL_PORT_RANGE_START / RDS_LOCAL_PORT_RANGE_END in .env
```

### Stage 4: Scaffold

**Scaffold gates fail repeatedly.**

Inspect the failed gate under `vendor/scaffold/`, then run the underlying
command in the generated app. Common causes:

- missing migration or setup command;
- missing dependency;
- test/gate expects a file or route that does not exist;
- spec was too vague for Scaffold to plan correctly.

### Stage 5: Local Run

**`HOST_PORT` collision.**

Stop the previous build or choose a new port range.

**`/up` times out.**

Tail `builds/<id>/logs/local-run.log`. Usual causes:

- Rails credentials/key problem;
- failed database migration;
- broken initializer;
- app server started on the wrong port.

**Stale `tmp/pids/server.pid`.**

Remove the stale PID file in the generated app, then resume:

```bash
rm -f <app-dest>/tmp/pids/server.pid
./bin/rds-resume <build-id> --detach
```

### Stage 6: Deploy

**Preview URL is a `pending-zo-registration://...` sentinel.**

Normal Zo deploy writes a real HTTPS preview URL. A pending sentinel means
auto-registration is disabled or failed.

Check:

```bash
rg RDS_ZO_AUTO_REGISTER .env
tail -n 120 builds/<id>/logs/deploy.log
```

Then re-run deploy:

```bash
./bin/rds-deploy --build-id=<id> --target=zo
```

**Zo API returns `HTTP 401: Token has expired`.**

This is host/service identity, not app code. Refresh the service identity token
or restart the service that owns it, then retry deploy. Do not send repeated
app-code fixers at this failure.

**Public Vite preview returns blocked-host errors.**

RDS patches React/Web-3D Vite previews with `server.allowedHosts = true` before
registration. If an older preview still fails, patch the generated app's
`vite.config.*`, restart only that preview service, then re-check both page
HTML and module URLs.

**Preview returns a 520/empty upstream response.**

The service exists, but the app process is not serving the registered port.
Check localhost first:

```bash
curl -i http://127.0.0.1:<local_port>/
```

If localhost fails, fix the generated app process before touching public
hosting.

## QA And Review

### Scenario, visual, or typed UAT verdict blocks review

Treat verdicts as product evidence. Do not edit the verdict file to pass.

Read:

- `scenario-verdict.json`
- `visual-verdict.json`
- typed verdicts such as `workflow-verdict.json`, `website-verdict.json`, or
  `game-verdict.json`
- screenshots attached to failed checks

Then either patch the generated app or run Goal Mode:

```bash
./bin/rds-goal <build-id> --objective="Make this build review-ready"
```

### Taste review says the app is technically green but product-weak

Use targeted iteration:

```bash
./bin/rds-iterate <build-id>
```

or Goal Mode for a bounded loop.

## Dashboard

### Dashboard returns `503`

`RDS_DASHBOARD_PASSWORD` is not configured. RDS intentionally refuses to serve
the operator console without the built-in Basic Auth gate.

Set:

```bash
RDS_DASHBOARD_USER=...
RDS_DASHBOARD_PASSWORD=...
RDS_DASHBOARD_TOKEN=...
```

Then restart the dashboard service.

### Dashboard shows stale or wrong build state

Read `state.json` first. If the file is correct but the UI is stale:

1. confirm the dashboard process is using the same `RDS_BUILDS_DIR`;
2. restart the dashboard service;
3. check whether the build shares `app_dest` with another active build.

Public deploy snapshots should be immutable under `builds/<id>/deploy-snapshot/`.
Active working directories should not be reused casually across builds.

## Agent Sessions

### Session will not launch

Check provider/tool health:

```bash
which claude && claude --version
which codex && codex --version
tmux -V
git worktree list
```

Then verify the target repo is a git checkout:

```bash
git -C /path/to/repo status --short
```

Build-attached sessions default to `state.json.app_dest`. If that app directory
is missing or not a git checkout, launch with an explicit `--repo`.

### Session is running but no output appears

Inspect the session record and log:

```bash
./bin/rds-agent-status <session-id>
tmux attach -t <tmux_session>
tail -n 120 builds/<id>/agent-sessions/<session-id>.log
```

If tmux is gone but JSON says `running`, `rds-agent-status` reconciles the
status to `exited`.

## Recovery Loop

The loop is:

```text
rds-watchdog -> rds-fix -> rds-resume
```

Useful checks:

```bash
./bin/rds-watchdog --status
tail -f /dev/shm/rds-watchdog.log
./bin/rds-watchdog --once --fail-after=0 --max-fix-attempts=3
```

If the same fixer fires repeatedly, read the newest `builds/<id>/fixer-*.md`
and stop after two failed attempts. Repeating the same repair without new
evidence usually means the diagnosis is wrong.

If the build says `running` but no process is alive, check:

```bash
cat builds/<id>/run.pid
ps -p "$(cat builds/<id>/run.pid)" -o pid,etime,args
```

Then resume:

```bash
./bin/rds-resume <build-id> --detach
```

## State Corruption

If `state.json` is inconsistent, do not hand-edit it unless you are repairing
RDS itself. Typical causes are unsupported concurrency or a killed process
mid-stage.

Preserve evidence and start fresh:

```bash
mv builds/<id> builds/<id>.corrupt-$(date +%Y%m%d)
```

Then rerun the build.
