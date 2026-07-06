#!/usr/bin/env bash
# stop-gate.sh — Fires on Claude Code Stop. Runs static verification for the
# current task (position exported by launch-build.sh) and exits 2 on failure,
# which Claude Code treats as blocking and surfaces stderr to the agent.
#
# Runtime-dependent checks are skipped here — the stop-gate has no live server.
# The harness's post-session verify boots a runtime and runs the full set.

set -u

position="${SCAFFOLD_TASK_POSITION:-}"

if [[ -z "$position" ]]; then
  exit 0
fi

if bin/task verify "$position" --skip-runtime-deps >/dev/null 2>&1; then
  exit 0
fi

echo "stop-gate: verification failed for task $position" >&2
echo "stop-gate: run \`bin/task verify $position\` to see details" >&2
exit 2
