# bin/lib/common.sh — shared helpers. Source-only; do not execute.
# Every bin/ script does:
#   ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#   source "$ROOT/bin/lib/common.sh"
#   source "$ROOT/bin/lib/logging.sh"
#   source "$ROOT/bin/lib/state.sh"

# Resolve RDS root if not already set. Callers normally set ROOT themselves;
# this is a safety net.
if [[ -z "${RDS_ROOT:-}" ]]; then
  if [[ -n "${ROOT:-}" ]]; then
    RDS_ROOT="$ROOT"
  else
    RDS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  fi
fi
export RDS_ROOT

# Zo services can start with a narrower supervisor PATH than an interactive
# shell. Keep standard local binary locations visible to every RDS stage.
case ":$PATH:" in
  *:/usr/local/bin:*) ;;
  *) export PATH="/usr/local/bin:$PATH" ;;
esac
case ":$PATH:" in
  *:/usr/bin:*) ;;
  *) export PATH="/usr/bin:$PATH" ;;
esac
case ":$PATH:" in
  *:/bin:*) ;;
  *) export PATH="/bin:$PATH" ;;
esac

# Load defaults then .env (if present). .env wins.
if [[ -f "$RDS_ROOT/config/defaults.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$RDS_ROOT/config/defaults.env"; set +a
fi
if [[ -f "$RDS_ROOT/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$RDS_ROOT/.env"; set +a
fi

# Runtime data roots. Defaults preserve the historical single-directory
# checkout, while env overrides let operators keep mutable state outside the
# public source tree.
RDS_BUILDS_DIR="${RDS_BUILDS_DIR:-$RDS_ROOT/builds}"
RDS_INBOX_DIR="${RDS_INBOX_DIR:-$RDS_ROOT/inbox}"
RDS_EVENTS_PATH="${RDS_EVENTS_PATH:-$RDS_ROOT/events.jsonl}"
RDS_DASHBOARD_CHAT_DIR="${RDS_DASHBOARD_CHAT_DIR:-$RDS_ROOT/dashboard/chat}"
export RDS_BUILDS_DIR RDS_INBOX_DIR RDS_EVENTS_PATH RDS_DASHBOARD_CHAT_DIR

# --- Flag parsing -----------------------------------------------------------
# Usage: VAL="$(parse_flag --foo "$@" || echo default)"
# Matches `--foo=value` and `--foo value` forms. Returns non-zero if absent.
parse_flag() {
  local name="$1"; shift
  local prev=""
  for arg in "$@"; do
    case "$arg" in
      "$name"=*) printf '%s\n' "${arg#*=}"; return 0 ;;
      "$name")   prev="$name" ;;
      *)
        if [[ "$prev" == "$name" ]]; then
          printf '%s\n' "$arg"; return 0
        fi
        prev=""
        ;;
    esac
  done
  return 1
}

normalize_app_type() {
  local value
  value="$(printf '%s' "${1:-auto}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/_/-/g; s/^-+//; s/-+$//')"
  case "$value" in
    ""|auto|unknown) echo "auto" ;;
    game|games) echo "game" ;;
    website|site|content-site|landing|landing-page|marketing) echo "website" ;;
    app|webapp|web-app|interactive-web) echo "web-app" ;;
    dashboard|operator-console|console) echo "dashboard" ;;
    internal|internal-tool|tool|admin) echo "internal-tool" ;;
    prototype|proto) echo "prototype" ;;
    hack|experiment) echo "hack" ;;
    *)
      echo "FATAL: unknown app type '$1' (expected auto, game, website, web-app, dashboard, internal-tool, prototype, hack)" >&2
      return 1
      ;;
  esac
}

first_positional_arg() {
  local skip_next=0
  local arg
  for arg in "$@"; do
    if [[ "$skip_next" -eq 1 ]]; then
      skip_next=0
      continue
    fi
    case "$arg" in
      --*=*) continue ;;
      --*)   skip_next=1; continue ;;
      *)     printf '%s\n' "$arg"; return 0 ;;
    esac
  done
  return 1
}

