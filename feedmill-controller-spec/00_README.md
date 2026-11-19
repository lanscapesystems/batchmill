# Feed Mill Controller — Development Specification

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

**Status:** Draft design baseline, 2026-11-09. **Installation:** configurable; `MILL-001` was an illustrative placeholder.  
**Purpose:** Reference for future software design, coding, configuration, simulation, commissioning, and review. Not an approved electrical design or safety validation.

## Established requirements

- Shared controller software configurable **per installation**, without recompilation for routine equipment additions/assignments.
- Platform target: Debian-based fanless industrial x86 PC/SBC, Node.js/TypeScript control engine (`feedmill-backend`), browser HMI, Omron NX-ECC EtherCAT remote I/O (current, only supported fieldbus — EtherNet/IP via NX-EIC202 is a deferred future path), serial or NX-RS1201 scales.
- Hardwired independent emergency stop/safety circuit; remote I/O fault behavior and multiple watchdog layers; power-on automatically after applied supply; recover from ungraceful power loss.
- Desired **physical input to physical output response <30 ms** for operations that require it; to be validated end-to-end on selected PC, I/O modules, and network. Not a safety response-time rating.
- Platform limits: 32 ingredient bins; 1 weighed main batch mixer; 8 finished feed bins; 2 microingredient systems; 4 hammer mills. Material paths and motors/gates/conveyors are configurable, not assigned fixed maxima by this design.
- No actual deployment profile is established. Ingredient bins, finished bins, hammermills and 0-2 micro systems are enabled and assigned per installation within platform limits; previous deployment counts were examples.
- Ingredient inventory tracking and production/batch historical records required.

## Read in this order

1. [01 Architecture](01_ARCHITECTURE.md)
2. [02 Installation configuration](02_INSTALLATION_CONFIGURATION.md)
3. [03 Equipment and I/O](03_EQUIPMENT_AND_IO.md)
4. [04 Routing and reservations](04_MATERIAL_ROUTING.md)
5. [05 Batching](05_BATCH_ENGINE.md)
6. [06 Weighing](06_WEIGHING_AND_SCALES.md)
7. [07 Ingredients and inventory](07_RECIPES_INVENTORY.md)
8. [08 Finished feed](08_FINISHED_FEED.md)
9. [09 Hammer mills](09_HAMMER_MILLS.md)
10. [10 Micro systems](10_MICRO_SYSTEMS.md)
11. [11 Faults and safety](11_FAULTS_AND_SAFETY.md)
12. [12 Web HMI](12_WEB_HMI_AND_API.md)
13. [13 Persistence and power loss](13_PERSISTENCE_AND_RECOVERY.md)
14. [14 Commissioning](14_COMMISSIONING_AND_TESTS.md)
15. [15 Interfaces and contracts](15_INTERFACES_AND_EVENTS.md)
16. [16 Open questions](16_OPEN_DECISIONS.md)

## Status convention

- **REQUIRED** — known requirement from project discussion.
- **PROPOSED** — design recommendation, subject to review.
- **TBD** — missing mechanical, electrical, protocol, or process information.

All I/O channel numbers, equipment identifiers, route names, delays, capacities, scale protocols and example recipes are placeholders unless explicitly marked as confirmed. No code should assume the sample topology matches the real mill.

## Cross-cutting invariants

1. Browser/API never writes physical outputs directly.
2. A signal/output has one authoritative writer through Equipment Manager / output arbitration.
3. No motion starts merely because the OS, driver or web service restarted.
4. Physical safety functions are implemented and validated independently of Linux/the fieldbus master (EtherCAT, or EtherNet/IP if that future path is built).
5. Route activation requires atomic reservation of conflicting resources and validated permissives.
6. Each running batch uses a frozen recipe and installation configuration revision.
7. An unverified scale reading must never be treated as a fresh valid weight.
8. Inventory changes are traceable, idempotent transactions based on known actuals or identified estimates.
9. Changing engineering configuration while equipment is active is blocked.
10. Startup after power loss requires reconciliation of stored and observed machine state before resuming.

## Development refinement

17. [Installation baseline and activation contract](17_CONFIGURATION_BASELINE.md)
18. [Mill control execution contract](18_CONTROL_LOGIC.md)

[Machine-readable installation draft](installation.draft.json) records known counts and unresolved commissioning fields. New control policies remain PROPOSED until reviewed.

20. [Hammermill configuration and automatic refill](20_HAMMERMILL_CONFIGURATION_AND_LOGIC.md)

21. [Prioritized development to-do list](21_DEVELOPMENT_TODO.md)

22. [Motor feedback, rotation monitoring and upstream faults](22_MOTOR_FEEDBACK_AND_SPEED_FAULTS.md)

23. [Configurable delays and sensor overrides](23_TIMING_AND_SENSOR_OVERRIDES.md)

24. [Frontend data and command contracts](24_FRONTEND_DATA_AND_COMMANDS.md)

Runnable [HMI prototype](../hmi-prototype/dist/index.html) uses simulated local data.

25. [Ingredients and micro ingredients](25_INGREDIENT_CATEGORIES.md)

26. [Queue history, weights and scheduling](26_QUEUE_HISTORY_AND_SCHEDULING.md)
27. [Complete equipment configuration in Settings](27_EQUIPMENT_CONFIGURATION_UI.md)
