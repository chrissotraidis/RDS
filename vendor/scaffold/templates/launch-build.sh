#!/usr/bin/env bash
# launch-build.sh — Autonomous build with per-task context isolation
#
# Each task runs in its own Claude Code session with a fresh context window.
# State persists via tasks.json on disk between sessions.
# Verification checks from config.yml enforce empirical correctness.
#
# Usage:
#   ./launch-build.sh                  # Interactive — opens claude, you type /build
#   ./launch-build.sh --auto           # Autonomous, one task then stop
#   ./launch-build.sh --auto --batch   # Continuous loop: all tasks, one session each
#   ./launch-build.sh --headless       # Non-interactive, one task per invocation
#
# Options:
#   --max-turns N       Max tool invocations per task session (default: 150)
#   --max-budget USD    Max API spend per task session (default: 5.00)
#   --batch             Loop through all tasks (auto/headless only)
#   --codex-preflight-review  Run advisory Codex preflight review during bundle preparation
#   --codex-review      Run a Codex review after task verification
#   --codex-review-strict  Fail the task if Codex review exits non-zero

set -euo pipefail
cd "$(dirname "$0")"

LOCKDIR=".scaffold/build.lock"
mkdir -p .scaffold

ensure_local_git_boundary() {
  local top=""
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  local workspace_root="${RDS_WORKSPACE_ROOT:-/home/workspace}"
  if [[ -z "$top" || "$top" == "$workspace_root" ]]; then
    echo "Isolating scaffold app from parent git worktree..."
    git init -q
  elif [[ "$top" != "$PWD" ]]; then
    echo "Using parent project git worktree at $top"
    return 0
  fi

  git config user.email rds@local >/dev/null 2>&1 || true
  git config user.name "RDS" >/dev/null 2>&1 || true

  if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
    git add -A
    if ! git diff --cached --quiet; then
      git commit -q -m "RDS scaffold baseline" || true
    fi
  fi
}

ensure_local_git_boundary

# shellcheck source=lib/launch-build/lock.sh
source "lib/launch-build/lock.sh"
# shellcheck source=lib/launch-build/remediation.sh
source "lib/launch-build/remediation.sh"

acquire_build_lock

# Defaults
MODE="interactive"
MAX_TURNS="${RDS_SCAFFOLD_MAX_TURNS:-160}"
MAX_BUDGET="${RDS_SCAFFOLD_MAX_BUDGET:-10.00}"
BATCH=false
CODEX_PREFLIGHT_REVIEW=false
CODEX_REVIEW=false
CODEX_REVIEW_STRICT=false
REVIEW_FIX_MAX_TURNS="${REVIEW_FIX_MAX_TURNS:-40}"
REVIEW_FIX_MAX_BUDGET="${REVIEW_FIX_MAX_BUDGET:-1.50}"
REVIEW_EXEC_MAX_ATTEMPTS="${REVIEW_EXEC_MAX_ATTEMPTS:-2}"
REVIEW_PASS_MAX="${REVIEW_PASS_MAX:-3}"
[[ "${REVIEW_FIX_MAX_TURNS}" =~ ^[0-9]+$ ]] || REVIEW_FIX_MAX_TURNS=40
[[ "${REVIEW_FIX_MAX_BUDGET}" =~ ^[0-9]+(\.[0-9]+)?$ ]] || REVIEW_FIX_MAX_BUDGET="1.50"
[[ "${REVIEW_EXEC_MAX_ATTEMPTS}" =~ ^[0-9]+$ ]] || REVIEW_EXEC_MAX_ATTEMPTS=2
[[ "${REVIEW_PASS_MAX}" =~ ^[0-9]+$ ]] || REVIEW_PASS_MAX=2
VERIFY_RUNTIME_ACTIVE=false
VERIFY_RUNTIME_PORT=""
VERIFY_RUNTIME_BASE_URL=""
VERIFY_RUNTIME_LOG=""
VERIFY_RUNTIME_LAUNCH_PID=""
VERIFY_RUNTIME_CLEANUP_COMMAND=""
VERIFY_RUNTIME_FAILURE_KIND=""
LAST_VERIFY_OUTPUT_FILE=""
FAILURE_STAGE=""
FAILURE_KIND=""
FAILURE_ACTION_TAKEN=""
FAILURE_NEXT_STEP=""
FAILURE_VERIFICATION_STATE="not_run"
FAILURE_RUNTIME_STATE="not_started"
FAILURE_REVIEW_STATE="not_run"
FAILURE_RETRIES=""
REVIEW_RESULT=""
FAILURE_REVIEW_PASS=""
FAILURE_REVIEW_BASE_REF=""
FAILURE_REVIEW_HEAD_REF=""
FAILURE_REMEDIATION_COMMIT=""
FAILURE_REVIEW_UNRESOLVED_COUNT=""
FAILURE_REVIEW_NEW_COUNT=""
FAILURE_REVIEW_CARRY_COUNT=""
FAILURE_REVIEW_ADVISORY_COUNT=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --auto)       MODE="auto"; shift ;;
    --headless)   MODE="headless"; shift ;;
    --max-turns)  MAX_TURNS="$2"; shift 2 ;;
    --max-budget) MAX_BUDGET="$2"; shift 2 ;;
    --batch)      BATCH=true; shift ;;
    --codex-preflight-review) CODEX_PREFLIGHT_REVIEW=true; shift ;;
    --codex-review) CODEX_REVIEW=true; shift ;;
    --codex-review-strict) CODEX_REVIEW=true; CODEX_REVIEW_STRICT=true; shift ;;
    *)            echo "Unknown option: $1"; exit 1 ;;
  esac
done

chmod +x bin/task

if [[ "${CODEX_PREFLIGHT_REVIEW_ENABLED:-}" == "1" ]]; then
  CODEX_PREFLIGHT_REVIEW=true
fi

if [[ "${CODEX_REVIEW_ENABLED:-}" == "1" ]]; then
  CODEX_REVIEW=true
fi

if [[ "${CODEX_REVIEW_STRICT_ENABLED:-}" == "1" ]]; then
  CODEX_REVIEW=true
  CODEX_REVIEW_STRICT=true
fi

# ─── Optional dependency: codex CLI ───
# Fail fast if the operator asked for Codex-driven review but the CLI is
# missing or unauthenticated. Better to bail before the first task than
# to burn budget on tasks whose review will fail every time.
#
# Preflight review (`--codex-preflight-review`) is advisory — bin/task
# prepare degrades gracefully by recording preflight_review.status =
# "unavailable". We warn for it but don't block the build.
#
# Full review (`--codex-review` / `--codex-review-strict`) is a gate —
# if codex isn't available the review pass will fail every time, so we
# exit immediately and point at the remediation.
if $CODEX_REVIEW || $CODEX_PREFLIGHT_REVIEW; then
  codex_issue=""
  if ! command -v codex >/dev/null 2>&1; then
    codex_issue="codex CLI not found on PATH"
  elif ! codex login status >/dev/null 2>&1; then
    codex_issue="codex CLI found but not logged in — run 'codex login'"
  fi

  if [[ -n "$codex_issue" ]]; then
    if $CODEX_REVIEW; then
      echo "ERROR: $codex_issue" >&2
      echo "       --codex-review / --codex-review-strict require an authenticated codex CLI." >&2
      echo "       Install: https://github.com/openai/codex  |  Or rerun without the flag." >&2
      exit 1
    else
      echo "WARNING: $codex_issue" >&2
      echo "         --codex-preflight-review will be recorded as unavailable for each task." >&2
    fi
  fi
fi

# ─── Sync awareness: warn on spec-ahead-of-sync or pending proposal ───
# Not a hard block — the operator might knowingly build off a stale spec,
# or might be mid-proposal-review. But silent divergence is a footgun, so
# surface it at startup.
if [ -f tasks.json ] && [ -f spec.md ]; then
  last_synced_spec_sha=$(ruby -rjson -e 'puts (JSON.parse(File.read("tasks.json"))["last_synced_spec_sha"] || "").to_s' 2>/dev/null || echo "")

  if [ -n "$last_synced_spec_sha" ] && [ "$last_synced_spec_sha" != "baseline" ] && [ "$last_synced_spec_sha" != "WORKING_TREE" ]; then
    commits_since=$(git rev-list --count "${last_synced_spec_sha}..HEAD" -- spec.md 2>/dev/null || echo 0)
    if [ "$commits_since" -gt 0 ] 2>/dev/null; then
      echo ""
      echo "⚠️  spec.md has ${commits_since} commit(s) since the last sync (${last_synced_spec_sha:0:7})." >&2
      echo "    tasks.json reflects the spec at that SHA, not HEAD. Pending spec" >&2
      echo "    changes will NOT be built by this run." >&2
      echo "    Run \`bin/task sync\` to propose task updates, or continue if you" >&2
      echo "    know the pending spec changes aren't relevant yet." >&2
      echo "" >&2
    fi
  fi

  if [ -f .scaffold/sync-proposal.md ]; then
    echo ""
    echo "⚠️  Pending sync proposal at .scaffold/sync-proposal.md" >&2
    echo "    Tasks from that proposal are NOT in tasks.json. Review and apply" >&2
    echo "    with \`bin/task sync --apply\`, or delete the file to discard." >&2
    echo "" >&2
  fi
fi