rds_pid_cmdline() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || return 1
}

rds_pid_is_build_runner() {
  local pid="${1:-}" build_id="${2:-}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local cmdline
  cmdline="$(rds_pid_cmdline "$pid" || true)"
  [[ -n "$cmdline" ]] || return 1
  case "$cmdline" in
    *rds-build*|*launch-build.sh*) ;;
    *) return 1 ;;
  esac
  if [[ -n "$build_id" ]]; then
    case "$cmdline" in
      *"$build_id"*|*"/builds/$build_id/"*) return 0 ;;
      *) return 1 ;;
    esac
  fi
  return 0
}

# --- Slug / name derivation -------------------------------------------------
derive_source_title() {
  local input="${1:-}"
  local file=""
  if [[ -f "$input" ]]; then
    file="$input"
  elif [[ -n "${RDS_ROOT:-}" && -f "$RDS_ROOT/$input" ]]; then
    file="$RDS_ROOT/$input"
  fi

  if [[ -n "$file" ]]; then
    local title
    title="$(grep -m1 -E '^# +[^#]' "$file" 2>/dev/null | sed -E 's/^#+ *//' || true)"
    if [[ "$title" =~ ^[Tt]he[[:space:]]+[Ww]eb-[Aa]gnostic[[:space:]]+[Mm]aster[[:space:]]+[Pp]rompt$ ]]; then
      title=""
    fi
    if [[ -z "$title" ]] && grep -qi 'classic arcade game Dig Dug' "$file" 2>/dev/null; then
      title="Dig Dug Browser Game"
    fi
    if [[ -z "$title" ]]; then
      title="$(grep -m1 -E 'build "([^"]+)"' "$file" 2>/dev/null | sed -E 's/.*build "([^"]+)".*/\1/' || true)"
    fi
    if [[ -z "$title" ]]; then
      title="$(grep -m1 -E '[[:alnum:]]' "$file" 2>/dev/null | sed -E 's/^[-*#>`[:space:]]+//; s/[[:space:]]+/ /g' || true)"
    fi
    title="${title%$'\r'}"
    title="$(printf '%s' "$title" | sed -E 's/([[:lower:][:digit:]])([[:upper:]][[:alpha:]]+:)/\1 \2/g; s/^[Ss]pec:[[:space:]]*//; s/[[:space:]]+—[[:space:]]+(Scaffold Spec|Implementation Specification|Build Specification|Product Specification)$//; s/[[:space:]]+(Scaffold Spec|Implementation Spec|Implementation Specification|Build Specification|Product Specification|PRD)$//')"
    title="$(printf '%s' "$title" | sed -E 's/[[:space:]]*(Version|Owner|Status|Last Updated|Predecessors):.*$//I; s/[[:space:]]+0\)[[:space:]].*$//')"
    if [[ "$title" =~ ^(.{2,80})[[:space:]]+Product[[:space:]]+Requirements[[:space:]]+Document([[:space:]]+\(PRD\))?[[:space:]]*(v[0-9]+(\.[0-9]+)?)?.*$ ]]; then
      local product_name="${BASH_REMATCH[1]}"
      local product_version="${BASH_REMATCH[3]:-}"
      title="$product_name${product_version:+ $product_version}"
    fi
    title="$(printf '%s' "$title" | sed -E 's/[[:space:]]+/ /g; s/^[[:space:]]+//; s/[[:space:]]+$//')"
    if [[ -n "$title" && ! "$title" =~ ^[Ii]mplementation[[:space:]]+[Ss]pec$ ]]; then
      printf '%s\n' "$title"
      return 0
    fi
  fi

  local base
  base="$(basename "${input%/}")"
  base="${base%.md}"
  base="${base%.markdown}"
  base="${base%.txt}"
  base="${base%.git}"
  printf '%s\n' "$base"
}

