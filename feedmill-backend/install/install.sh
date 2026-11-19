#!/usr/bin/env bash
#
# One-shot installer for the feedmill backend + EtherCAT I/O daemon + HMI
# frontend stack on a Debian 13 target. Run once as root, from this
# project's checkout (the monorepo root, so hmi-prototype/ is a sibling of
# feedmill-backend/), after it's been copied onto the real machine:
#
#   sudo ./install/install.sh <ethercat-nic>
#
# <ethercat-nic> is the network interface wired to the EtherCAT bus (e.g.
# eth1) — it can't be auto-detected, since a machine may have several NICs
# and only one is on the bus. Re-running is safe: every step checks what's
# already done before doing it.
#
# What this does NOT do (still genuinely hardware-specific, not automatable):
#   - vendor/product IDs and PDO addressing are no longer hand-maintained
#     tables — the backend reads them live off the bus itself when you
#     click "Read Rack" in the HMI. Just wire up each card, assign its
#     slot (the real EtherCAT bus position) in the HMI's I/O Config tab,
#     and click Read Rack; no `ethercat` CLI commands needed by hand.
#   - the NX-RS1201 load cell calibration command/response handshake
#     (needs the real module on the bench — see scaleReader.ts)
#   - bench-test under real I/O load and a hard power-off
set -euo pipefail

IGH_REF="${IGH_REF:-stable-1.6}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="/usr/local/src/ethercat-master"
APP_DIR="/opt/feedmill/app"
HMI_DIR="/opt/feedmill/hmi"
HMI_SRC_DIR="$(cd "$PROJECT_DIR/../hmi-prototype" 2>/dev/null && pwd || true)"
DATA_DIR="/var/lib/feedmill/data"
CONF_DIR="/etc/feedmill"
APP_USER="feedmill"

