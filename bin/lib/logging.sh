# bin/lib/logging.sh — timestamped logger. Source-only.
#
# Usage:
#   log "something happened"
#   log_err "something broke"
#
# Callers stream stage output to a build log via tee in bin/rds-build; this
# helper just formats stdout lines.

_log_caller() {
  # $0 is the outer script when this file is sourced. Basename for brevity.
  basename "${0:-rds}" 2>/dev/null || printf 'rds'
}

log() {
  printf '[%s %s] %s\n' \
    "$(_log_caller)" \
    "$(date -u +%FT%TZ)" \
    "$*"
}

log_err() {
  printf '[%s %s] ERROR: %s\n' \
    "$(_log_caller)" \
    "$(date -u +%FT%TZ)" \
    "$*" >&2
}