# Derive a short slug from a trigger string (URL, path, or free text).
derive_slug() {
  local input="${1:-build}"
  local base
  base="$(derive_source_title "$input")"
  # Lowercase + replace non-alnum with '-' + collapse + trim.
  base="$(printf '%s' "$base" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  [[ -n "$base" ]] || base="build"
  printf '%s\n' "$base" | cut -c1-48
}

# Derive a snake_case app name from a spec file (first # heading) or fallback.
derive_app_name() {
  local spec="$1"; local fallback="${2:-my_app}"
  local name
  if [[ -f "$spec" ]]; then
    name="$(grep -m1 -E '^# ' "$spec" 2>/dev/null | sed -E 's/^#+ *//' || true)"
  fi
  name="${name:-$fallback}"
  name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//')"
  # Rails-compatible: must start with a letter.
  [[ "$name" =~ ^[a-z] ]] || name="app_$name"
  # Trim to a reasonable length.
  printf '%s\n' "$name" | cut -c1-40
}

# --- Port allocation --------------------------------------------------------
# Prints the first free TCP port in [start, end] (inclusive).
next_free_port() {
  local start="${1:-3100}" end="${2:-3199}"
  local port
  for (( port=start; port<=end; port++ )); do
    if ! _port_in_use "$port"; then
      printf '%s\n' "$port"; return 0
    fi
  done
  echo "FATAL: no free port in $start-$end" >&2
  return 1
}

_port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN && return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -P -n >/dev/null 2>&1 && return 0
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -E "[:.]$port[[:space:]]+.*LISTEN" >/dev/null && return 0
  fi
  timeout 1 bash -c ":</dev/tcp/127.0.0.1/$port" >/dev/null 2>&1 && return 0
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$port" <<'PY' >/dev/null 2>&1 || return 0
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(("0.0.0.0", port))
finally:
    sock.close()
PY
  fi
  return 1
}

