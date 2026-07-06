#!/usr/bin/env bash

agent_slug() {
  local value="${1:-task}"
  value="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
  printf '%s\n' "${value:-task}" | cut -c1-40
}

agent_now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

agent_provider_file() {
  case "${1:-}" in
    claude|claude-code) printf '%s\n' "$RDS_ROOT/lib/rds-agents/providers/claude-code.sh" ;;
    codex) printf '%s\n' "$RDS_ROOT/lib/rds-agents/providers/codex.sh" ;;
    *) return 1 ;;
  esac
}

agent_normalize_provider() {
  case "${1:-}" in
    claude|claude-code|"") printf '%s\n' "claude-code" ;;
    codex) printf '%s\n' "codex" ;;
    *) echo "FATAL: unknown agent provider '$1'." >&2; return 2 ;;
  esac
}

agent_session_root() {
  local build_id="${1:-}"
  if [[ -n "$build_id" ]]; then
    printf '%s\n' "${RDS_BUILDS_DIR:-$RDS_ROOT/builds}/$build_id/agent-sessions"
  else
    printf '%s\n' "$RDS_ROOT/agent-sessions"
  fi
}

agent_find_session_json() {
  local id="${1:-}"
  [[ -n "$id" ]] || return 1
  local found
  found="$(find "$RDS_ROOT/agent-sessions" "${RDS_BUILDS_DIR:-$RDS_ROOT/builds}" -path "*/agent-sessions/$id.json" -type f 2>/dev/null | head -n1 || true)"
  [[ -n "$found" ]] || return 1
  printf '%s\n' "$found"
}

agent_json_get() {
  local file="$1" expr="$2"
  jq -r "$expr // empty" "$file" 2>/dev/null || true
}

agent_update_json() {
  local file="$1"; shift
  local tmp
  tmp="$(mktemp)"
  jq "$@" "$file" >"$tmp"
  mv "$tmp" "$file"
}

agent_tmux_exists() {
  local session="${1:-}"
  [[ -n "$session" ]] || return 1
  tmux has-session -t "$session" 2>/dev/null
}

agent_repo_branch() {
  git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null | sed 's/^HEAD$/main/' || printf 'main\n'
}

agent_unique_branch() {
  local repo="$1" wanted="$2" branch n=2
  branch="$wanted"
  while git -C "$repo" show-ref --verify --quiet "refs/heads/$branch" || git -C "$repo" show-ref --verify --quiet "refs/remotes/origin/$branch"; do
    branch="${wanted}-${n}"
    n=$((n + 1))
  done
  printf '%s\n' "$branch"
}

agent_unique_worktree_path() {
  local repo="$1" slug="$2"
  local parent base path n
  parent="$(dirname "$repo")"
  base="$(basename "$repo")"
  path="$parent/${base}-worktrees/$slug"
  n=2
  while [[ -e "$path" ]]; do
    path="$parent/${base}-worktrees/${slug}-${n}"
    n=$((n + 1))
  done
  printf '%s\n' "$path"
}

agent_changed_files_json() {
  local worktree="$1"
  [[ -d "$worktree" ]] || { printf '[]\n'; return 0; }
  git -C "$worktree" status --short 2>/dev/null | sed -E 's/^...//' | jq -R -s 'split("\n") | map(select(length > 0))'
}

agent_write_context_packet() {
  local worktree="$1" session_json="$2"
  local context_dir="$worktree/.agent-session"
  mkdir -p "$context_dir"
  local exclude_file
  exclude_file="$(git -C "$worktree" rev-parse --git-path info/exclude 2>/dev/null || true)"
  if [[ -n "$exclude_file" ]]; then
    mkdir -p "$(dirname "$exclude_file")"
    touch "$exclude_file"
    grep -qxF ".agent-session/" "$exclude_file" || printf '\n.agent-session/\n' >>"$exclude_file"
  fi
  local build_id repo branch task provider log_path state_path
  build_id="$(agent_json_get "$session_json" '.build_id')"
  repo="$(agent_json_get "$session_json" '.repo_root')"
  branch="$(agent_json_get "$session_json" '.branch')"
  task="$(agent_json_get "$session_json" '.task')"
  provider="$(agent_json_get "$session_json" '.provider')"
  log_path="$(agent_json_get "$session_json" '.log_path')"
  {
    echo "# RDS Agent Session Context"
    echo
    echo "- Task: $task"
    echo "- Provider: $provider"
    echo "- Build ID: ${build_id:-none}"
    echo "- Repo root: $repo"
    echo "- Worktree: $worktree"
    echo "- Branch: $branch"
    echo "- Log path: $log_path"
    echo
    echo "## Constraints"
    echo
    echo "- Do not push to GitHub."
    echo "- Do not merge the branch."
    echo "- Do not edit RDS itself unless the task explicitly asks for RDS changes."
    echo "- Keep work inside this worktree."
    echo "- Run relevant checks and leave a short summary of what changed."
    if [[ -n "$build_id" && -f "${RDS_BUILDS_DIR:-$RDS_ROOT/builds}/$build_id/state.json" ]]; then
      echo
      echo "## RDS Build State"
      echo
      echo '```json'
      jq '{id: .id, slug: .slug, mode: .mode, stage: .stage, status: .status, review: .review, app_dest: .app_dest, preview_url: .preview_url, stack: .stack, app_type: .app_type}' "${RDS_BUILDS_DIR:-$RDS_ROOT/builds}/$build_id/state.json" 2>/dev/null || true
      echo '```'
    fi
    if [[ -n "$build_id" && -f "${RDS_BUILDS_DIR:-$RDS_ROOT/builds}/$build_id/spec.md" ]]; then
      echo
      echo "## Spec Excerpt"
      echo
      sed -n '1,180p' "${RDS_BUILDS_DIR:-$RDS_ROOT/builds}/$build_id/spec.md"
    fi
  } >"$context_dir/context.md"
}
