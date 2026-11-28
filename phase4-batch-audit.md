# Phase 4 audit: batching (backend `mill.ts`, HMI `queue.tsx`)

Static read of `feedmill-backend/src/mill.ts` (QueueBatch … UnloadBatch, advanceBatch, advanceDosing, recovery) and the HMI queue tab. Nothing run on hardware.

**On "the frontend just runs a simulation":** the HMI has no local simulation. Connected, it only renders the backend's queue and active batch; disconnected, it shows nothing. The fake behaviour is in the backend: with no scale mapped, dosing weight is invented (finding 1). Batch *logic* lives only in the backend, which is the right place, but it has the gaps below.

## P0 — wrong material or runaway feeding

1. **Invented weight when no scale is mapped.** `updateStepActual` adds `target × 100ms / 5000ms` per scan, `VALIDATING` skips the scale wait, and `pending` takes a zero baseline. A batch "completes", deducts bin inventory, and credits the destination bin with weight that never existed. *Fix:* no mapped, valid mixer scale = batch cannot start (reject in StartBatch, fault in VALIDATING). If a dry run is wanted, make it an explicit per-batch flag that posts no inventory.
2. **Scale invalid or unstable mid-batch is ignored.** `getMixerScale` returns an invalid reading (weight 0). `updateStepActual` never checks `valid`/`stable`, so actual = 0, the target is never reached, and the auger feeds forever. There is no feed timeout, no no-progress timer and no over-target check. *Fix:* scale invalid → hold feeders and pause with a reason; per-step feed timeout and no-weight-change timeout → fault; overfeed beyond a tolerance → stop and fault.
3. **E-stop / tripped auger not handled in DOSING.** `advanceBatch` only pauses when equipment the batch *owns* is in `fault`. An e-stop or a stopped auger leaves the step in `feeding`, which with finding 2 never ends. *Fix:* pause the batch on e-stop and on any owned equipment not running while it has a request.
4. **Steps are not validated.** `QueueBatch` builds steps with `sourceBinId: ''` / `augerId: ''` when the ingredient has no bin or the bin has no connection. `findAugerForBin` returns the first connection from the bin without checking it is an auger. Nothing checks bin balance against the target, that the auger is in Auto, or that the destination exists and is a finished bin. *Fix:* validate every step in VALIDATING and fault with the specific reason.
5. **Discharge ends on a timeout without a fault.** `DISCHARGING` goes to `CLEAROUT` after 60 s whether or not the mixer emptied (threshold `< 10 lb` is hard-coded), then `COMPLETED`, crediting the destination with the sum of `step.actual`. *Fix:* timeout = hold/fault ("mixer not empty"), configurable empty threshold; credit what was dosed only once discharge is confirmed.

## P1 — correctness

6. **Discharge gate is the first gate in the map.** `findGateForDischarge` returns any gate; with more than one gate it can pick the wrong one. `ROUTE_PRECHECK` proceeds with no gate at all (no path validation). *Fix:* find the gate(s) on the connection path mixer → destination (the `gatePortToward` traversal already exists).
7. **Requested batch size is ignored.** `QueueBatch` accepts `targetMass` but dosing steps use the recipe's `line.target` unscaled, so a different size is stored but never applied. *Fix:* scale line targets by `targetMass / recipe total`, or drop the parameter.
8. **Abort and Unload flow is broken.** `AbortBatch` nulls `activeBatch`, so `UnloadBatch` then rejects "No active batch". The HMI's Unload button only shows while an active batch exists, so after an abort it is never reachable. The mixer is left holding material with no way to discharge it. `UnloadBatch` also marks any batch `COMPLETED` without consuming inventory. *Fix:* abort moves the batch to a held `ABORTED_UNLOAD` state; Unload discharges, then closes it.
9. **Inventory drift.** Consumption posts only at `COMPLETED`. An aborted or faulted batch that already dosed material deducts nothing from the bins. *Fix:* post consumption for dosed steps on abort/fault too.
10. **Queued batches are lost on restart.** Only the active batch is persisted and recovered. `QueueBatch` doesn't persist. *Fix:* persist queue entries.
11. **Recovery precision.** Step `actual` is persisted every 5 s; recovery resumes PAUSED at the persisted state and relies on the scale still holding the same weight. *Fix:* on resume, re-baseline against the current scale weight minus persisted actual, and check it still matches.

## P2

12. No tolerance check on a finished step (under/over target is accepted silently, no deviation record).
13. Units: step unit comes from the recipe line; the inventory events assume `lbs`/`unit` without conversion.
14. Single-mixer assumption (`findEquipmentByType('mixer')`).
15. Not audited yet: micro-ingredient dosing path (`microLines`), refill interaction with a running batch, hammermill destination changes mid-batch.

