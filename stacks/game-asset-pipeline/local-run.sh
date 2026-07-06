#!/usr/bin/env bash
set -euo pipefail

APP_DEST="${1:?app destination required}"
BUILD_DIR="${2:?build dir required}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/bin/lib/common.sh"
# shellcheck disable=SC1091
source "$ROOT/bin/lib/logging.sh"

cd "$APP_DEST"

command -v uv >/dev/null 2>&1 || { echo "FATAL: uv is required for the game-asset-pipeline stack" >&2; exit 1; }

if [[ ! -f .env ]]; then
  : > .env
fi
if ! grep -q '^HOST_PORT=' .env 2>/dev/null; then
  printf 'HOST_PORT=%s\n' \
    "$(next_free_port "${RDS_LOCAL_PORT_RANGE_START:-4000}" "${RDS_LOCAL_PORT_RANGE_END:-4099}")" \
    >> .env
fi
local_port="$(grep '^HOST_PORT=' .env | head -n1 | cut -d= -f2)"
[[ "$local_port" =~ ^[0-9]+$ ]] || { echo "FATAL: HOST_PORT is not numeric: $local_port" >&2; exit 1; }

mkdir -p tmp/pids log
pidfile="$APP_DEST/tmp/pids/server.pid"
if [[ -f "$pidfile" ]]; then
  old_pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" || true
    sleep 1
  fi
  rm -f "$pidfile"
fi

uv sync
uv run pytest -q
PYTHONPATH="$APP_DEST" uv run python scripts/process_asset.py --input assets/in/sample_asset.json --spec spec/target_spec.yaml
PYTHONPATH="$APP_DEST" uv run python scripts/build_preview.py

HOST_PORT="$local_port" PYTHONPATH="$APP_DEST" setsid nohup uv run python scripts/serve_preview.py \
  > "$APP_DEST/log/asset-preview.log" 2>&1 &
echo "$!" > "$pidfile"

timeout="${RDS_WAIT_HEALTH_TIMEOUT_SEC:-120}"
interval=2
elapsed=0
healthy=0
log "  waiting up to ${timeout}s for http://localhost:$local_port/health.json ..."
while (( elapsed <= timeout )); do
  code="$(curl -sS -o /dev/null -w "%{http_code}" "http://localhost:$local_port/health.json" 2>/dev/null || true)"
  if [[ "$code" =~ ^[23][0-9][0-9]$ ]]; then
    healthy=1
    break
  fi
  sleep "$interval"
  elapsed=$((elapsed + interval))
done

if [[ "$healthy" -ne 1 ]]; then
  echo "FATAL: game-asset-pipeline preview did not report healthy within ${timeout}s" >&2
  tail -80 "$APP_DEST/log/asset-preview.log" >&2 || true
  exit 1
fi

printf '%s\n' "game-asset-pipeline preview healthy on port $local_port"
