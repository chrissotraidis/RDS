# Dashboard

The dashboard is the operator console for RDS: a single Bun + Hono server
(`dashboard/src/server.ts`) that renders every page server-side and reads all
state from disk (`RDS_BUILDS_DIR`, `events.jsonl`, per-build `state.json`).
There is no database and no client framework; if the files are on disk, the
page renders.

This doc is the page-by-page map. For the visual language (tokens, color,
typography), see `docs/DESIGN.md`. For what the pipeline writes to disk, see
`docs/PIPELINE.md`.

## Pages

| Route | Nav label | What it's for |
|---|---|---|
| `/` | Hub | Landing overview: build engine status, PRD inbox dropzone, watchdog toggle, Zo hosting slots, needs-review queue, recent builds, critical alerts, live activity. |
| `/builds` | Builds | Full build inventory: sortable/filterable table (status, stack, mode, hosting, ID), mobile card layout, per-row review/cost/last-activity. |
| `/new` | New Build | PRD-first intake: paste or attach a brief, run analysis (`/new/analyze`), review the recommended stack/skills plan, then launch. |
| `/b/:id` | (from Builds) | Build detail: status command center, approve/reject, chat box, blockers and evidence summary, live terminal, stage timeline, tabs for files/QA/goal/agents/raw state. |
| `/b/:id/playwright` | (from build detail) | Browser QA evidence: per-iteration crawl summary, page screenshots, gaps table, spec/game verdicts, run log, "Run QA now". |
| `/b/:id/cost` | (from build detail) | Cost breakdown computed from model session logs (`cost.json`; refresh with `POST /b/:id/refresh-cost`). |
| `/chat` | Chat | Persistent server-side chat threads, usually one per build. Sending a message can propose confirmed RDS actions (see `docs/CHAT_CONTRACT.md`). |
| `/agents` | Agents | Agent Sessions control plane: Claude Code / Codex workers in isolated git worktrees — status, diff, review, handoff, merge, stop, discard (see `docs/AUTONOMY.md`). |
| `/audit` | Activity | Append-only audit log of every write action (build start/stop, deploy, approve/reject, watchdog toggles, PRD uploads), with CSV/JSON export. |
| `/settings` | Settings | Operational defaults: builder provider (Claude/Codex), runtime health, write-token status, registry summary. Sub-pages: `/settings/stacks`, `/settings/skills`, `/settings/components`. |
| `/docs` | Documentation | Rendered operator docs index for the running install. |
| `/healthz` | — | Unauthenticated liveness probe (returns `ok`). Everything else requires auth. |

Useful JSON/streaming endpoints behind the same auth: `/b/:id/state.json`,
`/b/:id/events.json`, `/b/:id/truth.json`, `/b/:id/evidence-ledger.json`,
`/b/:id/cost.json`, `/b/:id/stream` (SSE events), `/b/:id/log` (SSE terminal),
`/watchdog`.

## Auth model

Two layers, both configured by environment:

- **Basic Auth gate** on every route except `/healthz`, `/favicon.ico`,
  `/site.webmanifest`, and `/static/*`. `RDS_DASHBOARD_USER` defaults to
  `rds`.
- **Write token**: every mutating route additionally requires an
  `X-RDS-Token` header matching `RDS_DASHBOARD_TOKEN`. The browser UI stores
  the token in `localStorage.rds_token` and injects it into its own fetches.

**Setup mode (fresh clone):** when neither `RDS_DASHBOARD_PASSWORD` nor
`RDS_DASHBOARD_TOKEN` is set, the dashboard serves — reads and writes — to
direct `localhost` requests only, with a persistent banner prompting you to
configure credentials. Non-local requests (including anything arriving via a
reverse proxy or with a non-localhost `Host` header) get a `503` explaining
what to configure. Setting the credentials switches both gates on.

This is a single-operator console, not a multi-user permission system.

## Local development (macOS-friendly)

The dashboard server runs fine on macOS; only the Linux-specific launcher
conveniences differ. Quickest path:

```bash
cd dashboard
bun install
bun run dev        # --hot reload; or `bun run start`
```

Styles are precompiled: `dashboard/public/tailwind.css` is vendored and served
from `/static/tailwind.css`, so there is no CSS build step just to run the
dashboard. If you add or change Tailwind classes or tokens, regenerate it with
`bun run build:css` (config: `dashboard/tailwind.config.js`).

Then open `http://localhost:4000` — with no credentials configured the
dashboard runs in localhost-only setup mode, so a fresh clone works
immediately. To exercise the auth gates (or point state somewhere else),
Bun auto-loads `dashboard/.env`:

```bash
cat > .env <<'ENV'
RDS_BUILDS_DIR=/tmp/rds-dev/builds
RDS_INBOX_DIR=/tmp/rds-dev/inbox
RDS_EVENTS_PATH=/tmp/rds-dev/events.jsonl
RDS_DASHBOARD_CHAT_DIR=/tmp/rds-dev/chat
RDS_DASHBOARD_STATE_DIR=/tmp/rds-dev/state
RDS_DASHBOARD_PASSWORD=localdev
RDS_DASHBOARD_TOKEN=localtoken
PORT=4000
ENV
mkdir -p /tmp/rds-dev/builds
```

Notes for macOS:

- `bin/rds-dashboard --detach/--status/--stop` use a pidfile under `/dev/shm`
  on Linux and fall back to `$TMPDIR` elsewhere; foreground
  `bin/rds-dashboard` works everywhere.
- Builds show as "running" only when the build runner PID is alive; PID
  detection uses `/proc` on Linux and `ps` elsewhere.
- A "build" is just a directory: drop a `state.json` under
  `RDS_BUILDS_DIR/<id>/` (see `builds/README.md` and
  `dashboard/tests/selftest.ts` for realistic shapes) and the dashboard will
  render it — no model workers needed.

## Smoke test

`bin/rds-selftest` runs the Playwright smoke suite in
`dashboard/tests/selftest.ts` against a running dashboard: page renders, auth,
build rows, build-detail controls, toast accessibility. It needs
`RDS_DASHBOARD_PASSWORD` and a Playwright Chromium
(`bunx playwright install chromium`).
