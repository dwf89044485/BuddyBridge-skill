#!/usr/bin/env bash
# Linux supervisor — setsid/nohup fallback process management.
# Sourced by daemon.sh; expects CTI_HOME, SKILL_DIR, PID_FILE, STATUS_FILE, LOG_FILE.

# ── Public interface (called by daemon.sh) ──

find_daemon_pids() {
  local daemon_path="$SKILL_DIR/dist/daemon.mjs"
  ps -eo pid=,args= | awk -v daemon_path="$daemon_path" '
    index($0, "node " daemon_path) > 0 { print $1 }
  '
}

first_daemon_pid() {
  find_daemon_pids | head -n 1
}

supervisor_start() {
  if command -v setsid >/dev/null 2>&1; then
    setsid node "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
  else
    nohup node "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 < /dev/null &
  fi
  # Fallback: write shell $! as PID; main.ts will overwrite with real PID
  echo $! > "$PID_FILE"
}

supervisor_stop() {
  local stopped=false
  local pid
  local pids

  pids=$(find_daemon_pids || true)
  if [ -z "$pids" ]; then
    pid=$(read_pid)
    if [ -z "$pid" ]; then
      echo "No bridge running"
      rm -f "$PID_FILE"
      return 0
    fi
    pids="$pid"
  fi

  for pid in $pids; do
    if pid_alive "$pid"; then
      kill "$pid" 2>/dev/null || true
      stopped=true
    fi
  done

  for _ in $(seq 1 10); do
    sleep 1
    pids=$(find_daemon_pids || true)
    [ -z "$pids" ] && break
  done

  if [ -n "$(find_daemon_pids || true)" ]; then
    for pid in $(find_daemon_pids || true); do
      kill -9 "$pid" 2>/dev/null || true
      stopped=true
    done
  fi

  if [ "$stopped" = true ]; then
    echo "Bridge stopped"
  else
    echo "Bridge was not running (stale PID file)"
  fi
  rm -f "$PID_FILE"
}

supervisor_is_managed() {
  # Linux fallback has no service manager; always false
  return 1
}

supervisor_status_extra() {
  # No extra status for Linux fallback
  :
}

supervisor_is_running() {
  local pid
  local actual_pid

  actual_pid=$(first_daemon_pid)
  if [ -n "$actual_pid" ]; then
    echo "$actual_pid" > "$PID_FILE"
    return 0
  fi

  pid=$(read_pid)
  if pid_alive "$pid"; then
    return 0
  fi

  rm -f "$PID_FILE"
  return 1
}