# --- Repo URL normalization -------------------------------------------------
# Accepts: github.com/org/repo, https://github.com/org/repo(.git), git@github.com:org/repo(.git)
# Prints a clone-ready URL.
normalize_repo_url() {
  local url="$1"
  case "$url" in
    git@*:*)
      printf '%s\n' "$url"
      ;;
    https://github.com/*)
      [[ "$url" == *.git ]] && printf '%s\n' "$url" || printf '%s.git\n' "$url"
      ;;
    github.com/*)
      local tail="${url#github.com/}"
      [[ "$tail" == *.git ]] && printf 'https://github.com/%s\n' "$tail" \
                              || printf 'https://github.com/%s.git\n' "$tail"
      ;;
    *)
      # Pass through unknown forms; git will complain if it cannot resolve.
      printf '%s\n' "$url"
      ;;
  esac
}

# --- Zo public port exposure ------------------------------------------------
# Prints a public URL for the given local port, or a localhost fallback.
# TODO: verify against current Zo docs; see config/zo-hosting.md.
zo_expose_port() {
  local port="$1" build_id="${2:-build}"
  # build_id is currently unused but reserved for the per-app-subdomain
  # mode documented in config/zo-hosting.md.
  : "${build_id:?}"

  if [[ -z "${ZO_PUBLIC_HOST:-}" ]]; then
    echo "TODO[zo-hosting]: ZO_PUBLIC_HOST is unset — falling back to localhost URL." >&2
    printf 'http://localhost:%s\n' "$port"
    return 0
  fi

  # Strip any trailing slash from ZO_PUBLIC_HOST.
  local host="${ZO_PUBLIC_HOST%/}"

  # Default assumption (see config/zo-hosting.md): per-port path prefix.
  printf '%s/port/%s/\n' "$host" "$port"
}

# --- Safety: ensure we're inside the RDS repo ------------------------------
assert_rds_root() {
  if [[ ! -f "$RDS_ROOT/AGENT.md" ]]; then
    echo "FATAL: $RDS_ROOT does not look like the RDS repo (missing AGENT.md)" >&2
    return 1
  fi
}

# --- Stack registry ---------------------------------------------------------
# A "stack" is a runtime+framework profile under stacks/<id>/manifest.json.
# Phase-0 V1 adds canonical slugs and aliases without moving the proven V0
# directories yet. Runtime scripts keep reading manifest.json for compatibility.
# See stacks/README.md for the schema and extension contract.

stack_resolve_id() {
  local id="$1"
  case "$id" in
    rails-web)         printf '%s\n' "rails" ;;
    react-spa)         printf '%s\n' "react" ;;
    nextjs-fullstack)  printf '%s\n' "nextjs" ;;
    mobile-native)     printf '%s\n' "react-native" ;;
    *)                 printf '%s\n' "$id" ;;
  esac
}

stack_canonical_id() {
  local id
  id="$(stack_resolve_id "$1")"
  case "$id" in
    rails)         printf '%s\n' "rails-web" ;;
    react)         printf '%s\n' "react-spa" ;;
    nextjs)        printf '%s\n' "nextjs-fullstack" ;;
    react-native)  printf '%s\n' "mobile-native" ;;
    *)             printf '%s\n' "$id" ;;
  esac
}

stack_detect_from_text() {
  local file="$1"
  [[ -f "$file" ]] || return 1
  python3 - "$file" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8", errors="ignore").lower()

explicit = re.search(r"(?:stack:\s*|build with\s+)(rails-web|nextjs-fullstack|python-ai-service|astro-thin-web|web-3d|game-engine|game-asset-pipeline|mobile-native|browser-extension|rails|nextjs|react-native)\b", text)
if explicit:
    print(explicit.group(1))
    raise SystemExit(0)

signals = [
    ("rails-web", ["rails", "active record", "hotwire", "stimulus"]),
    ("nextjs-fullstack", ["next.js", "nextjs", "app router", "rsc", "server actions"]),
    ("python-ai-service", ["fastapi", "pydantic ai", "agent service", "rag"]),
    ("astro-thin-web", ["astro", "marketing site", "blog", "docs site"]),
    ("web-3d", ["three.js", "r3f", "webgl", "3d portfolio"]),
    ("game-engine", ["godot", "game engine", "html5 game", "platformer"]),
    ("game-asset-pipeline", ["blender", "gltf", "usd", "asset pipeline"]),
    ("mobile-native", ["expo", "react native", "ios app", "android app"]),
    ("browser-extension", ["chrome extension", "browser extension", "mv3"]),
]
scores = [(sum(1 for term in terms if term in text), slug) for slug, terms in signals]
score, slug = max(scores)
if score > 0:
    print(slug)
    raise SystemExit(0)
raise SystemExit(1)
PY
}

stack_detect_from_repo() {
  local dir="$1"
  [[ -d "$dir" ]] || return 1
  if [[ -f "$dir/Gemfile" && -f "$dir/config/application.rb" ]]; then echo rails-web; return 0; fi
  if compgen -G "$dir/next.config.*" >/dev/null; then echo nextjs-fullstack; return 0; fi
  if [[ -f "$dir/astro.config.mjs" || -f "$dir/astro.config.ts" ]]; then echo astro-thin-web; return 0; fi
  if [[ -f "$dir/app.json" && -f "$dir/eas.json" ]]; then echo mobile-native; return 0; fi
  if [[ -f "$dir/wxt.config.ts" ]]; then echo browser-extension; return 0; fi
  if [[ -f "$dir/project.godot" ]]; then echo game-engine; return 0; fi
  if [[ -f "$dir/vite.config.ts" ]] && grep -Rqs "@react-three/fiber" "$dir/package.json" "$dir/src" 2>/dev/null; then echo web-3d; return 0; fi
  if [[ -f "$dir/pyproject.toml" ]] && grep -qi "fastapi" "$dir/pyproject.toml"; then echo python-ai-service; return 0; fi
  if [[ -f "$dir/pyproject.toml" ]] && grep -qi "bpy" "$dir/pyproject.toml"; then echo game-asset-pipeline; return 0; fi
  return 1
}

stack_detect_from_source() {
  local source="$1" repo_dir="${2:-}"
  if [[ -n "$repo_dir" ]] && stack_detect_from_repo "$repo_dir"; then return 0; fi
  if [[ -f "$source" ]]; then stack_detect_from_text "$source" && return 0; fi
  if [[ -n "${RDS_ROOT:-}" && -f "$RDS_ROOT/$source" ]]; then stack_detect_from_text "$RDS_ROOT/$source" && return 0; fi
  return 1
}

# stack_manifest_path <id> → prints absolute path to the manifest, or fails.
stack_manifest_path() {
  local id
  id="$(stack_resolve_id "$1")"
  local p="$RDS_ROOT/stacks/$id/manifest.json"
  [[ -f "$p" ]] || return 1
  printf '%s\n' "$p"
}

# stack_list → prints registered stack ids, one per line.
stack_list() {
  local d
  for d in "$RDS_ROOT"/stacks/*/manifest.json; do
    [[ -f "$d" ]] || continue
    basename "$(dirname "$d")"
  done
}

