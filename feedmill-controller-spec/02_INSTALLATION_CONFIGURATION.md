# 02 — Installation Configuration and Capacity

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

## Function

Produce a validated, versioned installation definition that enables exactly the installed equipment, I/O, and routes without recompiling the application.

## Configurable platform capacity

| Component | Maximum | Installation selection |
|---|---:|---|
| Ingredient bins | 32 | Enable bins and map a discharge auger for each |
| Weighed main mixer | 1 | One motor and main scale; optional stuffer |
| Finished bins | 8 | Enable bins and configure each unload route |
| Micro systems | 2 | Enable 0, 1 or 2; configure individual hoppers and weighed drag |
| Hammermills | 4 | Configure source-bin augers, receiving bins and discharge augers |
| Hammermill source bins | Unspecified | Separate source registry; count to be configured, no invented maximum |

Earlier 23-bin and zero-micro deployment profiles were illustrative. Hammermill receiving-bin assignments are configurable, not fixed to numbered bins.

## Installation data model (PROPOSED)

`Installation(id, label, location, units, timezone, timezone_history_policy, config_revision, commissioning_status)`

`Equipment(id, type, display_name, enabled, parameters, feedback, permissives, fail_action)`

`IOPoint(id, adapter_id, module_slot, channel, direction, electrical_type, invert, scaling, debounce, ownership)`

`MaterialNode(id, equipment_or_storage_id, port)`; `MaterialEdge(from, to, condition, type)`; `Route(id, source, target, equipment_actions, startup_sequence, clearout_sequence, constraints)`.

`StorageBin(id, bin_kind, capacity, assigned_ingredient, inventory_method, fill_routes, discharge_routes)`.

`Scale(id, port_identity, protocol, unit, stability, freshness_timeout, calibration_reference)`.

## Machine-readable draft

See [installation.draft.json](installation.draft.json). It defines capacity and configuration contracts without presenting fictional equipment as installed. Empty registries and null fields are deliberately not production-ready. Hammermill source bins are distinct from mixer ingredient receiving bins; route records establish actual connectivity.

## Config lifecycle

1. Installer creates or imports draft configuration.
2. Validate schema, maximum counts, unique IDs, no duplicate physical output assignment, scale protocol, I/O electrical compatibility, route reachability, cycles/conflicts and required feedback.
3. Simulate the proposed installation and run preflight checks.
4. Require stopped / de-energized operating state and authorized engineer approval before activating changes impacting equipment, I/O or routes.
5. Commit new immutable configuration revision, record diff, who/when/why, and retain rollback version.
6. Reload only once the control engine has acknowledged the safe transition; prevent mid-batch revision changes.

## Operational modes

`DISABLED` (not installed) / `COMMISSIONING` (safe tests only) / `AVAILABLE` / `OUT_OF_SERVICE` / `FAULTED`. A disabled micro system must not create startup faults or operator controls.
