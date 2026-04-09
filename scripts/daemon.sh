#!/usr/bin/env bash
set -euo pipefail
CTI_HOME="${CTI_HOME:-$HOME/.claude-to-im}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CORE_DIR="$(cd "$SKILL_DIR/../BuddyBridge" 2>/dev/null && pwd || true)"
PID_FILE="$CTI_HOME/runtime/bridge.pid"
STATUS_FILE="$CTI_HOME/runtime/status.json"
LOG_FILE="$CTI_HOME/logs/bridge.log"

# ── Common helpers ──

ensure_dirs() { mkdir -p "$CTI_HOME"/{data,logs,runtime,data/messages}; }

ensure_core_built() {
  if [ -z "$CORE_DIR" ] || [ ! -f "$CORE_DIR/package.json" ] || [ ! -d "$CORE_DIR/src" ]; then
    return
  fi

  local core_entry="$CORE_DIR/dist/lib/bridge/context.js"
  local need_build=0

  if [ ! -f "$core_entry" ]; then
    need_build=1
  else
    local newest_core_src
    newest_core_src=$(find "$CORE_DIR/src" -name '*.ts' -newer "$core_entry" 2>/dev/null | head -1)
    if [ -n "$newest_core_src" ]; then
      need_build=1
    fi
  fi

  if [ "$need_build" = "1" ]; then
    echo "Building core bridge package..."
    (cd "$CORE_DIR" && npm run build)
  fi
}

ensure_built() {
  ensure_core_built

  local need_build=0
  if [ ! -f "$SKILL_DIR/dist/daemon.mjs" ]; then
    need_build=1
  else
    # Check if any source file is newer than the bundle
    local newest_src
    newest_src=$(find "$SKILL_DIR/src" -name '*.ts' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
    if [ -n "$newest_src" ]; then
      need_build=1
    fi
    # Also check if the local BuddyBridge dist was updated — its code is bundled into dist
    if [ "$need_build" = "0" ] && [ -n "$CORE_DIR" ] && [ -d "$CORE_DIR/dist" ]; then
      local newest_core_dist
      newest_core_dist=$(find "$CORE_DIR/dist" -name '*.js' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
      if [ -n "$newest_core_dist" ]; then
        need_build=1
      fi
    fi
    # Also check if node_modules/claude-to-im was updated (npm update)
    # — its code is bundled into dist, so changes require a rebuild
    if [ "$need_build" = "0" ] && [ -d "$SKILL_DIR/node_modules/claude-to-im/src" ]; then
      local newest_dep
      newest_dep=$(find "$SKILL_DIR/node_modules/claude-to-im/src" -name '*.ts' -newer "$SKILL_DIR/dist/daemon.mjs" 2>/dev/null | head -1)
      if [ -n "$newest_dep" ]; then
        need_build=1
      fi
    fi
  fi
  if [ "$need_build" = "1" ]; then
    echo "Building daemon bundle..."
    (cd "$SKILL_DIR" && npm run build)
  fi
}

normalize_runtime() {
  case "${1:-}" in
    claude|persistent-claude)
      echo "claude"
      ;;
    codex)
      echo "codex"
      ;;
    codebuddy|codebuddysdk|auto|"")
      echo "codebuddy"
      ;;
    *)
      echo "codebuddy"
      ;;
  esac
}

clean_env() {
  unset CLAUDECODE 2>/dev/null || true

  local runtime raw_runtime
  raw_runtime=$(grep "^CTI_RUNTIME=" "$CTI_HOME/config.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'" | tr -d '"' || true)
  runtime=$(normalize_runtime "$raw_runtime")

  local mode="${CTI_ENV_ISOLATION:-inherit}"
  if [ "$mode" = "strict" ]; then
    case "$runtime" in
      codex)
        while IFS='=' read -r name _; do
          case "$name" in ANTHROPIC_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      claude)
        # Keep ANTHROPIC_* (from config.env) — needed for third-party API providers.
        # Strip OPENAI_* to avoid cross-runtime leakage.
        while IFS='=' read -r name _; do
          case "$name" in OPENAI_*) unset "$name" 2>/dev/null || true ;; esac
        done < <(env)
        ;;
      codebuddy)
        # Keep both ANTHROPIC_* and OPENAI_* because codebuddy runtime may fallback to Claude or Codex.
        ;;
    esac
  fi
}

