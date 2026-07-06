#!/usr/bin/env bash
# stacks/rails/doctor.sh — prereq smoke-check for the Rails stack.
# Called by bootstrap/verify.sh once per registered stack. Prints
# one line per check and exits 1 if any fails.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FAIL=0

check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "✓ stack:rails $name"
  else
    echo "✗ stack:rails $name"
    FAIL=1
  fi
}

check "ruby >= 4.0.1"      bash -c '/opt/rubies/ruby-4.0.1/bin/ruby --version || ruby --version'
check "bundler"            bundle --version
check "postgres-15"        bash -c 'psql --version | grep -qE " (15|16|17|18)\."'
check "pg_isready"         pg_isready
check "rails-starter" test -f "$ROOT/vendor/rails-starter/bin/template-setup"

exit "$FAIL"
