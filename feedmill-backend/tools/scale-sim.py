#!/usr/bin/env python3
"""Fake continuous-output serial scalehead for the Linux host (stdlib only, no hardware).

  python3 scale-sim.py [--link /tmp/ttyScale] [--rate 10] [--format "ST,GS,{w:+09.1f} lb"] [--eol crlf|lf|cr]

Creates a pseudo-terminal and symlinks it at --link. In the HMI scale config set
Connection = Serial, Serial Port = /tmp/ttyScale (baud/parity are ignored by a pty).

On a host running the installed backend, run it as the backend's user, `feedmill`. Only that user can then open the
port and follow the /tmp link; run as yourself, the scale faults with "Permission denied". From this folder:

  sudo rm -f /tmp/ttyScale        # a link left by another user cannot be replaced
  install -m 644 scale-sim.py /tmp/scale-sim.py && sudo -u feedmill python3 /tmp/scale-sim.py

Type commands in this terminal:
  <number> | set <n>   set weight          +<n> / -<n>   add / subtract
  noise <n>            +-n random jitter (makes the scale read unstable; 0 = off)
  pause / resume       stop / restart output (exercises the freshness timeout)
  garbage              send one junk line      help      quit
"""
import argparse, os, pty, random, select, sys, time

EOL = {'crlf': '\r\n', 'lf': '\n', 'cr': '\r'}


def main():
    a = argparse.ArgumentParser()
    a.add_argument('--link', default='/tmp/ttyScale')
    a.add_argument('--rate', type=float, default=10.0, help='lines per second')
    a.add_argument('--format', default='ST,GS,{w:+09.1f} lb')
    a.add_argument('--eol', choices=EOL, default='crlf')
    a.add_argument('--weight', type=float, default=0.0)
    args = a.parse_args()

    master, slave = pty.openpty()  # keep `slave` open ourselves so writes never EIO when the backend disconnects
    os.set_blocking(master, False)
    if os.path.lexists(args.link):
        os.remove(args.link)
    os.symlink(os.ttyname(slave), args.link)
    print(f'serial scale on {args.link} -> {os.ttyname(slave)}   ("help" for commands)')
    print('"Permission denied" in the HMI? Run this as the backend\'s user: sudo -u feedmill (see "help")')

    weight, noise, paused = args.weight, 0.0, False
    next_tx = 0.0
    try:
        while True:
            now = time.monotonic()
            if select.select([sys.stdin], [], [], max(0, next_tx - now))[0]:
                line = sys.stdin.readline()
                if not line:
                    break
                cmd = line.strip().lower()
                try:
                    if cmd in ('q', 'quit', 'exit'): break
                    elif cmd == 'pause': paused = True
                    elif cmd == 'resume': paused = False
                    elif cmd == 'garbage': os.write(master, ('#### ERR ####' + EOL[args.eol]).encode())
                    elif cmd in ('', 'help', '?'): print(__doc__)
                    elif cmd.startswith('noise'): noise = abs(float(cmd.split()[1]))
                    elif cmd[0] in '+-' and len(cmd) > 1: weight += float(cmd)
                    else: weight = float(cmd.split()[-1])
                except (ValueError, IndexError):
                    print('?  (type help)')
                print(f'weight={weight:.2f} noise={noise} {"PAUSED" if paused else ""}')
            if time.monotonic() >= next_tx:
                next_tx = time.monotonic() + 1 / args.rate
                if not paused:
                    w = weight + random.uniform(-noise, noise)
                    try: os.write(master, (args.format.format(w=w) + EOL[args.eol]).encode('ascii'))
                    except BlockingIOError: pass  # nobody reading yet; drop the line like a real head would
                try: os.read(master, 4096)  # discard anything the backend sends us
                except (BlockingIOError, OSError): pass
    finally:
        if os.path.islink(args.link): os.remove(args.link)


if __name__ == '__main__':
    main()
