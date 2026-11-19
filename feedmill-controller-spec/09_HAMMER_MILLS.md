# 09 — Automatic Hammer Mill Replenishment

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

## Function

Operate up to four configurable hammer mill systems to fill eligible ingredient bins using level signals and material-routing equipment. The enabled hammermill count and source/receiving assignments are installation configuration. See [20 - Hammermill configuration and automatic refill](20_HAMMERMILL_CONFIGURATION_AND_LOGIC.md).

## Equipment model

`HammerMill(id, motor, run_feedback, fault, source_feeder, intake_path, discharge_path, eligible_destination_bins, auxiliary_equipment, operating_limits, level_policy)`.

Each target bin may have LOW/EMPTY request signal and FULL stop signal. Configurable signal normality/debounce/fail response, minimum off time, maximum continuous run time, anti-short-cycle logic, and operator enable.

## Automatic refill logic

1. Low-level threshold requests fill. A low/full pair creates hysteresis: once started, continue until FULL, subject to limits.
2. Check the source ingredient, route, bin ingredient compatibility, electrical/mechanical permissives, destination capacity and resource reservations.
3. Select/position routing equipment; verify state.
4. Start dust-control/required downstream equipment, then mill, verify its run feedback, then start source feed. **Actual startup ordering must be validated against mill OEM and dust system requirements**.
5. Monitor bin full, mill load/fault, downstream blockage, temperature/other installed protections, maximum runtime, sensor consistency, and operator stop.
6. On full, stop upstream feed then perform documented clearing/cleanout and controlled stop.
7. Release equipment reservation and log fill cycle/event.

## Faults and exclusions

- Low and full signal contradiction (depending on sensor meanings) → diagnostic/fault.
- A failed FULL sensor must not permit indefinite feeding: configured max runtime, overload checks and other independent protection are needed.
- The same bin cannot be selected by incompatible refill and dispensing routes without explicit process approval.
- One mill may serve multiple ingredient bins only if validated material purity, routing, and cleaning prevent cross-contamination.
- Emergency stopping and required dust explosion/machine guarding safety measures are independent of control software.

## Inventory implication

Level switches are not mass meters. Fill quantity is an estimate unless a weighing/flow measurement exists. Flag provenance explicitly.

## Initial settings TBD

Mill motor starter/drive type, feeder/airlocks, dust collection dependency, speed/start delays, level sensor types/locations, eligible source and destination bins, destination-selection priority, fill quantity measurement and current/temperature sensors.