# stack_validate <id> — exits non-zero with a friendly message if unknown.
stack_validate() {
  local requested="$1"
  local id
  id="$(stack_resolve_id "$requested")"
  if [[ -z "$id" ]]; then
    echo "FATAL: stack id is empty" >&2; return 1
  fi
  if ! stack_manifest_path "$id" >/dev/null 2>&1; then
    {
      echo "FATAL: unknown --stack='$requested'."
      echo "Registered stacks under stacks/<id>/manifest.json and aliases:"
      stack_list | sed 's/^/  - /'
      echo "Aliases:"
      echo "  - rails-web -> rails"
      echo "  - react-spa -> react"
      echo "  - nextjs-fullstack -> nextjs"
      echo "  - mobile-native -> react-native"
    } >&2
    return 1
  fi
}

# stack_field <id> <jq-filter> — reads a manifest field via jq.
# Example: stack_field rails .health_path  →  "/up"
stack_field() {
  local id filter
  id="$(stack_resolve_id "$1")"
  filter="$2"
  local p; p="$(stack_manifest_path "$id")" || return 1
  jq -r "$filter" "$p"
}

# write_build_manifest <path> <build_id> <mode> <requested_stack> <resolved_stack> <canonical_stack> <source> <repo_url> <prd_source> <app_dest> <provider> <app_type>
# Writes builds/<id>/build.yaml without requiring a YAML library. JSON-quoted
# scalars are valid YAML scalars, and the file is intended as an operator/agent
# manifest rather than a shell parse target in Phase 0.
write_build_manifest() {
  python3 - "$@" <<'PY'
import json
import sys
from datetime import datetime, timezone

(
    path,
    build_id,
    mode,
    requested_stack,
    resolved_stack,
    canonical_stack,
    source,
    repo_url,
    prd_source,
    app_dest,
    provider,
    app_type,
) = sys.argv[1:]

def q(value: str) -> str:
    if value == "":
        return "null"
    return json.dumps(value)

lines = [
    "# Generated by bin/rds-build. Operator-facing V1 build intent manifest.",
    "version: 1",
    f"build_id: {q(build_id)}",
    f"created_at: {q(datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'))}",
    f"mode: {q(mode)}",
    "stack:",
    f"  requested: {q(requested_stack)}",
    f"  canonical: {q(canonical_stack)}",
    f"  runtime: {q(resolved_stack)}",
    "skills:",
    "  requested: []",
    "  resolved: []",
    "source:",
    f"  type: {q('github-repo' if repo_url else ('local-file' if source and not source.startswith('http') else 'notion-url' if 'notion.' in source else 'url' if source.startswith('http') else 'prompt'))}",
    f"  trigger: {q(source)}",
    f"  repo: {q(repo_url)}",
    f"  prd: {q(prd_source)}",
    "  branch: null",
    "target:",
    f"  app_dest: {q(app_dest)}",
    "  preview_port: null",
    "  preview_target: \"zo\"",
    "  external_deploy: null",
    "inference:",
    f"  provider: {q(provider)}",
    f"app_type: {q(app_type)}",
]

with open(path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
PY
}

update_build_manifest_preview_port() {
  local manifest="$1" port="$2"
  [[ -f "$manifest" && -n "$port" ]] || return 0
  python3 - "$manifest" "$port" <<'PY'
import sys
import yaml
from pathlib import Path

path = Path(sys.argv[1])
port = sys.argv[2]
data = yaml.safe_load(path.read_text()) or {}
data.setdefault("target", {})["preview_port"] = int(port) if str(port).isdigit() else port
path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
PY
}

# --- Inference provider -----------------------------------------------------
# rds_infer <provider> <cwd> <turns> <budget> <persona>
# Reads the prompt from stdin and routes it through the selected terminal AI.
# Claude supports turn/budget caps directly. Codex does not expose the same
# budget controls, so the values are intentionally advisory for dashboard/log
# visibility when provider=codex.
rds_infer() {
  local provider="${1:-claude}"
  local cwd="${2:-$PWD}"
  local turns="${3:-80}"
  local budget="${4:-1.00}"
  local persona="${5:-}"
  local prompt
  prompt="$(cat)"

  case "$provider" in
    codex)
      if ! command -v codex >/dev/null 2>&1; then
        echo "FATAL: codex CLI not found." >&2
        return 2
      fi
      if ! codex login status >/dev/null 2>&1; then
        echo "FATAL: codex CLI found but not logged in." >&2
        return 2
      fi
      local codex_args=(exec -C "$cwd" --sandbox danger-full-access --skip-git-repo-check --color never)
      if [[ -n "${RDS_CODEX_MODEL:-}" ]]; then
        codex_args+=(--model "$RDS_CODEX_MODEL")
      fi
      local codex_timeout="${RDS_CODEX_INFER_TIMEOUT_SEC:-900}"
      if [[ "${RDS_INFER_FINAL_ONLY:-0}" == "1" ]]; then
        local final_file rc
        final_file="$(mktemp)"
        codex_args+=(--ephemeral --output-last-message "$final_file")
        if [[ -n "$persona" ]]; then
          printf '%s\n\n%s\n' "$persona" "$prompt" | timeout "$codex_timeout" codex "${codex_args[@]}" - >/dev/null
        else
          printf '%s\n' "$prompt" | timeout "$codex_timeout" codex "${codex_args[@]}" - >/dev/null
        fi
        rc=$?
        [[ -s "$final_file" ]] && cat "$final_file"
        rm -f "$final_file"
        return "$rc"
      fi
      if [[ -n "$persona" ]]; then
        printf '%s\n\n%s\n' "$persona" "$prompt" | timeout "$codex_timeout" codex "${codex_args[@]}" -
      else
        printf '%s\n' "$prompt" | timeout "$codex_timeout" codex "${codex_args[@]}" -
      fi
      ;;
    claude|"")
      if ! command -v claude >/dev/null 2>&1; then
        echo "FATAL: claude CLI not found." >&2
        return 2
      fi
      local claude_args=(-p --dangerously-skip-permissions --model "${RDS_CLAUDE_MODEL:-claude-opus-4-6}" --max-turns "$turns" --max-budget-usd "$budget")
      if [[ -n "$persona" ]]; then
        claude_args+=(--append-system-prompt "$persona")
      fi
      ( cd "$cwd" && printf '%s\n' "$prompt" | IS_SANDBOX="${IS_SANDBOX:-1}" claude "${claude_args[@]}" )
      ;;
    *)
      echo "FATAL: unknown inference provider '$provider'." >&2
      return 2
      ;;
  esac
}

rds_build_provider_from_state() {
  local build_dir="$1"
  jq -r '.inference.provider // empty' "$build_dir/state.json" 2>/dev/null || true
}
