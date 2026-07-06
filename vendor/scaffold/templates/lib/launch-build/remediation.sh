# remediation.sh — post-remediation re-verification, shared by both the
# verification-remediation loop and the Codex-review remediation loop.
#
# Sourced from launch-build.sh. The stage-specific prose and the post-remediation
# failure-kind differ slightly between callers, so the prose arguments are
# injected explicitly.
#
# post_remediation_verify_or_fail <stage> <runtime_desc> <runtime_err_msg_prefix> <post_rem_desc> <position> <title> <review_file> <start_ref>
#
# Side effects on failure:
#   - calls set_failure_state, print_failure_summary
#   - marks the task error (runtime fail) or block (static fail)
#   - removes $review_file
# Returns 1 on failure, 0 on success.

post_remediation_verify_or_fail() {
  local stage="$1"
  local runtime_desc="$2"
  local runtime_err_msg_prefix="$3"
  local post_rem_desc="$4"
  local position="$5"
  local title="$6"
  local review_file="$7"
  local start_ref="$8"

  local max_passes="${VERIFY_REMEDIATION_PASSES:-3}"
  local pass=1
  local verify_status=0

  while (( pass <= max_passes )); do
    echo ""
    echo "Re-running verification after remediation (pass ${pass}/${max_passes})..."
    if [[ -n "$start_ref" ]]; then
      export SCAFFOLD_TASK_FILES_CHANGED=$(git diff --name-only "$start_ref" HEAD 2>/dev/null || true)
    fi

    run_task_verification_with_runtime "$position"
    verify_status=$?
    if [[ "$verify_status" -eq 0 ]]; then
      return 0
    fi

    if [[ "$verify_status" -eq 2 ]]; then
      break
    fi

    if (( pass < max_passes )); then
      echo ""
      echo "Verification still failing — running additional Claude remediation pass (${pass}/${max_passes})..."
      if ! run_verification_remediation "$position" "$title" "$persona" "$LAST_VERIFY_OUTPUT_FILE"; then
        echo ""
        echo "Remediation pass ${pass} failed to execute; will treat as final failure."
        break
      fi
    fi
    pass=$((pass + 1))
  done

  echo ""
  if [[ "$verify_status" -eq 2 ]]; then
    set_failure_state \
      "$stage" \
      "${VERIFY_RUNTIME_FAILURE_KIND:-runtime_health_failed}" \
      "$runtime_desc" \
      "Fix the runtime boot issue, then reset the task and rerun launch-build."
    print_failure_summary "$position" "$title"
    echo "${VERIFY_RUNTIME_FAILURE_KIND:-runtime_health_failed}: ${runtime_err_msg_prefix} for task $position. Marking as error."
    ruby bin/task error "$position" "${VERIFY_RUNTIME_FAILURE_KIND:-runtime_health_failed}: ${runtime_err_msg_prefix}"
  else
    set_failure_state \
      "$stage" \
      "post_remediation_verification_failed" \
      "$post_rem_desc" \
      "Inspect the failing required checks, then reset the task and rerun launch-build."
    print_failure_summary "$position" "$title"
    echo "task_verification_failed: Verification failed after remediation for task $position. Circuit breaker tripped — marking blocked."
    ruby bin/task block "$position" "task_verification_failed: Post-remediation verification failed"
  fi
  rm -f "$review_file"
  return 1
}
