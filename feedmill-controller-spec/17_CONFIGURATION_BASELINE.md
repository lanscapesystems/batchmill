# 17 ? Installation baseline and activation contract

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

Status: PROPOSED development contract, 2026-11-09. Confirmed counts come from 00_README; equipment connections remain unconfirmed. This document refines 02 and does not establish as-built wiring.

## Configuration layers

1. Platform limits: 32 ingredient bins, 8 finished bins, one main mixer, 4 hammer mills, 2 micro systems.
2. Installation revision: installed assets, physical topology, I/O mapping, scale protocol, equipment parameters, routing and fault policies. Immutable once activated.
3. Recipe revision: ingredient quantities, ordering, tolerances and mixing program. Frozen for each batch.
4. Runtime state: availability, reservations, actual inventory, alarms and operation progress. Never stored as configuration defaults that can energize machinery on boot.

## Configurable installation baseline

| Asset | Installed baseline | Operational eligibility |
|---|---|---|
| Ingredient storage | Up to 32 enabled bins, each with discharge auger | Per-bin commissioning, ingredient assignment and verified dispensing route |
| Main mixer | One motor; mixer itself is weighed | Capacity, drive, optional stuffer and discharge mapping required |
| Scale | SC-01 logical placeholder | Indicator, physical vessel, serial protocol and freshness parameters required |
| Finished storage | FB-01 through FB-08 | Capacity and individual receiving paths required |
| Hammer mill | HM-01 | Source, eligible destinations, feeder and ancillary interlocks required |
| Micro systems | Configurable 0-2 | Disabled systems have no driver connections or runtime controls |
| Remote I/O | NX-EIC202 target | Exact coupler identity, modules, assemblies and channel map required |
| Controller | Debian industrial x86 target | Exact PC, storage, watchdog and power-on behavior required |

IDs identify logical assets and do not imply a dedicated feeder, motor, sensor or physical connection. Pounds in the original example remain a proposed display unit until confirmed. Persist quantities with explicit units; reject incompatible units.

## Required records

| Record | Required information |
|---|---|
| Equipment | ID, class, installed status, command/feedback signals, parameters, permissives, fault response, commissioning evidence |
| Signal | ID, adapter/module/channel, direction, electrical type, polarity, debounce, quality/freshness, owner |
| Storage | ID, material assignment, usable capacity and unit, measurement method, level signals and meaning, receiving/dispensing eligibility |
| Scale | ID, weighed vessel, persistent port, protocol, serial settings, unit/resolution/capacity, validity/stability/freshness rules |
| Route | Source/destination, ordered physical segments, actuator positions, complete resource set, start/stop dependencies, transfer and empty evidence, clearing policy |
| Timing policy | Named duration, value/unit, applicable equipment/state, derivation, commissioning result |
| Failure policy | Trigger, affected scope, immediate inhibition, permitted clearing, reset criteria, recovery/disposition |

A missing sensor is represented as absent. A missing engineering value is null, never zero or an invented default. Absence of feedback requires an explicitly reviewed alternative verification policy; a timer alone is not assumed equivalent to feedback.

## Validation and activation

Draft configurations may contain nulls and incomplete topology for design work. Production activation rejects missing required values, duplicate physical output ownership, unknown references, incompatible units, unsupported scale protocol, inaccessible routes and uncommissioned dependencies. Validate dependency graphs for cycles and contradictory actuator positions. Verify quantity bounds, min/max relationships and finite positive timeout values.

Activation requires no active operations, outputs in their validated inhibited state, no unresolved material disposition, authorized engineering action, and successful simulator/preflight results. The engine acknowledges the new immutable revision before accepting production commands. Existing reservations are never carried across revisions. Retain the previous revision for a deliberate rollback through the same checks.

## First field decisions

1. RESOLVED: MX-01 is itself weighed and has one motor. Confirm scale hardware and optional stuffer installation.
2. Trace each ingredient path, finished-bin path and hammer refill path with equipment IDs. Do not populate fictional routes.
3. Record mixer minimum/maximum working mass, mixing program, drive behavior during filling/discharge, gate operation and empty criteria.
4. Record scale and I/O hardware details and actual feedback availability.
5. Confirm bin capacities, sensors, refill priorities, units and material compatibility rules.

See 18 for proposed control behavior. The machine-readable companion installation.draft.json intentionally cannot activate production.
