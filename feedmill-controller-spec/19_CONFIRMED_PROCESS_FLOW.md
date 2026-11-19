# 19 - Confirmed material flow and batch coordination

Status: User-confirmed process requirements, 2026-11-09. Proposed implementation details are labeled below. This refinement supersedes conflicting topology assumptions in 00-18. Earlier installed counts were illustrative, not an actual deployment. See 20 for hammermill source, discharge and level-control configuration.

## Confirmed equipment topology

- The ingredient-bin system supports 32 bins. Each bin has its own discharge auger feeding the mixer receiving path. Automatic hammermill receiving-bin assignments are configurable. The earlier four-bin description does not hardcode bin IDs or establish an additional platform limit.
- The mixer has one motor and is itself weighed. Its scale supplies main-ingredient weighing and inventory consumption measurements. There is no separate main weigh hopper in this process.
- An optional mixer stuffer auger receives the bin discharge augers and micro discharge. Without a stuffer, those feeds enter the mixer directly. Enablement and actual equipment ID belong to installation configuration.
- Each micro system has individual ingredient hoppers feeding a weighed drag. The drag transfers to the mixer directly or through its stuffer. Micro count and hopper counts remain installation-specific.
- Each finished-bin unload route is individually configurable with up to five augers, one elevator, and ten valves/gates. These are per-route maxima, not an assertion that every bin has that equipment or that equipment is dedicated to one route.

## Batch coordination

On accepted batch start, start the main-ingredient dosing branch and each required enabled micro weighing branch under the same immutable batch ID. Main ingredients are weighed using the mixer scale. Each micro system weighs its own ingredients using its drag scale while the main branch proceeds. Do not reserve the mixer stuffer for the entire micro weighing period; it is needed for transfer, not preparation.

After all main ingredients are finalized and their feed path is clear, transfer the required micro material into the mixer. If a micro system is not ready, the main sequence waits without beginning the timed mixing stage. If micros finish early, hold their weighed material for the bound batch. Never discharge a micro drag into the mixer while a main ingredient's actual mass is being established.

Proposed coordination states:

`START -> [MAIN_DOSING || MICRO_WEIGHING] -> WAIT_MAIN_COMPLETE -> WAIT_MICROS_READY -> MICRO_TRANSFER -> VERIFY_ALL_RECEIVED -> TIMED_MIX -> UNLOAD -> COMPLETE`

The parallel branches retain independent progress, faults and committed actuals. If no micros are required, skip micro preparation/transfer. Proposed first implementation serializes transfers from two required micro systems to preserve attribution on the mixer scale and shared-stuffer ownership; parallel preparation remains allowed. Releasing each system as soon as it is ready versus waiting for all systems is a policy still to confirm; the proposed sequence waits for all.

## Scale and inventory accounting

Main ingredient consumption is the valid stable mixer weight change for that isolated dosing step. Stuffer transport delay and residual material must be accounted for before accepting final weight or beginning the next ingredient. Exact cutoff, run-on and empty/clear verification parameters remain unresolved.

Micro ingredient consumption comes from valid individual hopper dosing increments on the weighed drag, posted once against the micro hopper and batch. Mixer weight gain during micro transfer is receiving/reconciliation evidence, not a second ingredient-consumption posting. A transfer discrepancy retains the original scale evidence and creates an explicit reconciliation/disposition record. Drag residue, transport residue, and interrupted transfer must not be silently treated as delivered material.

## Recipe mixing stage

Begin crediting the recipe-prescribed mixing duration only after all required main and micro material has been received and verified, with mixer running confirmation and required permissives. Mixer operation during loading and unloading remains to be specified. A pause freezes credited mixing time; whether an interruption requires additional/restarted mixing time remains a recipe/process decision.

After the prescribed credited mixing time completes, automatically enter the selected destination's unload precheck. Motion remains subject to route availability and permissives.

## Configurable unload route

