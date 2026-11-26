#!/usr/bin/env bash
#
# Root-run web update. Installed as /usr/local/sbin/feedmill-apply-update and
# started ONLY by feedmill-update.service (the backend asks for it via one
# fixed sudoers line after streaming an upload to $STAGED).
#
# The upload is untrusted input from a loopback service running as `feedmill`,
# and this script runs the bundle's installer as root. So, in order:
#   1. copy the staged file into a root-only dir and delete the original
#      (the uploader can't swap it between check and use)
#   2. verify an Ed25519 signature against /etc/feedmill-update/pubkey.pem
#      (root-owned dir; no key installed = updates disabled)
#   3. only then unpack and run the bundle's install.sh in update mode,
#      which builds a new release, switches, health-checks, and reverts
#
# `feedmill-apply-update github` skips the signature and instead pulls the
# repo/branch in $STATE_DIR/update-source.json (stopgap until the HMI has auth).
#
# Bundle = outer .zip holding exactly two members: release.zip (monorepo
# source: feedmill-backend/ + hmi-prototype/) and release.sig (signature over
# release.zip). Build one with install/make-update.sh.
set -uo pipefail

STATE_DIR="/var/lib/feedmill"
STAGED="$STATE_DIR/staging/update.zip"
STATUS="$STATE_DIR/update-status.json"
BACKUPS="$STATE_DIR/backups"
DATA_DIR="$STATE_DIR/data"
TRUST_DIR="/etc/feedmill-update"
WORK="/var/lib/feedmill-update" # root-only, outside the feedmill-owned state dir
CURRENT="/opt/feedmill/current"
APP_USER="feedmill"
MAX_BYTES=$((512 * 1024 * 1024))
VERSION=""

status() { # status <state> <message>: queued|running|success|failed|rolled_back
  local tmp
  tmp="$(mktemp "$STATE_DIR/.status.XXXXXX")" || return 0
  printf '{"state":"%s","message":"%s","version":"%s","at":"%s"}\n' \
    "$1" "$(printf %s "$2" | tr -d '"\\')" "$(printf %s "$VERSION" | tr -d '"\\')" "$(date -u +%FT%TZ)" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$STATUS"
}
fail() { echo "ERROR: $*" >&2; status failed "$*"; rm -rf "$WORK" "$STAGED"; exit 1; }

