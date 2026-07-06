#!/usr/bin/env bash
set -euo pipefail

FAIL=0
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "✓ stack:astro-thin-web $name"
  else
    echo "✗ stack:astro-thin-web $name"
    FAIL=1
  fi
}

check "bun" bun --version
check "node >= 20" bash -c 'node -e "process.exit(Number(process.versions.node.split(\".\")[0]) >= 20 ? 0 : 1)"'
check "curl" curl --version

exit "$FAIL"
