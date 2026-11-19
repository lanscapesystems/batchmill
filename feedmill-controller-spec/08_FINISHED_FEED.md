# 08 — Finished Feed Bins and Discharge Routes

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

## Function

Deliver completed feed from the main mixer to any configured one of eight finished bins using any valid combination of augers, conveyors, gates, valves or diverters.

## Bin settings

`FB-01` through `FB-08`: name, assigned finished product (optional policy), total and usable capacity, actual/estimated inventory, full sensor (optional), receiving route list, discharge/withdrawal methods if integrated, cleanout/cross-contamination rules.

## Selection

- Batch order specifies destination; HMI verifies product-to-bin compatibility and available capacity.
- Controller determines required material route from configured graph; not all routes need the same equipment or gate type.
- Route manager reserves entire path exclusively where required; feedback validates gate/diverter positions.
- Check capacity and full/blocked sensors before discharge; monitor during transfer.

## Discharge sequence

`SELECT -> PRECHECK -> POSITION -> START DOWNSTREAM -> OPEN MIXER DISCHARGE -> VERIFY TRANSFER -> CLOSE -> PURGE/CLEAROUT -> RELEASE`.

Details such as how to detect an emptied mixer (weight threshold, timed run, switch) are TBD. Detect and fault on mismatch between gate command/feedback, missing conveyor run feedback, loss of destination capacity, route reservation loss or emergency stop activation.

## Inventory

After confirmed discharge record transferred amount and selected finished bin. If vessel residue, spillage or unmeasured transfer occurs, mark amounts estimated/reconciled rather than pretending exact. Support finished-bin manual loadout transactions if included in project scope.

## Commissioning

For each of eight bins verify only its intended route opens, no alternative route can energize, full signal inhibits intake, path startup/stop order is correct, no restart after communication loss and all feedback is consistent.

## Timing and failed-sensor operation refinement

See [23 - Configurable delays and sensor overrides](23_TIMING_AND_SENSOR_OVERRIDES.md). Auger/elevator start and stop delays and fault delays are configurable. Rotation startup delay is global. Required starter auxiliary, rotation and gate/valve position checks may be individually waived by an explicit sensor override; telemetry remains unverified rather than reported as confirmed.
