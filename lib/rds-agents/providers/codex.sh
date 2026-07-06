#!/usr/bin/env bash

rds_agent_provider_detect() {
  command -v codex >/dev/null 2>&1 || return 1
  codex --version 2>/dev/null | head -n1
}

rds_agent_provider_interactive_command() {
  printf 'codex'
}

rds_agent_provider_print_command() {
  local model_args=()
  if [[ -n "${RDS_CODEX_MODEL:-}" ]]; then
    model_args=(--model "$RDS_CODEX_MODEL")
  fi
  printf 'codex exec --sandbox danger-full-access --skip-git-repo-check --color never'
  if [[ "${#model_args[@]}" -gt 0 ]]; then
    printf ' %q %q' "${model_args[@]}"
  fi
  printf ' -'
}

