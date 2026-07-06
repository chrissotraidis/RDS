#!/usr/bin/env bash
# fixtures/build-fixture-repo.sh — assemble the brown-field smoke-test
# fixture repo from the already-vendored Rails starter.
#
# Why this is a script, not a committed bare repo:
#   The seeded working tree is ~13 MB. RDS itself is much smaller. Rather
#   than ship the bare repo in git, we build it on demand from the
#   Rails starter that's already vendored, then point rds-build at
#   it via a `file://` URL.
#
# Usage:
#   ./fixtures/build-fixture-repo.sh
#   # then:
#   ./bin/rds-build \
#       --repo="file://$(pwd)/fixtures/fixture-brown-field-repo.git" \
#       --prd=./inbox/fixture-prd.md \
#       --deploy-target=none
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/vendor/rails-starter"
FIXTURE_BARE="$ROOT/fixtures/fixture-brown-field-repo.git"
WORK="$ROOT/fixtures/_work"

[[ -d "$TEMPLATE" ]] || {
  echo "FATAL: $TEMPLATE not found — vendor first" >&2; exit 1; }

if [[ -d "$FIXTURE_BARE" ]]; then
  echo "[fixture] $FIXTURE_BARE already exists — remove it first to rebuild." >&2
  exit 0
fi

echo "[fixture] seeding working tree at $WORK"
rm -rf "$WORK"
mkdir -p "$WORK"
rsync -a \
  --exclude='.git' --exclude='log/*.log' --exclude='tmp/cache' \
  --exclude='vendor/bundle' --exclude='node_modules' \
  "$TEMPLATE/" "$WORK/"

cd "$WORK"
git init -q

# Default identity so the seed commit doesn't fail on a fresh box.
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-RDS}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-rds@local}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}"
export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"

git add -A
git -c commit.gpgsign=false commit -q -m "feat: seed brown-field fixture from Rails starter"

echo "[fixture] cloning to bare repo at $FIXTURE_BARE"
git clone --bare "$WORK" "$FIXTURE_BARE" >/dev/null 2>&1

# Cleanup working tree — only the bare repo is needed.
rm -rf "$WORK"

echo "[fixture] done."
echo "[fixture] smoke-test command:"
echo "  ./bin/rds-build --repo=\"file://$FIXTURE_BARE\" --prd=./inbox/fixture-prd.md --deploy-target=none"
