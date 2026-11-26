# Phase 4: how batching will operate after the fixes

Companion to `phase4-batch-audit.md` (finding numbers in brackets). Design only; nothing built yet. Items marked **DECISION** need your call; the default shown is what I'll build if you don't say otherwise.

## Principles
- The backend is the only batch engine; the HMI only displays state and sends commands.
- **No real weight, no batch.** Nothing posts inventory unless it was measured by a valid scale.
- Every wait has a reason shown to the operator and a timeout that ends in a fault or a hold, never silent progress.
- Material accounting is based on measured weight, and is posted whatever way the batch ends.

## Lifecycle

```
QUEUED -> VALIDATING -> READY -> DOSING -> MIXING -> ROUTE_PRECHECK -> DISCHARGING -> CLEAROUT -> COMPLETED
                                   |          |            |                |
                                   +----------+-- PAUSING -> PAUSED (resume returns to the interrupted state)
any active state --abort--> ABORTING -> ABORTED_HOLD --unload--> (discharge) --> ABORTED (closed)
any state --unrecoverable fault--> FAULTED (closed)
```

- **QUEUED** replaces IDLE. Queue entries are saved to the database on create/edit/delete, so they survive a restart [10].
- **Batch size:** `targetMass` scales every recipe line by `targetMass / recipe total`, micros included. Scaled targets are stored on the batch at queue time and shown in the queue [7].

