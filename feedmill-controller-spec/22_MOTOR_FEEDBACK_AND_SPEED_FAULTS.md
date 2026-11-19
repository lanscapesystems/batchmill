# 22 - Motor feedback, rotation monitoring and upstream faults

Status: confirmed motor requirements with proposed implementation details, 2026-11-09. Applies to every motor, including bin/source augers, stuffer, micro feeders/drags, mixer, hammermills, unload augers and elevators.

## Confirmed motor I/O

Every motor has a run-command output and a motor-starter auxiliary feedback input. An optional rotation-sensor input produces pulses. Configure pulse calibration and a minimum-RPM fault setpoint for each motor fitted with that sensor. When monitored RPM is below the minimum under the applicable running conditions, fault and stop that motor and all upstream equipment.

Starter auxiliary feedback proves starter state; it does not establish shaft rotation. A rotation sensor supplements the mandatory auxiliary input. Optional VFD analog speed reference is additional to run authorization and starter feedback.

See [configurable timing and sensor overrides](23_TIMING_AND_SENSOR_OVERRIDES.md): rotation startup delay is global, fault delay is configurable, and individually enabled sensor overrides waive selected feedback checks.

## Configuration contract

Motor records contain run_output, starter_aux_input, feedback polarity, startup/stop feedback timeout, optional rotation input, pulses_per_revolution, minimum_rpm and speed evaluation settings. Use explicit pulses per revolution as the calibration unit; the user's pulses/RPM wording describes pulse-to-speed calibration and must not be stored as an ambiguous unit. The sensor's monitored shaft and any gear-ratio conversion must be identified.

If rotation monitoring is disabled, no pulse input or RPM permissive is required; report RPM as unavailable rather than zero. If enabled, require positive finite pulses_per_revolution, a nonnegative finite minimum_rpm, a supported pulse-acquisition method and explicit startup/evaluation/timeout policy. Exact minimum values are installation setpoints, not defaults invented by software.

## Proposed pulse acquisition and RPM calculation

Use hardware pulse counting or timestamped edge acquisition capable of capturing the expected pulse rate. A sampled Boolean input may miss pulses between network/control updates; verify input module counter capability, filtering, maximum frequency, rollover and reset behavior during commissioning.

For a count window, RPM = 60 * pulse_count / (pulses_per_revolution * elapsed_seconds), using monotonic elapsed time. A period-based or hybrid estimator may be preferable at low speed; the selected estimator, window and resolution must support the configured minimum. Track measurement quality, timestamp and counter continuity separately from speed.

No pulses while fresh acquisition is operating indicates loss of rotation after the configured no-pulse timeout. Missing/stale acquisition indicates invalid measurement, not a valid zero-speed sample. Define both fault responses; do not silently disable monitoring when data disappears.

## Proposed running supervision

- OFF: run request off; verify auxiliary feedback releases within the configured stop timeout. Do not issue a low-RPM fault for an intentionally stopped motor.
- STARTING: run request on; verify auxiliary feedback within start timeout; allow only the explicitly configured rotation startup grace.
- RUNNING: require valid auxiliary feedback and evaluate monitored RPM. Sustained RPM below minimum triggers LOW_RPM according to configured persistence; exact comparison, window and delay remain to be finalized.
- FAULTED: revoke run authorization for the motor and inhibit all upstream feeding equipment. Record initiating motor, RPM/quality, minimum, route/operation and propagated stop reasons.

Do not reset startup grace repeatedly while a run command remains active. A commanded load pause, batch pause or controlled stop suppresses inappropriate low-speed evaluation only for motors intentionally stopped; an independently commanded-running downstream motor remains supervised. Optional VFD operation must respect the minimum-RPM policy at its permitted operating speeds.

## Upstream stop propagation

Upstream means equipment that can feed material into the faulted device through an active or authorized material path. It is derived from configured physical flow and active route/position state, not equipment numbering or startup-list index. Traverse all feeding branches transitively, including motors owned by other operations sharing that device. Block pending starts into the affected path as well as stopping running feeders.

For confirmed isolated/disconnected branches, do not stop unrelated equipment. When routing/position validity is uncertain, proposed behavior conservatively includes every branch that could currently feed the faulted device. Validate the dependency model for cycles and terminate traversal using visited IDs.

Examples: a stuffer low-speed fault stops the stuffer plus bin augers/micro drags feeding it; an unload conveyor fault stops that conveyor and every feeder upstream, including mixer discharge authorization; a hammermill discharge auger fault stops its feeding mill/source chain. Include nonmotor material-admission actions in the upstream inhibition: their exact gate close/hold actions remain installation-specific and must be defined. A stopped mixer motor alone does not prove that mixer discharge has stopped.

The mandatory response stops the faulted motor and upstream flow. Downstream equipment behavior remains a separate configured clearing/fault policy. Preserve route ownership and material state; fault propagation must not release occupied equipment for another operation.

Proposed software ordering evaluates speed/feedback faults and computes the full stop-inhibition set before output arbitration, so an upstream start cannot be issued in the same cycle after the fault was recognized. Physical response still includes acquisition and device delays and requires measurement.

## Open decisions

- Confirm calibration convention with actual sensor data; identify monitored shaft and pulse count/revolution.
- Global mill rotation-startup delay value, RPM window/estimator, no-pulse timeout, configurable fault-delay values and threshold equality behavior.
- Auxiliary mismatch fault propagation and behavior when pulse telemetry is invalid.
- Per-equipment upstream gate/material isolation and downstream clearing policy.
- Fault latching/reset and restart authorization; proposed default is explicit reset/revalidation with no automatic restart.
- VFD speed bounds and minimum-RPM relationship across normal speeds and commanded pauses.

## Acceptance cases

- Every configured motor requires run output and auxiliary input; sensorless motors need no pulse wiring.
- Known pulse counts produce expected RPM across minimum/maximum speeds and counter rollover.
- Start grace permits acceleration but cannot hide a stalled motor indefinitely.
- Low-speed fault stops the motor and every transitive upstream feeder, including shared-operation branches, before accepting further starts.
- Unrelated isolated routes remain available; uncertain routing invokes the documented conservative scope.
- Intentional pause does not create false low-speed faults; commanded-running motors remain monitored.
- Stale acquisition, missing pulses, auxiliary mismatch and sensor noise exercise distinct diagnostics.
- Fault acknowledgment does not start equipment or release unresolved material ownership.
