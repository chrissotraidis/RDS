#!/usr/bin/env bash
# scaffold.sh — Spec-to-Build Bootstrapper
#
# Takes a specification document and produces the complete Claude Code
# autonomous build scaffolding: CLAUDE.md, tasks.json, config.yml,
# launch-build.sh, bin/task, slash commands, settings, and runbook.
#
# Uses Arnold's library patterns (recipes, domain types, personas) for
# classification and task generation.
#
# Usage:
#   ./scaffold.sh spec.md --output ./my-project
#   ./scaffold.sh spec.md --recipe web_app --domain productivity --output ./my-project
#   ./scaffold.sh spec.md --wiki ./wiki --context context.json --output ./my-project
#   ./scaffold.sh spec.md --output ./my-project --skip-rules --skip-tasks
#
# Options:
#   --recipe LIST       Comma-separated recipe hints (first is primary)
#   --domain LIST       Comma-separated domain hints
#   --persona NAME      Persona hint
#   --output DIR        Output directory (default: current directory)
#   --wiki DIR          Wiki directory for enrichment (entity names, routes, risks)
#   --context FILE      Arnold context JSON for stack detection
#   --skip-rules        Skip architectural rule extraction (faster, no claude call)
#   --skip-tasks        Skip task generation (faster, no claude call; creates empty tasks.json)
#   --max-turns N       Max turns for task generation claude call (default: 5)
#   --max-tasks N       Hard cap for generated implementation tasks before UAT/hygiene
#   --mock              Generate interactive mockup in mockup/ directory
#   --mock-only         Skip steps 1-8, regenerate mockup only (requires existing project)
#   --feedback FILE     Apply mockup feedback to spec.md, then regenerate tasks + mockup

set -euo pipefail

SCAFFOLD_DIR="$(cd "$(dirname "$0")" && pwd)"

# Temp file cleanup
TMPFILES=()
cleanup_tmp() { rm -rf "${TMPFILES[@]+"${TMPFILES[@]}"}"; }
trap cleanup_tmp EXIT