# ─── Run post-merge hooks from config.yml ───
run_post_merge_hooks() {
  local position="$1"

  [ -f config.yml ] || return 0

  # Get changed files from last commit
  local changed_files
  changed_files=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || echo "")
  [ -n "$changed_files" ] || return 0

  # Parse hooks from config.yml and check trigger_paths
  ruby -ryaml -e '
    config = YAML.safe_load_file("config.yml")
    hooks = config["post_merge_hooks"] || []
    changed = ARGV[0].split("\n")

    hooks.each do |hook|
      triggers = hook["trigger_paths"] || []
      matched = triggers.any? do |pattern|
        changed.any? { |f| File.fnmatch(pattern, f, File::FNM_PATHNAME | File::FNM_DOTMATCH) }
      end

      next unless matched

      puts "  Running hook: #{hook["name"]}"
      system(hook["command"])

      commit_paths = hook["commit_paths"] || []
      if commit_paths.any? && $?.success?
        existing = commit_paths.select { |p| File.exist?(p) || Dir.glob(p).any? }
        if existing.any?
          system("git", "add", *existing)
          has_changes = !system("git", "diff", "--cached", "--quiet")
          if has_changes
            msg = hook["commit_message"] || "Post-merge hook: #{hook["name"]}"
            system("git", "commit", "-m", msg)
          end
        end
      end
    end
  ' "$changed_files"
}

# ─── Run verification checks from config.yml ───
run_verification_checks() {
  [ -f config.yml ] || return 0

  ruby -ryaml -e '
    config = YAML.safe_load_file("config.yml")
    checks = config["verification_checks"] || []
    failed_required = false
    verbose = ENV["VERIFY_VERBOSE"] == "1"

    checks.each do |check|
      name = check["name"]
      command = check["command"]
      required = check["required"] || false
      conditional = check["conditional"]

      next unless command # Skip checks without commands (e.g., solid_stack type)

      # Skip if conditional glob matches no existing files
      if conditional && Dir.glob(conditional).empty?
        puts "  #{name}: SKIP (no #{conditional} files)"
        next
      end

      $stderr.puts "  > #{command}" if verbose
      print "  #{name}: "
      start = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      out_dest = verbose ? $stderr : "/dev/null"
      err_dest = verbose ? $stderr : "/dev/null"
      success = system(command, out: out_dest, err: err_dest)
      elapsed = Process.clock_gettime(Process::CLOCK_MONOTONIC) - start
      code = $?.exitstatus

      if success
        puts "✓  [exit #{code}, #{elapsed.round(1)}s]"
      else
        puts "✗  [exit #{code}, #{elapsed.round(1)}s]"
        if required
          $stderr.puts "    REQUIRED check failed: #{name}"
          failed_required = true
        end
      end
    end

    exit(1) if failed_required
  '
}