[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
exec 9>/run/feedmill-update.lock
flock -n 9 || { echo "an update is already running" >&2; exit 1; }

MODE="${1:-zip}" # zip = signed upload; github = pull the configured repo/branch (unsigned until the HMI has auth)
IFACE="$(sed -n 's/^IFACE=//p' "$TRUST_DIR/install.env" 2>/dev/null | head -n1)"
[[ -n "$IFACE" && -d "/sys/class/net/$IFACE" ]] || fail "EtherCAT NIC '$IFACE' from install.env not found"

rm -rf "$WORK"
install -d -m 0700 -o root -g root "$WORK" "$WORK/src"
SHA=""
if [[ "$MODE" == github ]]; then
  status running "downloading from GitHub"
  REPO="lanscapesystems/batchmill" # fixed; same constant as src/updateApi.ts
  # the branch comes from a feedmill-owned file, so re-validate before it reaches a URL
  BRANCH="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).branch||"")' "$STATE_DIR/update-source.json" 2>/dev/null || true)"
  [[ -n "$BRANCH" ]] || BRANCH="phase1-3-load-faults-horn"
  [[ "$BRANCH" =~ ^[A-Za-z0-9_][A-Za-z0-9_./-]*$ && "$BRANCH" != *..* ]] || fail "invalid branch name"
  SHA="$(curl -fsSL -m 30 -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/$BRANCH")" || fail "GitHub: cannot resolve $REPO@$BRANCH (private repo, wrong name, or offline)"
  [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || fail "GitHub returned an unexpected commit id"
  # pin to the resolved sha so a push mid-download can't mix versions
  curl -fsSL -m 600 --max-filesize "$MAX_BYTES" "https://codeload.github.com/$REPO/tar.gz/$SHA" -o "$WORK/src.tgz" || fail "GitHub download failed"
  tar -xzf "$WORK/src.tgz" -C "$WORK/src" --strip-components=1 --no-same-owner || fail "GitHub archive is corrupt"
else
  status running "verifying upload"
  [[ -f "$TRUST_DIR/pubkey.pem" ]] || fail "updates disabled: no signing key installed"
  [[ -f "$STAGED" && ! -L "$STAGED" ]] || fail "no staged upload"
  [[ "$(stat -c %s "$STAGED")" -le "$MAX_BYTES" ]] || fail "upload too large"
  mv "$STAGED" "$WORK/bundle.zip" || fail "could not take the staged upload"
  # exact member names only: nothing in the bundle picks its own path
  unzip -p "$WORK/bundle.zip" release.zip >"$WORK/release.zip" 2>/dev/null || fail "bundle has no release.zip"
  unzip -p "$WORK/bundle.zip" release.sig >"$WORK/release.sig" 2>/dev/null || fail "bundle has no release.sig"
  openssl pkeyutl -verify -pubin -inkey "$TRUST_DIR/pubkey.pem" -rawin \
    -in "$WORK/release.zip" -sigfile "$WORK/release.sig" >/dev/null 2>&1 || fail "signature check failed — not an authentic update"
  unzip -q "$WORK/release.zip" -d "$WORK/src" || fail "release.zip is corrupt"
fi
SRC="$WORK/src/feedmill-backend"
for f in feedmill-backend/package.json feedmill-backend/install/install.sh hmi-prototype/package.json; do
  [[ -f "$WORK/src/$f" ]] || fail "update is missing $f"
done
VERSION="$(node -p "require('$SRC/package.json').version" 2>/dev/null)" || fail "cannot read release version"

# Snapshot db + config before anything is switched. No snapshot, no update.
# One folder per snapshot: mill.db (data), config.json (data), io.conf (derived
# from config.json, but versioned with the daemon, so it is restored with it).
status running "snapshotting database"
TS="$(date +%Y%m%d%H%M%S)"
SNAP="$BACKUPS/pre-update/$TS"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$BACKUPS" "$BACKUPS/pre-update" "$SNAP"
if [[ -f "$DATA_DIR/mill.db" ]]; then
  # SQLite online backup (consistent under WAL), run as the db's own user from
  # the live release so the same native better-sqlite3 build is used
  (cd "$CURRENT/app" && runuser -u "$APP_USER" -- node -e '
    const D=require("better-sqlite3");
    new D(process.argv[1],{fileMustExist:true}).backup(process.argv[2])
      .then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})' \
    "$DATA_DIR/mill.db" "$SNAP/mill.db") || fail "database snapshot failed — update aborted, nothing changed"
fi
[[ ! -f "$DATA_DIR/config.json" ]] || install -m 0640 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR/config.json" "$SNAP/config.json"
[[ ! -f /etc/feedmill/io.conf ]] || install -m 0640 -o "$APP_USER" -g "$APP_USER" /etc/feedmill/io.conf "$SNAP/io.conf"
ls -1dt "$BACKUPS"/pre-update/*/ 2>/dev/null | tail -n +6 | xargs -r rm -rf # keep the last 5

status running "building $VERSION and switching (several minutes)"
(cd "$SRC" && FEEDMILL_UPDATE=1 bash install/install.sh "$IFACE") 2>&1 | tee "$WORK/install.log"
RC=${PIPESTATUS[0]}
# last lines of the installer's output, so the HMI shows the real cause
WHY="$(tail -n 4 "$WORK/install.log" | tr '\n' ' ' | tr -cd '[:print:]' | tail -c 300)"

if [[ $RC -eq 0 ]]; then
  status success "updated to $VERSION"
elif [[ $RC -eq 3 ]]; then
  # new code was live, failed its health check, and install.sh put the old
  # release back — but the new backend may already have migrated mill.db or
  # rewritten config.json / io.conf, so put all three back from the snapshot
  systemctl stop feedmill-backend.service
  if [[ -f "$SNAP/mill.db" ]]; then
    rm -f "$DATA_DIR/mill.db" "$DATA_DIR/mill.db-wal" "$DATA_DIR/mill.db-shm"
    install -m 0640 -o "$APP_USER" -g "$APP_USER" "$SNAP/mill.db" "$DATA_DIR/mill.db"
  fi
  [[ ! -f "$SNAP/config.json" ]] || install -m 0640 -o "$APP_USER" -g "$APP_USER" "$SNAP/config.json" "$DATA_DIR/config.json"
  [[ ! -f "$SNAP/io.conf" ]] || install -m 0640 -o "$APP_USER" -g "$APP_USER" "$SNAP/io.conf" /etc/feedmill/io.conf
  systemctl start feedmill-backend.service
  status rolled_back "$VERSION failed its health check; previous release, database and config restored"
  RC=1
else
  status failed "$VERSION did not build (current release untouched): $WHY"
fi
rm -rf "$WORK"
exit "$RC"
