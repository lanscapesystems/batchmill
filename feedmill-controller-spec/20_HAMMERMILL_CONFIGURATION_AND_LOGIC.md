# 20 - Hammermill configuration and automatic refill

Status: confirmed requirements with explicitly proposed execution details, 2026-11-09. Supersedes example installation counts and fixed bin assignments elsewhere.

## Confirmed configuration

The system is configured per installation, within existing platform limits of 32 mixer ingredient bins, four hammermills and two micro systems. Earlier 23-bin, one-hammermill and zero-micro profiles were examples. Micro count is configurable from zero to two. Hammermill receiving bins are configurable; do not hardcode the four previously described receiving bins or treat four as a newly established maximum.

Hammermills have a separate set of source bins. Each hammermill can be configured to receive a source-bin auger from any source bin. Source selection and physical route availability are explicit configuration, not inferred from numbering. The source-bin count and whether augers are dedicated/shared remain unspecified. Source bins are distinct from ingredient bins that receive milled product and subsequently dose the mixer.

Each hammermill has an analog current transducer for monitoring motor amperage. Its discharge augers are configurable. Each hammer-refilled ingredient bin has high and low level sensors. When automatic mode is enabled for the associated hammermill, those sensors request and terminate refill.

## Configuration records

- HammerSourceBin: ID, material assignment, enabled status, source auger references and optional inventory/measurement method.
- HammerSourceRoute: source bin, hammermill, feeder auger, any additional physical equipment, required permissives and reservation resources.
- HammerMill: ID, motor command/feedback, automatic enable, eligible source routes, eligible receiving routes, current measurement, startup/shutdown and fault policies.
- HammerReceivingRoute: hammermill, ingredient destination bin, discharge augers in physical order, configured startup/stop verification, material compatibility and complete reservation resources.
- RefillPolicy: destination low/high signals and normalized meaning, request latch, priority, source selection rule, maximum runtime, sensor filtering/contradiction policy, restart criteria.
- CurrentMeasurement: analog input reference, electrical signal type/range, engineering scaling to amperes, sample freshness, valid range, filtering and diagnostic behavior. A configurable high-current setpoint pauses infeed. Threshold values, delays and resume behavior remain unresolved.

A source route and discharge route together define one complete milling operation. All referenced equipment must be commissioned and physically connected. Selection must preserve source material to receiving-bin ingredient compatibility. Changes to live source/destination selection require controlled stop and verified path clearance; never switch under running material flow.

## Proposed automatic state machine

`DISABLED -> READY -> DEMAND_PENDING -> RESERVE -> POSITION/PRECHECK -> START_DISCHARGE -> START_MILL -> START_SOURCE -> FILLING -> STOP_SOURCE -> CLEAR -> STOP -> RELEASE -> READY`

This sequencing is proposed pending OEM/installation-specific startup and clearing requirements. Dependency records determine actual order, delays and proof of readiness; generic ordering is not a hardware guarantee.

- Normalize electrical inputs into LOW_DEMAND (material below configured low threshold) and HIGH_REACHED (at/above high threshold). The wiring polarity is configured separately.
- In READY with automatic enabled, valid LOW_DEMAND latches a refill request. Once filling starts, clearing LOW_DEMAND does not stop the fill; HIGH_REACHED terminates it. This gives low/high hysteresis.
- HIGH_REACHED inhibits a start and takes priority over a low request. An impossible normalized low/high combination raises a sensor diagnostic and blocks automatic feeding. Exact debounce, persistence and fault-reset rules require configuration.
- Choose an eligible material-compatible source and destination using explicit rules. Proposed deterministic arbitration is configured priority then oldest request; no implicit ingredient substitution or automatic source switch.
- Atomically reserve the selected source auger/path, hammermill, discharge augers/path and destination. Multiple hammermills may operate together only when configured paths/resources do not conflict.
- Establish the complete receiving path before admitting source material. Validate required feedback and current-measurement quality according to the configured readiness policy.
- During FILLING, monitor high level, motor/auger status, current measurement, route validity, elapsed runtime and automatic/operator commands. High level stops further source feed and begins the configured controlled completion sequence.
- Reaching full cannot be the only supervision: a failed high sensor must not permit unlimited run. Define maximum runtime and relevant process protections before activation.
- Disabling automatic mode prevents new automatic starts. Exact handling of an already active fill (controlled finish versus immediate source stop and clearing) remains to be decided; it must be an explicit policy.
- Unknown sensor state, route fault or lost current telemetry invokes an explicit failure response. Healthy current telemetry alone cannot prove material flow or available destination capacity.
- Fault reset and restored power do not automatically resume an interrupted fill. Reconcile source, mill, discharge path and destination before rearming.

