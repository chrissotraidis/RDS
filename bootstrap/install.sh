#!/usr/bin/env bash
# bootstrap/install.sh — one-shot setup for a fresh Zo VM.
# Idempotent: safe to re-run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { echo "[install $(date -u +%FT%TZ)] $*"; }

log "RDS install starting (root=$ROOT)"

# --- Step 1: OS prerequisites -----------------------------------------------
log "Step 1 — OS prerequisites"
MISSING=0
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "  MISSING: $1"
    MISSING=1
  else
    log "  ok: $1"
  fi
}
need git
need ruby
need bundle
need curl
need jq
need rsync
# Bun powers the dashboard (bin/rds-dashboard). Optional but recommended.
if command -v bun >/dev/null 2>&1 || [[ -x /root/.bun/bin/bun ]]; then
  log "  ok: bun"
else
  log "  WARN: bun not found — bin/rds-dashboard will not start until Bun is installed (https://bun.sh)"
fi

if [[ "$MISSING" -ne 0 ]]; then
  log "Install the above, then re-run."
  exit 1
fi

# --- Step 2: Claude Code CLI ------------------------------------------------
log "Step 2 — Claude Code CLI"
if ! command -v claude >/dev/null 2>&1; then
  log "  FATAL: Claude Code CLI ('claude') not found."
  log "  On Zo this is expected to be pre-installed with subscription auth."
  log "  Abort."
  exit 1
fi
log "  claude: $(claude --version 2>/dev/null || echo unknown)"

# --- Step 3: Arnold CLI -----------------------------------------------------
log "Step 3 — Arnold CLI"
if ! command -v arnold >/dev/null 2>&1; then
  if [[ -n "${ARNOLD_REMOTE:-}" ]]; then
    log "  arnold not found — building from source"
    "$ROOT/bootstrap/build-arnold.sh"
  else
    log "  WARN: arnold not found and ARNOLD_REMOTE is unset"
    log "  Wiki can run without Arnold context; set ARNOLD_REMOTE and rerun install.sh if you want it."
  fi
else
  log "  arnold present: $(arnold --version 2>/dev/null || echo unknown)"
fi

# --- Step 4: Wiki plugin smoke test --------------------------------
log "Step 4 — Wiki plugin"
if [[ ! -f "$ROOT/vendor/wiki/.claude-plugin/plugin.json" ]]; then
  log "  FATAL: vendor/wiki/.claude-plugin/plugin.json missing."
  log "  Re-vendor wiki (see vendor/README.md) and re-run."
  exit 1
fi
# Smoke test: ensure Claude accepts the plugin dir. Actual load happens at
# build time via --plugin-dir in bin/rds-spec.
if ! claude --plugin-dir "$ROOT/vendor/wiki" --version >/dev/null 2>&1; then
  log "  WARN: 'claude --plugin-dir vendor/wiki --version' failed."
  log "  This may mean your Claude CLI version does not support --plugin-dir."
  log "  See docs/TROUBLESHOOTING.md (Wiki plugin fails to load)."
fi

# --- Step 5: Apply local patches to vendored components --------------------
log "Step 5 — applying patches"
shopt -s nullglob
for p in "$ROOT"/patches/*.patch; do
  log "  trying $(basename "$p")"
  if git apply --check "$p" >/dev/null 2>&1; then
    git apply "$p"
    log "    applied"
  elif git apply --reverse --check "$p" >/dev/null 2>&1; then
    log "    already applied — skipping"
  else
    log "    WARN: $(basename "$p") does not apply cleanly; leaving as-is"
  fi
done
shopt -u nullglob

# --- Step 6: Directories ----------------------------------------------------
log "Step 6 — preparing directories"
mkdir -p inbox builds logs fixtures

# --- Step 7: Env file -------------------------------------------------------
log "Step 7 — env"
if [[ ! -f .env ]]; then
  cp .env.example .env
  log "  created .env from .env.example — **edit before running a build**"
else
  log "  .env already present — leaving it alone"
fi

# --- Step 8: Dashboard deps -------------------------------------------------
log "Step 8 — dashboard (bin/rds-dashboard)"
if [[ -f "$ROOT/dashboard/package.json" ]]; then
  BUN="${BUN_BIN:-}"
  [[ -z "$BUN" || ! -x "$BUN" ]] && BUN="$(command -v bun || echo /root/.bun/bin/bun)"
  if [[ -x "$BUN" ]]; then
    (cd "$ROOT/dashboard" && "$BUN" install)
    log "  dashboard deps installed"
  else
    log "  WARN: bun not found — skipping dashboard install. Run 'bin/rds-dashboard --install' once Bun is on PATH."
  fi
else
  log "  WARN: dashboard/package.json missing — skipping"
fi

# --- Step 9: Version stamp --------------------------------------------------
log "Step 9 — writing version stamp"
stamp_file="$ROOT/.rds-installed"
{
  echo "installed_at=$(date -u +%FT%TZ)"
  if git rev-parse HEAD >/dev/null 2>&1; then
    echo "rds_commit=$(git rev-parse HEAD)"
  else
    echo "rds_commit=unknown (not a git repo)"
  fi
  echo "scaffold_commit=$(cd vendor/scaffold 2>/dev/null && git rev-parse HEAD 2>/dev/null || echo copied-from-local)"
  echo "wiki_commit=$(cd vendor/wiki 2>/dev/null && git rev-parse HEAD 2>/dev/null || echo copied-from-local)"
  echo "rails_starter_commit=$(cd vendor/rails-starter 2>/dev/null && git rev-parse HEAD 2>/dev/null || echo copied-from-local)"
} > "$stamp_file"
log "  wrote $stamp_file"

log "Install complete. Next: ./bootstrap/verify.sh"