read_pid() {
  [ -f "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || echo ""
}

pid_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

status_running() {
  [ -f "$STATUS_FILE" ] && grep -q '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" 2>/dev/null
}

read_status_field() {
  local key="$1"
  grep -o '"'"$key"'"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//'
}

read_status_bool() {
  local key="$1"
  grep -o '"'"$key"'"[[:space:]]*:[[:space:]]*\(true\|false\)' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*: *//'
}

show_last_exit_reason() {
  if [ -f "$STATUS_FILE" ]; then
    local reason
    reason=$(grep -o '"lastExitReason"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS_FILE" 2>/dev/null | head -1 | sed 's/.*: *"//;s/"$//')
    [ -n "$reason" ] && echo "Last exit reason: $reason"
  fi
}

show_failure_help() {
  echo ""
  echo "Recent logs:"
  tail -20 "$LOG_FILE" 2>/dev/null || echo "  (no log file)"
  echo ""
  echo "Next steps:"
  echo "  1. Run diagnostics:  bash \"$SKILL_DIR/scripts/doctor.sh\""
  echo "  2. Check full logs:  bash \"$SKILL_DIR/scripts/daemon.sh\" logs 100"
  echo "  3. Rebuild bundle:   cd \"$SKILL_DIR\" && npm run build"
}

verify_online() {
  local timeout_sec="${1:-60}"
  local started=false

  for _ in $(seq 1 "$timeout_sec"); do
    if status_running; then
      started=true
      break
    fi
    sleep 1
  done

  if [ "$started" = "true" ]; then
    local pid runtime resolved provider_chain used_persistent fallback_applied
    pid=$(read_pid)
    runtime=$(read_status_field configuredRuntime)
    [ -n "$runtime" ] || runtime=$(read_status_field runtime)
    resolved=$(read_status_field resolvedProvider)
    provider_chain=$(read_status_field providerChain)
    used_persistent=$(read_status_bool usedPersistent)
    fallback_applied=$(read_status_bool fallbackApplied)
    echo "✅ Bridge online${pid:+ (PID: $pid)}${runtime:+, runtime: $runtime}${resolved:+, provider: $resolved}"
    [ -n "$provider_chain" ] && echo "Provider chain: $provider_chain"
    [ -n "$used_persistent" ] && echo "Persistent: $used_persistent"
    [ -n "$fallback_applied" ] && echo "Fallback applied: $fallback_applied"
    supervisor_is_running || echo "⚠️ Supervisor process not detected, but status.json reports running=true"
    cat "$STATUS_FILE" 2>/dev/null
    return 0
  fi

  echo "❌ Bridge verification failed: not online within ${timeout_sec}s"
  status_running || echo "  status.json not reporting running=true."
  show_last_exit_reason
  show_failure_help
  return 1
}

# ── Load platform-specific supervisor ──

case "$(uname -s)" in
  Darwin)
    # shellcheck source=supervisor-macos.sh
    source "$SKILL_DIR/scripts/supervisor-macos.sh"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Windows detected via Git Bash / MSYS2 / Cygwin — delegate to PowerShell
    echo "Windows detected. Delegating to supervisor-windows.ps1..."
    powershell.exe -ExecutionPolicy Bypass -File "$SKILL_DIR/scripts/supervisor-windows.ps1" "$@"
    exit $?
    ;;
  *)
    # shellcheck source=supervisor-linux.sh
    source "$SKILL_DIR/scripts/supervisor-linux.sh"
    ;;
esac

# ── Commands ──

