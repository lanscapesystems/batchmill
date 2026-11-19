# 06 — Weighing, Serial Scales, Dosing

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

## Function

Produce trustworthy weight measurements, control feeder cutoffs, reject invalid/stale readings and store actual consumed or produced masses.

## Scale adapter contract

```text
ScaleReading {
  scale_id
  weight
  unit
  stable
  motion
  overload
  communication_valid
  sample_timestamp_monotonic
  sequence_number
  raw_status
}
```

The driver must decode the actual indicator protocol (TBD), frame/sanity/checksum validate, convert to canonical units, reject out-of-range and stale data, and report disconnects separately from zero weight.

## Installer scale configuration

Persistent serial identity, speed/parity/stop bits, device protocol, polling versus streaming, baud/line timeout, scale capacity, resolution, decimal position, units, communication freshness threshold, indication stability criteria, optional supported tare/zero commands, calibration reference and last verification date.

Calibrations requiring physical certified weights must follow the chosen indicator's manual and regulatory requirements; no blind software calibration.

## Dosing sequence (per ingredient)

`PRECHECK -> OPEN/RUN FAST -> OPTIONAL SLOW FEED -> COAST/CUTOFF -> SETTLE -> VERIFY -> COMPLETE/FAULT`

- Each feeder can define max feed time, coarse-to-fine threshold, predicted material in flight, minimum stable interval, cutoff error tolerances, top-off/retry policies, underweight/overweight handling.
- Cutoff compensation is learned from valid completed cycles only; bounded per feeder and ingredient. Ignore corrupt samples or outliers.
- For cumulative weighing, record stable weight **before** and **after** each ingredient, compute difference, and protect against tare changes or other simultaneous inflows.
- Explicitly prohibit negative/physically impossible inventory deltas except through controlled adjustments or reversal handling.
- No silent automatic retries after an overfill fault. Operator intervention can be required.

## Timing concerns

`<30 ms` applies only to declared I/O response paths; the actual scale update interval and serial latency must be established. Millisecond loop timing does not imply that a scale provides millisecond-valid changes.

## Testing

Valid frame, malformed frame, serial unplug, freeze-last-value, indicated motion, overload, negative weight, discontinuity, unit mismatch, tare during dosing, ingredient switching, reboot mid-dose and feed cutoff overshoot.
