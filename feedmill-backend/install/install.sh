#!/usr/bin/env bash
#
# One-shot installer/deployer for the feedmill backend + EtherCAT I/O daemon
# + HMI frontend stack on a Debian 13 target. Run as root, from this
# project's checkout (the monorepo root, so hmi-prototype/ is a sibling of
# feedmill-backend/), after it's been copied onto the real machine:
#
#   sudo ./install/install.sh [ethercat-nic]
#
# [ethercat-nic] is the network interface wired to the EtherCAT bus (e.g.
# eth1) — it can't be auto-detected, since a machine may have several NICs
# and only one is on the bus. Leave it off and the installer lists the
# machine's wired NICs and asks which one to build the IgH master for.
#
# Layout (every run builds a NEW release; nothing in a live release is edited):
#   /opt/feedmill/releases/<id>/{app,hmi,ethercat-rt}   root-owned, read-only
#   /opt/feedmill/current   -> releases/<id>            all units run from here
#   /opt/feedmill/previous  -> the release before it    for `feedmill-rollback`
# If the new release isn't healthy after the switch, this script flips back to
# the previous one itself. Re-running is the upgrade path. State lives outside
# the releases: /var/lib/feedmill (db), /etc/feedmill (io.conf).
#
# Env: FORCE=1 skips the "batch/equipment running" refusal;
#      IGH_REF=<branch|tag|commit> overrides the IgH master version;
#      ASSUME_RT=install|skip answers the PREEMPT_RT kernel prompt unattended
#      (a first run on a non-RT kernel offers the RT kernel matching this
#      machine, installs it on request, then exits 10 — reboot and re-run).
#
# What this does NOT do (still genuinely hardware-specific, not automatable):
#   - vendor/product ID and PDO addressing are no longer hand-maintained
#     tables — the backend reads them live off the bus itself when you
#     click "Read Rack" in the HMI (the whole rack is ONE EtherCAT slave,
#     the coupler; "slot" is a card's position in the physical rack, used
#     to slice up that one slave's PDO list, not a separate bus position
#     per card). Just wire up each card, assign its rack position in the
#     HMI's I/O Config tab, and click Read Rack; no `ethercat` CLI by hand.
#   - the NX-RS1201 load cell calibration command/response handshake
#     (needs the real module on the bench — see scaleReader.ts)
#   - bench-test under real I/O load and a hard power-off
#   - snapshot/restore mill.db across a rollback (code rolls back, data doesn't)
set -euo pipefail

IGH_REF="${IGH_REF:-stable-1.6}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="/usr/local/src/ethercat-master"
ROOT_DIR="/opt/feedmill"
RELEASES_DIR="$ROOT_DIR/releases"
CURRENT="$ROOT_DIR/current"
PREVIOUS="$ROOT_DIR/previous"
KEEP_RELEASES=3
HMI_SRC_DIR="$(cd "$PROJECT_DIR/../hmi-prototype" 2>/dev/null && pwd || true)"
STATE_DIR="/var/lib/feedmill" # feedmill's $HOME: npm cache, hmi cache, data/
DATA_DIR="$STATE_DIR/data"
CONF_DIR="/etc/feedmill"
APP_USER="feedmill"

log() { echo ">> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# ---- PREEMPT_RT kernel: picked to match THIS machine, before anything is built --
# io_daemon runs a 4 ms SCHED_FIFO cycle; on a non-RT kernel a loaded box misses
# cycles and the bus goes unhealthy. The IgH modules are built against the
# RUNNING kernel, so if an RT kernel has to be installed the run stops here:
# reboot into it, then re-run the same command.
rt_running() { [[ "$(cat /sys/kernel/realtime 2>/dev/null)" == 1 ]] || uname -v | grep -q PREEMPT_RT; }

rt_choice() { # prints install|skip|abort; ASSUME_RT=install|skip answers it unattended
  local a="${ASSUME_RT:-}"
  if [[ -z "$a" ]]; then
    printf '%s' "$1 [i]nstall / [s]kip (continue without RT) / [a]bort: " >&2
    { read -r a </dev/tty; } 2>/dev/null || die "no terminal to ask on — re-run with ASSUME_RT=install or ASSUME_RT=skip"
  fi
  case "${a,,}" in i*) echo install ;; s*) echo skip ;; *) echo abort ;; esac
}

