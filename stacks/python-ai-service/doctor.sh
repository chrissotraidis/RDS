#!/usr/bin/env bash
set -euo pipefail

FAIL=0
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "✓ stack:python-ai-service $name"
  else
    echo "✗ stack:python-ai-service $name"
    FAIL=1
  fi
}

check "python >= 3.12" bash -c 'python3.12 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"'
check "venv" python3.12 -m venv --help
check "pip bootstrap" bash -c 'tmp="$(mktemp -d)"; python3.12 -m venv "$tmp/venv"; "$tmp/venv/bin/python" -m ensurepip --upgrade >/dev/null 2>&1 || true; "$tmp/venv/bin/python" -m pip --version'
check "curl" curl --version

exit "$FAIL"
