# 03 — Equipment Model and I/O Adapters

## Function

Translate physical Omron I/O into validated logical signals; translate equipment requests into controlled outputs. No application component other than output arbitration may own writes to a physical output.

## Equipment types

- `Motor`: required run output and starter auxiliary feedback input; optional pulse rotation input with configurable pulses/revolution and minimum-RPM fault; start/stop timeout, manual permit and min-off time. See [motor contract](22_MOTOR_FEEDBACK_AND_SPEED_FAULTS.md).
- `Auger`: motor plus material-source/destination assignment, coarse/fine control modes if installed, anti-bridging policy if fitted.
- `Conveyor` / `Drag`: motor, downstream path prerequisites, run-on/cleanout interval.
- `Gate`: actuator type (single solenoid spring return or open/close outputs), open/closed limit inputs, feedback timeout, fault state.
- `Diverter`: enumerated positions, actuator and feedback, permitted switching conditions.
- `Mixer`: drive, run confirmation, discharge equipment, weigh vessel and process state.
- `Scale`: validated readings from a serial indicator or NX-RS1201 load cell module, not a generic uncontrolled analog input.
- `StorageBin`: ingredient/destination, limits and routes; may have level switch inputs.
- `HammerMill`: mill motor, feeder, optional ancillary motors, permissives, routes.

## Three-stage mapping

`Physical address` (`EIP-01 / slot / channel`) → `Logical signal` (`MX01_RUN_FB`) → `Equipment port` (`MX-01.running_feedback`).

Illustrative I/O names (physical addresses TBD):

| Signal | Type | Intended use |
|---|---|---|
| `MX01_RUN_CMD` | DO | Mixer motor request |
| `MX01_RUN_FB` | DI | Mixer motor running |
| `MX01_DRIVE_FAULT` | DI | Mixer motor drive fault |
| `MX01_GATE_OPEN_CMD`, `MX01_GATE_CLOSE_CMD` | DO (if dual actuator) | Mixer gate control |
| `MX01_GATE_OPEN_FB`, `MX01_GATE_CLOSED_FB` | DI | Gate limit status |
| `HM01_RUN_CMD`, `HM01_FEED_CMD` | DO | Hammer mill / feed motor requests |
| `HM01_RUN_FB`, `HM01_FAULT` | DI | Mill diagnostics |
| `IBxx_LEVEL_LOW`, `IBxx_LEVEL_FULL` | DI (optional) | Fill request / stop input |
| `FBxx_LEVEL_FULL` | DI (optional) | Destination fullness guard |
| `AGxx_RUN_CMD`, `AGxx_RUN_FB` | DO, DI | Generic auger |

**I/O count must be calculated from final equipment survey**, not a bin count multiplied by assumed points. EIP unit model, slot order, assembly sizes, electrical ratings, and fault actions TBD.

## Driver requirements

**Current production path: NX-ECC (EtherCAT).** Per project decision, EtherCAT is the only supported fieldbus for now; the EtherNet/IP path below (`NX-EIC202`) is a **deferred future feature**, not bench-verified, not wired into `feedmill-backend`.

- Debian runs a Linux EtherCAT master: **IgH EtherCAT Master** (`ethercat-rt/` + `feedmill-backend/install/install.sh` build it from source with the generic driver, so no NIC-specific kernel patch is required). Driver/version and DKMS compatibility with the installed kernel are still bench-verified per target, same discipline as any other field-commissioned driver.
- **Port selection is a commissioning field, not an assumption.** The EtherCAT master binds to one dedicated Debian NIC, named by stable interface name or MAC address (the IgH master's `main_devices` modprobe parameter, written into `ethercat.service` by the installer), never "whichever interface comes up first." That NIC must be excluded from NetworkManager/general LAN control.
- The rotary-switch node address (1–199) identifies the slave position on the EtherCAT segment; it is unrelated to, and does not select, the Debian-side NIC.
- Record the exact NIC bound to the master, the master driver/version, and the EtherCAT segment's slave order alongside the usual rack layout.
- Cyclic exchange of every digital/analog I/O point (and rotation-sensor edge counting, and NX-RS1201 weight) is done by a separate realtime C program, `ethercat-rt/io_daemon.c`, run as its own systemd service (`feedmill-io-daemon.service`) — the Node control process's 100ms scan cannot touch the EtherCAT process image directly. The daemon's channel config (`/etc/feedmill/io.conf`) is generated from the rack + I/O mapping by `syncIoConf()`/`generateIoConf()` in `src/ethercat.ts`; it force-zeros every output if the Node process stops updating its command file, so a backend crash or hard power-off fails safe rather than latching the last commanded output.
- Every vendor/product ID and PDO index:subindex the daemon uses (`NX_CARD_PRODUCT_ID`, `NX_DI_PDO`, `NX_DO_PDO`, `NX_AI_PDO`, `NX_AO_PDO`, `NX_RS1201_PDO` in `src/types.ts`) is currently a placeholder pending `ethercat slaves -v` / `ethercat pdos -p <slot>` against the real rack — do not treat any of it as bench-verified yet.
- Disconnect/reconnect, command freshness/expiry, and per-module fault verification requirements above still apply.
- Serial device identity by persistent `/dev/serial/by-id` or udev rule, not transient `/dev/ttyUSB0` — this applies to serial scale indicators (`ScaleConfig.connectionType: 'serial'`), read by `src/scaleReader.ts`.

### NX-EIC202 (EtherNet/IP) — deferred future path

The equipment/I/O data model still carries an EtherNet/IP coupler option (`NX-EIC202`) alongside EtherCAT (`NX-ECC`); building it out is deferred, and nothing below is bench-verified or implemented in the current backend.

- Omron NX-EIC202 cyclic EtherNet/IP scanner, correct assembly mapping and connection identity, input/output images and freshness timestamps.
- Supervise session/connection state, connection timeout, module diagnostics, stale images and reconnect transitions.
- Every command stamped with controller generation and monotonic expiry; stale output commands must never be replayed.
- Disconnect/reconnect keeps outputs inhibited pending deliberate system re-arming and feedback check.
- Verify output fault behavior **per NX output module** using the manufacturer's documentation and physical testing.

## Ownership and manual control

- Manual and automatic control request same equipment arbiter; commands checked against modes, equipment reservations, interlocks, and safety system state.
- No forced output bypasses via normal HMI. Commissioning tests are time-limited, explicitly authorized, locally supervised and blocked when unsafe.
- Conflicting requests must fail with reason and preserve the current validated state.

## Timing and failed-sensor operation refinement

See [23 - Configurable delays and sensor overrides](23_TIMING_AND_SENSOR_OVERRIDES.md). Auger/elevator start and stop delays and fault delays are configurable. Rotation startup delay is global. Required starter auxiliary, rotation and gate/valve position checks may be individually waived by an explicit sensor override; telemetry remains unverified rather than reported as confirmed.