pin_rt_boot() { # make the RT kernel boot by default, now and after future kernel upgrades
  install -m 0755 -o root -g root "$PROJECT_DIR/install/pin-rt-kernel.sh" /usr/local/sbin/feedmill-pin-rt-kernel
  install -d -m 0755 /etc/kernel/postinst.d
  printf '#!/bin/sh\n/usr/local/sbin/feedmill-pin-rt-kernel || true\n' \
    | install -m 0755 -o root -g root /dev/stdin /etc/kernel/postinst.d/zzz-feedmill-rt # sorts after zz-update-grub
  /usr/local/sbin/feedmill-pin-rt-kernel || echo "WARNING: could not make the RT kernel the boot default — pick it in the boot menu or set it by hand" >&2
}

ensure_rt_kernel() {
  if rt_running; then log "PREEMPT_RT kernel running ($(uname -r))"; return; fi
  local arch model pkg image cand reason="" installed
  arch="$(dpkg --print-architecture)"
  # absent on x86; guard with -r because a failed `<` redirect prints its error before a trailing 2>/dev/null applies
  model=""; [[ -r /proc/device-tree/model ]] && model="$(tr -d '\0' </proc/device-tree/model)"
  log "running kernel $(uname -r) is NOT PREEMPT_RT (arch $arch${model:+, $model})"

  # an RT kernel from an earlier run that simply hasn't been booted yet
  installed="$(dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 'linux-image-*-rt-*' 2>/dev/null | awk '$1=="ii"{print $2; exit}' || true)"
  if [[ -n "$installed" ]]; then
    [[ "${ASSUME_RT:-}" == skip ]] && return
    pin_rt_boot
    echo "An RT kernel ($installed) is installed but not running. Reboot (it is now the boot default)," >&2
    echo "then re-run: sudo $0 $IFACE   (ASSUME_RT=skip continues without it)" >&2
    exit 10
  fi

  # NB: every lookup below ends in `|| true` — with set -e + pipefail an empty/failed query would abort the installer silently
  # which RT kernel fits this hardware?
  pkg="linux-image-rt-$arch"
  cand="$(apt-cache policy "$pkg" 2>/dev/null | awk '/Candidate:/{print $2}' || true)"
  case "$arch" in amd64 | arm64) ;; *) reason="Debian ships no RT kernel for $arch" ;; esac
  # Pi boards need the Raspberry Pi kernel flavour; the generic arm64 RT image may not boot there
  [[ -z "$reason" && "$model" == *"Raspberry Pi"* ]] && reason="$model needs a board-specific kernel; the generic $pkg may not boot on it"
  [[ -z "$reason" && ( -z "$cand" || "$cand" == "(none)" ) ]] && reason="$pkg is not available from the configured apt sources"

  if [[ -n "$reason" ]]; then
    echo "Cannot auto-select an RT kernel: $reason." >&2
    local go="${ASSUME_RT:-}"
    if [[ "$go" != skip ]]; then
      printf 'Continue on a non-RT kernel anyway? [y/N]: ' >&2
      { read -r go </dev/tty; } 2>/dev/null || die "no terminal to ask on — re-run with ASSUME_RT=skip to continue without RT"
      [[ "${go,,}" == y* ]] || die "aborted — install a PREEMPT_RT kernel by hand, reboot, and re-run"
    fi
    log "WARNING: continuing on a non-RT kernel — expect missed EtherCAT cycles under load"
    return
  fi

  image="$(apt-cache depends "$pkg" | awk '/Depends: linux-image-/{print $2; exit}' || true)"
  echo "Matched for this machine: $pkg -> ${image:-$pkg} ($cand), with linux-headers-rt-$arch." >&2
  echo "Installing a kernel needs a reboot; this installer will stop afterwards and must be re-run." >&2
  case "$(rt_choice "Install the PREEMPT_RT kernel now?")" in
    install)
      apt-get install -y -qq --no-install-recommends "$pkg" "linux-headers-rt-$arch" >/dev/null
      pin_rt_boot
      echo "RT kernel installed and set to boot by default. Reboot (afterwards uname -v shows PREEMPT_RT), then re-run: sudo $0 $IFACE" >&2
      exit 10 ;;
    skip) log "WARNING: continuing on a non-RT kernel — expect missed EtherCAT cycles under load" ;;
    *) die "aborted" ;;
  esac
}

