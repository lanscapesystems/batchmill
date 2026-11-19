# 10 — Microingredient Systems (Platform Capability)

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

## Status

Installation configuration enables **0, 1 or 2 systems** without changing source code. Earlier zero-system examples do not define the installation.

## Function

Each micro system is a weighed hopper drag / vessel supplied by a configurable row of small ingredient hoppers with augers. Prepare a micro batch associated with a particular main batch, then transfer into the mixer when an authorized compatible route is available.

## Equipment/configuration

`MicroSystem(id, enabled, scale_id, weigh_vessel_or_hopper_drag, discharge_actuator, micro_hoppers[], transfer_route, capacity, tolerance_policy, cleanout_policy)`.

`MicroHopper(id, ingredient_id, feeder, optional_level_switches, inventory, dosing_parameters)`.

Do not assume a fixed number of micro hoppers; hardware module limits may constrain real installations.

## Operation

`EMPTY/READY -> RESERVE FOR MAIN_BATCH -> VERIFY SCALE -> DOSE INGREDIENTS -> SETTLE/VERIFY -> AWAIT MIXER RECEIVE -> DISCHARGE -> VERIFY EMPTY -> COMPLETE`.

- Never transfer material prepared for a different main batch; enforce immutable main batch ID binding.
- Permit both micro systems to prepare simultaneously only when resources permit.
- If recipe or main batch is canceled, put prepared micro material into a named disposition/recovery state; do not blindly discard or transfer.
- Inventory postings based on actual per-hopper mass, respecting shared cumulative scale measurements.

## Behavior when disabled

No scale connections, I/O requirements, startup errors, routing choices, or ordinary operator controls for that system. Configuration remains schema-valid with empty equipment set.

## Ingredient category refinement

[25 - Ingredients and micro ingredients](25_INGREDIENT_CATEGORIES.md) requires separate catalogs, recipe sections and inventory groups, with category-matched bin/hopper assignments and receiving. Combined batch totals include both groups; ledger history retains original material/category.
