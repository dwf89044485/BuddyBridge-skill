#!/usr/bin/env bash
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_JSON="$SKILL_DIR/package.json"
PACKAGE_LOCK_JSON="$SKILL_DIR/package-lock.json"
DEP_NAME="claude-to-im"
LOCAL_SPEC="file:../BuddyBridge"
FORK_SPEC="github:dwf89044485/BuddyBridge"

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/core-source.sh status
  bash scripts/core-source.sh local [--install]
  bash scripts/core-source.sh fork [--install]

Commands:
  status   Show current core dependency source.
  local    Point claude-to-im dependency to local ../BuddyBridge.
  fork     Point claude-to-im dependency back to github:dwf89044485/BuddyBridge.

Flags:
  --install  Run npm install after updating package.json.
USAGE
}

read_declared_spec() {
  node - "$PACKAGE_JSON" "$DEP_NAME" <<'NODE'
const fs = require('node:fs');
const [pkgPath, depName] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const spec = pkg?.dependencies?.[depName] || '';
process.stdout.write(spec);
NODE
}

read_lock_spec() {
  if [ ! -f "$PACKAGE_LOCK_JSON" ]; then
    return 0
  fi

  node - "$PACKAGE_LOCK_JSON" <<'NODE'
const fs = require('node:fs');
const lockPath = process.argv[2];
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
const entry = lock?.packages?.['node_modules/claude-to-im'];
const out = entry?.resolved || entry?.version || '';
process.stdout.write(out);
NODE
}

write_declared_spec() {
  local target_spec="$1"

  node - "$PACKAGE_JSON" "$DEP_NAME" "$target_spec" <<'NODE'
const fs = require('node:fs');
const [pkgPath, depName, spec] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (!pkg.dependencies || typeof pkg.dependencies[depName] !== 'string') {
  throw new Error(`Missing dependencies.${depName} in ${pkgPath}`);
}
pkg.dependencies[depName] = spec;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
NODE
}

resolve_path() {
  local p="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$p"
    return
  fi

  local dir
  dir="$(cd "$(dirname "$p")" && pwd -P)"
  echo "$dir/$(basename "$p")"
}

show_status() {
  local declared lock_spec installed_path
  declared="$(read_declared_spec)"
  lock_spec="$(read_lock_spec || true)"

  echo "Declared dependency: $DEP_NAME@$declared"
  if [ -n "$lock_spec" ]; then
    echo "Lockfile source: $lock_spec"
  else
    echo "Lockfile source: (missing or not resolved yet)"
  fi

  if [ -e "$SKILL_DIR/node_modules/$DEP_NAME" ]; then
    installed_path="$(resolve_path "$SKILL_DIR/node_modules/$DEP_NAME")"
    echo "Installed path: $installed_path"
  else
    echo "Installed path: (node_modules/$DEP_NAME not installed)"
  fi

  case "$declared" in
    "$LOCAL_SPEC")
      echo "Active mode: local (single-source development via ../BuddyBridge)"
      ;;
    "$FORK_SPEC")
      echo "Active mode: fork (publish/default dependency)"
      ;;
    *)
      echo "Active mode: custom ($declared)"
      ;;
  esac
}

cmd="${1:-status}"
shift || true

install_after_update=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install)
      install_after_update=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
  shift
done

case "$cmd" in
  status)
    show_status
    ;;

  local|fork)
    current_spec="$(read_declared_spec)"
    target_spec="$LOCAL_SPEC"
    [ "$cmd" = "fork" ] && target_spec="$FORK_SPEC"

    if [ "$current_spec" = "$target_spec" ]; then
      echo "Dependency already set: $DEP_NAME@$target_spec"
    else
      write_declared_spec "$target_spec"
      echo "Updated package.json: $DEP_NAME@$target_spec"
    fi

    if [ "$install_after_update" = true ]; then
      echo "Running npm install to sync lockfile and node_modules..."
      (cd "$SKILL_DIR" && npm install)
    else
      echo "Next step: run 'cd $SKILL_DIR && npm install' to sync lockfile and node_modules."
    fi

    show_status
    ;;

  *)
    echo "Unknown command: $cmd" >&2
    usage
    exit 1
    ;;
esac