## 0. Queue-time warnings (QueueBatch / EditBatch)
When a batch is added or edited, the backend returns warnings with the result and the HMI shows them in a confirmation popup (**Add anyway / Cancel**). The batch is queued either way if the operator confirms, and the warnings are saved on the batch.
- **Inventory:** the batch's scaled targets are checked against each source bin's balance **minus the targets of every batch already ahead of it in the queue** (and any active batch not yet posted), so the 3rd queued batch is judged on what will actually be left. Short bins are listed with need vs. available.
- **Mixer capacity:** the batch's total weight (sum of scaled targets) against the mixer's **Capacity (lbs)**. Over capacity is listed with total vs. capacity. If the mixer has no capacity set, the warning says "mixer capacity not set" once instead of silently passing. The field already exists (`config.capacity`, default 4000 lb) but only in Settings, equipment section; per your rule that per-machine settings live in the sidebar, it moves to the mixer sidebar (with Cleanout time).
- Editing the recipe, size or position in the queue re-runs the warnings. Warnings are only advisory; nothing here blocks starting.
- Today the backend checks neither warning. (The scale's own "capacity" is the load cell rating, a different number from the mixer capacity.)
- **Untracked bins** (below) are excluded from the inventory check.

## 0b. Live queue: no Start button
The Start button and the StartBatch command are removed. The queue runs itself:
- A new batch with no schedule time is eligible immediately. A batch with a **scheduled start time** becomes eligible when that time arrives.
- Each scan, if no batch is active and nothing holds the queue, the first eligible batch in queue order is released into VALIDATING. A scheduled batch that is not yet due is skipped, so it does not hold up eligible batches behind it; when its time comes it goes next, after any batches ahead of it that are still unfinished (an active batch is never interrupted).
- If the release gate (next section) fails for the head batch, it stays QUEUED with a reason line ("Waiting: mixer scale invalid", "Waiting: GT1 not in Auto") and retries every scan. Nothing is rejected and no prompt is shown; the queue waits behind it.
- **Edit while queued:** any batch that has not been released can be edited (recipe, destination, size, scheduled time), re-ordered or deleted. Edits re-run the queue-time warnings. A batch released between opening the editor and saving rejects the edit ("already started").
- Recommended, needs your OK (**DECISION**): a **Queue Hold / Run** switch on the Queue tab. Without a Start button there is otherwise no way to stop the next batch beginning (maintenance, changing a bin). Hold never interrupts the active batch; it only stops new releases. **The queue comes back on Hold after a restart or power loss**, so a batch never starts unattended after an outage; a scheduled batch that went past due while off runs once the operator hits Run, flagged "late" in history.

## 1. Release gate (head of the queue, before VALIDATING) [1, 4, 6]
All must pass or the batch waits in QUEUED with the specific reason (nothing is claimed, nothing moves):
- A mixer exists, with a mapped scale whose reading is currently **valid** and **stable**, and the reading is within the empty threshold (the mixer is empty). The batch does **not** tare the scale itself: each step already measures against its own baseline, so zero drift does not affect dosing, and an automatic tare would hide leftover material. If the mixer is physically empty but the reading sits above the threshold, the operator zeros the scale from the scale's own zero function (outside a batch).
- Every step has a source bin and a source auger; the auger is a real auger fed by that bin; the auger and mixer are in **Auto** and not faulted; every bin on the path has no active trip.
- **No operator prompts at release.** Inventory and mixer-capacity warnings are raised when the batch is added to the queue (see "Queue-time warnings"), so the queue never stalls on a question. Only the hard checks here can hold a release.
- Destination exists, is a finished bin, is not full/fault.
- A path exists mixer → gate(s) → destination; every gate on it is in Auto. The discharge gate(s) are the ones found by the connection path, not "the first gate" [6].
- E-stop OK, no forced outputs, no other active batch, no ABORTED_HOLD batch waiting for Unload.
There is **no simulated dosing and no mode that runs without a scale.**

## 2. Dosing, one ingredient at a time [2, 3, 12]
Per step: `pending → baseline → feeding → cutoff → settling → complete`.
- **baseline:** needs valid + stable scale; records baseline weight.
- **feeding:** auger on, speed slows in the slow zone (unchanged). Watchdogs while feeding:
  - **Scale invalid/unstable-for-too-long:** stop the auger, pause the batch, reason "Scale invalid".
  - **No-progress timer:** it starts only after the auger(s) have been running for the bin's **No-progress delay** (bin sidebar, default 60 s); after that the weight must rise by at least the minimum amount (default 2 lb) every 10 s, or the step faults "No flow from B3". Pausing and resuming restarts the delay.
  - **Overfeed:** actual > target + tolerance → stop and fault.
  - **E-stop or owned equipment tripped/not running while it should be:** pause the batch (it resumes from the same step after the reset).
- **cutoff/settling:** the auger stops when weight ≥ target − freefall (as now). After the settle time the step records `actual` and the **deviation** (actual − target), stored on the batch record either way. Then the tolerance check and freefall calibration below run.

### Tolerance and auto freefall calibration (from the Sysmac project)
The PLC does implement this (batch steps 6 to 8: `FF_Auto`, `FF_Strength`, `Max_Adj_lbs`). Its behaviour, which I will copy:
- **Per-bin settings** (bin sidebar): *Freefall (lbs)* (exists today), *Tolerance (lbs)* (absolute, as in the PLC; blank = 2 % of the step target), *Auto freefall* checkbox, *Adjust strength (%)*, *Max adjust per batch (lbs)*.
- **Within tolerance:** the batch continues. If *Auto freefall* is on, freefall is corrected from the error: `adjust = |actual - target| x strength %`. Over target means freefall **+ adjust** (stop earlier next time); under target means freefall **- adjust** (stop later). The adjust is capped at *Max adjust*. Freefall never goes below 0.
- **Out of tolerance:** the batch **holds** with a popup showing desired, actual, difference, current freefall and the freefall it would become. The operator chooses **Ignore** (no change, continue), **Update freefall** (apply the calculated adjust, **ignoring the max-adjust cap**, continue) or **Abort**. This matches the PLC's Ignore / Update buttons.
- **Improvement over the PLC:** no calibration from a step that was paused, resumed, interrupted by an invalid scale, or had a no-flow fault (the stop point was not a clean run), and each adjustment is written to the bin's history (old to new, error, batch) so a bad trend can be seen and undone. The adjusted freefall is persisted with the bin config.
- Not yet checked: how the PLC handles micros for this; I will read that before applying it to micro bins.

## 3. Mixing
Mixer runs for the recipe mix time; the timer only counts down while the mixer is confirmed running (a trip pauses the batch and the timer holds).

## 4. Discharge [5, 6]
- ROUTE_PRECHECK waits (with reason) for the destination to be not-full and for the path gate(s) to reach the correct outlet (already `pathReady`).
- The scale reading below a **configurable empty threshold** (global setting, default 10 lb), stable, declares the mixer empty. The mixer and gate then **keep running for the mixer's "Cleanout time"** (a field in the mixer sidebar, seconds) before the batch moves to CLEAROUT and releases them. The timer restarts if the weight rises again above the threshold. Pause/abort during cleanout stops it normally.
- If the timeout passes first: the batch **holds** in DISCHARGING with "Mixer not empty — discharge timed out" and an alarm; the operator can **extend**, **abort**, or fix the cause. It never completes on a timeout.
- Destination balance is credited by the weight actually discharged (dosed total confirmed by the empty scale), not just the sum of targets.

## 5. Pause / resume / recovery [11]
- Pause stops the batch's equipment through their own stop delays; PAUSED releases ownership.
- **Resume** re-checks the start gate's relevant parts (e-stop, equipment in Auto, scale valid) and **re-baselines**: new baseline = current scale weight − saved `actual` for the step in progress. If the scale disagrees with saved progress by more than a tolerance, the operator is **asked**: re-baseline from the current weight, or abort.
- After power loss the active batch comes back PAUSED (as now) with the same warning; step progress is persisted every second while feeding (not every 5 s).

## 6. Abort and unload [8, 9]
- **Abort** (guarded confirm popup): stop equipment by their stop delays, state → **ABORTED_HOLD**. The batch stays "active" so the mixer is still owned/known to be loaded.
- Dosed material is posted to inventory as consumption **immediately** (what was measured), tagged aborted [9]; nothing is credited to the destination yet.
- **Unload** (HMI button, now reachable) runs the discharge sequence of section 4 to the chosen destination (default the original; the operator may pick another) and then closes the batch as ABORTED, crediting the destination with what was discharged.
- **Discard** (no unload) is allowed only when the scale reads empty (the operator has emptied the mixer another way).
- A new batch cannot start while an ABORTED_HOLD batch exists.
- Faulted batches follow the same accounting rule (consumption posted for what was dosed) and also end in ABORTED_HOLD when material remains in the mixer, FAULTED otherwise.

## 7. HMI changes
- Queue tab shows: scaled targets, per-step state/actual/deviation, a clear **reason line** for any wait/hold, and the new abort/unload controls.
- No Start button. The queue list shows each batch's schedule time and state; the head batch shows the release-gate reason while it waits. Edit works on any unreleased batch. (Queue Hold / Run switch, if approved.)
- Tolerance popup (Ignore / Update freefall / Abort) as above; capacity and inventory warnings popup when adding or editing a batch.
- Scale-missing is a visible banner on the Queue tab, instead of silent simulation.
- Batch history shows deviations, aborts and discharge time.

## 7b. Untracked bins (hammermill feeds)
A bin whose discharge connects **only to a hammermill** (directly or through augers and other non-bin equipment) is not a batching bin, so it gets a **"Not tracked"** checkbox in its sidebar. When set, the bin is hidden from the Inventory tab and the Recipes tab (not selectable as an ingredient source), from batch creation and inventory warnings, and gets no inventory events. It stays on the system diagram and in the I/O and overrides as equipment.
- The checkbox only appears (and the backend only accepts it) when the connection check passes. If a connection edit later makes the bin feed anything else, the flag is cleared with a warning, so it cannot silently hide a bin that batches draw from.
- Ingredient history is per ingredient, not per bin, so flagging a bin as Not tracked never conflicts with it.

## 8. Tests (`phase4.check.ts`, run by `npm run check`)
One test per finding: no scale → batch waits in QUEUED with a reason (never starts, never simulated); live queue releases a new batch immediately, a scheduled batch at its time, in order, and a not-yet-due one does not block; edit while queued re-runs warnings, an edit after release is rejected; queue-time inventory warning counts batches ahead; mixer capacity warning; untracked-bin flag (only with hammermill-only discharge, hidden from inventory and recipes, cleared when connections change); freefall auto adjust (over/under, max-adjust cap, no adjust after a pause, Ignore / Update popup, Update ignores the cap); scale invalid mid-feed → auger off and paused; no flow → step fault; overfeed → stop; e-stop pauses and resumes at the same step; missing bin/auger/low balance/bad destination rejected; discharge timeout holds (never completes); wrong-gate selection with two gates; size scaling; abort → hold → unload accounting; queue persistence across a restart; resume re-baseline refusal.

## Build order
1. Release gate + live queue (no Start button, scheduling, edit-while-queued) + remove simulation (1, 4, 6) with tests.
2. Dosing watchdogs and pause-on-trip (2, 3, 12).
3. Discharge holds and empty threshold (5).
4. Abort/unload/inventory accounting (8, 9) and the HMI buttons.
5. Queue persistence, size scaling, resume re-baseline, finer persistence (7, 10, 11).
6. Queue-time warnings, mixer capacity in the sidebar.
7. Tolerance popup and auto freefall calibration.
8. Untracked bins.
9. HMI reason lines, banner, history.

## Decisions (settled)
- Inventory and mixer capacity: warn at batch creation (not at start); never block the queue.
- No dry-run / no-scale mode.
- Out-of-tolerance step: hold for the operator (Ignore / Update freefall / Abort, as in the PLC).
- Resume with scale/progress mismatch: ask the operator.
- Discharge: continues for the mixer's Cleanout time after declared empty.
- No automatic tare; empty check on the reading, manual scale zero outside a batch.
- No Start button; live queue with optional scheduled start; batches editable until released.
- Hammermill-only bins can be marked Not tracked.
- Auto freefall calibration follows the PLC.
- Queue Hold / Run switch: built; the queue comes up on Hold after every restart.

## Still open
- Defaults: no-progress delay 60 s (per bin), minimum rise 2 lb per 10 s, bin tolerance blank = 2 % of target, empty threshold 10 lb; freefall adjust strength and max adjust are set per bin (no auto adjust until set).
