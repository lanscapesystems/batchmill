# 05 — Main Batch Engine and Mixer Sequencing

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

## Function

Take a recipe-driven batch request, validate ingredient sources and mixer capacity, dose each ingredient into the **weighed main mixer**, operate mixing, discharge to one of eight finished bins, and produce an auditable batch record.

**CONFIRMED:** the mixer itself is weighed and has one motor. Micro preparation runs in parallel with main dosing; micro transfer follows main dosing, before timed mixing. See 19.

## Batch planning

- Each batch references an immutable recipe revision, installation revision, requested mass and destination finished bin.
- Resolve recipe ingredients to eligible storage bins; reserve inventory policy (estimate/hold; then post actuals).
- Calculate target mass, mixer usable capacity, tolerance, expected fill and destination capacity.
- Establish final source selections and intended material paths before permitting start.

### Bin selection priority

When multiple bins are assigned the same ingredient, select the bin with the lowest bin number first (e.g. B-1 before B-5). This is the default source for that ingredient in the batch plan. All alternate bins with the same ingredient are recorded as failover candidates, ordered by ascending bin number.

### Bin empty failover

During DOSING, if the scale determines the active source bin is empty (no weight gain detected after all discharge augers for that bin are started and a configurable fault delay has elapsed), the batch engine:

1. Stops the current bin's discharge auger(s).
2. Looks up the next alternate bin for that ingredient (next lowest bin number with the same assignment and available inventory).
3. If an alternate bin is found: switches the active source bin, starts the alternate bin's discharge route, and resumes dosing without operator intervention. The batch record logs the bin switch event.
4. If no alternate bins remain: faults the batch with a "bin empty — no alternate source" alarm. Operator must acknowledge and either refill a bin or abort.

## Top-level state machine (PROPOSED)

`IDLE -> VALIDATING -> READY -> DOSING -> MIXING -> ROUTE_PRECHECK -> DISCHARGING -> CLEAROUT -> COMPLETED`

Exceptional states: `PAUSING`, `PAUSED`, `FAULTED`, `ABORTING`, `ABORTED`, `RECOVERY_REQUIRED`.

### Important state rules

- `VALIDATING`: validate scale connection/freshness, vessel empty/known tare state, recipe and ingredient bin access, permissions, mixer gate position and equipment readiness.
- `DOSING`: one or more ingredient dosing child operations; each has its own recorded target, cutoffs and actual mass. Parallel feeding only when model and scale strategy explicitly support it.
- `MIXING`: timed or condition-driven mixer sequence; require motor feedback and configured permissives.
- `ROUTE_PRECHECK`: reserve finished destination and validate path prior to discharge.
- `DISCHARGING`: operate correct material path with destination capacity, status and interlock checks.
- `CLEAROUT`: close feed path and run configured downstream clearing operations without cross-contamination.
- `COMPLETED`: publish final batch actuals/inventory transactions and release reservations.

## Commands

`QueueBatch`, `StartBatch`, `RequestPause`, `ResumeAfterValidation`, `CancelQueued`, `Abort`, `AcknowledgeFault`; all require authorization and state-dependent validation. Acknowledging a fault **does not** start any machinery.

## Required record

Batch ID, recipe version, selected source bins, target and actual ingredient masses, scale quality, start/end timestamps, actual destination, equipment/route IDs, overrides with authorizations, alarms, operator, interrupted/resumed/canceled status.

## Failure behavior

If scale data stale, inventory/route invalid, motor feedback absent or control heartbeat expires, stop/hold the relevant feeders per fault matrix. Power loss records the most recently committed state; restarting cannot infer an auger has stopped merely because its command state was off—feedback and safety states must be checked.
