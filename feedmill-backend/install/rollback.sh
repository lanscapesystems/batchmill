#!/usr/bin/env bash
#
# Flip /opt/feedmill/current back to the previous release and restart.
# Installed by install.sh as /usr/local/sbin/feedmill-rollback (root, 0755).
#   sudo feedmill-rollback
# Run it again to flip forward again (current and previous swap).
# Code only: mill.db and /etc/feedmill are NOT restored.
set -euo pipefail

ROOT_DIR="/opt/feedmill"
CURRENT="$ROOT_DIR/current"
PREVIOUS="$ROOT_DIR/previous"

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || die "run as root (sudo $0)"

NEW="$(readlink -f "$PREVIOUS" 2>/dev/null || true)"
OLD="$(readlink -f "$CURRENT" 2>/dev/null || true)"
[[ -n "$NEW" && -d "$NEW" ]] || die "no previous release to roll back to"
[[ "$NEW" != "$OLD" ]] || die "previous and current are the same release"

if [[ "${FORCE:-0}" != 1 ]] && STATE_JSON="$(curl -fsS -m 3 http://127.0.0.1:3001/api/v1/state 2>/dev/null)"; then
  node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit((s.activeBatch&&!["PAUSED","COMPLETED","FAULTED","IDLE"].includes(s.activeBatch.state))||(s.equipment||[]).some(e=>e.state!==undefined&&e.status==="running")?1:0)' <<<"$STATE_JSON" \
    || die "a batch is in progress (not paused) or a motor is running — stop it first (or FORCE=1)"
fi

flip() { # atomic symlink replace
  ln -sfn "$1" "$ROOT_DIR/.$2.tmp" && mv -T "$ROOT_DIR/.$2.tmp" "$ROOT_DIR/$2"
}
restart_stack() {
  systemctl restart feedmill-io-daemon.service feedmill-backend.service
  ! systemctl cat feedmill-hmi.service >/dev/null 2>&1 || systemctl restart feedmill-hmi.service
}
healthy() {
  local i
  for i in $(seq 1 30); do
    curl -fsS -m 2 http://127.0.0.1:3001/api/v1/health >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

echo ">> rolling back $(basename "$OLD") -> $(basename "$NEW")"
flip "$NEW" current
flip "$OLD" previous
restart_stack
if ! healthy; then
  echo "ERROR: $(basename "$NEW") is not healthy — restoring $(basename "$OLD")" >&2
  flip "$OLD" current
  flip "$NEW" previous
  restart_stack
  die "rollback failed (journalctl -u feedmill-backend -n 100)"
fi
echo "Now running $(basename "$NEW")"
