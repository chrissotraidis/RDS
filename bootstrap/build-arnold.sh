#!/usr/bin/env bash
# bootstrap/build-arnold.sh — builds Arnold from source.
#
# Arnold is not distributed as a Linux binary. On Zo we build from source and
# install a small wrapper to /usr/local/bin/arnold that shells into the
# checked-out Gemfile.
#
# If the Arnold repo layout differs at build time, inspect it and adjust this
# script. If Arnold cannot be built and the Wiki plugin can run without it,
# the caller may replace arnold with a no-op shim (see docs/TROUBLESHOOTING.md).
set -euo pipefail

ARNOLD_REMOTE="${ARNOLD_REMOTE:-}"
ARNOLD_DIR="${ARNOLD_DIR:-/opt/arnold}"
INSTALL_PATH="${ARNOLD_INSTALL_PATH:-/usr/local/bin/arnold}"

log() { echo "[build-arnold $(date -u +%FT%TZ)] $*"; }
run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "FATAL: need root privileges or sudo for: $*" >&2
    exit 1
  fi
}

command -v git   >/dev/null || { echo "FATAL: git required" >&2; exit 1; }
command -v ruby  >/dev/null || { echo "FATAL: ruby required" >&2; exit 1; }
command -v bundle >/dev/null || { echo "FATAL: bundler required" >&2; exit 1; }
[[ -n "$ARNOLD_REMOTE" ]] || {
  echo "FATAL: ARNOLD_REMOTE is required when arnold is not already installed." >&2
  exit 1
}

# Persistent install dir (not /tmp) so the wrapper survives reboots.
if [[ -d "$ARNOLD_DIR/.git" ]]; then
  log "updating existing clone at $ARNOLD_DIR"
  (cd "$ARNOLD_DIR" && git fetch --quiet && git reset --hard origin/HEAD)
else
  log "cloning $ARNOLD_REMOTE → $ARNOLD_DIR"
  run_privileged mkdir -p "$(dirname "$ARNOLD_DIR")"
  run_privileged chown "$(id -u):$(id -g)" "$(dirname "$ARNOLD_DIR")" 2>/dev/null || true
  git clone "$ARNOLD_REMOTE" "$ARNOLD_DIR"
fi

log "bundle install"
(cd "$ARNOLD_DIR" && bundle install --path vendor/bundle)

# Arnold's entrypoint: prefer exe/arnold, fall back to bin/arnold.
ENTRY=""
for candidate in exe/arnold bin/arnold; do
  if [[ -f "$ARNOLD_DIR/$candidate" ]]; then
    ENTRY="$candidate"; break
  fi
done
if [[ -z "$ENTRY" ]]; then
  log "FATAL: neither exe/arnold nor bin/arnold found in $ARNOLD_DIR"
  log "       Arnold repo layout may have changed — inspect manually."
  exit 1
fi

log "installing wrapper → $INSTALL_PATH"
if [[ "$(id -u)" -eq 0 ]]; then
  tee "$INSTALL_PATH" >/dev/null <<WRAPPER
#!/usr/bin/env bash
exec bundle exec --gemfile="$ARNOLD_DIR/Gemfile" ruby "$ARNOLD_DIR/$ENTRY" "\$@"
WRAPPER
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "FATAL: need root privileges or sudo to write $INSTALL_PATH" >&2
    exit 1
  fi
  sudo tee "$INSTALL_PATH" >/dev/null <<WRAPPER
#!/usr/bin/env bash
exec bundle exec --gemfile="$ARNOLD_DIR/Gemfile" ruby "$ARNOLD_DIR/$ENTRY" "\$@"
WRAPPER
fi
run_privileged chmod 0755 "$INSTALL_PATH"

if arnold --version >/dev/null 2>&1; then
  log "arnold installed: $(arnold --version)"
else
  log "FATAL: arnold wrapper installed but --version failed."
  log "       See docs/TROUBLESHOOTING.md (Arnold build fails → stub with shim)."
  exit 1
fi
