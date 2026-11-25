#!/usr/bin/env bash
#
# Reverses install.sh: removes everything it put on the Debian box.
#   sudo ./install/uninstall.sh
#
# DELETES /var/lib/feedmill (the batch database) and /etc/feedmill (io.conf).
# Leaves apt packages (build-essential, nginx, node, ...) installed; nginx is
# just stopped from serving the feedmill site and its default site is NOT
# restored.
set -uo pipefail
[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }

echo ">> stopping + disabling services"
for u in feedmill-hmi feedmill-backend feedmill-io-daemon ethercat; do
  systemctl disable --now "$u.service" 2>/dev/null
  rm -f "/etc/systemd/system/$u.service"
done
systemctl daemon-reload

echo ">> removing nginx site, sudoers, udev rule"
rm -f /etc/nginx/conf.d/feedmill.conf /etc/sudoers.d/feedmill /etc/udev/rules.d/99-feedmill-ethercat.rules
nginx -t 2>/dev/null && systemctl reload nginx
udevadm control --reload-rules

echo ">> removing app, data, config"
rm -rf /opt/feedmill /var/lib/feedmill /etc/feedmill
rm -f /usr/local/sbin/feedmill-rollback
rm -f /usr/local/sbin/feedmill-apply-update /usr/local/sbin/feedmill-pin-rt-kernel /etc/kernel/postinst.d/zzz-feedmill-rt
rm -rf /etc/feedmill-update /var/lib/feedmill-update
if [[ -f /etc/default/grub.d/90-feedmill-rt.cfg ]]; then # RT kernel stays installed, just no longer forced as default
  rm -f /etc/default/grub.d/90-feedmill-rt.cfg
  command -v update-grub >/dev/null && update-grub >/dev/null 2>&1
fi

echo ">> removing user + group"
userdel feedmill 2>/dev/null
groupdel ethercat 2>/dev/null

echo ">> removing IgH EtherCAT master (modules, libs, headers, CLI)"
modprobe -r ec_generic ec_master 2>/dev/null
if [[ -d /usr/local/src/ethercat-master ]]; then
  (cd /usr/local/src/ethercat-master && make uninstall 2>/dev/null)
fi
rm -rf /usr/local/src/ethercat-master
rm -f /usr/local/bin/ethercat /usr/local/include/ecrt.h /usr/local/lib/libethercat* \
      /usr/local/sbin/ethercatctl /etc/sysconfig/ethercat
rm -rf /lib/modules/"$(uname -r)"/ethercat /usr/local/etc/ethercat.conf
depmod -a
ldconfig

echo "Done. Reboot recommended to clear any leftover module/NIC state."
