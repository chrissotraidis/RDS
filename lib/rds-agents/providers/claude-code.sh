#!/usr/bin/env bash

rds_agent_provider_detect() {
  command -v claude >/dev/null 2>&1 || return 1
  claude --version 2>/dev/null | head -n1
}

rds_agent_provider_interactive_command() {
  local name="$1"
  if [[ -n "${RDS_CLAUDE_MODEL:-}" ]]; then
    printf 'claude --name %q --model %q' "$name" "$RDS_CLAUDE_MODEL"
  else
    printf 'claude --name %q' "$name"
  fi
}

rds_agent_provider_print_command() {
  if [[ -n "${RDS_CLAUDE_MODEL:-}" ]]; then
    printf 'claude -p --permission-mode auto --output-format text --model %q' "$RDS_CLAUDE_MODEL"
  else
    printf 'claude -p --permission-mode auto --output-format text'
  fi
}

