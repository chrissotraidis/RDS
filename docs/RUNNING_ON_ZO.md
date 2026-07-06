# Running RDS on Zo

Zo Computer is a first-class RDS host because it provides the same shape RDS
expects from a dedicated VPS: persistent files, a Linux shell, long-running
services, browser automation, and authenticated coding-agent providers.

This guide covers both the host model and the setup checklist. It is public
host documentation: keep live instance URLs, service IDs, passwords, tokens,
private build IDs, and operator-specific notes out of this file.

## Host Model

RDS on Zo is normally one managed HTTP service plus local runtime data:

```text
/path/to/RDS/                 # source checkout
/path/to/RDS-data/            # optional private runtime data root
  builds/
  inbox/
  dashboard-chat/
```

Simple installs may keep runtime data under the checkout because `.gitignore`
excludes it. Production installs should prefer a separate data root so the Git
repo stays a clean source tree. See the runtime data section in
`docs/ARCHITECTURE.md`.

## 1. Confirm the Host and Prerequisites

```bash
uname -a
cat /etc/os-release
which git ruby bundler curl jq rsync python3 bun
ruby --version
psql --version
```

RDS expects a Linux host with persistent disk, local process supervision, and
access to coding-agent CLIs. Model-backed builds require Claude Code and/or
Codex CLI installed and authenticated for the host user. Notion-driven intake
requires a Notion MCP or equivalent export flow available to the operator
agent.

Docker, Docker Compose, Fly.io, and systemd are not required for the Zo path
and should not be part of the default setup.

## 2. Clone and Bootstrap

```bash
git clone https://github.com/chrissotraidis/RDS.git /path/to/RDS
cd /path/to/RDS
./bootstrap/install.sh
./bootstrap/verify.sh
```

For a clean source-tree check before installation:

```bash
./bootstrap/verify.sh --fresh-clone
```

## 3. Configure Environment

```bash
cp .env.example .env
$EDITOR .env
```

Common values:

```bash
RDS_HOME=/path/to/RDS
RDS_BUILDS_DIR=/path/to/RDS/builds
RDS_INBOX_DIR=/path/to/RDS/inbox
RDS_ZO_OWNER=<your-zo-handle>
```

`RDS_ZO_OWNER` makes generated preview services use your Zo public URLs.

For production-like use, prefer a private data root outside the source
checkout:

```bash
RDS_BUILDS_DIR=/path/to/RDS-data/builds
RDS_INBOX_DIR=/path/to/RDS-data/inbox
RDS_DASHBOARD_CHAT_DIR=/path/to/RDS-data/dashboard-chat
```

Read the runtime data guidance in `docs/ARCHITECTURE.md` before moving an
existing live instance.

## 4. Confirm Postgres

```bash
pg_isready -h 127.0.0.1 -p 5432
PGPASSWORD=rails psql -h 127.0.0.1 -U rails -d postgres -c "SELECT 1;"
```

If the Rails role does not exist, create it with the host's normal Postgres
administration flow. RDS defaults to the local Rails development credentials
used by its templates.

## 5. Smoke Test a Build

```bash
mkdir -p inbox
cat > inbox/prd-smoke.md <<'EOF'
# Smoke

A single-page Rails app that says "hello, RDS" on the root path.
EOF

./bin/rds-build inbox/prd-smoke.md \
  --app-dest=/path/to/smoke-rds \
  --stack=rails-web \
  --app-type=web-app
```

Then check:

```bash
./bin/rds-status
```

A good smoke run has `state.json`, stage logs, and either a preview URL or a
clear deploy-target explanation.

## Running Builds

Green-field:

```bash
./bin/rds-build ./inbox/research.md \
  --app-dest=/path/to/generated-app \
  --stack=rails-web \
  --app-type=web-app
```

Brown-field:

```bash
./bin/rds-build \
  --repo=https://github.com/acme/app.git \
  --prd=./inbox/acme-prd.md \
  --app-dest=/path/to/generated-app \
  --branch=main \
  --stack=rails-web \
  --app-type=dashboard
```

Detached launcher:

```bash
./bin/rds-start ./inbox/research.md --app-dest=/path/to/generated-app
./bin/rds-status
```

Each build writes durable state, logs, events, screenshots, and review evidence
under `builds/<id>/` or the configured build-data root.

## Dashboard Service

The dashboard is `dashboard/src/server.ts`. For local foreground testing:

```bash
PORT=4000 \
RDS_DASHBOARD_USER=rds \
RDS_DASHBOARD_PASSWORD=<strong-password> \
RDS_DASHBOARD_TOKEN=<random-token> \
./bin/rds-dashboard
```

For a managed Zo service, use `bin/rds-service-entrypoint` as the entrypoint
and keep dashboard secrets in the service env, not in Git.

Security model:

- RDS implements Basic Auth in `dashboard/src/server.ts`;
- all dashboard routes except `/healthz` require `RDS_DASHBOARD_PASSWORD`;
- if `RDS_DASHBOARD_PASSWORD` is unset, the dashboard returns `503` instead of
  serving an unprotected control surface;
- write actions also require `X-RDS-Token`;
- the dashboard is not a multi-user auth system;
- public preview URLs are review artifacts, not hardened production deploys.

Verify:

```bash
curl -fsS http://127.0.0.1:4000/healthz
RDS_DASHBOARD_URL=http://127.0.0.1:4000 ./bin/rds-selftest
```

## Verification

```bash
./bootstrap/verify.sh
./bin/rds-selftest
```

When changing QA, taste review, readiness, stack defaults, or skill resolution:

```bash
./bin/rds-quality-fixtures --keep-going
```

## Operating Rules

- Keep generated apps outside the RDS repo with `--app-dest`.
- Keep private runtime data out of Git.
- Run one build at a time unless the system has been explicitly upgraded for
  concurrency.
- Do not reset or reclone over a live checkout without backing up `builds/`,
  `inbox/`, `.env`, dashboard chat, service env vars, and generated apps.

## Updating

```bash
cd /path/to/RDS
git fetch origin --prune
git rev-list --left-right --count HEAD...origin/main
git pull --ff-only
./bootstrap/install.sh
./bootstrap/verify.sh
```

If vendored components changed, read `docs/COMPONENTS.md` before trusting
future builds. If the checkout has local runtime data, preserve `builds/`,
`inbox/`, `.env`, dashboard chat, service env vars, and generated apps
deliberately.
