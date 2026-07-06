#!/usr/bin/env bash
# context-guard.sh — PreToolUse hook, fires on every Edit/Write/MultiEdit.
#
# Blocks writes to context-plane artifacts (spec.md, CLAUDE.md, config.yml,
# .scaffold/*). Exit 2 returns stderr to the agent so it can reconsider.
#
# Parses the JSON payload structurally — regex matching would miss
# edits whose old_string/new_string contents contain "file_path": keys
# (common when editing JSON, code samples, or this hook itself).
# Prefers jq (fast) and falls back to ruby (always available).

set -u

payload="$(cat)"

if command -v jq >/dev/null 2>&1; then
  file_path="$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null)"
else
  file_path="$(printf '%s' "$payload" | ruby -rjson -e '
    begin
      data = JSON.parse(STDIN.read)
      path = data.dig("tool_input", "file_path") || data.dig("tool_input", "path") || ""
      puts path
    rescue
      puts ""
    end
  ' 2>/dev/null)"
fi

if [[ -z "$file_path" ]]; then
  exit 0
fi

rel="${file_path#./}"
if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
  rel="${rel#${CLAUDE_PROJECT_DIR}/}"
fi

case "$rel" in
  spec.md|CLAUDE.md|config.yml|.scaffold|.scaffold/*)
    echo "context-guard: refusing write to context-plane artifact: $rel" >&2
    echo "context-guard: spec.md, CLAUDE.md, config.yml, and .scaffold/ are read-only during task execution." >&2
    echo "context-guard: if the spec must change, stop the task and update it outside the build harness." >&2
    exit 2
    ;;
esac

exit 0
