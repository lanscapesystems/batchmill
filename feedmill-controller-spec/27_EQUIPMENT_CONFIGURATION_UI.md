# 27 - Complete equipment configuration in Settings

Status: required UI organization with proposed backend contract, 2026-11-09. Supersedes count-only prototype configuration described in 24.

## Organization

All configured equipment is available in Settings. Stack equipment in approximate physical-flow order within sections: hammermill source bins/infeed; hammermills/discharge; ingredient bins/discharge; micro systems; mixer/stuffer/scales; unload equipment; finished bins/gates. Selecting any equipment expands its configuration in place. Support add, edit and remove without recompilation; preserve stable IDs and show disabled equipment as configurable.

The System diagram and Settings use the same equipment and connection records. Configuration changes update names, connections and displayed I/O without maintaining a separate count-generated model. Infer layout order from material-flow edges, not from numbering. Store named subassemblies/route ordering explicitly for shared equipment and alternate paths. Scale-to-vessel association is a measurement relationship, not a material-flow edge.

## Device configuration

- Every record: stable ID, name, equipment class, system/assembly membership, installed/enabled state, upstream material connections and commissioning state.
- Motors/augers/elevators: run output, starter auxiliary input, optional rotation pulse input, pulse calibration, minimum RPM, fault/start/stop delays and selected feedback overrides. Rotation startup delay remains global.
- Hammermills/source infeed: allowed source/discharge connections, analog current mapping, high-current pause setpoint; optional VFD output, electrical scaling and normal speed command. Current-based regulation remains low priority despite configuration fields existing.
- Gates/valves: actuator outputs, commanded positions, limit inputs, movement/fault delays and individual feedback overrides.
- Bins/hoppers: ingredient/category assignment, capacity, high/low inputs and permitted receiving/dispensing routes. Micro hopper records identify system 1 or 2. Finished bins additionally configure product/destination rules and unload motor order/gate positions.
- Scales: vessel association, protocol, persistent port, units/limits, freshness/stability and calibration references.

Each destination unload definition supports up to five augers, one elevator and ten gates/valves. Start order is downstream-first; required gate positions and confirmations precede motor startup. The prototype provides editable motor-ID order and gate position lists; full production route records must also carry transfer, clearing, fault and pause policies.

## Backend lifecycle and validation

Use one typed installation draft with revision/optimistic concurrency. Save equipment and its references transactionally. Reject duplicate IDs, duplicate physical output ownership, unknown references, capacity excess, invalid units/durations, unsupported pulse acquisition and contradictory or cyclic startup dependencies. Material loops require explicitly modeled transfer operations; the prototype rejects graph cycles outright. Permit incomplete draft mapping for design work; do not mark it commissioned or production-ready.

Validate each unload path's actual connectivity, downstream order, gate position consistency and physical capacities. Backend must not use approximate diagram layout rank as proof of a valid route. Runtime overrides are audited commands, not mutations of raw telemetry or silent configuration activation.

Remove only after resolving inbound connections, scale references, route membership, active operations, reservations and material inventory. Ingredient reassignment must preserve historical ledger identity and requires reconciliation of occupied storage. Class/category changes have the same reference constraints.

Production activation retains stopped-state approval and immutable revision rules in 17. Prototype saves apply immediately to simulated equipment and browser storage; they are not production activation. Counts are derived from equipment records, not an alternative topology source. Platform limits remain 32 ingredient bins, 8 finished bins, 4 hammermills, one main mixer and up to two micro systems.

## Current prototype model (2026-11-11)

Equipment uses a flat model — all items are top-level records in EQUIPMENT_DEFS with type prefix + number IDs (B-1, HM-1, MX-1, MD-1, A-1, GT-1, FB-1). There are no parent-child hierarchies; augers, micro drags, and gates are independent equipment. The Settings tab renders an interactive SVG flow path diagram where clicking a block opens a sidebar configuration panel.

### Equipment types and configuration fields

