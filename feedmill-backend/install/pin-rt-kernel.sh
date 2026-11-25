#!/usr/bin/env bash
#
# Make the newest PREEMPT_RT kernel the GRUB default so the box boots it
# unattended. Installed by install.sh as /usr/local/sbin/feedmill-pin-rt-kernel
# and re-run by /etc/kernel/postinst.d/zzz-feedmill-rt after every kernel
# install, so a newer RT kernel (new ABI) is picked up too and a newer
# non-RT kernel can never take over the default.
#
# Exit: 0 pinned (or already), 2 GRUB isn't the bootloader here, 3 no RT entry.
# Debian's sort order between "-rt-" and plain kernels isn't something to rely
# on, so this pins the exact menu entry id instead.
set -euo pipefail

CFG=/boot/grub/grub.cfg
DROPIN=/etc/default/grub.d/90-feedmill-rt.cfg

[[ $(id -u) -eq 0 ]] || { echo "run as root" >&2; exit 1; }
command -v update-grub >/dev/null && [[ -f "$CFG" ]] || { echo "GRUB is not the bootloader here — set the RT kernel as default by hand" >&2; exit 2; }

find_entry() { # newest non-recovery -rt- entry id in the generated menu
  grep -oE "gnulinux-[^' ]*-rt-[^' ]*-advanced-[0-9a-fA-F-]+" "$CFG" | sort -uV | tail -n1 || true
}
ENT="$(find_entry)"
if [[ -z "$ENT" ]]; then update-grub >/dev/null 2>&1 || true; ENT="$(find_entry)"; fi
[[ -n "$ENT" ]] || { echo "no PREEMPT_RT kernel entry in $CFG" >&2; exit 3; }

# entries live in the "Advanced options" submenu unless GRUB_DISABLE_SUBMENU is set
SUB="$(grep -oE "gnulinux-advanced-[0-9a-fA-F-]+" "$CFG" | head -n1 || true)"
WANT="${SUB:+$SUB>}$ENT"

if [[ -f "$DROPIN" ]] && grep -qxF "GRUB_DEFAULT=\"$WANT\"" "$DROPIN"; then
  echo "RT kernel already the boot default ($ENT)"; exit 0
fi
install -d -m 0755 /etc/default/grub.d
printf '# managed by the feedmill installer: boot the PREEMPT_RT kernel\nGRUB_DEFAULT="%s"\n' "$WANT" >"$DROPIN"
update-grub
echo "RT kernel set as boot default ($ENT)"