# Defaults
SPEC_FILE=""
RECIPE_HINT=""
DOMAIN_HINT=""
PERSONA_HINT=""
OUTPUT_DIR="."
SKIP_RULES=false
SKIP_TASKS=false
MAX_TURNS=8
MAX_TASKS="${SCAFFOLD_MAX_TASKS:-}"
MOCK=false
MOCK_ONLY=false
FEEDBACK_FILE=""
WIKI_DIR=""
CONTEXT_FILE=""

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --recipe)     [[ $# -ge 2 ]] || { echo "Error: --recipe requires a value"; exit 1; }; RECIPE_HINT="$2"; shift 2 ;;
    --domain)     [[ $# -ge 2 ]] || { echo "Error: --domain requires a value"; exit 1; }; DOMAIN_HINT="$2"; shift 2 ;;
    --persona)    [[ $# -ge 2 ]] || { echo "Error: --persona requires a value"; exit 1; }; PERSONA_HINT="$2"; shift 2 ;;
    --output)     [[ $# -ge 2 ]] || { echo "Error: --output requires a value"; exit 1; }; OUTPUT_DIR="$2"; shift 2 ;;
    --skip-rules) SKIP_RULES=true; shift ;;
    --skip-tasks) SKIP_TASKS=true; shift ;;
    --max-turns)  [[ $# -ge 2 ]] || { echo "Error: --max-turns requires a value"; exit 1; }; MAX_TURNS="$2"; shift 2 ;;
    --max-tasks)  [[ $# -ge 2 ]] || { echo "Error: --max-tasks requires a value"; exit 1; }; MAX_TASKS="$2"; shift 2 ;;
    --wiki)       [[ $# -ge 2 ]] || { echo "Error: --wiki requires a value"; exit 1; }; WIKI_DIR="$2"; shift 2 ;;
    --context)    [[ $# -ge 2 ]] || { echo "Error: --context requires a value"; exit 1; }; CONTEXT_FILE="$2"; shift 2 ;;
    --mock)       MOCK=true; shift ;;
    --mock-only)  MOCK_ONLY=true; MOCK=true; shift ;;
    --feedback)   [[ $# -ge 2 ]] || { echo "Error: --feedback requires a value"; exit 1; }; FEEDBACK_FILE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: scaffold.sh <spec.md> [options]"
      echo ""
      echo "Options:"
      echo "  --recipe LIST       Comma-separated recipe hints (first is primary)"
      echo "  --domain LIST       Comma-separated domain hints"
      echo "  --persona NAME      Persona hint"
      echo "  --output DIR        Output directory (default: .)"
      echo "  --skip-rules        Skip architectural rule extraction"
      echo "  --skip-tasks        Skip task generation (empty tasks.json)"
      echo "  --wiki DIR          Wiki directory for enrichment (entity names, routes, risks)"
      echo "  --context FILE      Arnold context JSON for stack detection"
      echo "  --max-turns N       Max turns for task generation (default: 8)"
      echo "  --max-tasks N       Hard cap for implementation tasks before UAT/hygiene"
      echo "  --mock              Generate interactive mockup in mockup/ directory"
      echo "  --mock-only         Regenerate mockup only (skip steps 1-8)"
      echo "  --feedback FILE     Apply feedback to spec, regenerate tasks + mockup"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1"; exit 1 ;;
    *)
      SPEC_FILE="$1"; shift ;;
  esac
done

# Validate inputs

# For --mock-only or --feedback, spec file is optional (use project's spec.md)
if $MOCK_ONLY || [ -n "$FEEDBACK_FILE" ]; then
  # Create output directory (needed for absolute path)
  mkdir -p "$OUTPUT_DIR"
  OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

  # Use project's spec.md if no spec file given
  if [ -z "$SPEC_FILE" ]; then
    SPEC_FILE="$OUTPUT_DIR/spec.md"
  fi

  if [ ! -f "$SPEC_FILE" ]; then
    echo "Error: Spec file not found: $SPEC_FILE"
    exit 1
  fi

  SPEC_FILE="$(cd "$(dirname "$SPEC_FILE")" && pwd)/$(basename "$SPEC_FILE")"

  # Validate feedback file if provided
  if [ -n "$FEEDBACK_FILE" ]; then
    if [ ! -f "$FEEDBACK_FILE" ]; then
      echo "Error: Feedback file not found: $FEEDBACK_FILE"
      exit 1
    fi
    FEEDBACK_FILE="$(cd "$(dirname "$FEEDBACK_FILE")" && pwd)/$(basename "$FEEDBACK_FILE")"
  fi
fi

if [ -z "$SPEC_FILE" ]; then
  echo "Usage: scaffold.sh <spec.md> [options]"
  echo "Run with --help for more options."
  exit 1
fi

if [ ! -f "$SPEC_FILE" ]; then
  echo "Error: Spec file not found: $SPEC_FILE"
  exit 1
fi

# Make spec path absolute
SPEC_FILE="$(cd "$(dirname "$SPEC_FILE")" && pwd)/$(basename "$SPEC_FILE")"

# Create output directory
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

echo "========================================"
echo "  Scaffold: Spec-to-Build Bootstrapper"
echo "========================================"
echo ""
echo "Spec:   $SPEC_FILE"
echo "Output: $OUTPUT_DIR"
[ -n "$WIKI_DIR" ] && echo "Wiki:   $WIKI_DIR"
[ -n "$CONTEXT_FILE" ] && echo "Context: $CONTEXT_FILE"
$MOCK && echo "Mock:   enabled"
[ -n "$FEEDBACK_FILE" ] && echo "Feedback: $FEEDBACK_FILE"
echo ""

# ─── Task generation helpers ───
TASK_GEN_FAILURE_KIND=""
TASK_GEN_FAILURE_MESSAGE=""
TASK_GEN_FAILURE_LOG=""
TASK_GEN_DEBUG_ARTIFACTS=""
TASK_GEN_STRATEGY=""

classify_task_generation_failure() {
  local log_file="$1"
  TASK_GEN_FAILURE_KIND="unknown"
  TASK_GEN_FAILURE_MESSAGE="task generation validation failed"

  if [ -f "$log_file" ]; then
    TASK_GEN_FAILURE_LOG="$log_file"
    local kind
    kind=$(ruby -e '
      text = File.exist?(ARGV[0]) ? File.read(ARGV[0], encoding: "UTF-8") : ""
      if (match = text.match(/Failure kind:\s*([a-z_]+)/i))
        puts match[1]
      elsif text.match?(/Could not extract JSON/i)
        puts "no_json_detected"
      elsif text.match?(/No tasks generated/i)
        puts "empty_tasks"
      else
        puts "unknown"
      end
    ' "$log_file" 2>/dev/null || echo "unknown")
    TASK_GEN_FAILURE_KIND="$kind"
    TASK_GEN_FAILURE_MESSAGE=$(ruby -e '
      text = File.exist?(ARGV[0]) ? File.read(ARGV[0], encoding: "UTF-8") : ""
      first = text.lines.find { |line| !line.strip.empty? }.to_s.strip
      puts(first.empty? ? "task generation validation failed" : first)
    ' "$log_file" 2>/dev/null || echo "task generation validation failed")
  fi
}

validate_task_generation_output() {
  local raw_file="$1"
  local output_file="$2"
  local attempt_label="$3"
  local log_file="$4"
  local tmp_output
  tmp_output=$(mktemp)

  VALIDATE_ARGS=(--recipe-type "$PRIMARY_RECIPE_TYPE" --spec "$SPEC_FILE")
  [ -n "$WIKI_DIR" ] && VALIDATE_ARGS+=(--wiki "$WIKI_DIR")
  [ -n "$CONTEXT_FILE" ] && VALIDATE_ARGS+=(--context "$CONTEXT_FILE")
  [ -n "$MAX_TASKS" ] && VALIDATE_ARGS+=(--max-tasks "$MAX_TASKS")
  if ruby "$SCAFFOLD_DIR/lib/validate_tasks.rb" "${VALIDATE_ARGS[@]}" <"$raw_file" >"$tmp_output" 2>"$log_file"; then
    mv "$tmp_output" "$output_file"
    return 0
  fi

  rm -f "$tmp_output"
  classify_task_generation_failure "$log_file"
  echo "  ${attempt_label} malformed: ${TASK_GEN_FAILURE_KIND}"
  echo "    ${TASK_GEN_FAILURE_MESSAGE}"
  TASK_GEN_DEBUG_ARTIFACTS="${TASK_GEN_DEBUG_ARTIFACTS}\n- ${raw_file}\n- ${log_file}"
  return 1
}

print_task_generation_failure_summary() {
  local spec_size="$1"

  echo ""
  echo "Task Generation Failure Summary"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Spec size: ${spec_size} bytes"
  echo "Strategy: ${TASK_GEN_STRATEGY:-unknown}"
  echo "Failure kind: ${TASK_GEN_FAILURE_KIND:-unknown}"
  echo "Message: ${TASK_GEN_FAILURE_MESSAGE:-task generation failed}"
  if [ -n "$TASK_GEN_DEBUG_ARTIFACTS" ]; then
    echo "Debug artifacts:"
    printf "%b\n" "$TASK_GEN_DEBUG_ARTIFACTS"
  fi
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ─── Apply feedback to spec (if --feedback provided) ───
if [ -n "$FEEDBACK_FILE" ]; then
  echo "[Pre] Applying mockup feedback to spec..."
  ruby "$SCAFFOLD_DIR/lib/apply_feedback.rb" \
    --feedback "$FEEDBACK_FILE" \
    --spec "$OUTPUT_DIR/spec.md"

  # Update SPEC_FILE to point to the (potentially updated) spec
  SPEC_FILE="$OUTPUT_DIR/spec.md"
  echo ""
fi

# ─── Skip steps 1-8 for --mock-only ───
if $MOCK_ONLY; then
  echo "Mock-only mode: skipping steps 1-8"
  echo ""

  # Detect recipe from existing config or use generic
  if [ -f "$OUTPUT_DIR/config.yml" ]; then
    PRIMARY_RECIPE_PATH=$(ruby -ryaml -e '
      config = YAML.safe_load_file(ARGV[0])
      stacks = config["detected_stacks"] || []
      # Map detected stacks back to recipe paths
      if stacks.include?("rails")
        puts File.join(ARGV[1], "library/recipes/web_app.yml")
      else
        puts File.join(ARGV[1], "library/recipes/generic.yml")
      end
    ' "$OUTPUT_DIR/config.yml" "$SCAFFOLD_DIR")
  else
    PRIMARY_RECIPE_PATH="$SCAFFOLD_DIR/library/recipes/generic.yml"
  fi

  DOMAIN_PATHS=""
  SUPPORTING_RECIPE_PATHS=""

  # Jump to step 9 (mockup generation)
else

# ─── Step 1: Classify spec against library ───
echo "[1/8] Classifying spec against recipes, domains, and personas..."

MATCH_ARGS=(--spec "$SPEC_FILE" --library "$SCAFFOLD_DIR/library")
[ -n "$RECIPE_HINT" ] && MATCH_ARGS+=(--recipe "$RECIPE_HINT")
[ -n "$DOMAIN_HINT" ] && MATCH_ARGS+=(--domain "$DOMAIN_HINT")
[ -n "$PERSONA_HINT" ] && MATCH_ARGS+=(--persona "$PERSONA_HINT")

# Use Claude classifier by default; cache by spec hash; fall back to keyword
# matcher (match_library.rb) automatically if Claude isn't available or fails.
# Opt out with SCAFFOLD_SKIP_CLAUDE_CLASSIFY=1 to force the legacy matcher.
if [ "${SCAFFOLD_SKIP_CLAUDE_CLASSIFY:-0}" = "1" ]; then
  MATCH_RESULT=$(ruby "$SCAFFOLD_DIR/lib/match_library.rb" "${MATCH_ARGS[@]}")
else
  MATCH_ARGS+=(--cache-dir "$OUTPUT_DIR/.scaffold/classify-cache")
  MATCH_RESULT=$(ruby "$SCAFFOLD_DIR/lib/classify_spec.rb" "${MATCH_ARGS[@]}")
fi

# Extract paths from match result
PRIMARY_RECIPE_PATH=$(echo "$MATCH_RESULT" | ruby -rjson -e 'puts JSON.parse(STDIN.read).dig("primary_recipe", "path")')
PRIMARY_RECIPE_NAME=$(echo "$MATCH_RESULT" | ruby -rjson -e 'puts JSON.parse(STDIN.read).dig("primary_recipe", "name")')
PRIMARY_RECIPE_TYPE=$(ruby -ryaml -e 'puts YAML.safe_load_file(ARGV[0], permitted_classes: [Symbol])["type"]' "$PRIMARY_RECIPE_PATH" 2>/dev/null || echo "generic")

SUPPORTING_RECIPE_PATHS=$(echo "$MATCH_RESULT" | ruby -rjson -e '
  sr = JSON.parse(STDIN.read)["supporting_recipes"] || []
  puts sr.map { |r| r["path"] }.join(",")
')
SUPPORTING_RECIPE_NAMES=$(echo "$MATCH_RESULT" | ruby -rjson -e '
  sr = JSON.parse(STDIN.read)["supporting_recipes"] || []
  puts sr.map { |r| r["name"] }.join(", ")
')

DOMAIN_PATHS=$(echo "$MATCH_RESULT" | ruby -rjson -e '
  d = JSON.parse(STDIN.read)["domains"] || []
  puts d.map { |r| r["path"] }.join(",")
')
DOMAIN_NAMES=$(echo "$MATCH_RESULT" | ruby -rjson -e '
  d = JSON.parse(STDIN.read)["domains"] || []
  puts d.map { |r| r["name"] }.join(", ")
')

PERSONA_PATH=$(echo "$MATCH_RESULT" | ruby -rjson -e 'puts JSON.parse(STDIN.read).dig("persona", "path")')
PERSONA_NAME=$(echo "$MATCH_RESULT" | ruby -rjson -e 'puts JSON.parse(STDIN.read).dig("persona", "name")')

echo "  Primary recipe: $PRIMARY_RECIPE_NAME"
[ -n "$SUPPORTING_RECIPE_NAMES" ] && echo "  Supporting:      $SUPPORTING_RECIPE_NAMES"
echo "  Domain(s):       $DOMAIN_NAMES"
echo "  Persona:         $PERSONA_NAME"
echo ""

# ─── Step 2: Generate config.yml ───
echo "[2/8] Generating config.yml..."

CONFIG_ARGS=(--recipe "$PRIMARY_RECIPE_PATH" --output "$OUTPUT_DIR/config.yml" --spec "$SPEC_FILE")
[ -n "$SUPPORTING_RECIPE_PATHS" ] && CONFIG_ARGS+=(--supporting "$SUPPORTING_RECIPE_PATHS")
[ -n "$WIKI_DIR" ] && CONFIG_ARGS+=(--wiki "$WIKI_DIR")

ruby "$SCAFFOLD_DIR/lib/generate_config_yml.rb" "${CONFIG_ARGS[@]}"
echo ""

# ─── Step 3: Extract architectural rules (optional) ───
RULES_ARGS=()
if ! $SKIP_RULES && command -v claude &>/dev/null; then
  echo "[3/8] Extracting architectural rules from spec..."
  RULES_FILE="$OUTPUT_DIR/.scaffold-rules.md"
  ruby "$SCAFFOLD_DIR/lib/extract_rules.rb" --spec "$SPEC_FILE" --output "$RULES_FILE"
  if [ -f "$RULES_FILE" ] && [ -s "$RULES_FILE" ]; then
    RULES_ARGS=(--rules-file "$RULES_FILE")
  fi
  echo ""
else
  echo "[3/8] Skipping rule extraction (--skip-rules or claude not available)"
  echo ""
fi

# ─── Step 4: Generate CLAUDE.md ───
echo "[4/8] Generating CLAUDE.md..."

CLAUDE_MD_ARGS=(--spec "$SPEC_FILE" --primary-recipe "$PRIMARY_RECIPE_PATH" --output "$OUTPUT_DIR/CLAUDE.md")
[ -n "$SUPPORTING_RECIPE_PATHS" ] && CLAUDE_MD_ARGS+=(--supporting-recipes "$SUPPORTING_RECIPE_PATHS")
[ -n "$DOMAIN_PATHS" ] && CLAUDE_MD_ARGS+=(--domains "$DOMAIN_PATHS")
[ -n "$PERSONA_PATH" ] && CLAUDE_MD_ARGS+=(--persona "$PERSONA_PATH")
CLAUDE_MD_ARGS+=(--config "$OUTPUT_DIR/config.yml")
[ -f "$OUTPUT_DIR/wiki/index/wiki-index.json" ] && CLAUDE_MD_ARGS+=(--wiki)
[[ ${#RULES_ARGS[@]} -gt 0 ]] && CLAUDE_MD_ARGS+=("${RULES_ARGS[@]}")

ruby "$SCAFFOLD_DIR/lib/generate_claude_md.rb" "${CLAUDE_MD_ARGS[@]}"
echo ""

# ─── Step 5: Generate tasks.json ───
if ! $SKIP_TASKS; then
  # Build common prompt args for render_prompt.rb
  PROMPT_ARGS=(--primary-recipe "$PRIMARY_RECIPE_PATH")
  [ -n "$SUPPORTING_RECIPE_PATHS" ] && PROMPT_ARGS+=(--supporting-recipes "$SUPPORTING_RECIPE_PATHS")
  [ -n "$DOMAIN_PATHS" ] && PROMPT_ARGS+=(--domains "$DOMAIN_PATHS")
  [ -n "$WIKI_DIR" ] && PROMPT_ARGS+=(--wiki "$WIKI_DIR")

  SPEC_SIZE=$(wc -c < "$SPEC_FILE" | tr -d ' ')
  TASK_GEN_START=$(ruby -e 'puts Process.clock_gettime(Process::CLOCK_MONOTONIC)')
  TASK_CLAUDE_CALLS=0

  if [ "$SPEC_SIZE" -gt 50000 ]; then
    echo "[5/8] Breaking spec into thin v2 tasks (large spec: ${SPEC_SIZE} bytes)..."
  else
    echo "[5/8] Breaking spec into thin v2 tasks..."
  fi

  TASK_PROMPT_FILE=$(mktemp); TMPFILES+=("$TASK_PROMPT_FILE")
  {
    ruby "$SCAFFOLD_DIR/lib/render_prompt.rb" \
      --template "$SCAFFOLD_DIR/prompts/task_skeleton_system.md.erb" \
      "${PROMPT_ARGS[@]}"
    if [[ -n "$MAX_TASKS" ]]; then
      echo ""
      echo "# RDS TASK BUDGET"
      echo ""
      echo "This stack has a hard task budget of ${MAX_TASKS} implementation tasks before the automatically-added UAT and Final Hygiene tasks."
      echo "For small browser apps and games, merge related work into vertical slices. Do not split visual polish, controls, scoring, audio, persistence, and responsive behavior into dozens of separate tasks."
      echo "If the spec appears to need more than ${MAX_TASKS} implementation tasks, consolidate into larger coherent passes and preserve acceptance criteria inside those tasks."
    fi
    echo ""
    echo "---"
    echo ""
    ruby "$SCAFFOLD_DIR/lib/render_prompt.rb" \
      --template "$SCAFFOLD_DIR/prompts/task_breakdown_user.md.erb" \
      --spec "$SPEC_FILE"
  } > "$TASK_PROMPT_FILE"
  TASK_DEBUG_DIR="$OUTPUT_DIR/.scaffold-debug"
  mkdir -p "$TASK_DEBUG_DIR"
  TASK_GEN_SUCCESS=false
  TASK_GEN_STRATEGY="one-shot"
  ONE_SHOT_MAX_ATTEMPTS=2

  for attempt in $(seq 1 "$ONE_SHOT_MAX_ATTEMPTS"); do
    PROMPT_TO_RUN="$TASK_PROMPT_FILE"
    if [ "$attempt" -gt 1 ]; then
      CORRECTIVE_PROMPT_FILE=$(mktemp); TMPFILES+=("$CORRECTIVE_PROMPT_FILE")
      {
        cat "$TASK_PROMPT_FILE"
        echo ""
        echo "# CORRECTIVE INSTRUCTION"
        echo ""
        echo "Your previous output failed validation."
        echo "Failure kind: ${TASK_GEN_FAILURE_KIND:-unknown}"
        echo "Failure summary: ${TASK_GEN_FAILURE_MESSAGE:-task generation validation failed}"
        echo ""
        echo "Return ONLY a complete raw JSON array. Do not resume mid-object. Start with [ and end with ]."
        if [[ -n "$MAX_TASKS" ]]; then
          echo "Stay within the hard task budget: no more than ${MAX_TASKS} implementation tasks before UAT/hygiene."
        fi
      } > "$CORRECTIVE_PROMPT_FILE"
      PROMPT_TO_RUN="$CORRECTIVE_PROMPT_FILE"
      echo "  retrying one-shot generation..."
    fi

    RAW_FILE="$TASK_DEBUG_DIR/task_generation_raw_attempt_${attempt}.json.txt"
    LOG_FILE="$TASK_DEBUG_DIR/task_generation_validate_attempt_${attempt}.log"
    TASKS_RAW=$(claude -p \
      --max-turns "$MAX_TURNS" \
      --model sonnet \
      --append-system-prompt "Output ONLY a raw JSON array. No markdown, no tables, no prose, no commentary. Start with [ and end with ]." \
      --dangerously-skip-permissions < "$PROMPT_TO_RUN" 2>/dev/null || true)
    TASK_CLAUDE_CALLS=$((TASK_CLAUDE_CALLS + 1))
    printf "%s" "$TASKS_RAW" > "$RAW_FILE"
    TASK_GEN_DEBUG_ARTIFACTS="${TASK_GEN_DEBUG_ARTIFACTS}\n- ${RAW_FILE}"

    if [ -z "$TASKS_RAW" ]; then
      TASK_GEN_FAILURE_KIND="empty_output"
      TASK_GEN_FAILURE_MESSAGE="Claude returned an empty response."
      echo "  attempt ${attempt} malformed: empty_output"
      echo "    Claude returned an empty response."
    elif validate_task_generation_output "$RAW_FILE" "$OUTPUT_DIR/tasks.json" "attempt ${attempt}" "$LOG_FILE"; then
      TASK_GEN_SUCCESS=true
      [ "$PROMPT_TO_RUN" = "$TASK_PROMPT_FILE" ] || rm -f "$PROMPT_TO_RUN"
      break
    fi

    [ "$PROMPT_TO_RUN" = "$TASK_PROMPT_FILE" ] || rm -f "$PROMPT_TO_RUN"
  done

  if ! $TASK_GEN_SUCCESS && [ "$SPEC_SIZE" -gt 50000 ]; then
    echo "  falling back to chunked generation..."
    TASK_GEN_STRATEGY="chunked_fallback"
    CHUNK_RAW_FILE="$TASK_DEBUG_DIR/task_generation_chunked_raw.json.txt"
    CHUNK_LOG_FILE="$TASK_DEBUG_DIR/task_generation_chunked_validate.log"
    CHUNK_ARGS=(--spec "$SPEC_FILE" --primary-recipe "$PRIMARY_RECIPE_PATH" --output "$CHUNK_RAW_FILE" --debug-dir "$TASK_DEBUG_DIR")
    [ -n "$SUPPORTING_RECIPE_PATHS" ] && CHUNK_ARGS+=(--supporting-recipes "$SUPPORTING_RECIPE_PATHS")
    [ -n "$DOMAIN_PATHS" ] && CHUNK_ARGS+=(--domains "$DOMAIN_PATHS")
    if ruby "$SCAFFOLD_DIR/lib/generate_task_skeleton_chunks.rb" "${CHUNK_ARGS[@]}"; then
      if validate_task_generation_output "$CHUNK_RAW_FILE" "$OUTPUT_DIR/tasks.json" "chunked merge" "$CHUNK_LOG_FILE"; then
        TASK_GEN_SUCCESS=true
        echo "  chunk merge validated successfully"
        TASK_GEN_DEBUG_ARTIFACTS="${TASK_GEN_DEBUG_ARTIFACTS}\n- ${CHUNK_RAW_FILE}\n- ${CHUNK_LOG_FILE}"
      fi
    else
      TASK_GEN_FAILURE_KIND="chunk_generation_failed"
      TASK_GEN_FAILURE_MESSAGE="Chunked task generation helper failed."
    fi
  fi

  if ! $TASK_GEN_SUCCESS; then
    rm -f "$TASK_PROMPT_FILE"
    print_task_generation_failure_summary "$SPEC_SIZE"
    exit 1
  fi

  TASK_COUNT=$(ruby -rjson -e 'doc = JSON.parse(File.read(ARGV[0], encoding: "UTF-8")); puts (doc["tasks"] || []).size' "$OUTPUT_DIR/tasks.json")
  echo "  Generated thin task skeleton: $TASK_COUNT tasks"

  COVERAGE_RESULT=$(ruby "$SCAFFOLD_DIR/lib/validate_skeleton_coverage.rb" \
    --skeleton "$OUTPUT_DIR/tasks.json" \
    --config "$OUTPUT_DIR/config.yml" 2>/dev/null || true)

  if [ -n "$COVERAGE_RESULT" ] && echo "$COVERAGE_RESULT" | grep -q "has 0 implementation tasks"; then
    echo "  Coverage gap detected:"
    echo "$COVERAGE_RESULT" | sed 's/^/    /'
    echo "  Re-running task generation with corrective instruction..."

    CORRECTIVE_PROMPT_FILE=$(mktemp); TMPFILES+=("$CORRECTIVE_PROMPT_FILE")
    {
      cat "$TASK_PROMPT_FILE"
      echo ""
      echo "# CORRECTIVE INSTRUCTION"
      echo ""
      echo "Your previous output had a multi-stack coverage gap:"
      echo "$COVERAGE_RESULT"
      echo ""
      echo "You MUST add implementation tasks for the missing stack(s) listed above."
      echo "Interleave them with backend tasks — do not cluster them at the end."
    } > "$CORRECTIVE_PROMPT_FILE"

    RAW_FILE="$TASK_DEBUG_DIR/task_generation_coverage_retry.json.txt"
    LOG_FILE="$TASK_DEBUG_DIR/task_generation_coverage_retry.log"
    TASKS_RAW=$(claude -p \
      --max-turns "$MAX_TURNS" \
      --model sonnet \
      --append-system-prompt "Output ONLY a raw JSON array. No markdown, no tables, no prose, no commentary. Start with [ and end with ]." \
      --dangerously-skip-permissions < "$CORRECTIVE_PROMPT_FILE" 2>/dev/null || true)
    TASK_CLAUDE_CALLS=$((TASK_CLAUDE_CALLS + 1))
    printf "%s" "$TASKS_RAW" > "$RAW_FILE"
    if [ -n "$TASKS_RAW" ] && validate_task_generation_output "$RAW_FILE" "$OUTPUT_DIR/tasks.json" "coverage retry" "$LOG_FILE"; then
      TASK_COUNT=$(ruby -rjson -e 'doc = JSON.parse(File.read(ARGV[0], encoding: "UTF-8")); puts (doc["tasks"] || []).size' "$OUTPUT_DIR/tasks.json")
      echo "  Corrected task skeleton: $TASK_COUNT tasks"
    fi
    rm -f "$CORRECTIVE_PROMPT_FILE"
  fi

  rm -f "$TASK_PROMPT_FILE"

  TASK_GEN_END=$(ruby -e 'puts Process.clock_gettime(Process::CLOCK_MONOTONIC)')
  TASK_GEN_DURATION=$(ruby -e 'puts (ARGV[1].to_f - ARGV[0].to_f).round(1)' "$TASK_GEN_START" "$TASK_GEN_END")
  echo "  Task generation used $TASK_CLAUDE_CALLS one-shot Claude call(s) in ${TASK_GEN_DURATION}s"

  echo "  Generated $TASK_COUNT tasks"
else
  echo "[5/8] Skipping task generation (--skip-tasks)"
  echo '{"schema_version":2,"hydration_mode":"lazy","last_synced_spec_sha":"baseline","tasks":[]}' > "$OUTPUT_DIR/tasks.json"
  TASK_COUNT=0
fi
echo ""

# ─── Step 6: Copy template files ───
echo "[6/8] Copying template files..."

# ─── Clone project template if recipe specifies one ───
TEMPLATE_LOCAL_PATH=$(ruby -ryaml -e '
  recipe = YAML.safe_load_file(ARGV[0], permitted_classes: [Symbol])
  tpl = recipe["template"] || {}
  local = tpl["local_path"].to_s
  local = local.sub("~", ENV["HOME"]) unless local.empty?
  puts local
' "$PRIMARY_RECIPE_PATH" 2>/dev/null || true)

TEMPLATE_GIT_URL=$(ruby -ryaml -e '
  recipe = YAML.safe_load_file(ARGV[0], permitted_classes: [Symbol])
  puts (recipe.dig("template", "git_url") || "")
' "$PRIMARY_RECIPE_PATH" 2>/dev/null || true)

if [ -n "$TEMPLATE_LOCAL_PATH" ] || [ -n "$TEMPLATE_GIT_URL" ]; then
  TEMPLATE_SOURCE=""
  if [ -n "$TEMPLATE_LOCAL_PATH" ] && [ -d "$TEMPLATE_LOCAL_PATH" ]; then
    TEMPLATE_SOURCE="$TEMPLATE_LOCAL_PATH"
    echo "  Using local template: $TEMPLATE_SOURCE"
  elif [ -n "$TEMPLATE_GIT_URL" ]; then
    TEMPLATE_CLONE_DIR=$(mktemp -d)
    TMPFILES+=("$TEMPLATE_CLONE_DIR")
    echo "  Cloning template from $TEMPLATE_GIT_URL..."
    if git clone --depth 1 -q "$TEMPLATE_GIT_URL" "$TEMPLATE_CLONE_DIR" 2>/dev/null; then
      TEMPLATE_SOURCE="$TEMPLATE_CLONE_DIR"
    else
      echo "  WARNING: Could not clone $TEMPLATE_GIT_URL (auth required or host unreachable)"
      echo "  Skipping template copy — CLAUDE.md, config.yml, and task plan are intact,"
      echo "  but the app skeleton (app/, config/, bin/dev, etc.) was not populated."
      TEMPLATE_SOURCE=""
    fi
  fi

  if [ -n "$TEMPLATE_SOURCE" ]; then
    # Copy template files that form the Rails skeleton.
    # Exclude .git, scaffold artifacts, and files we generate ourselves.
    rsync -a --quiet \
      --exclude '.git' \
      --exclude '.git/' \
      --exclude 'CLAUDE.md' \
      --exclude 'tasks.json' \
      --exclude 'config.yml' \
      --exclude 'runbook.md' \
      --exclude 'spec.md' \
      --exclude 'launch-build.sh' \
      --exclude '.claude/' \
      --exclude '.scaffold/' \
      --exclude '.github/workflows/spec-review.yml' \
      --exclude '.github/prompts/product-advocate.md' \
      "$TEMPLATE_SOURCE/" "$OUTPUT_DIR/"

    echo "  Template files copied (app/, config/, lib/ui_kit/, Gemfile, etc.)"

    # Ensure ui_kit agent instructions are accessible at the project root for context
    if [ -d "$OUTPUT_DIR/lib/ui_kit" ]; then
      echo "  UI Kit engine available at lib/ui_kit/"
      echo "    Patterns: $(find "$OUTPUT_DIR/lib/ui_kit/app/views" -name '_*.html.erb' 2>/dev/null | wc -l | tr -d ' ') partials"
    fi
  fi
fi

# launch-build.sh
cp "$SCAFFOLD_DIR/templates/launch-build.sh" "$OUTPUT_DIR/launch-build.sh"
chmod +x "$OUTPUT_DIR/launch-build.sh"

# bin/task + its extracted modules
mkdir -p "$OUTPUT_DIR/bin"
cp "$SCAFFOLD_DIR/templates/bin/task" "$OUTPUT_DIR/bin/task"
chmod +x "$OUTPUT_DIR/bin/task"

# lib/scaffold_task/*.rb — required by bin/task
mkdir -p "$OUTPUT_DIR/lib/scaffold_task"
cp "$SCAFFOLD_DIR/templates/lib/scaffold_task/"*.rb "$OUTPUT_DIR/lib/scaffold_task/"

# lib/launch-build/*.sh — sourced by launch-build.sh
mkdir -p "$OUTPUT_DIR/lib/launch-build"
cp "$SCAFFOLD_DIR/templates/lib/launch-build/"*.sh "$OUTPUT_DIR/lib/launch-build/"

# lib/wiki_enricher.rb — required by lib/scaffold_task/wiki.rb when a wiki is
# present. Always copy so dossier generation degrades gracefully if the operator
# adds a wiki dir later.
cp "$SCAFFOLD_DIR/templates/lib/wiki_enricher.rb" "$OUTPUT_DIR/lib/wiki_enricher.rb"

# bin/smoke_test
cp "$SCAFFOLD_DIR/templates/bin/smoke_test" "$OUTPUT_DIR/bin/smoke_test"
chmod +x "$OUTPUT_DIR/bin/smoke_test"

# bin/spec_coverage
cp "$SCAFFOLD_DIR/templates/bin/spec_coverage" "$OUTPUT_DIR/bin/spec_coverage"
chmod +x "$OUTPUT_DIR/bin/spec_coverage"

# .claude/commands
mkdir -p "$OUTPUT_DIR/.claude/commands"
cp "$SCAFFOLD_DIR/templates/.claude/commands/build.md" "$OUTPUT_DIR/.claude/commands/"
cp "$SCAFFOLD_DIR/templates/.claude/commands/next-task.md" "$OUTPUT_DIR/.claude/commands/"
cp "$SCAFFOLD_DIR/templates/.claude/commands/task-status.md" "$OUTPUT_DIR/.claude/commands/"
cp "$SCAFFOLD_DIR/templates/.claude/commands/validate.md" "$OUTPUT_DIR/.claude/commands/"

# .claude/hooks (measurement plane — stop gate + context-plane guard)
mkdir -p "$OUTPUT_DIR/.claude/hooks"
cp "$SCAFFOLD_DIR/templates/.claude/hooks/stop-gate.sh" "$OUTPUT_DIR/.claude/hooks/"
cp "$SCAFFOLD_DIR/templates/.claude/hooks/context-guard.sh" "$OUTPUT_DIR/.claude/hooks/"
chmod +x "$OUTPUT_DIR/.claude/hooks/stop-gate.sh" "$OUTPUT_DIR/.claude/hooks/context-guard.sh"

# .github/workflows and prompts
mkdir -p "$OUTPUT_DIR/.github/workflows"
mkdir -p "$OUTPUT_DIR/.github/prompts"
cp "$SCAFFOLD_DIR/templates/.github/workflows/spec-review.yml" "$OUTPUT_DIR/.github/workflows/"
cp "$SCAFFOLD_DIR/templates/.github/prompts/product-advocate.md" "$OUTPUT_DIR/.github/prompts/"

# .claude/skills (label-activated, rendered from primary + supporting recipe context)
if [ -n "$SUPPORTING_RECIPE_PATHS" ]; then
  ruby "$SCAFFOLD_DIR/lib/generate_label_skills.rb" \
    --templates-dir "$SCAFFOLD_DIR/templates/.claude/skills" \
    --recipe "$PRIMARY_RECIPE_PATH" \
    --supporting "$SUPPORTING_RECIPE_PATHS" \
    --output-dir "$OUTPUT_DIR/.claude/skills" \
    --label-map "$OUTPUT_DIR/.claude/label-map.json"
else
  ruby "$SCAFFOLD_DIR/lib/generate_label_skills.rb" \
    --templates-dir "$SCAFFOLD_DIR/templates/.claude/skills" \
    --recipe "$PRIMARY_RECIPE_PATH" \
    --output-dir "$OUTPUT_DIR/.claude/skills" \
    --label-map "$OUTPUT_DIR/.claude/label-map.json"
fi

# lib/publish_to_wiki.rb (wiki bridge — only when wiki provided)
if [ -n "$WIKI_DIR" ]; then
  mkdir -p "$OUTPUT_DIR/lib"
  cp "$SCAFFOLD_DIR/templates/lib/publish_to_wiki.rb" "$OUTPUT_DIR/lib/publish_to_wiki.rb"
fi

echo "  Copied: launch-build.sh, bin/task, bin/smoke_test, bin/spec_coverage, .claude/commands/*, .claude/skills/*, .github/workflows/*, .github/prompts/*"
[ -n "$WIKI_DIR" ] && echo "  Copied: lib/publish_to_wiki.rb (wiki bridge)"
echo ""

# ─── Step 7: Generate settings.json ───
echo "[7/8] Generating .claude/settings.json..."
ruby "$SCAFFOLD_DIR/lib/generate_settings_json.rb" \
  --recipe "$PRIMARY_RECIPE_PATH" \
  --output "$OUTPUT_DIR/.claude/settings.json"
echo ""

# ─── Step 8: Generate runbook and copy spec ───
echo "[8/8] Generating runbook and copying spec..."

# Generate runbook from template
ruby -ryaml -rerb -e '
  Encoding.default_external = Encoding::UTF_8
  Encoding.default_internal = Encoding::UTF_8
  primary_recipe = YAML.safe_load_file(ARGV[0], permitted_classes: [Symbol])
  spec_text = File.read(ARGV[2], encoding: "UTF-8")
  project_name = spec_text[/^#\s+(.+)/, 1] || "Project"
  template = ERB.new(File.read(ARGV[1]), trim_mode: "-")
  result = template.result(binding)
  File.write(ARGV[3], result)
' "$PRIMARY_RECIPE_PATH" \
  "$SCAFFOLD_DIR/templates/runbook.md.erb" \
  "$SPEC_FILE" \
  "$OUTPUT_DIR/runbook.md"

# Copy spec (skip if source and destination are the same file — e.g. --output .)
if [ "$SPEC_FILE" != "$OUTPUT_DIR/spec.md" ]; then
  cp "$SPEC_FILE" "$OUTPUT_DIR/spec.md"
fi

# Clean up temp files
rm -f "$OUTPUT_DIR/.scaffold-rules.md"

echo "  Generated: runbook.md, spec.md"
echo ""

# ─── Generate .gitignore from detected stacks ───
if [ -f "$OUTPUT_DIR/config.yml" ]; then
  ruby -ryaml -e '
    config = YAML.safe_load_file(ARGV[0])
    patterns = config["gitignore_patterns"] || []
    if patterns.any?
      File.write(File.join(ARGV[1], ".gitignore"), patterns.join("\n") + "\n")
      $stderr.puts "Generated .gitignore (#{patterns.size} patterns)"
    end
  ' "$OUTPUT_DIR/config.yml" "$OUTPUT_DIR"
fi

# ─── Generate Procfile.dev for Rails projects ───
if [ -f "$OUTPUT_DIR/config.yml" ]; then
  ruby -ryaml -e '
    config = YAML.safe_load_file(ARGV[0])
    recipe = YAML.safe_load_file(ARGV[2], permitted_classes: [Symbol])
    stacks = config["detected_stacks"] || []
    capabilities = config["workflow_capabilities"] || {}
    framework = recipe["framework"] || {}

    if stacks.include?("rails") && capabilities["browser_ui"]
      lines = []
      lines << "web: bin/rails server -p 3000"

      asset_desc = framework.values.map { |v| v.to_s.downcase }.join(" ")

      # Add CSS watcher based on detected CSS framework
      if asset_desc.include?("dartsass")
        lines << "css: bin/rails dartsass:watch"
      elsif asset_desc.include?("tailwind")
        lines << "css: bin/rails \"tailwindcss:watch[always]\""
      end

      # Add JS watcher if jsbundling-rails is in the framework spec
      lines << "js: yarn build --watch" if asset_desc.match?(/jsbundling|esbuild|webpack|rollup/)

      # Add queue worker if background work is expected
      lines << "queue: bin/jobs" if capabilities["background_work"]

      path = File.join(ARGV[1], "Procfile.dev")
      File.write(path, lines.join("\n") + "\n")
      $stderr.puts "Generated Procfile.dev (#{lines.size} processes: #{lines.map { |l| l.split(":").first }.join(", ")})"
    end
  ' "$OUTPUT_DIR/config.yml" "$OUTPUT_DIR" "$PRIMARY_RECIPE_PATH"
fi

# ─── Initialize git ───
if [ ! -d "$OUTPUT_DIR/.git" ]; then
  echo "Initializing git repository..."
  git -C "$OUTPUT_DIR" init -q
  git -C "$OUTPUT_DIR" add -A
  # Resolve a git identity for the initial commit. Prefer the environment's
  # configured identity (global or local); fall back to a scaffold default
  # so unconfigured environments (fresh CI runners) don't fail the commit.
  commit_email=$(git -C "$OUTPUT_DIR" config user.email 2>/dev/null || echo "scaffold@localhost")
  commit_name=$(git -C "$OUTPUT_DIR" config user.name 2>/dev/null || echo "Scaffold")
  git -C "$OUTPUT_DIR" \
    -c "user.email=$commit_email" \
    -c "user.name=$commit_name" \
    commit -q -m "Scaffold: initial project setup

Generated by scaffold.sh from $(basename "$SPEC_FILE")
Recipe: $PRIMARY_RECIPE_NAME
Domain: $DOMAIN_NAMES
Tasks: $TASK_COUNT"
  echo ""
fi

# End of --mock-only else block
fi

# ─── Step 9: Generate mockup (if --mock) ───
#
# Two-stage, no LLM-driven HTML generation:
#   Phase A: extract_screens.rb → mockup-manifest.json  (1 Claude call)
#   Phase B: render_mockup.rb  → mockup/index.html      (deterministic, no Claude)
#
# The high-fidelity mockup is produced by the coding agent at build time from
# the same manifest, using the project's own UI conventions.
if $MOCK && command -v claude &>/dev/null; then
  echo "[9] Generating mockup preview..."

  if [ ! -f "$OUTPUT_DIR/spec.md" ]; then
    echo "  Error: spec.md not found in $OUTPUT_DIR"
    exit 1
  fi
  if [ ! -f "$OUTPUT_DIR/tasks.json" ]; then
    echo "  Error: tasks.json not found in $OUTPUT_DIR"
    exit 1
  fi

  # Phase A: extract screens via Claude.
  echo "  Phase A: Extracting screens from spec..."
  SCREEN_ARGS=(--spec "$OUTPUT_DIR/spec.md" --tasks "$OUTPUT_DIR/tasks.json" --primary-recipe "$PRIMARY_RECIPE_PATH" --output "$OUTPUT_DIR/mockup-manifest.json")
  [ -n "$DOMAIN_PATHS" ] && SCREEN_ARGS+=(--domains "$DOMAIN_PATHS")

  ruby "$SCAFFOLD_DIR/lib/extract_screens.rb" "${SCREEN_ARGS[@]}"

  if [ ! -f "$OUTPUT_DIR/mockup-manifest.json" ]; then
    echo "  Error: Screen extraction failed. Skipping mockup preview."
  else
    SCREEN_COUNT=$(ruby -rjson -e 'puts JSON.parse(File.read(ARGV[0], encoding: "UTF-8"))["screens"].size' "$OUTPUT_DIR/mockup-manifest.json")
    echo "  Phase A complete: $SCREEN_COUNT screens extracted"

    # Phase B: deterministic renderer — no Claude calls, no streaming waits.
    echo "  Phase B: Rendering structural preview..."
    ruby "$SCAFFOLD_DIR/lib/render_mockup.rb" \
      --manifest "$OUTPUT_DIR/mockup-manifest.json" \
      --output "$OUTPUT_DIR/mockup"

    cp "$SCAFFOLD_DIR/templates/mockup-feedback.md" "$OUTPUT_DIR/mockup/feedback-template.md"

    echo ""
    echo "  Mockup preview: $OUTPUT_DIR/mockup/index.html"
    echo "  Manifest:       $OUTPUT_DIR/mockup-manifest.json  (build-time source of truth)"
    echo "  Feedback:       $OUTPUT_DIR/mockup/feedback-template.md"
    echo ""
    echo "  To iterate:"
    echo "    1. Open $OUTPUT_DIR/mockup/index.html to review structure & data"
    echo "    2. Record feedback in mockup-feedback.md"
    echo "    3. Run: $0 --feedback mockup-feedback.md --output $OUTPUT_DIR --mock"
    echo ""
    echo "  The high-fidelity mockup is built during launch-build.sh using the"
    echo "  project's own UI conventions — the manifest drives screen structure,"
    echo "  seed data, and navigation."
  fi
  echo ""
elif $MOCK; then
  echo "[9] Skipping mockup generation (claude CLI not available)"
  echo ""
fi

# ─── Summary ───
echo "========================================"
echo "  Scaffold Complete"
echo "========================================"
echo ""
echo "  Output:     $OUTPUT_DIR"
echo "  Recipe:     ${PRIMARY_RECIPE_NAME:-(mock-only)}"
[ -n "${SUPPORTING_RECIPE_NAMES:-}" ] && echo "  Supporting:  $SUPPORTING_RECIPE_NAMES"
echo "  Domain(s):  ${DOMAIN_NAMES:-(mock-only)}"
echo "  Persona:    ${PERSONA_NAME:-(mock-only)}"
echo "  Tasks:      ${TASK_COUNT:-(existing)}"
echo ""
echo "  Files generated:"
echo "    CLAUDE.md          — Project instructions for Claude"
echo "    tasks.json         — Thin v2 task skeleton with lazy hydration"
echo "    config.yml         — Verification checks & post-merge hooks"
echo "    spec.md            — Specification (copied)"
echo "    runbook.md         — Living development guide"
echo "    launch-build.sh    — Build orchestration script"
echo "    bin/task           — Task state management"
echo "    .claude/           — Settings & slash commands"
if [ -f "$OUTPUT_DIR/mockup/index.html" ]; then
echo "    mockup/index.html  — Interactive mockup (open in browser)"
echo "    mockup-manifest.json — Screen manifest"
fi
echo ""
echo "  Next steps:"
echo "    cd $OUTPUT_DIR"
if [ -f "$OUTPUT_DIR/mockup/index.html" ]; then
echo "    open mockup/index.html             # Review mockup first"
echo "    # Edit mockup-feedback.md with changes, then:"
echo "    # $0 --feedback mockup-feedback.md --output . --mock"
fi
echo "    ./launch-build.sh --auto --batch   # Run all tasks autonomously"
echo "    ./launch-build.sh                  # Interactive mode"
echo ""