## Suggested order
Fix 1–5 first (they change what material is made and recorded), with a backend test for each. Then 6–8 together, then 9–11.

---

# Re-audit after the Phase 4 build

Checked against the code and `feedmill-backend/src/batch.check.ts` (one test per finding, all passing with the other suites). Browser-checked on a scratch backend: Run/Hold, the queue-time warnings popup, the waiting reason, the new batch form, the bin/mixer settings fields. Nothing run on hardware.

| # | Finding | Status |
|---|---|---|
| 1 | Invented weight with no scale | **Fixed.** `updateStepActual` and every no-scale branch are gone; no valid, stable, empty mixer scale = the batch waits in the queue with the reason. |
| 2 | Invalid / unstable scale ignored mid-batch | **Fixed.** Scale lost while feeding stops the auger and pauses the batch; settling waits for a valid stable reading; Resume needs the scale back. New no-flow watchdog (delay per bin, default 60 s, then a minimum rise per 10 s). |
| 3 | E-stop / tripped auger not handled in DOSING | **Fixed.** E-stop pauses the batch with a reason (it did pause before, with none); owned-equipment trips already paused. |
| 4 | Steps not validated | **Fixed** (release gate: bin, auger, Auto, not faulted, destination, flow path, gates). Not checked: a *bin* trip (bins have none). |
| 5 | Discharge ends on a timeout | **Fixed.** Empty = valid, stable, below the threshold; then the mixer's Cleanout Time; a timeout alarms and pauses the batch (Resume retries). |
| 6 | Wrong discharge gate | **Fixed.** Gates come from the flow path mixer to destination, each with the outlet toward the next hop. Mixer is re-requested after a pause (it was not before). |
| 7 | Batch size ignored | **Fixed.** Size scales every line. |
| 8 | Abort / Unload broken | **Fixed.** Abort with material gives ABORTED_HOLD; Unload (to the original or another finished bin) or Discard once empty. |
| 9 | Inventory drift on abort / fault | **Fixed.** Dosed material is deducted once however the batch ends. |
| 10 | Queued batches lost on restart | **Fixed.** Whole batches saved as JSON (queue order too); queue comes back on Hold. |
| 11 | Recovery precision | **Fixed.** Saved every second while feeding; Resume compares the scale with saved progress and asks. |
| 12 | No tolerance check | **Fixed.** Hold for the operator with Ignore / Update freefall / Abort; auto freefall calibration as in the PLC. |

Found and fixed while building:
- A finished batch was written back to the database right after it was cleared (the end-of-scan save ran on it), so it could be recovered as active later.
- A batch that faulted was never released from `activeBatch`, so it blocked the queue until it was aborted.
- Batch timers used the wall clock; they now count scans (exact and testable) and restart on Resume.
- The mixer was not re-requested when a paused batch resumed in discharge.

## Still open
1. **Micro dosing is not audited.** `micro_drag` has timer-based dosing and a weight stop setpoint that the batch engine ignores; micro lines are dosed like majors through the first connection under the bin. Needs its own pass against the PLC micros logic.
2. **Single mixer, unit handling** (audit items 13, 14): unchanged. Units are assumed to be lbs.
3. **No explicit overfeed fault.** An overshoot lands in the tolerance hold instead (the auger is already stopping by then). Covered by tolerance, not by a separate limit.
4. **Not exercised in the browser:** the tolerance popup, the scale-mismatch popup and the Unload / Discard buttons (they need a live scale feed); they are type-checked and the backend side is tested.
5. **Not done on hardware:** everything above runs against a simulated scale.
6. Defaults I chose where you did not say: auto freefall strength 50 %, max adjust 2 lb per batch, resume mismatch 10 lb, mixer empty 10 lb, discharge timeout 60 s, settle 2 s.

---

# Micro dosing audit (PLC `Operate` / `Faults` / `HOAs` vs `mill.ts`)

Read from the Sysmac project (`DLRBatcher2026_09_29.smc2`, Main program: Operate steps 10-21, Faults R72-R101, HOAs M-1..M-12). Backend read: `buildBatch`, `advanceDosing`, `releaseBlocker`. Nothing run on hardware.