## Current monitoring boundary

Confirmed: measure/display amperage and retain quality/status. Each hammermill has a configurable high-current infeed-pause setpoint in amperes. High current requests a pause of the active source infeed auger; it is not an instruction to stop the hammermill motor or its discharge path. Their continued operation remains subject to normal permissives and fault policies.

Each hammermill source infeed auger optionally supports an analog output for VFD speed setpoint. Fixed-speed augers remain supported without an analog output. Configure the analog channel, electrical range, speed engineering units/range, allowed command bounds and normal operating speed per equipped auger. Keep run/stop authorization separate from speed reference; zero analog output must not be assumed to prove a stopped auger.

Proposed load-hold substate: FILLING -> INFEED_LOAD_PAUSED on valid current meeting the configured high-current criterion. Retain route/source/destination ownership and demand. High destination level, fault, operator stop or automatic-disable policy takes precedence over a load-based resume. Threshold comparison, persistence, startup grace, resume setpoint/hysteresis, resume dwell, automatic versus operator resume, maximum hold and invalid-current behavior must be specified before enabling this feature. Do not infer automatic restart solely from current falling below the pause setpoint.

Optional VFD speed output does not imply closed-loop speed regulation. Continuous current-based speed modulation, underload/stall detection and automatic retry are not established requirements. Electrical scaling is not assumed to be 4-20 mA or 0-10 V until hardware is identified. Define analog output on pause, fault, communication loss and boot, alongside the separate run command.

Development priority: hammermill load/infeed regulation is low priority. See [development to-do list](21_DEVELOPMENT_TODO.md). Recording the requirement does not mark it implemented; a configuration that requires it cannot be commissioned with this behavior silently absent.

## Inventory and concurrency

Mixer ingredient consumption continues to come from the mixer scale. Low/high levels and hammermill amperage are not mass measurements. Refill/source inventory quantities remain estimated unless a real mass measurement exists. Keep source consumption and receiving-bin receipt as linked transactions with quality and idempotency keys.

Proposed initial exclusion: do not refill and dose from the same ingredient bin concurrently. This policy needs process confirmation; it prevents unmeasured inflow from undermining source inventory reconciliation. Other refill and batch operations may coexist when resources and process rules permit. Micro preparation does not claim hammermill resources unless physically shared.

## Unresolved configuration and control details

- Source-bin count, source auger identity/shared use, material assignments and permitted source-to-mill routes.
- Receiving assignments, discharge auger topology, destination priority and source selection policy.
- Transducer model, analog input hardware/scaling, current thresholds and any requested control response.
- Level sensor polarity/placement, filtering, runtime limits, startup/shutdown delays and feedback availability.
- Automatic-disable behavior during fill, batch pause interaction, and same-bin refill/dosing concurrency.

## Acceptance cases

- Any configured source route can feed its assigned mill; an unconfigured or incompatible route is rejected.
- Low latches a demand, leaving low does not cancel filling, and high terminates source feeding.
- Full at request time prevents startup; invalid/contradictory level states block automatic feeding.
- Two mills contending for a shared source/discharge auger cannot both reserve it.
- Analog samples convert using explicit scaling; stale/out-of-range values never display as valid zero amperes.
- Automatic disabled prevents new fills; active-fill behavior follows the selected policy.
- Repeated level transitions or restarts do not duplicate inventory postings or replay motor starts.

- High current pauses source infeed and retains the operation; reaching high bin level while load-paused prevents a subsequent feed restart.
- Fixed-speed source augers require no analog output; VFD-equipped augers enforce configured scaling, bounds and separate run authorization.
