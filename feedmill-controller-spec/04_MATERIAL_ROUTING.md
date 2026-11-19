# 04 — Material Routing and Shared Equipment Reservation

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

## Function

Find and validate physically configured material paths and coordinate simultaneous operations using shared augers, conveyors, gates and diverters.

## Material graph

- Nodes: bins, mixer, hammer mill, augers, conveyors, gates, diverters, receiving points.
- Directed edges: allowed material flow; condition may require gate/diverter position and process mode.
- Route: selected directed path plus set of equipment operations, position checks, startup order, shutdown/cleanout sequence and minimum permissives.
- Distinguish **bulk ingredient -> mixer**, **hammer mill -> ingredient bin**, **mixer -> finished bin**, and any return/transfer paths.
- Each path must be surveyed and confirmed; do not infer an installed connection from a shared equipment name.

## Route example (fictional for illustration)

```yaml
id: R-MX01-FB04
source: MX-01
destination: FB-04
requires:
  - {equipment: AG-DISCH, action: RUN}
  - {equipment: CV-DISTRIBUTION, action: RUN}
  - {equipment: DV-01, action: POSITION, value: BRANCH_B}
checks: [FB04_NOT_FULL, MIXER_READY_TO_DISCHARGE]
start_order: [DV-01, CV-DISTRIBUTION, AG-DISCH]
stop_order: [AG-DISCH, CV-DISTRIBUTION]
clearout_ms: TBD
```

Sample route components do not assert that these devices exist in `MILL-001`.

## Reservation engine

- All equipment needed for a route, plus relevant source/destination capacity, is reserved **atomically** before moving anything.
- An operation may begin only if the full route is reservable; partial lock acquisition must roll back without motion.
- Lock types include exclusive actuator, exclusive path segment, receiving capacity and non-conflicting reads; permit known-safe sharing only with explicit rules.
- Use consistent lock ordering, ownership ID, lease/health status, and fault recovery; a crashed operation cannot leave automatic motion enabled.
- Check conflicts: same conveyor fed from incompatible directions, diverter different position, two destinations, incompatible products/cross-contamination, mill refill into a bin being emptied (if forbidden).
- Route switching requires cleared material path and appropriate stopped-state confirmation.

## Route validation

Graph reaches target; required equipment exists and commissioned; all I/O and feedback mapped; startup sequence respects downstream-before-upstream; actuator transitions feasible; cleanout requirements specified; destination not full and capacity estimate valid; fault actions defined.

## Concurrent activity examples

Main mixer loading, a hammer mill filling a different ingredient bin, and finished-bin unload could coexist **only if** their resources and process constraints permit it. No assumption of concurrency until physical topology confirms it.
