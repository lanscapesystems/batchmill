# 18 ? Mill control execution contract

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

Status: PROPOSED development behavior, 2026-11-09. Refines 03?15. Physical action sequences and numeric setpoints require installation confirmation.

## Ownership and scheduling

The control engine owns operating decisions; equipment arbitration owns ordinary output requests; the hardware service applies only current authorized output images. Each request carries operation ID, configuration revision, control generation and monotonic expiry. Invalid input quality cannot satisfy a permissive. An expiry independently inhibits affected commands even if network updates continue.

Each control cycle snapshots inputs and quality, evaluates inhibit conditions, advances operations, arbitrates intents, then publishes an expiring output image and state snapshot. New inhibition suppresses output intents in that same evaluation cycle. Database, HTTP and logging never block this cycle. A required durable transition becomes an asynchronous waiting state; timeout prevents dependent motion.

## System states

| State | Entry / permitted behavior | Exit |
|---|---|---|
| BOOT_INHIBITED | No production requests applied; validate configuration, storage and adapters | Validation success to RECONCILING; failures to NOT_READY |
| RECONCILING | Compare durable operation state with physical vessel, gates, drives and material ownership | No unresolved material to DISARMED; otherwise RECOVERY_REQUIRED |
| DISARMED | Diagnostics and planning only | Explicit authorized arm after all required checks |
| READY | May accept validated automatic/manual operations | Disarm, inhibit, failure or recovery requirement |
| NOT_READY | Explain failed prerequisites; no production start | Recheck through DISARMED |
| RECOVERY_REQUIRED | Hold affected resources and uncertain material identity | Authorized documented disposition, then reconciliation |

System readiness does not imply that every asset is available. An isolated asset fault blocks its dependent operations; loss of shared control integrity inhibits all affected outputs. Automatic/manual is an ownership mode checked independently from system readiness. Never switch an owned device to manual during an automatic operation.

## Batch admission and ownership

Queueing is non-actuating. Release freezes recipe/configuration revisions, source-bin selection, target masses, ingredient order, destination and batch ID. Initial implementation proposes one active main batch, one ingredient feeder at a time, and no next-batch loading before empty confirmation and completion. The mixer itself is confirmed weighed. Micro preparation runs concurrently; see 19 for the required join and transfer stage.

Before first ingredient motion validate the entire plan, including intended discharge reachability, product compatibility and capacity policy. Reserve the vessel and logical destination receiving capacity for the batch; acquire equipment for each complete stage atomically. Do not hold partial equipment reservations while waiting for another stage. Revalidate destination conditions immediately before discharge. A route blocked later leaves the material in a defined holding state.

## Ingredient dosing

| State | Actions and transition condition |
|---|---|
| PRECHECK | Validate reserved source/path, fresh valid scale, required gate position and vessel ownership |
| BASELINE | With competing inflows prohibited, acquire stable pre-dose weight and durably record step identity/baseline |
| POSITION_AND_START | Position route; verify positions; start required downstream devices before feed according to verified dependency graph |
| FAST_FEED | Run selected feeder; supervise elapsed time, weight plausibility, route health and feedback |
| FINE_FEED | Optional only for capable equipment and validated thresholds; otherwise proceed directly to cutoff |
| CUTOFF | Stop material source at configured compensated threshold; keep only approved transport clearing active |
| SETTLE | Verify source stopped and transport complete, then wait for valid stable weight |
| VERIFY | Actual mass = final stable weight minus baseline; apply ingredient tolerance and plausibility rules |
| COMMIT | Persist actual and inventory transaction under deterministic step key; await durable success |
| RELEASE | Release step route once cleared; next ingredient may start |

Each state has explicit timeout and fault reason. No weight increase while feeding, unexpected negative change, stale scale, tare discontinuity or overload stops the affected dosing operation. An invalid final reading never posts a guessed actual. Underfill top-off requires a configured bounded policy with attempt/mass limits; overfill requires disposition. Source substitution is a recorded replanning action, never silent selection.

## Mixing and discharge

