# 23 - Configurable delays and sensor overrides

Status: user-confirmed requirements and labeled proposed execution semantics, 2026-11-09. Supersedes per-motor rotation-startup timing and unconditional feedback requirements where an explicit override is active.

## Confirmed timing configuration

Fault delay is configurable. Auger and elevator start and stop delays are configurable. Rotation sensor startup delay is one global mill configuration setting, applied consistently to every motor with rotation supervision. Do not add a per-motor rotation-startup override unless subsequently requested.

Proposed field placement and semantics:

| Setting | Scope | Meaning |
|---|---|---|
| rotation_startup_delay_ms | Global mill | Grace from actual OFF-to-ON run-output transition before evaluating rotation faults |
| start_delay_ms | Per auger/elevator | Wait after start eligibility before issuing run output; recheck permissives when delay expires |
| stop_delay_ms | Per auger/elevator | Controlled-stop run-on interval before withdrawing run output, when the active stop policy permits run-on |
| fault_delay_ms | Per monitored fault condition | Required continuous fault condition before declaring its fault; actual values unset |
| starter_start_timeout_ms / starter_stop_timeout_ms | Per motor | Expected auxiliary transition deadline; distinct from sequencing delays |
| position_timeout_ms | Per gate/valve movement | Expected position confirmation deadline; distinct from motor sequencing delays |

Per-condition fault-delay scope and the timer definitions above are proposed implementation details. Durations are explicit milliseconds, finite and nonnegative. Null is unresolved, not zero. Validate pulse observation timing against the selected minimum RPM and acquisition method.

Proposed rotation evaluation: global startup grace expires, then a persistent low-RPM condition accumulates its configured fault delay. A healthy valid sample clears persistence; stale acquisition follows its separate validity policy. Repeated START requests while already running do not reset grace. Sequencing, startup grace, acquisition window, transition timeout and fault persistence must not be silently added twice.

Stop delay is for ordinary sequence/clearing stops. Once a motor/upstream fault is declared, revoke affected run authorization without adding an ordinary stop delay. Pause behavior remains governed by the still-unresolved per-phase pause contract; a stop-delay setting does not establish which devices may run on during pause.

## Confirmed override capability

Provide an enableable override for each motor-starter auxiliary feedback, optional rotation sensor, and every gate/valve limit switch so an individual failed sensor need not stop mill operation. Preserve configured sensor mappings. A sensor override changes how its associated operational feedback checks are enforced; it does not energize equipment or override unrelated permissives.

Proposed runtime model: each override stores sensor ID, enabled state, affected check(s), actor, reason and activation/deactivation timestamps. Operator role/authorization, expiry and persistence across restart remain to be decided. Keep overrides separate from immutable installation revisions so deliberate degraded operation does not require rewriting equipment topology.

## Effective feedback semantics

- Auxiliary override: skip the selected auxiliary-based start/run/stop proof and its associated faults. Show actual auxiliary state and OVERRIDDEN status. Do not synthesize a healthy feedback sample. Rotation supervision remains active unless separately overridden.
- Rotation override: bypass the selected sensor's rotation/low-RPM validity permissives and faults, while retaining raw pulse/RPM diagnostics as available. Display RPM quality and OVERRIDDEN status. Auxiliary checks remain active unless separately overridden.
- Gate/valve limit override: waive only the selected position-feedback requirement. Retain the commanded route position and indicate POSITION_UNVERIFIED. Other limits and route exclusions continue to apply. If all required checks are confirmed or explicitly overridden, unload may proceed under the override policy.
- Overriding one failed limit does not globally bypass other positions or hide contradictory non-overridden feedback. Multi-position actuator semantics must map each limit and affected check explicitly.

Gate override cannot establish actual material connectivity. Retain configured route ownership and conservatively account for uncertain possible upstream paths in fault propagation. No override removes the motor stop-output capability, resource reservations, material compatibility, command expiry or independent safety functions.

## Activation, faults and removal

An override alone does not start/restart equipment or acknowledge/reset an existing latched fault. Proposed behavior permits deliberate recovery once the selected feedback-related blocker is waived and remaining checks pass; exact active-fault reset workflow remains unresolved. While running, re-enabling a check after override removal evaluates current feedback under an explicit revalidation policy; do not silently restart rotation startup grace on a motor that never stopped.

Show an always-visible degraded-feedback indicator, per-device override status and an active override list. Log changes and associate active overrides with batch/operation history. Raw telemetry remains available for diagnosis. Reboot restoration/confirmation policy must be defined before production commissioning.

## Acceptance cases

- All rotation-equipped motors use the same global startup delay; independent motor starts retain independent elapsed timers.
- Auger/elevator start and controlled-stop delays are configurable and respect downstream-first startup dependencies.
- A declared low-speed fault stops the motor and upstream equipment without ordinary stop-delay run-on.
- Auxiliary override bypasses only auxiliary checks; rotation override bypasses only rotation checks.
- Unload with a failed limit is blocked normally and can proceed only when that specific feedback requirement is explicitly overridden and other prerequisites pass.
- Actual feedback is not rewritten; HMI and history identify degraded operation.
- Enabling an override cannot energize a motor, reset unrelated faults or release occupied routes.
- Override removal, faults during timed delays and restart with saved overrides exercise explicit revalidation policies.
