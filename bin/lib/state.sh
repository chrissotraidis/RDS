# bin/lib/state.sh — manages $BUILD_DIR/state.json. Source-only.
#
# Requires `jq`. state.json shape is documented in docs/PIPELINE.md.

STATE_STAGES=(intake spec taste skill-resolve rails-init scaffold skill-install local-run deploy qa taste-review)

_state_file() { printf '%s\n' "$1/state.json"; }

_now() { date -u +%FT%TZ; }

# state_init <build_dir> <mode> <repo_url> <prd_source> <trigger> [app_dest] [stack] [provider] [claude_model] [codex_model] [app_type] [display_name]
# Initializes state.json for a new build. mode is green|brown. stack defaults to "rails".
state_init() {
  local dir="$1" mode="$2" repo_url="${3:-}" prd_source="${4:-}" trigger="${5:-}" app_dest="${6:-}" stack="${7:-rails}" provider="${8:-claude}" claude_model="${9:-}" codex_model="${10:-}" app_type="${11:-auto}" display_name="${12:-}"
  local now; now="$(_now)"
  local build_id; build_id="$(basename "$dir")"
  mkdir -p "$dir"
  jq -n \
    --arg build_id "$build_id" \
    --arg mode "$mode" \
    --arg stack "$stack" \
    --arg trigger "$trigger" \
    --arg repo_url "$repo_url" \
    --arg prd_source "$prd_source" \
    --arg app_dest "$app_dest" \
    --arg provider "$provider" \
    --arg claude_model "$claude_model" \
    --arg codex_model "$codex_model" \
    --arg app_type "$app_type" \
    --arg display_name "$display_name" \
    --arg now "$now" \
    '{
      build_id: $build_id,
      display_name: (if $display_name == "" then null else $display_name end),
      mode: $mode,
      stack: $stack,
      app_type: (if $app_type == "" or $app_type == "auto" then null else $app_type end),
      inference: {
        provider: $provider,
        claude_model: (if $claude_model == "" then null else $claude_model end),
        codex_model:  (if $codex_model  == "" then null else $codex_model  end)
      },
      trigger:    (if $trigger    == "" then null else $trigger    end),
      repo_url:   (if $repo_url   == "" then null else $repo_url   end),
      prd_source: (if $prd_source == "" then null else $prd_source end),
      app_dest:   (if $app_dest   == "" then null else $app_dest   end),
      started_at: $now,
      updated_at: $now,
      current_stage: null,
      stages: {
        "intake":     {status: "pending"},
        "spec":         {status: "pending"},
        "taste":        {status: "pending"},
        "skill-resolve": {status: "pending"},
        "rails-init":   {status: "pending"},
        "scaffold":     {status: "pending"},
        "skill-install": {status: "pending"},
        "local-run":    {status: "pending"},
        "deploy":       {status: "pending"},
        "qa":           {status: "pending"},
        "taste-review": {status: "pending"}
      },
      preview_url: null,
      po_questions_file: null,
      review: { status: "not_required", decided_at: null, decided_by: null, reason: null },
      cost:   { total_usd: 0, total_tokens: 0, by_task: {}, updated_at: null },
      error: null
    }' > "$(_state_file "$dir")"
}

# state_set_app_type <build_dir> <app_type>
# Records the durable product type contract. Use "auto" only to clear it.
state_set_app_type() {
  local dir="$1" app_type="$2"
  local f; f="$(_state_file "$dir")"
  local tmp="$f.tmp.$$"
  jq --arg t "$app_type" --arg now "$(_now)" '
    .app_type = (if $t == "" or $t == "auto" then null else $t end) |
    .updated_at = $now
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
}

# state_set_app_dest <build_dir> <app_dest>
# Records the absolute path the build's app lives at. Idempotent.
state_set_app_dest() {
  local dir="$1" app_dest="$2"
  local f; f="$(_state_file "$dir")"
  local tmp="$f.tmp.$$"
  jq --arg p "$app_dest" --arg now "$(_now)" '
    .app_dest = $p | .updated_at = $now
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
}