## What the PLC does (micro path)
- Micros are bins 20-27 (`CurrentBin > 19`), dosed by 8 augers M1-M8 into a **separate micros hopper on Scale2**, not the mixer scale. A shared VFD (M11) drives whichever micro auger is running; a **micros scale conveyor (M12)** moves the hopper contents into the mixer.
- Zero check at batch start: Scale2 must be within `MicrosZeroToleranceSV` of 0 (else Micros Empty Tolerance fault, batch will not start), same as the mixer scale.
- Step 10: if the previous recipe line was a major, run M12 first for 30 (timer units, probably 0.1 s) to clear the conveyor, then wait for Scale2 to settle (`FillSettleTDSV`). Consecutive micros skip this.
- Steps 13-15: baseline = Scale2, `StopLbs = start + amount - FF_Lbs`, slow when `>= start + amount - Slow_Lbs`; VFD speed = bin `Dispense_Speed`, or `Slow_Speed` in the slow zone; stop at `StopLbs`; bin `SettleTime` wait on `!Scale2Moving`; ending weight and actual recorded.
- Steps 16-18: per-bin tolerance, popup (Ignore / Update freefall), freefall auto-adjust with `Max_Adj_lbs`: identical to majors.
- Steps 19-20: if the **next line is a major or the recipe ends**, run M12 until `MicrosUnloadTimeSV` has elapsed *and* Scale2 < zero tolerance (Micros Failed to Empty fault if not within `MicrosFailedToEmptyTDSV`). If the next line is another micro, nothing is unloaded: micros accumulate on Scale2 and each step re-baselines.
- Step 21: inventory, run log, batch log (same as majors).
- Interlocks: micro auger run chain requires `!M12.OkNxtTd.UP` (no dosing while the conveyor is running); VFD starts 0.7 s after any auger coil and stops when none is requested; per-bin auger stop counter keeps the auger running through the freefall.
- Micro faults: Over Capacity (`Scale2 > MicrosCapacity`, only while the current bin is a micro), Failed to Achieve Weight (per-bin minutes, counts down while the bin requests dispense), Failed to Empty, Empty Tolerance.

## Findings

**P0**
1. **Micros are weighed on the mixer scale.** `getMixerScale()` is the only scale `advanceDosing` knows. The `micro_drag` settings (`scaleId`, `weightStopSetpoint`, `timerBasedDosing`) and the `micro_hopper` bin type are never read by the batch engine. Real micros would be dosed against a scale that does not see them (they sit in the hopper until the conveyor runs), so actual = 0 and the auger feeds until the no-flow watchdog or a timeout fault. *Fix:* give the micros hopper its own scale (the micro drag's `scaleId`) and have a micro step use that scale for baseline, actual and settle.
2. **The micros conveyor is never run.** Nothing requests M12/`micro_drag`: not before the first micro after a major, not after the last micro. Micro material would never reach the mixer. *Fix:* implement the unload step (run until minimum time elapsed and hopper scale below zero tolerance, with a failed-to-empty fault) as part of dosing a micro group.
3. **`findAugerForBin` returns the first connection from the bin with no type check.** For a micro hopper that is possibly the micro drag, so the "auger" is the conveyor and the step runs it per ingredient. `releaseBlocker` only checks the thing exists and is in Auto. *Fix:* require a real micro auger, and treat the drag as a separate unload device.

**P1**
4. **No micro-scale checks.** Missing: hopper empty at batch start (Scale2 zero tolerance), over-capacity fault, scale-lost handling for the micro scale. Release gate checks only the mixer scale.
5. **Shared VFD not modelled.** PLC sets one VFD speed from the bin (`Dispense_Speed` / `Slow_Speed`) and starts the VFD only after an auger starter closes. The backend's slow-speed path needs `analogSpeedOutput` on each auger; micro augers share one drive, so it must be an equipment-level output set per bin (the VFD start order already exists at mill.ts ~1534).
6. **Interlock between conveyor and augers** (no micro dosing while M12 runs) is absent; irrelevant until finding 2 is fixed, then required.
7. **Accumulation semantics.** On the PLC consecutive micros stay on Scale2 and each step re-baselines from the current gross; unloading happens only at a micro-to-major transition or at the end. The backend's per-step baseline works for that, but with the unload step added the order matters: majors-first/micros-last ordering (`[...recipe.lines, ...recipe.microLines]`) means one unload, whereas the PLC follows the recipe's own order (a micro between two majors unloads twice). Keep micros last unless the recipe order is something you want to preserve.

**P2**
8. **Failed-to-achieve-weight timer** is a per-bin total time (minutes) while dispensing; the backend has only the no-flow watchdog (rate-based). A slow but never-finishing feed is not caught. Add a per-step total timeout.
9. **Zero-amount line.** PLC treats a line with amount <= 0 as end of recipe and jumps to mixing; the backend scales lines and dosing a 0-target step would complete instantly (harmless) but is unchecked.
10. Settle uses the bin settle time on the same scale; carry over when the micro scale exists.

## Unknowns
- Timer units of the 30 in the initial conveyor cleanout and the default of `MicrosUnloadTimeSV` (set in HMI, not in the program).
- Whether the real machine's micro hopper scale will be a second EtherCAT load cell (RS1201) at a fixed slot; the I/O config would need it.

## Suggested order
1 and 2 together (micro scale + conveyor unload), then 3 and 4, then 5-8. Until 1 and 2 are done, micro lines should not be allowed in a recipe that is run for real (reject in `releaseBlocker`): that is a small guard I can add now.