log() { echo ">> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[[ $(id -u) -eq 0 ]] || die "run as root (sudo $0 <ethercat-nic>)"
IFACE="${1:-}"
[[ -n "$IFACE" ]] || die "usage: $0 <ethercat-nic>   (e.g. $0 eth1)"
[[ -d "/sys/class/net/$IFACE" ]] || die "no such network interface: $IFACE"
MAC="$(cat "/sys/class/net/$IFACE/address")"

# ---- 1. OS packages ---------------------------------------------------
log "installing build dependencies"
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  build-essential autoconf automake libtool pkg-config git rsync nginx \
  "linux-headers-$(uname -r)" >/dev/null
command -v node >/dev/null || die "node is not installed — install Node.js 22+ first, then re-run"
NODE_BIN="$(command -v node)"
NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node.js 22+ required (found $(node -v)) — better-sqlite3 needs it; reinstall with setup_22.x from deb.nodesource.com"

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
cat >/etc/systemd/system/ethercat.service <<EOF
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

# ---- 3. io_daemon --------------------------------------------------------
log "building io-daemon"
mkdir -p /opt/feedmill/ethercat-rt
gcc -O2 -Wall -o /opt/feedmill/ethercat-rt/io-daemon \
  "$PROJECT_DIR/ethercat-rt/io_daemon.c" -lethercat -lpthread -lrt
cp "$PROJECT_DIR/ethercat-rt/feedmill-io-daemon.service" \
  /etc/systemd/system/feedmill-io-daemon.service

mkdir -p "$CONF_DIR"
if [[ ! -f "$CONF_DIR/io.conf" ]]; then
  # Valid, empty placeholder — the daemon will exit/restart every couple of
  # seconds until the app writes real channels via syncIoConf(), which then
  # restarts this unit itself. Harmless, expected during first boot.
  printf '# placeholder until the app has a verified rack to generate channels from\ncycle_us 4000\n' \
    >"$CONF_DIR/io.conf"
fi

# ---- 4. app user + directories -----------------------------------------
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR" "$CONF_DIR"
usermod -aG dialout "$APP_USER" # serial scalehead access (ScaleConfig connectionType 'serial')

# The kernel module creates /dev/EtherCAT0 root-owned by default — without
# this, every `ethercat` CLI call the backend makes (as the unprivileged
# $APP_USER) fails with EACCES, and getMasterStatus() reports it as
# unreachable (surfaced in the HMI as "cannot reach the EtherCAT master").
getent group ethercat >/dev/null || groupadd --system ethercat
usermod -aG ethercat "$APP_USER"
cat >/etc/udev/rules.d/99-feedmill-ethercat.rules <<'EOF'
KERNEL=="EtherCAT[0-9]*", GROUP="ethercat", MODE="0660"
EOF
udevadm control --reload-rules
udevadm trigger # re-applies the new rule to a device node from an earlier run too

# the backend must be able to restart the daemon after regenerating its
# config (ecrt can't hot-add PDO registrations to an active master)
cat >/etc/sudoers.d/feedmill <<EOF
$APP_USER ALL=(root) NOPASSWD: /bin/systemctl restart feedmill-io-daemon.service
EOF
chmod 0440 /etc/sudoers.d/feedmill
visudo -c -f /etc/sudoers.d/feedmill >/dev/null || die "generated sudoers file is invalid"

# ---- 5. deploy + build the app (native deps must be built ON this box) -
log "deploying app to $APP_DIR"
rsync -a --delete \
  --exclude node_modules --exclude dist --exclude data --exclude install \
  "$PROJECT_DIR"/ "$APP_DIR"/
chown -R "$APP_USER:$APP_USER" "$APP_DIR" # must happen before npm runs as $APP_USER below, not after
(
  cd "$APP_DIR"
  sudo -u "$APP_USER" npm ci --no-audit --no-fund
  sudo -u "$APP_USER" npm run build
  sudo -u "$APP_USER" npm prune --omit=dev --no-audit --no-fund
)

cat >/etc/systemd/system/feedmill-backend.service <<EOF
[Unit]
Description=Feedmill backend
After=network.target ethercat.service
Wants=ethercat.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=MILL_DATA_DIR=$DATA_DIR
ExecStart=$NODE_BIN dist/server.js
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

# ---- 6. deploy + build the HMI frontend (sibling checkout in the monorepo) --
if [[ -n "$HMI_SRC_DIR" ]]; then
  log "deploying HMI to $HMI_DIR"
  rsync -a --delete --exclude node_modules --exclude .next \
    "$HMI_SRC_DIR"/ "$HMI_DIR"/
  chown -R "$APP_USER:$APP_USER" "$HMI_DIR" # before npm runs as $APP_USER, same reason as the backend above
  (
    cd "$HMI_DIR"
    sudo -u "$APP_USER" npm ci --no-audit --no-fund
    sudo -u "$APP_USER" npm run build
    sudo -u "$APP_USER" npm prune --omit=dev --no-audit --no-fund
  )

  cat >/etc/systemd/system/feedmill-hmi.service <<EOF
[Unit]
Description=Feedmill HMI (Next.js frontend)
After=network.target feedmill-backend.service
Wants=feedmill-backend.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$HMI_DIR
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=$NODE_BIN node_modules/.bin/next start
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
else
  log "hmi-prototype not found as a sibling of this checkout — skipping HMI deploy"
fi

# ---- 7. nginx: the one externally-reachable port (80) --------------------
# The backend (127.0.0.1:3001) and HMI (127.0.0.1:3000) both bind loopback-
# only, by design — nothing but nginx is meant to reach them. This is what
# makes the HMI reachable from other devices on the network while keeping
# the backend port closed to it.
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
cat >/etc/nginx/conf.d/feedmill.conf <<EOF
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

    location /api/ {
        proxy_pass http://127.0.0.1:3001/api/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
$ROOT_LOCATION
}
EOF
nginx -t || die "generated nginx config is invalid"

# ---- 8. enable + (re)start everything -----------------------------------
# `enable --now` only STARTS a unit that isn't running yet — it won't pick
# up a rebuilt binary or changed code on a re-run. feedmill-io-daemon and
# feedmill-backend both get rebuilt from source every run (steps 3 and 5),
# so they're explicitly restarted below, not just enabled. That's a brief,
# deliberate interruption to real I/O and the control loop — don't re-run
# this installer while a batch is actively running real outputs.
# ethercat.service (the kernel modules) is left as enable-only: reloading
# it tears down the whole EtherCAT bus, which is more disruptive and only
# actually needed if the NIC/MAC changed — do that by hand if so.
log "enabling and starting services"
systemctl daemon-reload
systemctl enable --now ethercat.service
systemctl enable feedmill-io-daemon.service
systemctl restart feedmill-io-daemon.service
systemctl enable feedmill-backend.service
systemctl restart feedmill-backend.service
if [[ -n "$HMI_SRC_DIR" ]]; then
  systemctl enable feedmill-hmi.service
  systemctl restart feedmill-hmi.service
fi
systemctl enable --now nginx
systemctl reload nginx # picks up the config even when nginx was already running from an earlier install

cat <<EOF

Done. Still required before trusting ANY real I/O point:
  1. In the HMI's I/O Config tab: add each card with its real slot (the
     EtherCAT bus position), map equipment ports to signals (including
     rotationPulseInput where applicable), then click "Read Rack" — this
     reads vendor/product IDs and PDO addresses live off the bus itself
     and regenerates/restarts the io-daemon. No ethercat CLI by hand.
  2. If Read Rack reports a card "ok" but its signals still don't show up
     as channels in /etc/feedmill/io.conf, the ethercat CLI output on this
     IgH version doesn't match what getSlaveProductId()/getSlavePdoEntries()
     in src/ethercat.ts expect — compare their regexes against the actual
     output of \`ethercat slaves -p <pos> -v\` / \`ethercat pdos -p <pos>\`.
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
