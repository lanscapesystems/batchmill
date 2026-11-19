# 24 - Frontend data and command contracts

Status: required UI behavior from user, proposed API shape, 2026-11-09. The runnable frontend in ../hmi-prototype is a simulator, not an implementation of these backend services.

## State delivery and commands

Initial snapshot plus revisioned live events contain configuration revision, server timestamp, connection/freshness quality, current operation, queue, equipment, faults and active overrides. Reconnect fetches a fresh snapshot or a verifiably contiguous event range. Detect stale telemetry visibly; do not show disconnected I/O as valid OFF. Authoritative state and status are computed in the control engine, not inferred by browser color logic.

Continue the versioned POST /api/v1/commands envelope: request_id, authenticated actor, action, target_id, expected_state_revision and parameters. Backend derives actor identity from the authenticated session. Return command ID, accepted/rejected reason, resulting revision and completion events. Pending commands do not optimistically imply physical completion. Commands are idempotent and conflicts return a refreshable rejection.

## Queue and recipes

Queue data: stable order, batch ID, recipe ID and frozen revision, ingredient/source plan, target mass with unit, destination, requested release time, state, validation blockers and reservation status. Current batch includes independent main/micro progress, ingredient target/actual and quality, recipe mixing elapsed/remaining time, unload substep, pause state and reasons.

Actions: queue, reorder, reschedule, cancel queued, start, pause, resume, abort. Scheduling stores UTC plus installation timezone and explicit daylight-saving ambiguity resolution. Requested release time is distinct from actual start. Scheduled release must revalidate all prerequisites; late/blocked batch behavior and unattended auto-start policy remain decisions. Expose blockers rather than silently skipping an order. Abort with material requires disposition.

Recipe drafts are separate from saved immutable revisions. Save returns a new revision; queued/active batches retain their snapshot. Require positive target quantities, units, valid ingredients, capacity/tolerance compatibility and valid mixing duration. Approvals and permissions follow 07/12. Never mutate a saved revision when a form is merely edited.

## Inventory period and provenance

Provide current bin balances separately from period aggregates. Query accepts inclusive start/exclusive end UTC, installation timezone, optional ingredient/bin/type filters and pagination. Return totals with units and quality, plus immutable ledger rows sorted by time and stable ID. Usage means posted consumption, not reserved stock; shipment means posted receipt. HMI period selection applies consistently to usage totals and logs, not to current balances.

Ledger rows retain ingredient ID at transaction time, bin ID, quantity/unit, measurement quality, type, batch/shipment reference, actor, timestamps and idempotency key. Reassigning a bin must not rewrite historical ingredient usage. Ingredient assignment has effective time/revision and requires material reconciliation if the bin is nonempty or owned by an operation.

Shipment entry validates compatible bin assignment, capacity, positive quantity/unit and reference, then commits one idempotent receipt transaction. Corrections use linked reversals/adjustments. Main and micro consumption follow their respective valid scales; do not double-post micro receiving checks. Current totals and aggregates come from one consistent ledger revision.

## Fault history and equipment presentation

Faults expose raised_at, cleared_at, acknowledged_at/by, active, severity, equipment/operation, message/code, reset eligibility and cause. Sort by raised_at descending with ID tie-breaker; optionally filter active/cleared. Acknowledge, cause clearance and reset are distinct events. Never delete a cleared fault to remove it from the active list.

Equipment snapshot: ID/name/class, mode, authoritative status and reasons, upstream inhibition, active operation/route owner, commanded outputs, raw feedback, effective feedback/permissives, RPM/current values and quality, delay timers, active overrides and current settings revision. Before low-speed persistence expires, emit warning rather than fault; high-current load hold is a warning unless another fault applies.

Status precedence proposed: fault > disabled > warning > running > not_running; retain all concurrent reasons. Off never hides a latched fault. Upstream-inhibited equipment is not shown running just because its requested mode is Hand. Indicate unknown/stale feedback separately from all five process colors.

