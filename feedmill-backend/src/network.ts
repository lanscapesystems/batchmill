import os from 'os';
import fs from 'fs';

// Interfaces backed by real hardware; everything else (bridges, veth, tun/tap,
// docker, wireguard, loopback) is excluded even if the sysfs check below can't run.
const VIRTUAL_PREFIXES = ['lo', 'docker', 'veth', 'br-', 'virbr', 'tun', 'tap', 'wg', 'vmnet', 'vboxnet'];

// shortcut: the /sys/class/net/<name>/device check (Linux-only — a physical NIC has
// this symlink, a virtual one doesn't) is the real filter; off-Linux dev machines fall
// back to the prefix list above, so upgrade this if NIC selection ships on non-Linux.
export function listCandidateNics(): string[] {
  const ifaces = os.networkInterfaces();
  const hasSysfs = fs.existsSync('/sys/class/net');
  return Object.keys(ifaces)
    .filter(name => {
      const addrs = ifaces[name];
      if (!addrs?.length || addrs[0].internal) return false;
      if (VIRTUAL_PREFIXES.some(p => name.toLowerCase().startsWith(p))) return false;
      if (!hasSysfs) return true;
      const base = `/sys/class/net/${name}`;
      // EtherCAT needs a wired NIC; exclude Wi-Fi (old wext and modern cfg80211 both expose one of these).
      if (fs.existsSync(`${base}/wireless`) || fs.existsSync(`${base}/phy80211`)) return false;
      return fs.existsSync(`${base}/device`);
    })
    .sort();
}
