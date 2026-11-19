# 21 - Development to-do list

Status: working backlog, 2026-11-09. Unchecked items are not implemented or finalized. Confirmed requirements remain in the process specifications; this file sets development order.

## High priority - finish control definitions

- [ ] Implement configurable fault and auger/elevator start/stop delays with global mill rotation-startup delay.
- [ ] Define and implement individual auxiliary, rotation and gate/valve limit overrides, degraded-feedback display and audit history; settle authorization, reset, removal and reboot policy.

- [ ] Finalize common motor contract: required run output/auxiliary input, optional pulse sensor, pulses/revolution, minimum RPM, startup/evaluation delays and transitive upstream fault-stop scope.
- [ ] Verify pulse acquisition hardware can capture required rates; define RPM validity, missing-pulse and counter rollover behavior.

- [ ] Define pause/stop/resume for every batch phase: bin augers, stuffer, micro feeders/drag, mixer, unload augers, elevator and gates. Preserve material ownership through partial discharge.
- [ ] Finalize main dosing: ingredient ordering, cutoff/coast, stuffer clearing, stable-weight acceptance, tolerance and top-off rules.
- [ ] Finalize mixer motor behavior during loading/unloading and credited recipe mixing time after pauses.
- [ ] Finalize micro preparation/transfer coordination, drag empty verification, two-system arbitration and transfer reconciliation.
- [ ] Finalize per-destination unload configuration: gate limits, downstream-first motor order, start verification, mixer outlet action, empty/clear evidence and shutdown order.
- [ ] Define typed installation schema and validation for enabled assets, physical routes, I/O ownership and per-phase policies; retain 0-2 configurable micro systems.
- [ ] Define fault scope, stale-data handling, command expiry and power-loss reconciliation contracts.

## Medium priority - simulator and operating workflows

- [x] ~~Implement simulated I/O and scales with deterministic batch, micro and unload sequences.~~ Built (the `/ws/simulator` WebSocket + `IOSource` toggle), then deliberately removed from `feedmill-backend` per project decision: this is now a production/real-I/O-only branch (real EtherCAT I/O via `ethercat-rt/io_daemon.c`, real scale readers via `src/scaleReader.ts`). Re-add a simulated layer only on a separate frontend-dev branch, not here.
- [ ] Verify reservation conflicts, pause at each substep, invalid scales, gate failure and interrupted inventory commits.
- [ ] Implement idempotent ingredient consumption and destination receipt; avoid double-counting micro transfers.
- [ ] Finalize ordinary hammer refill: configurable source/destination routes, low/high hysteresis, priority, startup/stop and automatic-disable behavior.
- [x] Build initial six-tab industrial HMI prototype with simulated local data (hmi-prototype).
- [ ] Connect HMI to authoritative revisioned backend state and validated commands; implement full topology/route configuration, scheduler policy and permissions per 24.
- [ ] Complete production recovery workflows and current/VFD device editing.
- [ ] Complete hardware survey: scale protocols, NX modules/channel map, analog signal types, watchdog and storage.
- [ ] Define commissioning cases and required evidence for each enabled route and failure policy.

## Low priority - hammermill load and infeed regulation

- [ ] Implement amperage monitoring with configured analog scaling, validity/freshness and HMI status.
- [ ] Add per-hammermill high-current infeed-pause setpoint; pause the selected infeed auger without conflating it with whole-batch pause or whole-mill shutdown.
- [ ] Decide threshold equality/persistence, startup grace, hysteresis, resume dwell, automatic/manual resume and maximum load-pause duration.
- [ ] Define fault/invalid-current behavior and precedence of high level, stop, faults and automatic disable over load resume.
- [ ] Support optional analog VFD speed output per infeed auger: channel/range, speed units, command bounds, normal set speed and separate run control. Retain fixed-speed support.
- [ ] Define speed output/run behavior during pause, shutdown, communication loss and startup.
- [ ] Simulate high-current holds and high-level arrival during a hold; verify no unintended restart and correct fixed-speed/VFD variants.
- [ ] Commission current measurement, pause threshold and VFD output against actual equipment before enabling dependent production configurations.

Continuous current-based speed modulation is not a confirmed feature; optional VFD speed setting alone does not add a closed-loop regulator.