Timed mixing starts only after all required main and micro ingredients are received, verified and durable. The drive's filling/discharge behavior is an installation parameter, currently unresolved. Count mixing time only while required running feedback and permissives are valid. Interrupted mixing uses a recipe-specific validated restart/remaining-time policy; no default assumption that elapsed wall time counts.

After mixing, acquire the complete discharge route; recheck receiving capacity/product assignment; position and verify routing; start downstream equipment in verified order; then authorize vessel discharge. Monitor destination full, drive feedback, route ownership, gate positions and scale validity. Empty is an explicit configured evidence rule with dwell and timeout. A discharge command or elapsed timer alone does not prove transfer.

Close and verify the vessel discharge path, execute approved clearing, verify transport completion, durably post destination quantity/quality and batch completion once, then release ownership. Ingredient consumption is posted at finalized dosing; completion must not post it again. Residue or uncertain transfer enters reconciliation with measured/estimated provenance.

## Pause, stop, abort and faults

| Event | Required control behavior |
|---|---|
| Pause during dosing | Inhibit source feed, apply approved bounded clearing if permissible, preserve source/baseline/step ownership; enter PAUSED only once controlled hold is verified |
| Pause during mixing | Follow configured drive hold policy and freeze credited mixing time as appropriate |
| Pause during discharge | Follow validated transfer hold policy; retain destination and route ownership until material location is reconciled |
| Resume | Explicit request; validate all current prerequisites and accumulated material before motion |
| Abort before material entry | Controlled stop and release after verification; mark canceled/aborted |
| Abort after material entry | Controlled stop; retain material ownership in DISPOSITION_REQUIRED; no automatic dump or false empty declaration |
| Asset fault | Inhibit affected source/actions; permit clearing only when the specific fault matrix allows it and downstream health is valid |
| Control integrity loss / power return | Inhibit affected outputs; invalidate old generations; reconcile before any new arm/start |
| Alarm acknowledgment | Record acknowledgment only; does not clear physical cause, arm or start |

A reservation lease expiry never makes a material-filled path free for reuse. It marks ownership orphaned/recovery-required until verified clear. Stop and clearing behavior must be defined per equipment/failure combination; there is no universal run-on rule.

## Automatic hammer replenishment

Enable independently per commissioned hammer system. A valid low request latches demand until full, operator cancellation or fault; supervise maximum runtime and contradictory sensors. Eligible destinations must have configured material compatibility and real routes. Propose configured priority followed by oldest outstanding request as deterministic tie-break; starvation escalation raises an alarm, without changing material compatibility.

Acquire the entire fill route and destination ownership before startup. Confirm required ancillary equipment and routing in the OEM-approved order, then mill running, then material feed. Full stops feed first; clearing and mill/ancillary shutdown follow the approved sequence. A fault may prohibit clearing. Record quantity as estimated unless actual mass measurement exists.

Initially prohibit simultaneous refill and dispensing of the same ingredient bin. Permit hammer operation alongside batching only after verified resource disjointness and process approval. A waiting hammer request holds no partial equipment locks. Faulted requests require explicit reset/revalidation before restart.

## Simulator acceptance scenarios

- Complete a batch with exact frozen revisions and one posting per ingredient/final transfer.
- Two operations request the same diverter: only one obtains the whole route; neither partially actuates.
- Scale freezes during feeding: source inhibited, no fabricated final mass, explicit recovery.
- Destination fills during discharge: approved hold, retained ownership, no reroute with moving material.
- Control heartbeat stops while network communication continues: output commands expire.
- Power fails between physical dose and durable finalization: recovery finds uncertain material and never repeats feed automatically.
- Abort with a nonempty vessel: material remains owned until recorded disposition.
- Hammer demand competes with batching for a bin: deterministic exclusion without partial reservations.
- Repeated completion messages: no duplicate inventory posting or discharge.

Implement these against simulated adapters before mapping physical outputs (the current `feedmill-backend` has no simulated-adapter layer to run these against directly — exercise via automated tests or a bench EtherCAT rack instead). Numeric durations, capacities, tolerance bands and electrical fault actions remain activation blockers until supplied and verified.
