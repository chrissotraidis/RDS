# lock.sh — build lock acquire/cleanup with stale-PID detection.
#
# Sourced from launch-build.sh. Expects LOCKDIR to be set.
#
# acquire_build_lock writes hostname+PID to $LOCKDIR/pid via atomic rename.
# If the lockdir already exists, checks whether the owning PID is alive on
# this host. Dead PIDs are cleaned with a visible warning; live PIDs or
# other-host locks abort.

acquire_build_lock() {
  # Attempts 1-2: if lockdir exists but pid isn't published, wait for a
  # racing acquirer to finish publishing. Attempt 3: give up waiting and
  # clean as stale. Attempt 4: retry mkdir after cleanup.
  local attempt
  for attempt in 1 2 3 4; do
    if mkdir "$LOCKDIR" 2>/dev/null; then
      local tmp="$LOCKDIR/pid.tmp"
      printf '%s\n%s\n' "$(hostname)" "$$" > "$tmp"
      mv "$tmp" "$LOCKDIR/pid"
      return 0
    fi

    local pidfile="$LOCKDIR/pid"
    local lock_host="" lock_pid=""
    if [[ -f "$pidfile" ]]; then
      lock_host="$(sed -n '1p' "$pidfile" 2>/dev/null || true)"
      lock_pid="$(sed -n '2p' "$pidfile" 2>/dev/null || true)"
    fi

    local current_host
    current_host="$(hostname)"

    # No readable pid file. This is ambiguous: it could be a racing acquirer
    # that has mkdir'd $LOCKDIR but not yet published its pid file, or a
    # truly abandoned lock. Distinguish by waiting and retrying — a live
    # acquirer finishes publishing in well under a second; an abandoned
    # lockdir will still be missing a pid file after several seconds.
    if [[ -z "$lock_pid" || ! "$lock_pid" =~ ^[0-9]+$ ]]; then
      if [[ "$attempt" -le 2 ]]; then
        sleep 2
        continue
      fi
      echo ""
      echo "############################################################"
      echo "# WARNING: stale build lock with no/invalid pid file"
      echo "# (waited for a racing acquirer to publish; none did)"
      echo "# Cleaning up $LOCKDIR and retrying."
      echo "############################################################"
      echo ""
      rm -rf "$LOCKDIR"
      continue
    fi

    if [[ -n "$lock_host" && "$lock_host" != "$current_host" ]]; then
      echo "Error: Another build is already running on host '$lock_host' (pid $lock_pid, lockdir: $LOCKDIR)"
      echo "Refusing to clean a lock from a different machine. Remove manually if certain it is stale."
      exit 1
    fi

    if kill -0 "$lock_pid" 2>/dev/null; then
      echo "Error: Another build is already running (pid $lock_pid, lockdir: $LOCKDIR)"
      exit 1
    fi

    echo ""
    echo "############################################################"
    echo "# WARNING: stale lock from PID $lock_pid on $lock_host, cleaning up"
    echo "# (process is not alive; lockdir: $LOCKDIR)"
    echo "############################################################"
    echo ""
    rm -rf "$LOCKDIR"
  done

  echo "Error: Unable to acquire build lock after stale cleanup (lockdir: $LOCKDIR)"
  exit 1
}

cleanup_build_lock() {
  if [[ -f "$LOCKDIR/pid" ]]; then
    local owner_pid
    owner_pid="$(sed -n '2p' "$LOCKDIR/pid" 2>/dev/null || true)"
    if [[ "$owner_pid" != "$$" ]]; then
      return 0
    fi
  fi
  rm -rf "$LOCKDIR" 2>/dev/null || rmdir "$LOCKDIR" 2>/dev/null || true
}