case "${1:-help}" in
  start)
    ensure_dirs
    ensure_built

    # Check if already running (supervisor-aware: launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      EXISTING_PID=$(read_pid)
      echo "Bridge already running${EXISTING_PID:+ (PID: $EXISTING_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
      exit 1
    fi

    # Source config.env BEFORE clean_env so that CTI_ANTHROPIC_PASSTHROUGH
    # and other CTI_* flags are available when clean_env checks them.
    [ -f "$CTI_HOME/config.env" ] && set -a && source "$CTI_HOME/config.env" && set +a

    clean_env
    echo "Starting bridge..."
    supervisor_start

    # Poll for up to 90 seconds waiting for status.json to report running
    STARTED=false
    for _ in $(seq 1 90); do
      sleep 1
      if status_running; then
        STARTED=true
        break
      fi
      # If supervisor process already died, stop waiting
      if ! supervisor_is_running; then
        break
      fi
    done

    if [ "$STARTED" = "true" ]; then
      NEW_PID=$(read_pid)
      echo "Bridge started${NEW_PID:+ (PID: $NEW_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Failed to start bridge."
      supervisor_is_running || echo "  Process not running."
      status_running || echo "  status.json not reporting running=true."
      show_last_exit_reason
      show_failure_help
      exit 1
    fi
    ;;

  stop)
    if supervisor_is_managed; then
      echo "Stopping bridge..."
      supervisor_stop
      echo "Bridge stopped"
    else
      PID=$(read_pid)
      if [ -z "$PID" ]; then echo "No bridge running"; exit 0; fi
      if pid_alive "$PID"; then
        kill "$PID"
        for _ in $(seq 1 10); do
          pid_alive "$PID" || break
          sleep 1
        done
        pid_alive "$PID" && kill -9 "$PID"
        echo "Bridge stopped"
      else
        echo "Bridge was not running (stale PID file)"
      fi
      rm -f "$PID_FILE"
    fi
    ;;

  restart)
    echo "Restarting bridge..."
    # Stop if running
    if supervisor_is_managed; then
      supervisor_stop
    else
      PID=$(read_pid)
      if [ -n "$PID" ] && pid_alive "$PID"; then
        kill "$PID"
        for _ in $(seq 1 10); do
          pid_alive "$PID" || break
          sleep 1
        done
        pid_alive "$PID" && kill -9 "$PID"
      fi
      rm -f "$PID_FILE"
    fi
    # Wait for process to fully terminate
    sleep 1
    # Start
    ensure_dirs
    ensure_built
    [ -f "$CTI_HOME/config.env" ] && set -a && source "$CTI_HOME/config.env" && set +a
    clean_env
    supervisor_start
    # Poll for up to 90 seconds waiting for status.json to report running
    STARTED=false
    for _ in $(seq 1 90); do
      sleep 1
      if status_running; then
        STARTED=true
        break
      fi
      if ! supervisor_is_running; then
        break
      fi
    done
    if [ "$STARTED" = "true" ]; then
      NEW_PID=$(read_pid)
      echo "Bridge restarted${NEW_PID:+ (PID: $NEW_PID)}"
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Failed to restart bridge."
      supervisor_is_running || echo "  Process not running."
      status_running || echo "  status.json not reporting running=true."
      show_last_exit_reason
      show_failure_help
      exit 1
    fi
    ;;

  status)
    # Platform-specific status info (prints launchd/service state)
    supervisor_status_extra

    # Process status: supervisor-aware (launchctl on macOS, PID on Linux)
    if supervisor_is_running; then
      PID=$(read_pid)
      echo "Bridge process is running${PID:+ (PID: $PID)}"
      # Business status from status.json
      if status_running; then
        runtime=$(read_status_field configuredRuntime)
        [ -n "$runtime" ] || runtime=$(read_status_field runtime)
        resolved=$(read_status_field resolvedProvider)
        provider_chain=$(read_status_field providerChain)
        used_persistent=$(read_status_bool usedPersistent)
        fallback_applied=$(read_status_bool fallbackApplied)
        echo "Bridge status: running"
        [ -n "$runtime" ] && echo "Configured runtime: $runtime"
        [ -n "$resolved" ] && echo "Resolved provider: $resolved"
        [ -n "$provider_chain" ] && echo "Provider chain: $provider_chain"
        [ -n "$used_persistent" ] && echo "Persistent: $used_persistent"
        [ -n "$fallback_applied" ] && echo "Fallback applied: $fallback_applied"
      else
        echo "Bridge status: process alive but status.json not reporting running"
      fi
      cat "$STATUS_FILE" 2>/dev/null
    else
      echo "Bridge is not running"
      [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
      if [ -f "$STATUS_FILE" ]; then
        runtime=$(read_status_field configuredRuntime)
        [ -n "$runtime" ] || runtime=$(read_status_field runtime)
        resolved=$(read_status_field resolvedProvider)
        provider_chain=$(read_status_field providerChain)
        [ -n "$runtime" ] && echo "Last configured runtime: $runtime"
        [ -n "$resolved" ] && echo "Last resolved provider: $resolved"
        [ -n "$provider_chain" ] && echo "Last provider chain: $provider_chain"
      fi
      show_last_exit_reason
    fi
    ;;

  logs)
    N="${2:-50}"
    tail -n "$N" "$LOG_FILE" 2>/dev/null | sed -E 's/(token|secret|password)(["\\x27]?\s*[:=]\s*["\\x27]?)[^ "]+/\1\2*****/gi'
    ;;

  rebuild)
    ensure_dirs

    if [ -n "$CORE_DIR" ] && [ -f "$CORE_DIR/package.json" ]; then
      echo "Rebuilding BuddyBridge..."
      (cd "$CORE_DIR" && npm run build)
    else
      echo "Skipping BuddyBridge build (core repo not found)."
    fi

    echo "Rebuilding BuddyBridge-skill..."
    (cd "$SKILL_DIR" && npm run build)

    echo "Restarting bridge..."
    "$0" restart

    echo "Verifying online status..."
    verify_online 60
    ;;

  *)
    echo "Usage: daemon.sh {start|stop|restart|status|logs [N]|rebuild}"
    ;;
esac