# ─── Append runbook entry ───
append_runbook() {
  local position="$1"
  local title="$2"
  local bundle_path
  bundle_path=".scaffold/task-details/${position}.json"

  local runbook_entry
  runbook_entry=$(ruby -rjson -e '
    path = ARGV[0]
    abort unless File.exist?(path)
    detail = JSON.parse(File.read(path, encoding: "utf-8"))
    puts detail["runbook"] if detail["runbook"] && !detail["runbook"].empty?
  ' "$bundle_path" 2>/dev/null || true)

  if [ -n "$runbook_entry" ]; then
    ruby -e '
      path = "runbook.md"
      position = ARGV[0]
      title = ARGV[1]
      entry = ARGV[2]
      header = "### Task #{position}: #{title}"
      block = "#{header}\n\n#{entry.strip}\n"
      content = File.exist?(path) ? File.read(path, encoding: "UTF-8") : ""

      pattern = /^### Task #{Regexp.escape(position)}:.*?(?=^### Task \d+:|\z)/m
      updated =
        if content.match?(pattern)
          content.sub(pattern, block + "\n")
        else
          content = content.rstrip
          content.empty? ? block : "#{content}\n\n#{block}"
        end

      File.write(path, updated)
    ' "$position" "$title" "$runbook_entry"
    git add runbook.md
    git diff --cached --quiet || git commit -m "Update runbook after task $position"
  fi
}

# ─── Publish build evidence to wiki ───
publish_to_wiki() {
  [ -f config.yml ] || return 0
  [ -f "lib/publish_to_wiki.rb" ] || return 0

  local wiki_dir
  wiki_dir=$(ruby -ryaml -e '
    config = YAML.safe_load_file("config.yml") rescue {}
    puts config.dig("wiki_bridge", "wiki_dir").to_s
  ' 2>/dev/null || true)

  [ -n "$wiki_dir" ] || return 0
  [ -d "$wiki_dir" ] || { echo "Wiki bridge: SKIP (dir not found: $wiki_dir)"; return 0; }

  echo "Publishing build evidence to wiki..."
  ruby lib/publish_to_wiki.rb --wiki-dir "$wiki_dir" || {
    echo "Wiki bridge: WARNING — publish failed (non-fatal)"
  }
}

reset_failure_state() {
  FAILURE_STAGE=""
  FAILURE_KIND=""
  FAILURE_ACTION_TAKEN=""
  FAILURE_NEXT_STEP=""
  FAILURE_VERIFICATION_STATE="not_run"
  FAILURE_RUNTIME_STATE="not_started"
  FAILURE_REVIEW_STATE="not_run"
  FAILURE_RETRIES=""
  REVIEW_RESULT=""
  FAILURE_REVIEW_PASS=""
  FAILURE_REVIEW_BASE_REF=""
  FAILURE_REVIEW_HEAD_REF=""
  FAILURE_REMEDIATION_COMMIT=""
  FAILURE_REVIEW_UNRESOLVED_COUNT=""
  FAILURE_REVIEW_NEW_COUNT=""
  FAILURE_REVIEW_CARRY_COUNT=""
  FAILURE_REVIEW_ADVISORY_COUNT=""

  if [[ -n "$LAST_VERIFY_OUTPUT_FILE" && -f "$LAST_VERIFY_OUTPUT_FILE" ]]; then
    rm -f "$LAST_VERIFY_OUTPUT_FILE"
  fi
  LAST_VERIFY_OUTPUT_FILE=""
}

set_failure_state() {
  FAILURE_STAGE="$1"
  FAILURE_KIND="$2"
  FAILURE_ACTION_TAKEN="$3"
  FAILURE_NEXT_STEP="$4"
}

print_failure_summary() {
  local position="$1"
  local title="$2"

  [[ -n "$FAILURE_KIND" ]] || return 0

  echo ""
  echo "Failure Summary"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Task: [$position] $title"
  echo "Stage: ${FAILURE_STAGE:-unknown}"
  echo "Failure: ${FAILURE_KIND}"
  echo "Verification: ${FAILURE_VERIFICATION_STATE}"
  echo "Runtime: ${FAILURE_RUNTIME_STATE}"
  echo "Review: ${FAILURE_REVIEW_STATE}"
  [[ -z "$FAILURE_REVIEW_PASS" ]] || echo "Review pass: ${FAILURE_REVIEW_PASS}"
  [[ -z "$FAILURE_REVIEW_BASE_REF" ]] || echo "Review base: ${FAILURE_REVIEW_BASE_REF}"
  [[ -z "$FAILURE_REVIEW_HEAD_REF" ]] || echo "Review head: ${FAILURE_REVIEW_HEAD_REF}"
  [[ -z "$FAILURE_REMEDIATION_COMMIT" ]] || echo "Latest remediation commit: ${FAILURE_REMEDIATION_COMMIT}"
  [[ -z "$FAILURE_REVIEW_UNRESOLVED_COUNT" ]] || echo "Unresolved findings: ${FAILURE_REVIEW_UNRESOLVED_COUNT}"
  [[ -z "$FAILURE_REVIEW_NEW_COUNT" ]] || echo "New findings this pass: ${FAILURE_REVIEW_NEW_COUNT}"
  [[ -z "$FAILURE_REVIEW_CARRY_COUNT" ]] || echo "Previously seen findings still open: ${FAILURE_REVIEW_CARRY_COUNT}"
  [[ -z "$FAILURE_REVIEW_ADVISORY_COUNT" ]] || echo "Advisory findings logged: ${FAILURE_REVIEW_ADVISORY_COUNT}"
  [[ -z "$FAILURE_RETRIES" ]] || echo "Retries: ${FAILURE_RETRIES}"
  [[ -z "$FAILURE_ACTION_TAKEN" ]] || echo "Action taken: ${FAILURE_ACTION_TAKEN}"
  [[ -z "$FAILURE_NEXT_STEP" ]] || echo "Next step: ${FAILURE_NEXT_STEP}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

config_value() {
  local field="$1"

  ruby -ryaml -rjson -e '
    config = YAML.safe_load_file("config.yml") rescue {}
    value = config[ARGV[0]]
    case value
    when Array
      value.each { |entry| puts entry.is_a?(Hash) ? entry.to_json : entry }
    when Hash
      puts JSON.generate(value)
    when nil
      exit 0
    else
      puts value
    end
  ' "$field" 2>/dev/null || true
}

task_requires_http_runtime() {
  local position="$1"
  local bundle_path=".scaffold/task-details/${position}.json"

  ruby -rjson -ryaml -e '
    path = ARGV[0]
    config = YAML.safe_load_file("config.yml") rescue {}
    global_checks = Array(config["verification_checks"])
    global_needs_http = global_checks.any? do |check|
      command = check["command"].to_s
      command.include?("APP_BASE_URL") || command.match?(/curl\b.*https?:\/\//)
    end

    if File.exist?(path)
      detail = JSON.parse(File.read(path, encoding: "utf-8")) rescue {}
      commands = detail.dig("verification", "commands") || []
      needs_http = commands.any? { |cmd| cmd["command"].to_s.include?("APP_BASE_URL") || cmd["command"].to_s.include?("curl -sf") }
      exit(needs_http || global_needs_http ? 0 : 1)
    end
    exit(global_needs_http ? 0 : 1)
  ' "$bundle_path" 2>/dev/null
}

pick_free_port() {
  ruby -rsocket -e 'server = TCPServer.new("127.0.0.1", 0); puts server.addr[1]; server.close'
}

render_boot_command() {
  local command="$1"
  local port="$2"

  ruby -e '
    command = ARGV[0].dup
    port = ARGV[1]
    command.gsub!(/(^|\s)-d(?=\s|$)/, "\\1")
    command.gsub!(/(^|\s)--daemon(?:ize)?(?=\s|$)/, "\\1")
    command.gsub!(/(^|\s)-p\s+\d+/, "\\1-p #{port}")
    command.gsub!(/(^|\s)--port(?:=|\s+)\d+/, "\\1--port #{port}")
    command.gsub!(/(^|\s)(HOST_PORT|APP_PORT|PORT)=\d+/, "\\1\\2=#{port}")
    command.gsub!("localhost:3000", "127.0.0.1:#{port}")
    command.gsub!("127.0.0.1:3000", "127.0.0.1:#{port}")

    if command.match?(/\bbin\/rails server\b/) && !command.match?(/(^|\s)-b\s+/)
      command += " -b 127.0.0.1"
    end

    puts command.split.join(" ")
  ' "$command" "$port"
}

rewrite_health_url() {
  local url="$1"
  local port="$2"

  ruby -ruri -e '
    uri = URI(ARGV[0])
    uri.host = "127.0.0.1"
    uri.port = ARGV[1].to_i
    puts uri.to_s
  ' "$url" "$port"
}

cleanup_verification_runtime() {
  [[ "$VERIFY_RUNTIME_ACTIVE" == "true" ]] || return 0

  echo "Cleaning up verification runtime..."

  if [[ -n "$VERIFY_RUNTIME_LAUNCH_PID" ]] && kill -0 "$VERIFY_RUNTIME_LAUNCH_PID" 2>/dev/null; then
    kill "$VERIFY_RUNTIME_LAUNCH_PID" >/dev/null 2>&1 || true
    wait "$VERIFY_RUNTIME_LAUNCH_PID" 2>/dev/null || true
  fi

  if [[ -n "$VERIFY_RUNTIME_CLEANUP_COMMAND" ]]; then
    APP_PORT="$VERIFY_RUNTIME_PORT" APP_BASE_URL="$VERIFY_RUNTIME_BASE_URL" bash -c "$VERIFY_RUNTIME_CLEANUP_COMMAND" >/dev/null 2>&1 || true
  fi

  # Fallback: kill any remaining processes on the runtime port (e.g., child processes
  # not covered by the PID-based kill above).
  if command -v lsof >/dev/null 2>&1 && [[ -n "$VERIFY_RUNTIME_PORT" ]]; then
    local pids
    pids=$(lsof -ti tcp:"$VERIFY_RUNTIME_PORT" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill >/dev/null 2>&1 || true
      sleep 1
      pids=$(lsof -ti tcp:"$VERIFY_RUNTIME_PORT" 2>/dev/null || true)
      [[ -z "$pids" ]] || echo "$pids" | xargs kill -9 >/dev/null 2>&1 || true
    fi
  fi

  [[ -z "$VERIFY_RUNTIME_LOG" ]] || rm -f "$VERIFY_RUNTIME_LOG"

  VERIFY_RUNTIME_ACTIVE=false
  VERIFY_RUNTIME_PORT=""
  VERIFY_RUNTIME_BASE_URL=""
  VERIFY_RUNTIME_LOG=""
  VERIFY_RUNTIME_LAUNCH_PID=""
  VERIFY_RUNTIME_CLEANUP_COMMAND=""
  VERIFY_RUNTIME_FAILURE_KIND=""
}

wait_for_runtime_health() {
  local port="$1"
  local log_file="$2"
  local health_lines="$3"
  local failure_kind="runtime_health_failed"
  local attempts=30

  while (( attempts > 0 )); do
    local all_passed=true
    while IFS='|' read -r raw_url expected_status; do
      [[ -n "$raw_url" ]] || continue
      local health_url
      health_url=$(rewrite_health_url "$raw_url" "$port")
      local actual_status
      actual_status=$(curl -s -o /dev/null -w '%{http_code}' "$health_url" || true)
      if [[ "$actual_status" != "${expected_status:-200}" ]]; then
        all_passed=false
        break
      fi
    done <<< "$health_lines"

    $all_passed && return 0

    if [[ -n "$VERIFY_RUNTIME_LAUNCH_PID" ]] && ! kill -0 "$VERIFY_RUNTIME_LAUNCH_PID" 2>/dev/null; then
      wait "$VERIFY_RUNTIME_LAUNCH_PID" 2>/dev/null || true
      failure_kind="runtime_start_failed"
      break
    fi

    sleep 1
    attempts=$((attempts - 1))
  done

  VERIFY_RUNTIME_FAILURE_KIND="$failure_kind"
  echo "Runtime log:"
  [[ -f "$log_file" ]] && cat "$log_file"
  return 1
}

start_verification_runtime() {
  local position="$1"

  local boot_command cleanup_command health_lines runtime_env_json
  boot_command=$(config_value "boot_command")
  cleanup_command=$(config_value "cleanup_command")
  health_lines=$(ruby -ryaml -e '
    config = YAML.safe_load_file("config.yml") rescue {}
    Array(config["health_checks"]).each do |check|
      next unless check.is_a?(Hash) && check["url"]
      puts "#{check["url"]}|#{check["expected_status"] || 200}"
    end
  ' 2>/dev/null || true)
  runtime_env_json=$(config_value "runtime_env")

  if [[ -z "$boot_command" ]]; then
    echo "Verification runtime: SKIP (no boot_command configured)"
    return 1
  fi

  if ! task_requires_http_runtime "$position"; then
    return 1
  fi

  if [[ -z "$health_lines" ]]; then
    echo "Verification runtime: SKIP (no health_checks configured)"
    return 1
  fi

  local attempt=1
  local saw_start_failure=false
  local last_failure_kind=""
  while (( attempt <= 2 )); do
    cleanup_verification_runtime

    VERIFY_RUNTIME_PORT=$(pick_free_port)
    VERIFY_RUNTIME_BASE_URL="http://127.0.0.1:${VERIFY_RUNTIME_PORT}"
    VERIFY_RUNTIME_LOG=$(mktemp)
    VERIFY_RUNTIME_CLEANUP_COMMAND="$cleanup_command"
    VERIFY_RUNTIME_FAILURE_KIND=""

    local rendered_boot_command
    rendered_boot_command=$(render_boot_command "$boot_command" "$VERIFY_RUNTIME_PORT")

    echo "Starting isolated verification runtime on ${VERIFY_RUNTIME_BASE_URL} (attempt ${attempt}/2)..."
    (
      APP_PORT="$VERIFY_RUNTIME_PORT" \
      PORT="$VERIFY_RUNTIME_PORT" \
      APP_BASE_URL="$VERIFY_RUNTIME_BASE_URL" \
      VERIFY_RUNTIME_COMMAND="$rendered_boot_command" \
      RUNTIME_ENV_JSON="$runtime_env_json" \
      bash -c '
        if [[ -n "$RUNTIME_ENV_JSON" ]]; then
          while IFS="=" read -r key val; do
            export "$key=$val"
          done < <(ruby -rjson -e '\''env = JSON.parse(ENV["RUNTIME_ENV_JSON"]) rescue {}; env.each { |k, v| puts "#{k}=#{v}" }'\'')
        fi
        exec bash -c "$VERIFY_RUNTIME_COMMAND"
      ' >"$VERIFY_RUNTIME_LOG" 2>&1
    ) &
    VERIFY_RUNTIME_LAUNCH_PID=$!
    VERIFY_RUNTIME_ACTIVE=true

    if wait_for_runtime_health "$VERIFY_RUNTIME_PORT" "$VERIFY_RUNTIME_LOG" "$health_lines"; then
      export APP_PORT="$VERIFY_RUNTIME_PORT"
      export APP_BASE_URL="$VERIFY_RUNTIME_BASE_URL"
      return 0
    fi

    last_failure_kind="${VERIFY_RUNTIME_FAILURE_KIND:-runtime_health_failed}"
    [[ "$last_failure_kind" == "runtime_start_failed" ]] && saw_start_failure=true
    echo "$last_failure_kind"
    attempt=$((attempt + 1))
  done

  if $saw_start_failure; then
    VERIFY_RUNTIME_FAILURE_KIND="runtime_start_failed"
  else
    VERIFY_RUNTIME_FAILURE_KIND="${last_failure_kind:-runtime_health_failed}"
  fi
  return 2
}

run_task_verification_with_runtime() {
  local position="$1"

  local runtime_status
  local runtime_capture
  runtime_capture=$(mktemp)

  if [[ -n "$LAST_VERIFY_OUTPUT_FILE" && -f "$LAST_VERIFY_OUTPUT_FILE" ]]; then
    rm -f "$LAST_VERIFY_OUTPUT_FILE"
  fi
  LAST_VERIFY_OUTPUT_FILE=$(mktemp)

  if start_verification_runtime "$position" >"$runtime_capture" 2>&1; then
    FAILURE_RUNTIME_STATE="healthy"
    if [[ -s "$runtime_capture" ]]; then
      cat "$runtime_capture"
    fi
  else
    runtime_status=$?
    if [[ -s "$runtime_capture" ]]; then
      cat "$runtime_capture"
    fi
    if [[ "$runtime_status" -eq 2 ]]; then
      FAILURE_RUNTIME_STATE="${VERIFY_RUNTIME_FAILURE_KIND:-runtime_health_failed}"
      echo "runtime_failure: ${VERIFY_RUNTIME_FAILURE_KIND:-runtime_health_failed}"
      rm -f "$runtime_capture"
      cleanup_verification_runtime
      return 2
    fi

    FAILURE_RUNTIME_STATE="not_needed"
    rm -f "$runtime_capture"
  fi

  rm -f "$runtime_capture"

  # SCAFFOLD_VERIFY_SOURCE=harness tags this telemetry increment so the
  # attempt counter distinguishes harness-driven retries (real struggle) from
  # the agent's in-session `bin/task verify` self-probes (normal iteration).
  if VERIFY_VERBOSE=1 SCAFFOLD_VERIFY_SOURCE=harness ruby bin/task verify "$position" >"$LAST_VERIFY_OUTPUT_FILE" 2>&1; then
    cat "$LAST_VERIFY_OUTPUT_FILE"
    FAILURE_VERIFICATION_STATE="passed"
    cleanup_verification_runtime
    unset APP_PORT APP_BASE_URL
    return 0
  fi

  cat "$LAST_VERIFY_OUTPUT_FILE"
  FAILURE_VERIFICATION_STATE="failed"
  cleanup_verification_runtime
  unset APP_PORT APP_BASE_URL
  return 1
}

trap 'cleanup_verification_runtime; cleanup_build_lock' EXIT

task_field() {
  local position="$1"
  local field="$2"

  ruby -rjson -e '
    doc = JSON.parse(File.read("tasks.json", encoding: "utf-8"))
    abort unless doc.is_a?(Hash) && doc["schema_version"] == 2
    task = (doc["tasks"] || []).find { |t| t["position"] == ARGV[0].to_i }
    value = task && task[ARGV[1]]
    case value
    when Array
      puts value.join(", ")
    when nil
      exit 0
    else
      puts value
    end
  ' "$position" "$field" 2>/dev/null || true
}

review_state_path() {
  local position="$1"
  echo ".scaffold/review/${position}.json"
}

init_review_state() {
  local position="$1"
  local title="$2"
  local base_ref="$3"
  local state_path
  state_path=$(review_state_path "$position")

  mkdir -p "$(dirname "$state_path")"
  ruby -rjson -e '
    path = ARGV[0]
    payload = {
      "task_position" => ARGV[1].to_i,
      "task_title" => ARGV[2],
      "base_ref" => ARGV[3],
      "passes" => [],
      "latest" => {
        "unresolved_keys" => [],
        "new_keys" => [],
        "carry_keys" => [],
        "resolved_keys" => [],
        "head_ref" => nil,
        "remediation_commit" => nil,
        "pass" => 0
      }
    }
    File.write(path, JSON.pretty_generate(payload) + "\n")
  ' "$state_path" "$position" "$title" "$base_ref"
}

direct_dependency_context() {
  local position="$1"

  ruby -rjson -e '
    doc = JSON.parse(File.read("tasks.json", encoding: "utf-8"))
    abort unless doc.is_a?(Hash) && doc["schema_version"] == 2
    tasks = doc["tasks"] || []
    task = tasks.find { |entry| entry["position"] == ARGV[0].to_i }
    abort unless task
    deps = Array(task["depends_on"]).map do |dep|
      dep_task = tasks.find { |entry| entry["position"] == dep }
      next unless dep_task
      "- [#{dep_task["position"]}] #{dep_task["title"]}: #{dep_task["done_when"]}"
    end.compact
    puts deps.join("\n")
  ' "$position" 2>/dev/null || true
}

required_task_check_context() {
  local bundle_path="$1"

  ruby -rjson -e '
    path = ARGV[0]
    exit 0 unless File.exist?(path)
    detail = JSON.parse(File.read(path, encoding: "utf-8")) rescue {}
    commands = Array(detail.dig("verification", "commands")).select { |cmd| cmd["required"] }
    commands.each do |cmd|
      puts "- #{cmd["name"]}: #{cmd["command"]}"
    end
  ' "$bundle_path" 2>/dev/null || true
}

required_global_check_context() {
  ruby -ryaml -e '
    config = YAML.safe_load_file("config.yml") rescue {}
    checks = Array(config["verification_checks"]).select { |check| check["required"] }
    checks.each do |check|
      puts "- #{check["name"]}"
    end
  ' 2>/dev/null || true
}

workflow_gate_context() {
  local position="$1"

  ruby -rjson -e '
    doc = JSON.parse(File.read("tasks.json", encoding: "utf-8"))
    abort unless doc.is_a?(Hash) && doc["schema_version"] == 2
    task = (doc["tasks"] || []).find { |t| t["position"] == ARGV[0].to_i }
    abort unless task

    lines = []
    lines << "- required_capabilities: #{Array(task["capabilities_required"]).join(", ")}" if Array(task["capabilities_required"]).any?
    lines << "- entities_touched: #{Array(task["entities_touched"]).join(", ")}" if Array(task["entities_touched"]).any?
    lines << "- required_ui_affordances: #{Array(task["ui_actions"]).join(", ")}" if Array(task["ui_actions"]).any?
    lines << "- sensitive_events: #{Array(task["sensitive_events"]).join(", ")}" if Array(task["sensitive_events"]).any?
    lines << "- operational_prerequisites: #{Array(task["operational_prerequisites"]).join(", ")}" if Array(task["operational_prerequisites"]).any?
    puts lines.join("\n")
  ' "$position" 2>/dev/null || true
}

record_review_pass() {
  local position="$1"
  local base_ref="$2"
  local head_ref="$3"
  local remediation_commit="$4"
  local review_file="$5"
  local pass_number="$6"
  local state_path
  state_path=$(review_state_path "$position")
  mkdir -p "$(dirname "$state_path")"

  ruby -rjson -rdigest -e '
    path, base_ref, head_ref, remediation_commit, review_file, pass_number = ARGV
    state =
      if File.exist?(path)
        JSON.parse(File.read(path, encoding: "utf-8"))
      else
        { "passes" => [], "latest" => { "unresolved_keys" => [] } }
      end
    review = JSON.parse(File.read(review_file, encoding: "utf-8")) rescue { "findings" => [] }
    findings = Array(review["findings"])
    actionable = findings.select { |f| %w[blocking remediate].include?(f["severity"].to_s.downcase) }
    advisory = findings.select { |f| finding_severity = f["severity"].to_s.downcase; finding_severity == "advisory" || !%w[blocking remediate].include?(finding_severity) }

    normalize = lambda do |finding|
      category = finding["category"].to_s.downcase.strip
      file = finding["file"].to_s.strip
      line = finding["line"].to_i
      bucket = line > 0 ? (line / 25) : 0
      title = finding["title"].to_s.downcase.gsub(/[^a-z0-9]+/, " ").strip
      body = finding["body"].to_s.downcase.gsub(/[^a-z0-9]+/, " ").strip
      digest = Digest::SHA1.hexdigest([title, body].join("|"))[0, 12]
      [category, file, bucket, digest].join("|")
    end

    current_keys = actionable.map(&normalize).uniq
    advisory_keys = advisory.map(&normalize).uniq
    previous_keys = Array(state.dig("latest", "unresolved_keys"))
    new_keys = current_keys - previous_keys
    carry_keys = current_keys & previous_keys
    resolved_keys = previous_keys - current_keys

    pass_payload = {
      "pass" => pass_number.to_i,
      "base_ref" => base_ref,
      "head_ref" => head_ref,
      "remediation_commit" => (remediation_commit.nil? || remediation_commit.empty? ? nil : remediation_commit),
      "findings" => findings,
      "actionable_findings" => actionable,
      "advisory_findings" => advisory,
      "actionable_keys" => current_keys,
      "advisory_keys" => advisory_keys,
      "new_keys" => new_keys,
      "carry_keys" => carry_keys,
      "resolved_keys" => resolved_keys
    }

    state["base_ref"] = base_ref
    state["passes"] ||= []
    state["passes"] << pass_payload
    state["latest"] = {
      "pass" => pass_number.to_i,
      "head_ref" => head_ref,
      "remediation_commit" => (remediation_commit.nil? || remediation_commit.empty? ? nil : remediation_commit),
      "unresolved_keys" => current_keys,
      "advisory_keys" => advisory_keys,
      "new_keys" => new_keys,
      "carry_keys" => carry_keys,
      "resolved_keys" => resolved_keys,
      "advisory_count" => advisory_keys.size
    }

    File.write(path, JSON.pretty_generate(state) + "\n")
    puts JSON.generate(
      "unresolved_count" => current_keys.size,
      "new_count" => new_keys.size,
      "carry_count" => carry_keys.size,
      "resolved_count" => resolved_keys.size,
      "advisory_count" => advisory_keys.size
    )
  ' "$state_path" "$base_ref" "$head_ref" "$remediation_commit" "$review_file" "$pass_number"
}

apply_review_state_summary() {
  local summary_json="$1"

  FAILURE_REVIEW_UNRESOLVED_COUNT=$(ruby -rjson -e 'data = JSON.parse(ARGV[0]); puts data["unresolved_count"]' "$summary_json" 2>/dev/null || true)
  FAILURE_REVIEW_NEW_COUNT=$(ruby -rjson -e 'data = JSON.parse(ARGV[0]); puts data["new_count"]' "$summary_json" 2>/dev/null || true)
  FAILURE_REVIEW_CARRY_COUNT=$(ruby -rjson -e 'data = JSON.parse(ARGV[0]); puts data["carry_count"]' "$summary_json" 2>/dev/null || true)
  FAILURE_REVIEW_ADVISORY_COUNT=$(ruby -rjson -e 'data = JSON.parse(ARGV[0]); puts data["advisory_count"]' "$summary_json" 2>/dev/null || true)
}

run_claude_prompt() {
  local prompt="$1"
  local persona="$2"
  local turns="$3"
  local budget="$4"

  local model="${RDS_CLAUDE_MODEL:-claude-opus-4-6}"
  local provider="${RDS_INFERENCE_PROVIDER:-claude}"

  if [[ "$provider" == "codex" ]]; then
    local codex_args=(exec -C "$(pwd)" --sandbox danger-full-access --skip-git-repo-check)
    local codex_timeout="${RDS_CODEX_TASK_TIMEOUT_SEC:-900}"
    if [[ -n "${RDS_CODEX_MODEL:-}" ]]; then
      codex_args+=(--model "$RDS_CODEX_MODEL")
    fi
    if [[ -n "$persona" ]]; then
      printf '%s\n\n%s\n' "$persona" "$prompt" | timeout "$codex_timeout" codex "${codex_args[@]}" -
    else
      printf '%s\n' "$prompt" | timeout "$codex_timeout" codex "${codex_args[@]}" -
    fi
    return
  fi

  case $MODE in
    auto)
      if [[ -n "$persona" ]]; then
        claude --dangerously-skip-permissions \
          --model "$model" \
          --max-turns "$turns" \
          --max-budget-usd "$budget" \
          --append-system-prompt "$persona" \
          "$prompt"
      else
        claude --dangerously-skip-permissions \
          --model "$model" \
          --max-turns "$turns" \
          --max-budget-usd "$budget" \
          "$prompt"
      fi
      ;;
    headless)
      if [[ -n "$persona" ]]; then
        claude -p \
          --dangerously-skip-permissions \
          --model "$model" \
          --max-turns "$turns" \
          --max-budget-usd "$budget" \
          --append-system-prompt "$persona" \
          "$prompt"
      else
        claude -p \
          --dangerously-skip-permissions \
          --model "$model" \
          --max-turns "$turns" \
          --max-budget-usd "$budget" \
          "$prompt"
      fi
      ;;
  esac
}

build_review_prompt() {
  local position="$1"
  local title="$2"
  local base_ref="$3"
  local head_ref="$4"
  local bundle_path="$5"

  local done_when user_story section_ref workflow_gates dependency_context required_task_checks required_global_checks
  done_when=$(task_field "$position" "done_when")
  user_story=$(task_field "$position" "user_story")
  section_ref=$(task_field "$position" "section_ref")
  dependency_context=$(direct_dependency_context "$position")
  required_task_checks=$(required_task_check_context "$bundle_path")
  required_global_checks=$(required_global_check_context)
  workflow_gates=$(workflow_gate_context "$position")

  cat <<PROMPT
Review the git diff from ${base_ref} to ${head_ref} for task ${position}: ${title}.

Task context:
- section_ref: ${section_ref:-Overview}
- user_story: ${user_story:-none}
- done_when: ${done_when:-none}
- enforceable_contract:
  - Blocking or remediate findings must map to the done_when, the required checks below, or a direct dependency seam needed to satisfy them.
  - If scaffold does not currently prove the concern and done_when does not explicitly promise it, classify it as advisory.
  - bin/setup is backend-only by default unless done_when or a required check explicitly says otherwise.
  - Native/mobile/bootstrap expectations only rise to blocking/remediate when explicitly required by done_when or the required checks below.
- required_task_checks:
$(if [[ -n "$required_task_checks" ]]; then
  echo "$required_task_checks"
else
  echo "- none"
fi)
- required_global_checks:
$(if [[ -n "$required_global_checks" ]]; then
  echo "$required_global_checks"
else
  echo "- none"
fi)
- workflow_gates:
$(if [[ -n "$workflow_gates" ]]; then
  echo "$workflow_gates"
else
  echo "- none"
fi)
$(if [[ -n "$dependency_context" ]]; then
  echo "- direct_dependencies:"
  echo "$dependency_context"
fi)

The task has already passed its scripted verification gates. Use that as the baseline.
Review scope:
- review the cumulative diff from ${base_ref} to ${head_ref}
- review only code paths needed to satisfy this task's done_when
- include already-completed direct dependency surfaces only when this task relies on them
- use workflow_gates as a locator for relevant surfaces, not as permission to raise stricter requirements than the enforceable contract above
- review normal user entry paths, navigation reachability, seeded/authenticated flows, and integration seams promised by this task; do not rely only on direct URLs or isolated helpers
- if done_when is empty or underspecified, fail closed: do not invent requirements, and only raise blocking/remediate for concrete regressions, required-check mismatches, or direct dependency seam breakage

Classify findings with these severities:
- blocking: likely contradicts the enforceable contract above or introduces a concrete bug/regression that should have prevented task completion
- remediate: checks currently pass, but the implementation is still likely misaligned with the enforceable contract, direct dependency intent, or required tests/validation
- advisory: useful but non-blocking critique, including stronger ideal-state expectations beyond what scaffold currently enforces

Focus on:
- spec alignment and missing behavior implied by the task context
- missing integration wiring, navigation reachability through normal entry points, authz/authn, seed assumptions, and cross-stack contract issues
- missing tests or verification for behavior the task claims to support

Ignore:
- purely stylistic nits
- speculative refactors unrelated to the task
- issues that belong to later tasks or future app surfaces this task does not claim to implement
- missing future screens, routes, or workflows unless this task's done_when says they should already be wired now
- stronger implementation ideals that exceed scaffold's current required checks; log those as advisory instead

Output requirements:
- return JSON matching the provided schema only
- for each blocking or remediate finding, the body must begin with: `Contract source: <done_when|required_task_check|required_global_check|direct_dependency_seam|concrete_regression> - <short citation>`
- if the task contract is underspecified, log that as advisory unless a concrete regression or required-check/dependency mismatch makes it actionable
- prefer no finding over a speculative one

Return only structured findings.
PROMPT
}

summarize_review_findings() {
  local review_file="$1"

  ruby -rjson -e '
    data = JSON.parse(File.read(ARGV[0], encoding: "utf-8")) rescue {"findings" => []}
    findings = Array(data["findings"])
    if findings.empty?
      puts "No findings."
      exit 0
    end

    actionable, advisory = findings.partition { |finding| %w[blocking remediate].include?(finding["severity"].to_s.downcase) }

    render = lambda do |items, heading = nil|
      puts heading if heading
      items.each_with_index do |finding, idx|
        severity = finding["severity"].to_s.upcase
        category = finding["category"].to_s
        title = finding["title"].to_s
        file = finding["file"].to_s
        line = finding["line"]
        body = finding["body"].to_s.strip
        location = file.empty? ? "" : " (#{file}#{line ? ":#{line}" : ""})"
        puts "#{idx + 1}. [#{severity}] #{title}#{location}"
        puts "   category: #{category}" unless category.empty?
        puts "   #{body}" unless body.empty?
      end
    end

    render.call(actionable)
    if advisory.any?
      puts "Logged, not blocking:"
      render.call(advisory)
    end
  ' "$review_file"
}

review_summary_counts() {
  local review_file="$1"

  ruby -rjson -e '
    data = JSON.parse(File.read(ARGV[0], encoding: "utf-8")) rescue {"findings" => []}
    findings = Array(data["findings"])
    actionable = findings.count { |finding| %w[blocking remediate].include?(finding["severity"].to_s.downcase) }
    advisory = findings.count { |finding| finding["severity"].to_s.downcase == "advisory" || !%w[blocking remediate].include?(finding["severity"].to_s.downcase) }
    puts JSON.generate("actionable" => actionable, "advisory" => advisory)
  ' "$review_file"
}

review_requires_remediation() {
  local review_file="$1"

  ruby -rjson -e '
    data = JSON.parse(File.read(ARGV[0], encoding: "utf-8")) rescue {"findings" => []}
    actionable = Array(data["findings"]).any? do |finding|
      %w[blocking remediate].include?(finding["severity"].to_s.downcase)
    end
    exit(actionable ? 0 : 1)
  ' "$review_file"
}

classify_review_execution_failure() {
  local log_file="$1"

  ruby -e '
    text = File.exist?(ARGV[0]) ? File.read(ARGV[0], encoding: "utf-8") : ""
    kind =
      if text.match?(/not logged in|login required|authentication/i)
        "authentication"
      elsif text.match?(/invalid_json_schema|output schema|json schema|text\.format\.schema|Missing .*required/i)
        "schema"
      elsif text.match?(/failed to lookup address information|dns error|could not resolve host|websocket|error sending request|stream disconnected/i)
        "network"
      elsif text.match?(/readonly database|Operation not permitted|sandbox|permission/i)
        "environment"
      elsif text.match?(/panic|panicked|unwrap\(\)|Could not create otel exporter/i)
        "codex_cli"
      else
        "unknown"
      end
    puts kind
  ' "$log_file" 2>/dev/null || echo "unknown"
}

run_structured_codex_review() {
  local position="$1"
  local title="$2"
  local base_ref="$3"
  local output_file="$4"

  $CODEX_REVIEW || return 0

  if ! command -v codex >/dev/null 2>&1; then
    echo "Codex review execution failed: codex CLI not found"
    REVIEW_RESULT="review_execution_failed"
    return 1
  fi

  if ! codex login status >/dev/null 2>&1; then
    echo "Codex review execution failed: codex CLI is not logged in"
    REVIEW_RESULT="review_execution_failed"
    return 1
  fi

  if [[ -z "$base_ref" ]]; then
    echo "Codex review: SKIP (missing base ref)"
    REVIEW_RESULT="review_skipped"
    return 0
  fi

  local head_ref
  head_ref=$(git rev-parse HEAD 2>/dev/null || true)
  if [[ -z "$head_ref" || "$head_ref" == "$base_ref" ]]; then
    echo "Codex review: SKIP (no committed task diff to review)"
    printf '{"summary":"No committed diff to review.","findings":[]}\n' >"$output_file"
    REVIEW_RESULT="review_ok_no_findings"
    return 0
  fi

  local schema_file prompt
  schema_file=$(mktemp)
  cat >"$schema_file" <<'EOF'
{
  "type": "object",
  "additionalProperties": false,
  "required": ["summary", "findings"],
  "properties": {
    "summary": { "type": "string" },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["severity", "category", "title", "body", "file", "line"],
        "properties": {
          "severity": { "type": "string", "enum": ["blocking", "remediate", "advisory"] },
          "category": { "type": "string" },
          "title": { "type": "string" },
          "body": { "type": "string" },
          "file": { "type": ["string", "null"] },
          "line": { "type": ["integer", "null"] }
        }
      }
    }
  }
}
EOF

  prompt=$(build_review_prompt "$position" "$title" "$base_ref" "$head_ref" ".scaffold/task-details/${position}.json")
  local review_log
  review_log=$(mktemp)

  echo "Running Codex review..."
  if codex exec \
    -C "$(pwd)" \
    -s read-only \
    --ephemeral \
    --skip-git-repo-check \
    --output-schema "$schema_file" \
    --output-last-message "$output_file" \
    "$prompt" >"$review_log" 2>&1; then
    local review_counts actionable_count advisory_count
    review_counts=$(review_summary_counts "$output_file")
    actionable_count=$(ruby -rjson -e 'data = JSON.parse(ARGV[0]); puts data["actionable"]' "$review_counts" 2>/dev/null || echo "0")
    advisory_count=$(ruby -rjson -e 'data = JSON.parse(ARGV[0]); puts data["advisory"]' "$review_counts" 2>/dev/null || echo "0")
    rm -f "$review_log"
    rm -f "$schema_file"
    if review_requires_remediation "$output_file"; then
      echo "Codex review returned actionable findings."
      summarize_review_findings "$output_file"
      REVIEW_RESULT="review_ok_actionable_findings"
    elif [[ "$advisory_count" != "0" ]]; then
      echo "Codex review logged advisory-only findings (not blocking)."
      summarize_review_findings "$output_file"
      REVIEW_RESULT="review_ok_advisory_only"
    else
      echo "Codex review returned no findings."
      REVIEW_RESULT="review_ok_no_findings"
    fi
    return 0
  fi

  local failure_kind
  failure_kind=$(classify_review_execution_failure "$review_log")
  rm -f "$schema_file"
  echo "Codex review execution failed (${failure_kind})."
  echo "Review log:"
  cat "$review_log"
  rm -f "$review_log"
  REVIEW_RESULT="review_execution_failed"
  printf '{"summary":"Codex review execution failed.","findings":[]}\n' >"$output_file"
  return 1
}

run_structured_codex_review_with_retries() {
  local position="$1"
  local title="$2"
  local base_ref="$3"
  local output_file="$4"

  local attempt=1
  while (( attempt <= REVIEW_EXEC_MAX_ATTEMPTS )); do
    if run_structured_codex_review "$position" "$title" "$base_ref" "$output_file"; then
      FAILURE_REVIEW_STATE="$REVIEW_RESULT"
      [[ "$REVIEW_RESULT" == "review_ok_actionable_findings" ]] && FAILURE_REVIEW_STATE="actionable_findings"
      [[ "$REVIEW_RESULT" == "review_ok_advisory_only" ]] && FAILURE_REVIEW_STATE="advisory_logged"
      [[ "$REVIEW_RESULT" == "review_ok_no_findings" ]] && FAILURE_REVIEW_STATE="passed"
      return 0
    fi

    FAILURE_REVIEW_STATE="execution_failed"
    if (( attempt < REVIEW_EXEC_MAX_ATTEMPTS )); then
      echo "Retrying Codex review (${attempt}/${REVIEW_EXEC_MAX_ATTEMPTS})..."
      attempt=$((attempt + 1))
      continue
    fi

    FAILURE_RETRIES="review execution attempted ${REVIEW_EXEC_MAX_ATTEMPTS} time(s)"
    return 1
  done
}

build_remediation_prompt() {
  local position="$1"
  local title="$2"
  local review_file="$3"
  local state_path="$4"

  local done_when user_story section_ref dependency_context
  done_when=$(task_field "$position" "done_when")
  user_story=$(task_field "$position" "user_story")
  section_ref=$(task_field "$position" "section_ref")
  dependency_context=$(direct_dependency_context "$position")

  local findings_text
  findings_text=$(ruby -rjson -e '
    data = JSON.parse(File.read(ARGV[0], encoding: "utf-8"))
    findings = Array(data["findings"]).select { |f| %w[blocking remediate].include?(f["severity"].to_s.downcase) }
    findings.each_with_index do |finding, idx|
      puts "#{idx + 1}. [#{finding["severity"]}] #{finding["title"]}"
      puts "   category: #{finding["category"]}" unless finding["category"].to_s.empty?
      unless finding["file"].to_s.empty?
        location = finding["file"]
        location += ":#{finding["line"]}" if finding["line"]
        puts "   location: #{location}"
      end
      puts "   #{finding["body"]}"
    end
  ' "$review_file")

  local prior_attempt_note
  prior_attempt_note=$(ruby -rjson -e '
    path = ARGV[0]
    exit 0 unless File.exist?(path)
    state = JSON.parse(File.read(path, encoding: "utf-8")) rescue {}
    passes = Array(state["passes"])
    actionable_passes = passes.count { |entry| Array(entry["actionable_keys"]).any? }
    if actionable_passes > 1
      puts "Prior review passes already attempted: #{actionable_passes - 1}."
      carry = Array(state.dig("latest", "carry_keys")).size
      puts "#{carry} normalized finding(s) remained open across passes." if carry > 0
    end
  ' "$state_path" 2>/dev/null || true)

  cat <<PROMPT
You are remediating structured Codex review findings for task ${position}: ${title}.

Task context:
- section_ref: ${section_ref:-Overview}
- user_story: ${user_story:-none}
- done_when: ${done_when:-none}
$(if [[ -n "$dependency_context" ]]; then
  echo "- direct_dependencies:"
  echo "$dependency_context"
fi)

The task already passed \`bin/task verify ${position}\`, but Codex found likely spec-alignment or integration issues.
Fix only the unresolved findings below that are marked blocking or remediate.
Do not broaden scope beyond this task's cumulative review surface and direct dependency seams.
Advisory or deferred findings are intentionally out of scope for this remediation pass.
Each actionable finding body names its contract source; use that citation to keep the fix scoped.

Before making changes, write a short execution plan for this remediation pass:
- 3-5 concrete steps
- the specific findings each step addresses
- any direct dependency seam or verification risk that could affect the fix

Structured findings:
${findings_text}

${prior_attempt_note}

Instructions:
1. Inspect the cited code and fix blocking findings first, then remediate findings.
2. Run \`bin/task verify ${position}\` again.
3. Commit any fixes with: \`git add -A && git commit -m "Task ${position}: remediate review findings"\`
4. Do NOT edit \`runbook.md\` manually.
5. Do NOT change task status; the harness will decide completion after re-review.

Stop after the fixes and verification.
PROMPT
}

run_review_remediation() {
  local position="$1"
  local title="$2"
  local persona="$3"
  local review_file="$4"
  local state_path="$5"

  local prompt
  prompt=$(build_remediation_prompt "$position" "$title" "$review_file" "$state_path")

  echo ""
  echo "Running Claude remediation for Codex findings..."
  run_claude_prompt "$prompt" "$persona" "$REVIEW_FIX_MAX_TURNS" "$REVIEW_FIX_MAX_BUDGET"
}

build_verification_remediation_prompt() {
  local position="$1"
  local title="$2"
  local verify_output_file="$3"

  local done_when user_story section_ref verification_output
  done_when=$(task_field "$position" "done_when")
  user_story=$(task_field "$position" "user_story")
  section_ref=$(task_field "$position" "section_ref")
  verification_output=$(tail -n 200 "$verify_output_file" 2>/dev/null || true)

  cat <<PROMPT
You are remediating failed verification checks for task ${position}: ${title}.

Task context:
- section_ref: ${section_ref:-Overview}
- user_story: ${user_story:-none}
- done_when: ${done_when:-none}

The verification runtime was healthy, but one or more required checks failed.
Fix only the issues needed to make the failing required verification checks pass.

Before making changes, write a short execution plan for this remediation pass:
- 3-5 concrete steps
- the failing required checks each step addresses
- any likely regression or dependency risk from the fix

Verification output:
${verification_output}

Instructions:
1. Inspect the failing required verification checks and fix the underlying issue.
2. Run \`bin/task verify ${position}\` again.
3. Commit any fixes with: \`git add -A && git commit -m "Task ${position}: remediate verification failures"\`
4. Do NOT edit \`runbook.md\` manually.
5. Do NOT change task status; the harness will decide completion after re-verification.

Stop after the fixes and verification.
PROMPT
}

run_verification_remediation() {
  local position="$1"
  local title="$2"
  local persona="$3"
  local verify_output_file="$4"

  local prompt
  prompt=$(build_verification_remediation_prompt "$position" "$title" "$verify_output_file")

  echo ""
  echo "Running Claude remediation for verification failures..."
  run_claude_prompt "$prompt" "$persona" "$REVIEW_FIX_MAX_TURNS" "$REVIEW_FIX_MAX_BUDGET"
}

# ─── Build the prompt for a single task ───
#
# The task-variant context (done_when, metadata, runbook slice, predecessor
# telemetry, preflight review, implementation guidance, verification commands)
# lives in `bin/task dossier POSITION`. build_prompt() only wraps that payload
# with the stable workflow instructions that don't vary per task.
#
# Inspect the dossier directly: `ruby bin/task dossier N --bundle PATH > /tmp/d.md`
build_prompt() {
  local position="$1"
  local title="$2"
  local bundle_path="$3"

  local detected_stacks
  detected_stacks=$(ruby -ryaml -e '
    config = YAML.safe_load_file("config.yml") rescue {}
    stacks = config["detected_stacks"] || []
    puts stacks.join(", ")
  ' 2>/dev/null || echo "unknown")

  local dossier
  dossier=$(ruby bin/task dossier "$position" --bundle "$bundle_path" 2>/dev/null || true)

  # Compact skill manifest summary (one line per skill) so every task call
  # surfaces the opinionated tooling the project was scaffolded with.
  # The canonical reference is SKILLS.md at the app root; per-skill manifests
  # live in .rds/skills/<slug>.json.
  local skills_block
  skills_block=$(ruby -ryaml -rjson -e '
    skills_dir = ".rds/skills"
    unless Dir.exist?(skills_dir)
      print ""
      exit 0
    end
    entries = Dir.glob(File.join(skills_dir, "*.json")).sort.reject { |f| File.basename(f) == "resolved.json" }.map do |f|
      JSON.parse(File.read(f)) rescue nil
    end.compact.select { |s| s.is_a?(Hash) && s["slug"] }
    if entries.empty?
      print ""
      exit 0
    end
    lines = entries.map do |s|
      slug = s["slug"] || File.basename(s["path"] || "", ".*")
      name = s["name"] || slug
      desc = s["description"] || ""
      # If the resolved manifest only has slug/name, try to enrich from the
      # source YAML pointed at by skill["path"] (relative to RDS root).
      if desc.empty? && (path = s["path"])
        roots = [
          ENV["RDS_ROOT"],
          File.expand_path("..", Dir.pwd)
        ].compact
        roots.each do |r|
          full = File.join(r, path)
          if File.exist?(full)
            meta = YAML.safe_load_file(full) rescue {}
            desc = meta["description"] || ""
            break unless desc.empty?
          end
        end
      end
      "- `#{slug}` — #{name}#{desc.empty? ? "" : ": #{desc}"}"
    end
    print lines.join("\n")
  ' 2>/dev/null || true)

  local skills_section=""
  if [[ -n "$skills_block" ]]; then
    skills_section=$'\n## Available Skills\n\nThis project was scaffolded with the following RDS skills. **Use them as your defaults**; do not reinvent functionality they provide. Full guidance lives in `SKILLS.md` at the project root and `.rds/skills/<slug>.json`.\n\n'"$skills_block"$'\n\nSkill usage is mandatory when relevant:\n1. Read `SKILLS.md` before choosing an implementation pattern for UI, auth, data, testing, browser verification, canvas/game quality, secrets, or evals.\n2. Apply any resolved skill whose purpose matches this task. Do not silently ignore an applicable skill.\n3. In your final task note, state `Skills used:` with the skill slug(s), or `Skills not applicable:` with a short reason.\n4. If an applicable skill cannot be used because required files, packages, credentials, or tools are missing, stop and report that blocker instead of inventing an ad-hoc substitute.\n'
  fi

  cat <<PROMPT
You are implementing a single task for a software project.

The block below was produced by \`ruby bin/task dossier $position --bundle $bundle_path\`.
Run that command yourself any time you need to re-read this context
(after a branch switch, a long pause, or a split).

$dossier
$skills_section

## Project Stacks: $detected_stacks

This project may span multiple technology stacks. After implementing changes,
run verification for ALL stacks — not just the one you modified.

Use \`bin/task verify $position --skip-runtime-deps\` during iteration. This
omits checks that require a live HTTP server / browser / native runtime
(the build harness owns those: it boots a runtime and runs the full verify
suite after your session exits). Inside the session there is no server
running by default, so runtime checks would fail even when your code is
correct — don't waste turns debugging those here.

If you need to sanity-check a route locally, boot a server yourself
(\`bin/dev\` or \`bin/rails server\`) and curl it, but expect to stop it
before the session ends.

Before making changes, write a short execution plan for this task:
- restate the task goal in one sentence
- list 3-5 concrete implementation steps
- name any likely dependency seam, migration, auth, seed, or verification risk
- keep the plan tight to the current task only
$(if $CODEX_REVIEW; then
  echo ""
  echo "## Post-Task Review"
  echo ""
  echo "The build harness will run a structured Codex code review after verification."
  echo "If it finds blocking or remediation-level spec-alignment issues, the harness may run multiple bounded Claude remediation passes before stopping."
  echo "Keep the task commit focused and fix any obvious review risks before ending the session."
fi)

## Instructions

1. Run \`bin/task start $position\` to mark this task in_progress.
2. Implement the task completely following the prepared task bundle guidance and the spec behavior.
3. Run \`bin/task verify $position --skip-runtime-deps\` for static validation (see "Project Stacks" above for why).
4. Fix any static failures before proceeding.
5. Commit: \`git add -A && git commit -m "Task $position: $title"\`
6. Run \`bin/task done $position\` to mark complete.

**Stop verifying once static checks pass twice in a row.** Do not re-run
\`bin/task verify\` as a "just to be sure" step after a clean pass —
additional verifies burn budget without producing new information. Commit
and mark done immediately. The build harness will run full verification
(including runtime checks) after your session exits; any runtime failure
then triggers a bounded remediation pass.

Do not edit \`runbook.md\` manually. The build harness will upsert the prepared runbook entry after verification passes.

If stuck after 3 fix attempts, run \`bin/task error $position "description"\` and commit what you have.

Complete this ONE task only, then stop.
PROMPT
}

# ─── Run one task ───
run_task() {
  # Clear task-scoped env from any previous invocation so a stop-gate firing
  # during this session can't pick up stale files_changed / start_ref values
  # if the previous task returned without unsetting them (error/block paths).
  unset SCAFFOLD_TASK_POSITION SCAFFOLD_SESSION_ID SCAFFOLD_TASK_START_REF SCAFFOLD_TASK_FILES_CHANGED

  local task_json
  task_json=$(ruby bin/task next 2>&1) || true

  # Check if it's a message (no more tasks or all blocked)
  if echo "$task_json" | ruby -rjson -e 'exit(JSON.parse(STDIN.read.force_encoding("UTF-8")).key?("message") ? 0 : 1)' 2>/dev/null; then
    local msg
    msg=$(echo "$task_json" | ruby -rjson -e 'puts JSON.parse(STDIN.read.force_encoding("UTF-8"))["message"]')
    echo "$msg"
    return 1
  fi

  local position title prompt bundle_path
  local start_ref
  position=$(echo "$task_json" | ruby -rjson -e 'puts JSON.parse(STDIN.read.force_encoding("UTF-8"))["position"]')
  title=$(echo "$task_json" | ruby -rjson -e 'puts JSON.parse(STDIN.read.force_encoding("UTF-8"))["title"]')
  start_ref=$(git rev-parse HEAD 2>/dev/null || true)
  local prepare_args=(ruby bin/task prepare "$position")
  $CODEX_PREFLIGHT_REVIEW && prepare_args+=(--codex-preflight-review)
  bundle_path=$("${prepare_args[@]}" 2>/dev/null || true)
  if [[ -z "$bundle_path" ]]; then
    bundle_path=".scaffold/task-details/${position}.json"
  fi
  prompt=$(build_prompt "$position" "$title" "$bundle_path")

  # Build persona from primary task label for system prompt injection
  local persona
  persona=$(ruby -rjson -e '
    doc = JSON.parse(File.read("tasks.json", encoding: "utf-8"))
    abort unless doc.is_a?(Hash) && doc["schema_version"] == 2
    task = (doc["tasks"] || []).find { |t| t["position"] == ARGV[0].to_i }
    abort unless task
    primary = (task["labels"] || []).first
    personas = {
      "frontend" => "You are a frontend specialist. Prioritize user experience, accessibility, and visual correctness. Verify responsive behavior at mobile and desktop breakpoints. Prefer the simplest interactive pattern that works.",
      "backend" => "You are a backend specialist. Prioritize data integrity, API correctness, and test coverage. Use database constraints alongside application validations. Design for idempotency and error recovery.",
      "database" => "You are a database specialist. Prioritize schema integrity, migration safety, and query performance. Use database-level constraints as the source of truth for data integrity.",
      "ios" => "You are an iOS specialist. Ensure every Swift file compiles and is registered in the Xcode project. Follow Apple Human Interface Guidelines. Use SwiftUI with proper state management.",
      "android" => "You are an Android specialist. Ensure Gradle builds succeed. Follow Material Design guidelines and Jetpack Compose patterns with proper lifecycle management.",
      "testing" => "You are a testing specialist. Map every test to a GIVEN/WHEN/THEN scenario from the spec. Tests must be deterministic, fast, independent, and free of network dependencies.",
      "setup" => "You are a setup specialist. Produce a foundation that boots and passes all verification checks on the first try. Every dependency must install cleanly with zero external credentials required.",
      "auth" => "You are a security-minded auth specialist. Prioritize secure session and token management, proper password hashing, and input validation. Never store secrets in plain text.",
      "integration" => "You are an integration specialist. Prioritize end-to-end wiring, navigation flow, and data consistency. Verify every link resolves, every form submits, and every data dependency is satisfied with seed data."
    }
    puts personas[primary] if primary && personas[primary]
  ' "$position" 2>/dev/null || true)

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "  Task $position: $title"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""

  reset_failure_state
  # Exported so .claude/hooks/stop-gate.sh can verify the right task on session exit.
  export SCAFFOLD_TASK_POSITION="$position"
  export SCAFFOLD_SESSION_ID="${SCAFFOLD_SESSION_ID:-$(date +%s)-$$}-${position}"
  # Fallback diff reference for bin/task's files_changed computation (the
  # stop-gate runs after the agent's commit, so a bare HEAD diff is empty).
  export SCAFFOLD_TASK_START_REF="${start_ref:-}"
  run_claude_prompt "$prompt" "$persona" "$MAX_TURNS" "$MAX_BUDGET"

  # Capture the real task delta (start_ref..HEAD) for telemetry and downstream
  # prompts. bin/task verify reads SCAFFOLD_TASK_FILES_CHANGED and writes it to
  # .scaffold/telemetry/{position}.json.
  if [[ -n "${start_ref:-}" ]]; then
    export SCAFFOLD_TASK_FILES_CHANGED=$(git diff --name-only "$start_ref" HEAD 2>/dev/null || true)
  fi

  unset SCAFFOLD_TASK_POSITION SCAFFOLD_SESSION_ID

  # Check outcome
  local status
  status=$(ruby -rjson -e '
    doc = JSON.parse(File.read("tasks.json", encoding: "utf-8"))
    abort unless doc.is_a?(Hash) && doc["schema_version"] == 2
    task = (doc["tasks"] || []).find { |t| t["position"] == ARGV[0].to_i }
    puts task["status"]
  ' "$position")

  if [[ "$status" == "done" ]]; then
    echo ""
    echo "Running post-merge hooks..."
    run_post_merge_hooks "$position"

    echo "Running verification checks..."
    local verify_status=0
    local review_file
    review_file=$(mktemp)
    local review_state
    review_state=$(review_state_path "$position")

    run_task_verification_with_runtime "$position"
    verify_status=$?
    if [[ "$verify_status" -ne 0 ]]; then
      echo ""
      if [[ "$verify_status" -eq 2 ]]; then
        set_failure_state \
          "verification" \
          "${VERIFY_RUNTIME_FAILURE_KIND:-runtime_health_failed}" \
          "Retried isolated runtime startup before verification." \
          "Fix the runtime boot issue, then reset the task and rerun launch-build."
        print_failure_summary "$position" "$title"
        echo "${VERIFY_RUNTIME_FAILURE_KIND:-runtime_health_failed}: Verification runtime failed for task $position. Marking as error."
        ruby bin/task error "$position" "${VERIFY_RUNTIME_FAILURE_KIND:-runtime_health_failed}: Verification runtime failed"
        rm -f "$review_file"
        return 1
      fi

      if ! run_verification_remediation "$position" "$title" "$persona" "$LAST_VERIFY_OUTPUT_FILE"; then
        echo ""
        set_failure_state \
          "verification" \
          "verification_remediation_failed" \
          "Attempted one Claude remediation pass for required verification failures." \
          "Inspect the verification output, then reset the task and rerun launch-build."
        print_failure_summary "$position" "$title"
        echo "task_verification_failed: Claude remediation session failed for task $position. Marking as error."
        ruby bin/task error "$position" "task_verification_failed: Claude remediation session failed"
        rm -f "$review_file"
        return 1
      fi

      if ! post_remediation_verify_or_fail \
        "verification" \
        "Attempted one Claude remediation pass, then retried runtime-backed verification." \
        "Verification runtime failed after remediation" \
        "Attempted one Claude remediation pass for required verification failures." \
        "$position" "$title" "$review_file" "${start_ref:-}"; then
        return 1
      fi
    fi

    init_review_state "$position" "$title" "$start_ref"

    local review_pass=1
    local latest_head=""
    local remediation_commit=""
    local review_summary=""
    local pre_remediation_head=""
    while (( review_pass <= REVIEW_PASS_MAX )); do
      latest_head=$(git rev-parse HEAD 2>/dev/null || true)
      FAILURE_REVIEW_PASS="$review_pass"
      FAILURE_REVIEW_BASE_REF="$start_ref"
      FAILURE_REVIEW_HEAD_REF="$latest_head"
      [[ -n "$remediation_commit" ]] && FAILURE_REMEDIATION_COMMIT="$remediation_commit"

      if ! run_structured_codex_review_with_retries "$position" "$title" "$start_ref" "$review_file"; then
        echo ""
        set_failure_state \
          "review" \
          "review_execution_failed" \
          "Retried structured Codex review execution before stopping." \
          "Fix Codex review execution, then reset the task and rerun launch-build."
        print_failure_summary "$position" "$title"
        echo "review_execution_failed: Codex review failed for task $position. Marking as error."
        ruby bin/task error "$position" "review_execution_failed: Codex review execution failed"
        rm -f "$review_file"
        return 1
      fi

      review_summary=$(record_review_pass "$position" "$start_ref" "$latest_head" "${remediation_commit:-}" "$review_file" "$review_pass")
      apply_review_state_summary "$review_summary"

      if [[ "$REVIEW_RESULT" != "review_ok_actionable_findings" ]]; then
        break
      fi

      if (( review_pass >= REVIEW_PASS_MAX )); then
        if $CODEX_REVIEW_STRICT; then
          echo ""
          set_failure_state \
            "review" \
            "review_actionable_findings_remaining" \
            "Attempted ${REVIEW_PASS_MAX} Codex review pass(es) with Claude remediation between passes." \
            "Inspect the unresolved task-scoped review findings, then reset the task and rerun launch-build."
          FAILURE_RETRIES="review loop exhausted after ${REVIEW_PASS_MAX} pass(es)"
          print_failure_summary "$position" "$title"
          echo "post_review_failed: Codex still reports actionable findings for task $position after ${REVIEW_PASS_MAX} passes. Marking as error."
          ruby bin/task error "$position" "post_review_failed: actionable findings remain after ${REVIEW_PASS_MAX} passes"
          rm -f "$review_file"
          return 1
        else
          echo ""
          echo "WARNING: Codex still reports actionable findings for task $position after ${REVIEW_PASS_MAX} pass(es), but --codex-review-strict is not set. Continuing."
          summarize_review_findings "$review_file"
          break
        fi
      fi

      pre_remediation_head="$latest_head"
      if ! run_review_remediation "$position" "$title" "$persona" "$review_file" "$review_state"; then
        echo ""
        set_failure_state \
          "review" \
          "review_found_remediate" \
          "Attempted one Claude remediation pass for Codex findings." \
          "Inspect the review findings, then reset the task and rerun launch-build."
        print_failure_summary "$position" "$title"
        echo "post_review_failed: Claude remediation session failed for task $position. Marking as error."
        ruby bin/task error "$position" "post_review_failed: Codex remediation session failed"
        rm -f "$review_file"
        return 1
      fi

      remediation_commit=$(git rev-parse HEAD 2>/dev/null || true)
      FAILURE_REMEDIATION_COMMIT="$remediation_commit"
      if [[ -z "$remediation_commit" || "$remediation_commit" == "$pre_remediation_head" ]]; then
        echo ""
        set_failure_state \
          "review" \
          "post_remediation_no_new_commit" \
          "Claude remediation completed without producing a new commit for re-review." \
          "Ensure remediation changes are committed before rerunning launch-build."
        print_failure_summary "$position" "$title"
        echo "post_review_failed: remediation produced no new commit to review for task $position. Marking as error."
        ruby bin/task error "$position" "post_review_failed: remediation produced no new commit to review"
        rm -f "$review_file"
        return 1
      fi

      if ! post_remediation_verify_or_fail \
        "review" \
        "Attempted Claude remediation, then retried runtime-backed verification." \
        "Verification failed after review remediation" \
        "Attempted Claude remediation for Codex findings, then re-ran verification." \
        "$position" "$title" "$review_file" "${start_ref:-}"; then
        return 1
      fi

      review_pass=$((review_pass + 1))
    done

    rm -f "$review_file"
    echo ""
    append_runbook "$position" "$title"
    echo "Task $position completed and verified."
    return 0
  elif [[ "$status" == "error" ]]; then
    echo ""
    set_failure_state \
      "task_session" \
      "task_session_failed" \
      "Claude task session marked the task as error." \
      "Inspect the task error message in tasks.json, then reset the task and rerun launch-build."
    print_failure_summary "$position" "$title"
    echo "Task $position errored."
    return 1
  else
    echo ""
    echo "Task $position session ended with status: $status"
    echo "   May have run out of turns ($MAX_TURNS) or budget (\$$MAX_BUDGET)."
    # Session-exhausted fallback: the Claude session returned without marking
    # the task done or error. Persist an error state so tasks.json reflects
    # reality and downstream dependents don't silently stay blocked on a
    # task that is actually abandoned. The operator can `bin/task reset` to
    # retry after investigating.
    if [[ "$status" == "in_progress" ]]; then
      ruby bin/task error "$position" "session_exhausted: claude session returned without marking done/error (max-turns or max-budget likely hit)"
      echo "   Marked task $position as error (session_exhausted). Run \`ruby bin/task reset $position\` to retry."
    fi
    return 2
  fi
}

# ─── Main ───

echo "Build Status"
ruby bin/task status
echo ""

case $MODE in
  interactive)
    echo "Opening Claude Code. Type /build for continuous or /next-task for one at a time."
    echo ""
    exec claude
    ;;

  auto|headless)
    echo "Mode: $MODE | Per-task limits: $MAX_TURNS turns, \$$MAX_BUDGET budget"
    echo "Each task runs in a fresh context window."
    $CODEX_PREFLIGHT_REVIEW && echo "Codex preflight review: enabled"
    $CODEX_REVIEW && echo "Codex review: enabled$( $CODEX_REVIEW_STRICT && printf ' (strict)' )"
    echo ""

    if $BATCH; then
      task_count=0
      while true; do
        if ! run_task; then
          break
        fi
        task_count=$((task_count + 1))
        echo ""
        echo "Progress: $task_count task(s) completed"
        ruby bin/task status
        echo ""
        sleep 0.5
      done
      echo ""
      # Only publish wiki evidence if every task completed successfully
      pending_or_error=$(ruby -rjson -e '
        doc = JSON.parse(File.read("tasks.json", encoding: "UTF-8"))
        incomplete = (doc["tasks"] || []).count { |t| t["status"] != "done" }
        puts incomplete
      ' 2>/dev/null || echo "1")
      if [ "$pending_or_error" = "0" ]; then
        publish_to_wiki
      else
        echo "Wiki bridge: SKIP ($pending_or_error task(s) not done)"
      fi
      echo ""
      echo "Final Status"
      ruby bin/task status
    else
      run_task || true
    fi
    ;;
esac
