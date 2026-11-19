# 13 — Database, Abrupt Power Loss and Restart

## Goal

Permit normal mill shutdown by cutting cabinet power without requiring an OS shutdown, while preserving validated configuration, recipes, completed transactions and consistent recovery metadata.

## Storage design (PROPOSED)

- Debian minimal with read-only root/immutable system partitions; temporary files/log buffers in RAM where practical.
- Separately writable database/data partition on industrial SSD, preferably real **power-loss-protected** storage (verify exact part and PLP option).
- SQLite with WAL journaling and `synchronous=FULL` for database integrity, assuming storage/OS honor flushes. Maintain backup/checkpoint/recovery policy and retention.
- Do not claim every just-issued operation survives power loss: only **confirmed durable commits** are guaranteed by design, contingent on storage integrity.
- Keep A/B update or known-good image rollback; disable unattended disruptive upgrades/reboots while batching.
- **Current implementation**: `mill.db` is `better-sqlite3`, WAL + `synchronous=FULL`, as above. Every other on-disk state file (`config.json`, the io_daemon's generated `/etc/feedmill/io.conf`, the io_daemon's own `/run/feedmill/io-command.txt`, and the updater's downloaded zip + `last-update.json` marker) is written tmp-file-then-rename, so a hard power-off never leaves any of them half-written. Target disk is a consumer NVMe SSD, not confirmed power-loss-protected; a UPS with automatic clean shutdown is planned but **not yet implemented** — until it is, treat the above atomic-write/WAL discipline as the only power-loss protection in place.

## Recorded critical transitions

- Installation revision activated.
- Batch request accepted/start; ingredient source and scale baseline; ingredient actual finalized; mixer start/stop; chosen destination; discharge confirmed; batch completion.
- Inventory ledger postings, linked idempotency keys.
- Faults, operator authorization/override and restart transitions.

The control engine must avoid blocking time-critical cycles on disk; use carefully bounded durable event commit gates where continued execution depends on the previous transition being safely recorded.

## Restart sequence

`POWER RESTORED -> BIOS AUTO POWER ON -> BOOT -> OUTPUTS INHIBITED -> LOAD+VERIFY DB/CONFIG -> INITIALIZE I/O+SCALES -> RECONCILE PHYSICAL STATE -> IDLE or RECOVERY_REQUIRED`.

- No automatic resumption of motors, feed gates or augers merely because power returned.
- Confirm scale weight, gate limits, machine readiness, product/route ownership, bin contents, emergency stop and feedback.
- Operator/supervisor chooses documented resume, scrap, discharge, correction or abort workflow after reviewing discrepancies.
- Restart while database recovery is in progress must be safe; repeated power cuts during boot must be tested.

## Hardware requirements to confirm

Actual industrial PC: DC-voltage operating range, automatic power-on-after-loss BIOS behavior, independent hardware watchdog chip + Debian driver, recovery from brownout, approved storage, power supply behavior. If onboard watchdog has no usable Linux driver, assess an **independent hardware reset supervisor** rather than relying on software alone.
