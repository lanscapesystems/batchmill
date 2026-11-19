# 11 — Operational Faults, Watchdogs and Independent Safety

## Boundary

**A physical E-stop button is required but is not by itself a complete safety system.** Hazard assessment determines safety circuit topology, rated devices, stop behavior, reset and commissioning. Do not rely on Debian, the web app, the NX-EIC202 standard I/O or an ordinary application watchdog for personnel safety.

## Failures to supervise

| Failure | Detection | Required process response (engineering policy) |
|---|---|---|
| Batch logic stalled | Monotonic heartbeat/control deadline | I/O service inhibits commands, sends defined shutdown state, refuses stale commands |
| EIP process/PC/network failure | NX-EIC202 cyclic connection monitoring | NX output-module connection-fault states, verified per module |
| OS/kernel hang | Onboard hardware watchdog (driver verified), or approved external watchdog | Reboot PC; network I/O timeout independently transitions outputs |
| Serial scale stale/disconnected | Reader timestamps, framing timeout | Stop related dosing; invalidate reading; alarm |
| Drive command vs feedback mismatch | Device timeout | Stop related device/route; latch fault |
| Motor low RPM | Optional pulse sensor and configured minimum RPM | Stop faulted motor and all upstream equipment; inhibit upstream material admission; preserve occupied route ownership |
| Gate position disagreement | Feedback validity | Do not feed into unverified route |
| Conflicting route request | Reservation manager | Reject before motion |
| Bin empty during dosing | Scale: no weight gain after auger start + fault delay | Switch to next alternate bin (lowest number); fault if none remain |
| Level switches inconsistent | Input validation | Disable automatic refill/discharge as appropriate |
| Power loss | Physical deenergization and storage recovery | Outputs inhibit on return; recovery review |
| Browser/network HMI lost | Session keepalive | Controller may finish already validated process per installation policy |

## Critical application watchdog detail

A healthy EIP communication thread could continue refreshing **stale ON commands** after the batch application freezes. Thus the I/O process must check a continuously advancing control-engine generation/heartbeat and command-expiry timestamp. If stale, it must apply a defined inhibition/shutdown policy and fail the EIP connection if needed to guarantee coupler fault behavior. A `systemd` restart alone is not sufficient.

## NX-EIC202 caveats

- Determine precise model/firmware, cyclic I/O assemblies, RPI, multiplier and actual connection timeout from Omron manual and commissioning.
- Explicit-message output-data watchdog and cyclic I/O connection timeouts are **not interchangeable**.
- Determine and verify deenergized / hold-last / fault output behavior for **every actual NX output module**; never assume common behavior.
- Ordinary fail-safe shutdown of a feed motor on comms loss is process protection, not a safety-rated stop.

## Alarm framework

`Alarm(id, severity, device, cause, active, latched, ack_required, reset_conditions, first_seen, last_seen)`.

Separate automatic condition clearance from operator acknowledgment and restart authorization. An alarm acknowledgement must not energize any output.

## Safety engineering checklist

E-stop risk assessment; safety-rated contactor/drive STO where applicable; guarding; dust explosion/combustible-dust controls; rotating equipment; blocked conveyors; arc/electrical protection; isolation/lockout; feedback/EDM where required; functional and periodic tests. Qualified personnel approve the actual safety scheme.

See [motor feedback and speed fault contract](22_MOTOR_FEEDBACK_AND_SPEED_FAULTS.md) for topology-based upstream propagation and unresolved timing policies.
