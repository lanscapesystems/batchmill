# 14 — Installer Commissioning and Acceptance Tests

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

## Purpose

Commission the same application for different mills while preventing unverified wiring, routes and fault handling from being enabled for production.

## Stage A — Installation survey

Inventory physical equipment, as-built electrical schematics, motor/drive types, contactor output energization behavior, actuator fail states, level switch normality, scale indicator protocols, instrument locations, network scheme, safety risk assessment, material pathways and cleaning requirements.

## Stage B — Validate configuration offline

- Validate the configured enabled assets within platform maxima: 32 ingredient bins, 8 finished bins, 1 weighed mixer, 4 hammermills, and 2 micro systems.
- Every enabled equipment object has a unique ID, mapping, valid parameters and defined fail action.
- No double assignment of exclusive physical outputs; compatible DI/DO/AI/AO channel types.
- Graph integrity: all intended destinations reachable, startup/stop sequences acyclic, route resources conflict appropriately.
- Recipe ingredients map to eligible real storage and validated inventory units.
- Simulated full batch and hammer-fill cycles pass before activating physical outputs.

## Stage C — Point-to-point tests

One channel at a time under authorized commissioning procedure: input high/low, correct polarity, stuck/disconnected sensor; output-to-device identity; motor stop and run feedback; gate position limits and actuator direction; full/low level input truth tables; scale units/stability/communication loss.

## Stage D — Functional tests

1. Mixer dose accurately across minimum and maximum batch sizes, under/overweight, no-change weight, scale disconnect.
2. Confirm mixer discharge to **each FB-01 through FB-08** exclusively, destination full and blocked-route behavior.
3. Confirm ingredient sourcing and inventory deduction for all enabled ingredient bins and duplicate-ingredient source selection.
4. Confirm HM-01 starts on low request, stops on full and max runtime, does not fill wrong bin, stops on path fault.
5. Test route conflicts and concurrent tasks only where physical system allows them.
6. Test user roles, manual test timeout, audit and recipe revision consistency.

## Stage E — Failure injection

- Kill the Node control process (`feedmill-backend.service`) while `feedmill-io-daemon.service` keeps running (confirm outputs go safe on command-file staleness, not latch); kill the io_daemon while the backend keeps running; unplug I/O Ethernet; disconnect scale; reboot PC; remove power while dosing, discharge, writing records and during boot.
- Verify NX output fault behavior for each output module and each class of actuator.
- Verify hardware watchdog reset actually works on selected Debian PC.
- Confirm no motion after restore until required authorization and reconciliation.
- Measure real physical DI-to-DO latency under stress: CPU load, concurrent UI clients, DB activity, scale serial traffic, packet loss scenarios. Target <30 ms on designated non-safety path; record measured maxima, jitter and test conditions. If it cannot be met, redesign timing/driver or revise the approved requirement.
- At least 100 repeated abrupt power interruptions as initial acceptance plan, including during writes/recovery; tune number/procedure with test plan.

## Required signoffs

Separate checkboxes/records for safety circuit certification by qualified parties, electrical I/O checkout, functional test results, fault behavior, recovery, recipe/inventory accuracy, runtime endurance, operator training, backups, as-built config version and site owner acceptance.

Never use software acceptance testing as proof of safety integrity.