| Type | Prefix | Settings panel fields |
|---|---|---|
| Ingredient Bin | B | ID, Name, Capacity |
| Hammer Mill | HM | Motor fields, High Current Pause Setpoint (when analog load assigned), Auto Enable |
| Micro Drag | MD | Motor fields |
| Mixer | MX | Capacity, Run Output (DO), Run Confirmation Aux (DI), Analog Load Input (AI) → Min Amps / Max Amps / Motor FLA, Scale fields |
| Auger | A | Motor fields, Master VFD checkbox → VFD Run Output (DO), VFD Aux Input (DI), VFD Fault Delay (s) |
| Gate | GT | ID, Name |
| Finished Bin | FB | ID, Name, Capacity |

### Motor fields (shared by HM, MD, A)

All motor-driven equipment shares these base fields:

- Run Output (DO)
- Run Confirmation Aux (DI) — always on=running, no polarity setting
- Rotation Pulse Input (DI) → if assigned: Pulses per Rev, Min RPM, Rotation Startup Delay (ms)
- Start Delay (ms), Stop Delay (ms)
- Analog Speed Output (AO) → if assigned: Speed Min %, Speed Max %, Speed Min Limit %, Speed Max Limit %
- Analog Load Input (AI) → if assigned: Min Amps (A), Max Amps (A), Motor FLA (A)

Analog input scaling: min/max amps define the range at min/max counts (counts configured in Global IO Settings). Motor FLA converts raw amps to percent load.

Analog output scaling: speed set in percent via the System tab sidebar. Settings define min/max % at min/max counts and min/max % limits to clamp the operator's setpoint range.

### Master VFD (auger-only)

A checkbox at the bottom of the auger settings panel. When enabled, adds:
- VFD Run Output (DO)
- VFD Aux Input (DI)
- VFD Fault Delay (s)

This is only available for auger equipment, no other types.

### Global settings

- Motor Starter Fault Delay: seconds (default 0.5 s)
- All fault delays throughout the system are in seconds, not milliseconds
- IO pool count ranges configured globally, not per-equipment

### Default installation

- 2 hammer mills (HM-1, HM-2)
- 12 ingredient bins (B-1..B-12)
- 2 micro drags (MD-1, MD-2)
- 1 mixer (MX-1)
- 1 gate (GT-1)
- 4 finished bins (FB-1..FB-4)
- 20 augers (A-1..A-20)

### System tab

The System tab displays an interactive SVG flow path diagram using the same equipment positions and connections as Settings. Blocks are solid-filled rectangles showing only the equipment ID in bold white text. Block colors indicate status:

- Gray (#424242): Auto mode, not running
- Green (#2e7d32): Running (aux input confirmed when configured)
- Purple (#4a148c): Off or disabled
- Red (#b71c1c): Faulted

Selected equipment is indicated by a pink (#e91e8a) rectangle with 6px padding around the block. The sidebar shows equipment name, type, status, Hand/Auto/Off mode buttons, speed control (range slider clamped to min/max limits when analog speed output is configured), and overrides.

### Inventory tab

All units are in lbs throughout the system. Ingredient and micro hopper bins display a dropdown for ingredient assignment; the dropdown is only enabled when the bin balance is below 100 lbs. Finished bins show balance and level with no ingredient assignment.

### Recipes tab

Recipe lines display targets in lbs for both main ingredients and micro ingredients.

### UI interaction pattern

Settings: click equipment block in the flow path SVG to open its configuration sidebar. The sidebar shows all editable fields with IO pool dropdowns and numeric inputs. Changes apply immediately to simulated equipment.

System: click equipment block to select it and open the status/control sidebar. Mode buttons (Hand/Auto/Off) and speed slider are live controls.

## Prototype coverage and remaining work

Implemented: flat equipment model with SVG flow path diagram (shared between Settings and System), motor fields with analog IO scaling, Master VFD for augers, status-colored system blocks, speed control, ingredient bin assignment with balance guard, all units in lbs.

Still required for production: hardware adapter/module/channel editors and acquisition capabilities, complete route/pause/failure policies, exact electrical scaling and calibration records, draft review/activation, role checks, multi-client concurrency and actual command acknowledgments. The prototype stores human-readable channel references without asserting they address real hardware.