A route lists source, destination, required gate/valve positions with corresponding limit-switch signals, up to five auger references, optional elevator reference, explicit downstream-first motor start order, per-step start verification and timing, mixer discharge action, transfer completion evidence, and stop/clear/pause policies. References may point to shared equipment; reserve them atomically.

1. Reserve and precheck the selected destination route and receiving capacity.
2. Attempt the required gate/valve positions for that route. The position set includes isolation positions needed to exclude alternate destinations.
3. Wait for valid limit-switch confirmation for every required position. No conveying motor starts before all required route positions are confirmed. Missing or contradictory confirmation holds/faults the sequence; exact movement timeout remains configurable and unresolved.
4. Start conveying equipment one step at a time, farthest downstream first. The elevator participates at its physical position in this order. Advance only after that step's configured verification succeeds.
5. Authorize mixer material release only once the receiving route is ready. Exact mixer outlet hardware/action and its relationship to the ten routing gates remain to be identified. Do not open a material-retaining mixer outlet during initial route positioning if this would release feed into stopped equipment.
6. Monitor route confirmations and equipment health during transfer. Gate confirmation loss blocks new feed and invokes the defined fault policy; exact stop/clearing actions remain unresolved.
7. Verify mixer empty and transport completion, then perform the configured shutdown and complete the batch durably. Downstream-first startup does not establish the shutdown order.

## Pause at every batch phase

Pause is available throughout the batch, including micro weighing, micro transfer, gate positioning, motor startup, timed mixing, unloading and clearing. A pause request latches immediately and prevents automatic advance into a new production step. Already active equipment transitions through a phase-specific PAUSING policy; do not declare PAUSED until that policy's physical hold conditions are confirmed.

The exact auger stop sequence, stuffer/drag/elevator run-on, gate hold/close positions and mixer motor behavior are TBD. Neither immediate simultaneous motor stop nor automatic clearing is established by this requirement. Production activation requires these policies for each active phase. A batch pause's effect on an independently running hammer refill is also TBD.

Retain batch identity, frozen revisions, selected destination, material ownership, completed dosing actuals, remaining mixing time and unload substep across pause. Retain occupied route reservations. Resume requires explicit authorization and revalidation of gate limits, equipment state, scale quality and material location; never replay completed dosing or blindly continue at the next motor index. Recovery after partial discharge must account for material already delivered.

## Decisions still needed

- Configure the enabled ingredient bins and hammermill receiving-bin assignments for each installation; the earlier 23-bin profile was an example.
- Installed micro count, hopper assignments and scale details; optional stuffer enablement.
- Main dosing order, feeder control modes, stuffer clear criteria and mixer behavior while loading.
- Whether all required micros must be ready before any transfers, or ready systems may transfer after main dosing; transfer verification and discrepancy tolerance.
- Each finished-bin route, motor order including elevator, gate positions/limit switches and mixer discharge device.
- Per-phase pause/stop/resume behavior, timeouts, empty/clearing evidence, and mixer behavior during unload.

## Acceptance scenarios added

- Micro weighing begins with batch start and may complete before or after main dosing; transfer waits for main completion.
- Main scale ingredient actual is never contaminated by simultaneous micro transfer.
- Optional stuffer is started/verified before its upstream source feeds and is shared exclusively during attributable weighing/transfer.
- Any missing gate limit prevents the first unload conveying motor from starting.
- A five-auger/elevator route starts strictly in its configured downstream-first order; oversized routes fail validation.
- Pause during every unload substep prevents advancement and preserves destination/material ownership.
- Micro transfer reconciliation does not duplicate hopper inventory consumption.

## Timing and failed-sensor operation refinement

See [23 - Configurable delays and sensor overrides](23_TIMING_AND_SENSOR_OVERRIDES.md). Auger/elevator start and stop delays and fault delays are configurable. Rotation startup delay is global. Required starter auxiliary, rotation and gate/valve position checks may be individually waived by an explicit sensor override; telemetry remains unverified rather than reported as confirmed.
