# 12 — Browser HMI, API and Access Control

## Function

Operate and configure mills remotely or at a local panel through a browser, with no output writes originating directly from the HMI service.

## Main navigation (REQUIRED)

Exactly six main tabs, in order:

1. **Queue:** current status, queued batches and batch scheduling.
2. **Recipes:** create/edit formulas, ingredient targets and recipe mixing time; save immutable revisions.
3. **Inventory:** current balances, usage totals, shipment entry and shipment/mix-use history by ingredient. One prominent period selector controls all usage totals and history. Bin ingredient assignments are configurable and historically versioned.
4. **Faults:** active and cleared faults, sorted by time, with acknowledgment separate from clearing/reset.
5. **System:** dynamic configured material-flow diagram; named equipment rectangles in flow order. Clicking opens a right sidebar with Hand, Auto, Off; I/O; delays, pulse calibration, RPM thresholds, overrides and applicable device settings.
6. **Settings:** main mill configuration, global rotation startup delay, enabled assets, topology/routes, I/O and commissioning/configuration lifecycle.

Required equipment colors: gray not running, red fault, green running, orange warning (including high current and speed below threshold before fault delay expires), blue disabled. Include a text status/legend so color is not the only indicator. Preserve visible override and unverified-I/O state.

Use concise industrial HMI layouts: compact tables, direct labels, high-contrast controls and no marketing content. Disabled micro systems have no normal operating controls; settings supports 0-2 systems.

See [24 - Frontend data and command contracts](24_FRONTEND_DATA_AND_COMMANDS.md) for required backend support and prototype boundaries.

## User roles

- `Operator`: select approved recipes, request batches, pause, acknowledge noncritical alarms.
- `Supervisor`: authorize material overrides, inventory corrections, operational recovery.
- `Installer/Engineer`: modify equipment/I/O/routes, run safe test modes, activate configuration.
- `Administrator`: users, backups, cybersecurity settings, software maintenance.

Role permission alone never bypasses physical interlocks or safety controls.

## Command pattern

`POST /api/v1/commands` with request ID, actor, action, target, expected state revision and parameters. API checks identity and syntax then forwards to control engine; control engine authoritatively evaluates current state and returns accepted/rejected with reason. Accepted command is **not the same as completed physical action**.

## Live state

Read-only WebSocket broadcasts machine snapshot (revision, timestamp, operating mode, batch state, equipment status, alarms, scale status, inventory). Clients reconcile by revision after reconnect. Lost browser should never leave uncontrolled direct output ownership.

## HMI rules

Prominent machine state and equipment status, clear manual/automatic mode indicator, alarm prioritization, touchscreen-friendly controls, no decorative animation needed for operational clarity, require explicit destination and confirmation for batch release.

## Queue and configuration refinement

Queue additionally includes expandable batch history and target/actual weights. Schedules and quantities follow 26; all equipment is edited through the expandable, flow-ordered Settings sections in 27. See [26 - Queue history and scheduling](26_QUEUE_HISTORY_AND_SCHEDULING.md) and [27 - Equipment configuration UI](27_EQUIPMENT_CONFIGURATION_UI.md).