## System diagram and equipment sidebar

Topology provides nodes with stable IDs, names, class and installed/enabled flags; directed physical-flow edges; route membership, gate positions and source/destination assignments. Layout follows material-flow order, retaining branches for source bins, hammermills, ingredient augers, micros, optional stuffer, mixer and finished-bin paths. Shared assets appear once with shared connections. Do not derive physical connectivity from equipment count, ID order or name alone. Resolve cycles with explicit transfer-loop layout; preserve node identity/layout through telemetry updates.

Sidebar top actions map to equipment mode requests: Hand is manual run/open request, Auto returns control to authorized sequences, Off disables ordinary operation and requests its defined stop. Engine validates ownership, remaining feedback/overrides, interlocks and flow constraints; switching modes never steals equipment from an active batch. Valve actions must identify commanded position. Storage has no invented motor run output.

Show raw inputs/outputs with mapping, quality and timestamps; overridden checks remain explicitly unverified. Device-specific settings include start/stop/fault delays, pulse input enable, pulses/revolution, minimum RPM, feedback overrides, applicable current setpoint and optional VFD speed command. Rotation startup delay is edited globally in Settings and displayed read-only in device panels.

Separate settings edits (validated configuration revision, stopped-state activation rules) from runtime feedback-override commands. Override enable/disable is individually targeted and audited with actor/reason; production authorization, expiry and reboot policy are still unresolved in 23. An override is neither run command nor fault reset.

## Proposed read resources

- GET /api/v1/state and GET /api/v1/events?after_revision=...
- GET /api/v1/queue; GET /api/v1/recipes; GET /api/v1/recipes/{id}/revisions/{revision}
- GET /api/v1/inventory/balances; GET /api/v1/inventory/usage; GET /api/v1/inventory/ledger
- GET /api/v1/faults; GET /api/v1/topology; GET /api/v1/equipment/{id}
- GET /api/v1/configuration/active; GET /api/v1/configuration/drafts/{id}

Command actions include SetEquipmentMode, SetFeedbackOverride, AcknowledgeFault, RequestFaultReset, PostShipment, ChangeBinIngredient, SaveRecipeRevision, SaveConfigurationDraft and ActivateConfiguration, in addition to batch commands. Exact transport/schema remains proposed; no browser writes physical outputs.

## Prototype coverage and limits

Prototype provides six navigable tabs, local queue/scheduling, editable recipe revisions, shipment posting and period filtering, fault acknowledge/simulated clearing, count-driven sample topology and equipment sidebar settings/overrides. Browser storage persists one local simulator; export downloads JSON. Example equipment/weights are not an installation survey.

The sample diagram responds to enabled counts and optional stuffer; arbitrary physical topology editing, route assignment, source-bin selection and full per-device VFD/current configuration remain future work. Process advancement is explicit simulation and does not implement physical weighing, timed execution or automatic ledger consumption. No live backend, authentication, multi-client synchronization, production configuration activation, hardware commands or safety functions are connected.

Verify the production implementation against command rejection/stale state, historical ingredient reassignment, scheduler timezone transitions, unverified feedback, pause during unload and stable graph identity under telemetry updates before hardware commissioning.

## Ingredient category refinement

[25 - Ingredients and micro ingredients](25_INGREDIENT_CATEGORIES.md) requires separate catalogs, recipe sections and inventory groups, with category-matched bin/hopper assignments and receiving. Combined batch totals include both groups; ledger history retains original material/category.

## Queue and configuration refinement

Sections 26 and 27 supersede earlier prototype limits: queue/history now has expandable weights and recurring single-row quantities; Settings now edits equipment and explicit flow connections, and the diagram uses those same records. See [26 - Queue history and scheduling](26_QUEUE_HISTORY_AND_SCHEDULING.md) and [27 - Equipment configuration UI](27_EQUIPMENT_CONFIGURATION_UI.md).