# state_set_stage <build_dir> <stage> <status>
# status in: pending | running | done | skipped | failed | pending-review
state_set_stage() {
  local dir="$1" stage="$2" status="$3"
  local f; f="$(_state_file "$dir")"
  local now; now="$(_now)"
  local tmp="$f.tmp.$$"

  case "$status" in
    running)
      jq --arg s "$stage" --arg now "$now" '
        .current_stage = $s |
        .updated_at = $now |
        .stages[$s].status = "running" |
        .stages[$s].started_at = $now
      ' "$f" > "$tmp"
      ;;
    done|skipped|failed|pending-review)
      jq --arg s "$stage" --arg st "$status" --arg now "$now" '
        .updated_at = $now |
        .stages[$s].status = $st |
        .stages[$s].ended_at = $now
      ' "$f" > "$tmp"
      ;;
    pending)
      jq --arg s "$stage" --arg now "$now" '
        .updated_at = $now |
        .stages[$s] = {status: "pending"}
      ' "$f" > "$tmp"
      ;;
    *)
      echo "FATAL: state_set_stage unknown status '$status'" >&2
      rm -f "$tmp" 2>/dev/null
      return 1
      ;;
  esac

  mv "$tmp" "$f"
}

# state_set_error <build_dir> <message>
state_set_error() {
  local dir="$1" msg="$2"
  local f; f="$(_state_file "$dir")"
  local tmp="$f.tmp.$$"
  jq --arg m "$msg" --arg now "$(_now)" '
    .error = $m | .updated_at = $now
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
}

# state_set_preview <build_dir> <url>
state_set_preview() {
  local dir="$1" url="$2"
  local f; f="$(_state_file "$dir")"
  local tmp="$f.tmp.$$"
  jq --arg u "$url" --arg now "$(_now)" '
    .preview_url = $u | .updated_at = $now
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
}

# state_set_po_questions <build_dir> <path>
state_set_po_questions() {
  local dir="$1" path="$2"
  local f; f="$(_state_file "$dir")"
  local tmp="$f.tmp.$$"
  jq --arg p "$path" --arg now "$(_now)" '
    .po_questions_file = $p | .updated_at = $now
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
}

# state_mark_complete <build_dir>
# Sets current_stage to null to signal "done".
state_mark_complete() {
  local dir="$1"
  local f; f="$(_state_file "$dir")"
  local tmp="$f.tmp.$$"
  jq --arg now "$(_now)" '
    .current_stage = null | .updated_at = $now
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
}

# state_set_review <build_dir> <status> [decided_by] [reason]
# status in: not_required | pending | approved | rejected
# Used by the operator approval gate (TD-033).
state_set_review() {
  local dir="$1" status="$2" by="${3:-}" reason="${4:-}"
  local f; f="$(_state_file "$dir")"
  local tmp="$f.tmp.$$"
  case "$status" in
    not_required|pending|approved|rejected) ;;
    *)
      echo "FATAL: state_set_review unknown status '$status'" >&2
      return 1 ;;
  esac
  jq --arg s "$status" --arg by "$by" --arg reason "$reason" --arg now "$(_now)" '
    .review = {
      status: $s,
      decided_at: (if ($s == "approved" or $s == "rejected") then $now else (.review.decided_at // null) end),
      decided_by: (if $by == "" then (.review.decided_by // null) else $by end),
      reason:     (if $reason == "" then (.review.reason // null) else $reason end)
    } |
    .updated_at = $now
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
}

# state_set_cost <build_dir> <total_usd> <total_tokens> <by_task_json>
# Updates the cost rollup. by_task_json is a JSON object keyed by task position.
state_set_cost() {
  local dir="$1" total_usd="$2" total_tokens="$3" by_task_json="$4"
  local f; f="$(_state_file "$dir")"
  local tmp="$f.tmp.$$"
  jq --argjson usd "$total_usd" --argjson tok "$total_tokens" \
     --argjson by "$by_task_json" --arg now "$(_now)" '
    .cost = { total_usd: $usd, total_tokens: $tok, by_task: $by, updated_at: $now } |
    .updated_at = $now
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
}

# state_set_build_plan <build_dir> <plan_json_path>
# Records the proportional execution plan selected before scaffold.
state_set_build_plan() {
  local dir="$1" plan_path="$2"
  local f; f="$(_state_file "$dir")"
  local tmp="$f.tmp.$$"
  jq --slurpfile plan "$plan_path" --arg rel "builds/$(basename "$dir")/build-plan.json" --arg now "$(_now)" '
    .build_plan = ($plan[0] + { path: $rel }) |
    .updated_at = $now
  ' "$f" > "$tmp"
  mv "$tmp" "$f"
}