# Lists the wired NICs and asks which one is on the EtherCAT bus. The pick is
# handed to the EtherCAT master, so it stops carrying normal network traffic —
# hence the extra confirmation for a NIC that has an address or the default route.
select_nic() { # prompts on stderr, prints the chosen NIC on stdout
  local cands=() d n i mac st drv ips def prev pick sel
  def="$(ip route show default 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="dev"){print $(i+1); exit}}' || true)"
  prev="$(sed -n 's/^IFACE=//p' /etc/feedmill-update/install.env 2>/dev/null | head -n1 || true)"
  for d in /sys/class/net/*; do
    [[ -e "$d/device" && ! -d "$d/wireless" ]] && cands+=("${d##*/}") # physical wired only: no lo/bridge/veth/vlan/wifi
  done
  [[ ${#cands[@]} -gt 0 ]] || die "no physical wired network interfaces found"
  echo "Wired network interfaces. The one you pick is handed to the EtherCAT master" >&2
  echo "and stops carrying normal network traffic:" >&2
  for i in "${!cands[@]}"; do
    n="${cands[$i]}"; d="/sys/class/net/$n"
    mac="$(<"$d/address")"; st="$(<"$d/operstate")"
    drv="$(basename "$(readlink -f "$d/device/driver" 2>/dev/null)")"
    ips="$(ip -4 -o addr show dev "$n" 2>/dev/null | awk '{print $4}' | paste -sd, - || true)"
    printf '  %d) %-10s %s  %-7s %-10s %s%s%s
' "$((i + 1))" "$n" "$mac" "$st" "$drv" "${ips:-no IPv4}"       "$([[ "$n" == "$def" ]] && echo '  <- default route')" "$([[ "$n" == "$prev" ]] && echo '  <- used by the last install')" >&2
  done
  [[ -r /dev/tty ]] || die "no terminal to ask on — pass the NIC name: $0 <nic>"
  while :; do
    printf 'Select NIC [1-%d or name]%s: ' "${#cands[@]}" "${prev:+ (Enter = $prev)}" >&2
    { read -r pick </dev/tty; } 2>/dev/null || die "no terminal to ask on — pass the NIC name: $0 <nic>"
    [[ -n "$pick" ]] || pick="$prev"
    sel=""
    for i in "${!cands[@]}"; do
      [[ "$pick" == "$((i + 1))" || "$pick" == "${cands[$i]}" ]] && sel="${cands[$i]}"
    done
    [[ -n "$sel" ]] && break
    echo "  not a listed interface" >&2
  done
  ips="$(ip -4 -o addr show dev "$sel" 2>/dev/null | awk '{print $4}' | paste -sd, - || true)"
  if [[ -n "$ips" || "$sel" == "$def" ]]; then
    echo "WARNING: $sel has ${ips:-the default route}${ips:+ ($ips)}. Giving it to EtherCAT removes it from normal networking —" >&2
    echo "if it is your only connection you will lose SSH/HMI access to this machine." >&2
    printf "Type 'yes' to use %s anyway: " "$sel" >&2
    { read -r pick </dev/tty; } 2>/dev/null || die "no terminal to ask on"
    [[ "$pick" == yes ]] || die "aborted — pick a NIC that is dedicated to the EtherCAT bus"
  fi
  echo "$sel"
}

[[ $(id -u) -eq 0 ]] || die "run as root (sudo $0 [ethercat-nic])"
IFACE="${1:-}"
[[ -n "$IFACE" ]] || IFACE="$(select_nic)" || exit 1
[[ -d "/sys/class/net/$IFACE" ]] || die "no such network interface: $IFACE"
MAC="$(cat "/sys/class/net/$IFACE/address")"

# ---- 1. OS packages ---------------------------------------------------
if [[ "${FEEDMILL_UPDATE:-0}" != 1 ]]; then # web updates run offline; packages came with the first install
  log "installing build dependencies"
  apt-get update -qq
  ensure_rt_kernel # may stop the run for a reboot; must precede the headers install below
  apt-get install -y -qq --no-install-recommends \
    build-essential autoconf automake libtool pkg-config git rsync nginx curl unzip openssl \
    "linux-headers-$(uname -r)" >/dev/null
fi
command -v node >/dev/null || die "node is not installed — install Node.js 22+ first, then re-run"
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node.js 22+ required (found $(node -v)) — better-sqlite3 needs it; reinstall with setup_22.x from deb.nodesource.com"

# Refuse before touching anything: switching releases restarts the control
# loop and real I/O. (Server not reachable = nothing running = fine.)
if [[ "${FORCE:-0}" != 1 ]] && STATE_JSON="$(curl -fsS -m 3 http://127.0.0.1:3001/api/v1/state 2>/dev/null)"; then
  node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.exit(s.activeBatch||(s.equipment||[]).some(e=>e.status==="running")?1:0)' <<<"$STATE_JSON" \
    || die "a batch is active or equipment is running — stop it first (or FORCE=1)"
fi

# ---- 2. IgH EtherCAT Master (generic driver — works on any NIC) -------
if command -v ethercat >/dev/null && [[ -f /usr/local/include/ecrt.h ]]; then
  log "IgH EtherCAT Master already installed, skipping build"
else
  log "building IgH EtherCAT Master ($IGH_REF, generic driver)"
  rm -rf "$BUILD_DIR"
  git clone --quiet --branch "$IGH_REF" https://gitlab.com/etherlab.org/ethercat.git "$BUILD_DIR"
  (
    cd "$BUILD_DIR"
    ./bootstrap
    ./configure --prefix=/usr/local --enable-generic --disable-8139too \
      --with-linux-dir="/lib/modules/$(uname -r)/build"
    make -j"$(nproc)" all modules
    make modules_install install
  )
  depmod -a
  ldconfig
fi

# ethercat.service loads the kernel modules that bring the master up.
# main_devices binds it to the NIC wired to the bus; this must match $IFACE
# every time the installer runs, so the unit is always (re)written.
install -m 0644 -o root -g root /dev/stdin /etc/systemd/system/ethercat.service <<EOF
[Unit]
Description=IgH EtherCAT Master
After=network-pre.target
Before=network.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/modprobe ec_master main_devices=$MAC
ExecStart=/sbin/modprobe ec_generic
ExecStop=/sbin/modprobe -r ec_generic
ExecStop=/sbin/modprobe -r ec_master

[Install]
WantedBy=multi-user.target
EOF

# ---- 3. user, directories, device permissions ----------------------------
# Who may write what:
#   /opt/feedmill, releases/*   root only — the running app can't edit its own code
#   /var/lib/feedmill (+data)   feedmill (0750) — db, npm cache, next cache
#   /etc/feedmill               feedmill (0750) — backend rewrites io.conf, daemon reads it
if id "$APP_USER" >/dev/null 2>&1; then
  usermod --home "$STATE_DIR" "$APP_USER" # older installs used the app dir as $HOME
else
  useradd --system --home "$STATE_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi
usermod -aG dialout "$APP_USER" # serial scalehead access (ScaleConfig connectionType 'serial')
install -d -o root -g root -m 0755 "$ROOT_DIR" "$RELEASES_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$STATE_DIR" "$DATA_DIR" "$STATE_DIR/hmi-cache" "$CONF_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR" "$CONF_DIR"

if [[ ! -f "$CONF_DIR/io.conf" ]]; then
  # Valid, empty placeholder — the daemon will exit/restart every couple of
  # seconds until the app writes real channels via syncIoConf(), which then
  # restarts this unit itself. Harmless, expected during first boot.
  printf '# placeholder until the app has a verified rack to generate channels from\ncycle_us 4000\n' \
    >"$CONF_DIR/io.conf"
  chown "$APP_USER:$APP_USER" "$CONF_DIR/io.conf"
  chmod 0640 "$CONF_DIR/io.conf"
fi

# The kernel module creates /dev/EtherCAT0 root-owned by default — without
# this, every `ethercat` CLI call the backend makes (as the unprivileged
# $APP_USER) fails with EACCES, and getMasterStatus() reports it as
# unreachable (surfaced in the HMI as "cannot reach the EtherCAT master").
getent group ethercat >/dev/null || groupadd --system ethercat
usermod -aG ethercat "$APP_USER"
install -m 0644 -o root -g root /dev/stdin /etc/udev/rules.d/99-feedmill-ethercat.rules <<'EOF'
KERNEL=="EtherCAT[0-9]*", GROUP="ethercat", MODE="0660"
EOF
udevadm control --reload-rules
udevadm trigger # re-applies the new rule to a device node from an earlier run too

# Web-update trust root. Root-only dir ON PURPOSE: /etc/feedmill is writable
# by $APP_USER, which could otherwise swap the signing key and push its own
# "signed" update. Holds the Ed25519 public key updates must verify against
# and the NIC name the update run hands back to this installer.
TRUST_DIR="/etc/feedmill-update"
install -d -o root -g root -m 0755 "$TRUST_DIR"
printf 'IFACE=%s\n' "$IFACE" | install -m 0644 -o root -g root /dev/stdin "$TRUST_DIR/install.env"
if [[ -f "$PROJECT_DIR/install/update-pubkey.pem" ]]; then
  install -m 0644 -o root -g root "$PROJECT_DIR/install/update-pubkey.pem" "$TRUST_DIR/pubkey.pem"
fi
[[ -f "$TRUST_DIR/pubkey.pem" ]] || log "NOTE: no install/update-pubkey.pem — web updates stay disabled until a signing key is installed"
# $APP_USER stages uploads here; root's update unit copies out before verifying
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$STATE_DIR/staging" "$STATE_DIR/backups"

# the backend must be able to restart the daemon after regenerating its
# config (ecrt can't hot-add PDO registrations to an active master), and to
# kick off the root-owned update/rollback units — fixed command lines only,
# so no argument can be smuggled in.
SUDOERS_TMP="$(mktemp)"
cat >"$SUDOERS_TMP" <<EOF
$APP_USER ALL=(root) NOPASSWD: /bin/systemctl restart feedmill-io-daemon.service, \\
  /bin/systemctl start --no-block feedmill-update.service, \\
  /bin/systemctl start --no-block feedmill-rollback.service
EOF
visudo -c -f "$SUDOERS_TMP" >/dev/null || { rm -f "$SUDOERS_TMP"; die "generated sudoers file is invalid"; }
install -m 0440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/feedmill
rm -f "$SUDOERS_TMP"

# ---- 4. build a new release (native deps must be built ON this box) -----
VERSION="$(node -p "require('$PROJECT_DIR/package.json').version")"
REL_ID="$VERSION-$(date +%Y%m%d%H%M%S)"
REL_DIR="$RELEASES_DIR/$REL_ID"
DEPLOYED=0
# a half-built or rolled-back release is never left lying around
trap '[[ "$DEPLOYED" == 1 ]] || rm -rf "$REL_DIR"' EXIT

log "building release $REL_ID"
# Builds run as $APP_USER (never root: npm lifecycle scripts execute), so the
# two build dirs are feedmill-owned until locked down at the end of this step.
install -d -m 0755 -o root -g root "$REL_DIR" "$REL_DIR/ethercat-rt"
install -d -m 0755 -o "$APP_USER" -g "$APP_USER" "$REL_DIR/app"

gcc -O2 -Wall -o "$REL_DIR/ethercat-rt/io-daemon" \
  "$PROJECT_DIR/ethercat-rt/io_daemon.c" -lethercat -lpthread -lrt
cp "$PROJECT_DIR/ethercat-rt/feedmill-io-daemon.service" "$REL_DIR/ethercat-rt/"

rsync -a --exclude node_modules --exclude dist --exclude data --exclude install \
  "$PROJECT_DIR"/ "$REL_DIR/app"/
chown -R "$APP_USER:$APP_USER" "$REL_DIR/app" # before npm runs as $APP_USER, not after
(
  cd "$REL_DIR/app"
  sudo -H -u "$APP_USER" npm ci --no-audit --no-fund
  sudo -H -u "$APP_USER" npm run build
  sudo -H -u "$APP_USER" npm prune --omit=dev --no-audit --no-fund
)

if [[ -n "$HMI_SRC_DIR" ]]; then
  install -d -m 0755 -o "$APP_USER" -g "$APP_USER" "$REL_DIR/hmi"
  rsync -a --exclude node_modules --exclude .next --exclude .git "$HMI_SRC_DIR"/ "$REL_DIR/hmi"/
  chown -R "$APP_USER:$APP_USER" "$REL_DIR/hmi"
  (
    cd "$REL_DIR/hmi"
    sudo -H -u "$APP_USER" npm ci --no-audit --no-fund
    sudo -H -u "$APP_USER" npm run build
    sudo -H -u "$APP_USER" npm prune --omit=dev --no-audit --no-fund
  )
  # `next start` writes its runtime cache under .next/cache; the release is
  # read-only, so point that at feedmill's own state dir.
  rm -rf "$REL_DIR/hmi/.next/cache"
  ln -s "$STATE_DIR/hmi-cache" "$REL_DIR/hmi/.next/cache"
else
  log "hmi-prototype not found as a sibling of this checkout — skipping HMI build"
fi

# Lock down: root owns the code, everyone else reads/executes only.
chown -R root:root "$REL_DIR"
chmod -R go-w,a+rX "$REL_DIR"

# ---- 5. units + nginx (written fresh every run; they only point at current/) --
install -m 0644 -o root -g root "$REL_DIR/ethercat-rt/feedmill-io-daemon.service" \
  /etc/systemd/system/feedmill-io-daemon.service

# Root-run web-update + rollback. Installed copies in /usr/local/sbin (root,
# 0755) are what the units run — never anything from an uploaded bundle.
install -m 0755 -o root -g root "$PROJECT_DIR/install/apply-update.sh" /usr/local/sbin/feedmill-apply-update
install -m 0755 -o root -g root "$PROJECT_DIR/install/rollback.sh" /usr/local/sbin/feedmill-rollback
install -m 0644 -o root -g root /dev/stdin /etc/systemd/system/feedmill-update.service <<EOF
[Unit]
Description=Feedmill signed web update (root)

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/feedmill-apply-update
TimeoutStartSec=1800
EOF
install -m 0644 -o root -g root /dev/stdin /etc/systemd/system/feedmill-rollback.service <<EOF
[Unit]
Description=Feedmill rollback to previous release (root)

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/feedmill-rollback
TimeoutStartSec=300
EOF

install -m 0644 -o root -g root /dev/stdin /etc/systemd/system/feedmill-backend.service <<EOF
[Unit]
Description=Feedmill backend
After=network.target ethercat.service
Wants=ethercat.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$CURRENT/app
Environment=NODE_ENV=production
Environment=MILL_DATA_DIR=$DATA_DIR
ExecStart=$NODE_BIN dist/server.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

if [[ -n "$HMI_SRC_DIR" ]]; then
  install -m 0644 -o root -g root /dev/stdin /etc/systemd/system/feedmill-hmi.service <<EOF
[Unit]
Description=Feedmill HMI (Next.js frontend)
After=network.target feedmill-backend.service
Wants=feedmill-backend.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$CURRENT/hmi
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=NEXT_TELEMETRY_DISABLED=1
ExecStart=$NODE_BIN node_modules/.bin/next start
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
fi

# nginx: the one externally-reachable port (80). The backend (127.0.0.1:3001)
# and HMI (127.0.0.1:3000) both bind loopback-only, by design.
log "configuring nginx on port 80"
rm -f /etc/nginx/sites-enabled/default
if [[ -n "$HMI_SRC_DIR" ]]; then
  ROOT_LOCATION='
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }'
else
  ROOT_LOCATION='
    location / {
        default_type text/plain;
        return 404 "feedmill backend only on this host -- no HMI deployed\n";
    }'
fi
install -m 0644 -o root -g root /dev/stdin /etc/nginx/conf.d/feedmill.conf <<EOF
server {
    listen 80 default_server;

    location /ws/hmi {
        proxy_pass http://127.0.0.1:3001/ws/hmi;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_read_timeout 3600s;
    }

    # signed update bundle upload (streamed to the backend, not buffered)
    location = /api/v1/update {
        client_max_body_size 512m;
        proxy_request_buffering off;
        proxy_read_timeout 600s;
        proxy_pass http://127.0.0.1:3001/api/v1/update;
        proxy_set_header Host \$host;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
$ROOT_LOCATION
}
EOF
nginx -t || die "generated nginx config is invalid"

# ---- 6. switch releases, verify, roll back on failure --------------------
point_current_at() { # atomic: a symlink is never missing or half-written
  ln -sfn "$1" "$ROOT_DIR/.current.tmp" && mv -T "$ROOT_DIR/.current.tmp" "$CURRENT"
}
restart_stack() {
  systemctl daemon-reload
  systemctl enable ethercat.service feedmill-io-daemon.service feedmill-backend.service >/dev/null
  systemctl start ethercat.service # no-op if already up; never restarted here (tears down the bus)
  systemctl restart feedmill-io-daemon.service feedmill-backend.service
  if [[ -n "$HMI_SRC_DIR" ]]; then
    systemctl enable feedmill-hmi.service >/dev/null
    systemctl restart feedmill-hmi.service
  fi
}
wait_healthy() { # up to ~60s for backend (and HMI, if deployed)
  local i
  for i in $(seq 1 30); do
    if curl -fsS -m 2 http://127.0.0.1:3001/api/v1/health >/dev/null 2>&1 &&
      { [[ -z "$HMI_SRC_DIR" ]] || curl -fsS -m 2 -o /dev/null http://127.0.0.1:3000/ 2>/dev/null; }; then
      return 0
    fi
    sleep 2
  done
  return 1
}

OLD_REL="$(readlink -f "$CURRENT" 2>/dev/null || true)"
log "switching to $REL_ID"
point_current_at "$REL_DIR"
restart_stack
if ! wait_healthy; then
  echo "ERROR: release $REL_ID did not become healthy" >&2
  if [[ -n "$OLD_REL" && -d "$OLD_REL" ]]; then
    echo ">> rolling back to $(basename "$OLD_REL")" >&2
    point_current_at "$OLD_REL"
    restart_stack
    wait_healthy || echo "WARNING: previous release is not healthy either — check journalctl" >&2
  fi
  echo "ERROR: deploy failed (see: journalctl -u feedmill-backend -u feedmill-hmi -u feedmill-io-daemon -n 100)" >&2
  exit 3 # 3 = got as far as switching, then reverted; apply-update uses it to restore the db snapshot
fi
DEPLOYED=1
if [[ -n "$OLD_REL" && -d "$OLD_REL" && "$OLD_REL" != "$REL_DIR" ]]; then
  ln -sfn "$OLD_REL" "$ROOT_DIR/.previous.tmp" && mv -T "$ROOT_DIR/.previous.tmp" "$PREVIOUS"
fi

# ---- 7. nginx, rollback tool, cleanup -------------------------------------
systemctl enable --now nginx
systemctl reload nginx # picks up the config even when nginx was already running from an earlier install

# keep the newest $KEEP_RELEASES, never delete current/previous
KEEP_REAL="$(readlink -f "$CURRENT") $(readlink -f "$PREVIOUS" 2>/dev/null || true)"
for d in $(ls -1dt "$RELEASES_DIR"/*/ | tail -n +"$((KEEP_RELEASES + 1))"); do
  d="${d%/}"
  [[ " $KEEP_REAL " == *" $d "* ]] || { log "removing old release $(basename "$d")"; rm -rf "$d"; }
done
# pre-releases layout (healthy new release is up, so the old copies are dead weight)
rm -rf "$ROOT_DIR/app" "$ROOT_DIR/hmi" "$ROOT_DIR/ethercat-rt"

cat <<EOF

Done: release $REL_ID is live. Roll back to the previous release with:
  sudo feedmill-rollback        (code only — mill.db is NOT restored)

Still required before trusting ANY real I/O point:
  1. In the HMI's I/O Config tab: add each card with its physical rack
     position (slot), map equipment ports to signals (including
     rotationPulseInput where applicable), then click "Read Rack" — this
     reads the coupler's product ID and PDO entries live off the bus
     (the whole rack is one EtherCAT slave) and regenerates/restarts the
     io-daemon. No ethercat CLI by hand.
  2. If Read Rack reports a card "ok" but its signals still don't show up
     as channels in /etc/feedmill/io.conf, the ethercat CLI output on this
     IgH version doesn't match what getSlaveProductId()/getRackPdoEntries()
     in src/ethercat.ts expect — compare their regexes against the actual
     output of \`ethercat slaves -p 0 -v\` / \`ethercat pdos -p 0\`.
  3. Bench-test each point — inputs, outputs, and a hard power-off —
     before relying on it.
  4. For an NX-RS1201 scale: the calibration handshake isn't implemented
     yet (see scaleReader.ts) — only the raw weight PDO read is wired up.

Open the HMI from any device on the network at http://<this-box-ip>/ —
nginx on port 80 is the only externally-reachable door; the backend
(127.0.0.1:3001) and the HMI's own Next.js process (127.0.0.1:3000) are
both loopback-only and unreachable directly, by design.

Check status with:
  systemctl status ethercat.service feedmill-io-daemon.service feedmill-backend.service feedmill-hmi.service nginx
  journalctl -u feedmill-backend -u feedmill-io-daemon -u feedmill-hmi -f
EOF
