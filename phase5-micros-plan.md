# Plan: micro dosing system

Source of truth: the PLC (Operate steps 10-21, Faults R72-R101, HOAs M-1..M-12) and the findings in `phase4-batch-audit.md` ("Micro dosing audit"). Backend only first (`mill.ts`, `batchLogic.ts`, `types.ts`, `batch.check.ts`), then HMI settings and queue display. Every stage ends with tests in `batch.check.ts` and a green `tsc`.

## Target behaviour (what "done" means)
Micro lines dose into a micro hopper weighed on its own scale, then a micro conveyor moves the hopper into the mixer. Same stop point / slow zone / settle / tolerance / freefall logic as majors, but on the micro scale. All the PLC micro faults exist. No micro line can run unless the micro scale and conveyor are present and healthy.

## Stage 0: guard (small, do first)
`releaseBlocker`: a batch with micro lines waits with the reason "micro dosing not configured" until stage 1 finds a valid micro scale and conveyor. Removes the risk while the rest is built. Removed by stage 1.

## Stage 1: topology and config (no behaviour change yet)
- Define the chain: bin -> micro auger (M1-M8) -> `micro_drag` (the micros scale conveyor, M12; the belt is weighed, so it owns the scale via its existing `scaleId`) -> mixer. Majors go bin -> auger -> mixer and never touch it. Resolve it from connections: `findAugerForBin` must return only an `auger`; a new `findMicroConveyor(augerId)` follows auger -> micro_drag.
- **Micro bins are the normal `bin` type**, no separate type. A step is a micro step when it comes from the recipe's micro list; the connections (auger -> `micro_drag`) are checked against that at release. The `micro_hopper` bin type goes away; check `inventory.tsx` (it groups by that type) and switch it to the ingredient category (MICRO) or the same derivation.
- A step gets `kind: 'major' | 'micro'`, `scaleId`, `conveyorId`.
- **Kind and order come from the recipe's two lists, as today.** `recipe.lines` are majors and `recipe.microLines` are micros; `buildBatch` already builds `[...lines, ...microLines]`, so majors dose first and micros after, each in list order. No re-sorting is added. The release gate checks the list matches the plumbing: a micro line's bin must reach a `micro_drag` through its auger, and a major line's must not ("X is in the micro list but its auger does not feed the micros conveyor").
- New `micro_drag` config (HMI Settings): `zeroToleranceLbs` (MicrosZeroToleranceSV), `capacityLbs` (MicrosCapacity), `unloadMinSec` (MicrosUnloadTimeSV), `failedToEmptySec`, `settleSec`. No initial cleanout time (dropped, see stage 3). Remove `timerBasedDosing` and `weightStopSetpoint` (decided: dropped; the PLC batch logic does not use them).
- Release gate: for micro steps check micro auger exists and is Auto/not faulted, conveyor exists/Auto/not faulted, micro scale assigned, valid, stable, below zero tolerance. Replaces the stage 0 guard.

## Stage 2: scale per step
Replace `getMixerScale()` use inside `advanceDosing` with `stepScale(step)`: mixer scale for majors, the conveyor's scale for micros. Baseline, actual, settle, scale-lost pause, no-flow watchdog, tolerance hold and freefall calibration then work unchanged for micros. Resume's "scale vs saved progress" check must use the step's scale too. Tests: a micro step doses against the micro scale while the mixer scale stays at its own value.

## Stage 3: conveyor sequencing (the PLC steps 10-12 and 19-20)
Decided sequence: two dosing tracks run at the same time. The **major track** doses its lines one after another into the mixer (mixer scale). The **micro track** starts immediately with the batch and doses its lines one after another onto the stopped belt (micro scale); it does not wait for the majors. The belt runs into the mixer only when **both** tracks are finished (all majors done and the last micro settled and in tolerance). One unload per batch, then MIXING. A recipe with no micros never runs the belt; a recipe with only micros unloads as soon as they finish.

State model change (this is the main engine work): `dosingIndex` becomes one cursor per track (`majorIndex`, `microIndex`), each driving its own step through the existing pending -> feeding -> cutoff -> settling -> complete machine. `advanceDosing` runs the machine once per track per scan; the batch leaves DOSING for a new `UNLOADING_MICROS` state (or sub-state of DOSING) only when both cursors are at the end. Rules while both run:
- Pause, E-stop, scale lost on either scale, and any dosing problem stop **both** tracks (pause releases every feeder). Resume restarts both from their saved steps.
- Tolerance hold: the held track waits for the operator; the other track keeps dosing until its next step would also need attention. One popup at a time; a second hold waits its turn.
- Dosing error (no-flow etc.): pauses the batch, as now; Accept completes that track's step, Resume retries it.
- Persistence, recovery, snapshot and the HMI queue view all carry two active steps instead of one; `AcceptDosing`, `ResolveTolerance` and the dosing popups take a step/track id instead of assuming `dosingIndex`.
- Independence is safe because the two tracks use different scales and different feeders; the feeders of one track never share an auger with the other. Interlock: micro augers must not run while the belt runs, which holds by construction since the belt only runs after both tracks finish.
1. Before the first micro: nothing runs. The belt is not pre-cleaned (the PLC does a short run here; dropped because dosing is relative to a baseline and the end-of-batch unload empties the belt anyway). The step waits for a valid, stable micro scale, then baselines, exactly like a major.
2. Between micros: nothing. Each micro step re-baselines from the current belt weight, as in the PLC.
3. After the last micro (and its tolerance/settle): run the conveyor until the minimum unload time has passed **and** the micro scale is below zero tolerance; the "failed to empty" timer runs meanwhile. Then the batch moves on to MIXING.
- The conveyor is owned by the batch (`owner`/`request`) like the augers, so pause, E-stop and abort release it.
- Interlock: micro augers do not run while the conveyor runs (PLC `!M12.OkNxtTd.UP`); conveyor does not start while an auger runs.
- Abort/pause: pausing while micro material is in the hopper keeps it there; Resume continues the same step. Abort with Unload/Mix+Unload runs the micro unload first. Cancel leaves it, and the next batch is held by the hopper-not-empty check (`mixer not empty` equivalent for the hopper).
- Persist the new sub-states and conveyor timers so a power cut recovers to PAUSED like other states.

## Stage 4: micro faults (Faults R72-R101)
| PLC fault | Backend |
|---|---|
| Micros Empty Tolerance (batch start) | release gate + VALIDATING check; hopper must be within zero tolerance |
| Over Capacity (`Scale2 > capacity`) | check each scan while a micro step is active: stop feeders, pause, E-BA fault |
| Failed to Achieve Weight (per-bin minutes) | per-step total timeout, bin setting; becomes a `dosingProblem` (Accept / Resume popup that already exists) |
| Failed to Empty | conveyor unload timeout: alarm and keep waiting with Extend, same as mixer discharge |
| Conveyor starter/trip | handled by the existing motor fault path; batch pauses |

## Stage 5: shared VFD and speeds
Decided: augers keep their config in the sidebar, plus a **Shared VFDs dialog** (create / edit / delete) in Settings.
- A shared VFD holds its own I/O: run output, run-confirm input, analog speed output, start delay (default 0.7 s), plus fault-delay if the motor one is not reused. Stored alongside the scale configs.
- An auger gets a "Shared VFD" selector. When one is selected, the auger's own VFD/analog-speed fields are hidden and ignored (cleared on save so no stale I/O is left); the auger keeps only its starter (coil and aux).
- Backend: `vfdOf(eq)` returns the shared VFD when set. The VFD run output = OR of the run commands of every auger on it, with the starter-first / start-delay sequence (PLC M11) evaluated once per VFD, and it drops when none is requested. The analog speed output is written from the running auger's bin `Dispense_Speed` / `Slow_Speed`; only one micro auger runs at a time, and a second request on the same shared VFD while one runs is held. A VFD feedback timeout faults only the augers that are running (requested) on it, not the idle ones. The existing per-bin slow-speed code (`slowFeedSpeed`, `slowFeedLbs`) must accept a shared VFD's speed output instead of requiring `analogSpeedOutput` on the auger.
- I/O assignment: shared VFD outputs come from the same pools as motor I/O and are included in `io.conf` generation and the forcing / duplicate-assignment checks, so one terminal point cannot be used twice. Deleting a VFD still selected by an auger is refused.
- Not limited to micros: any group of augers on one drive can use it.

## Stage 6: HMI
- Settings: the new `micro_drag` fields (stage 1), micro bin fields already shared with bins.
- Queue tab: show the micro sub-state ("clearing conveyor", "unloading micros") and the hopper weight beside the mixer weight; tolerance and dosing-error popups already work per step.
- Inventory: micro hopper bins already listed; check balances deduct per step.

## Stage 7: verification
- Concurrency test: micro dosing starts while a major is still feeding; the belt does not run until the last major and last micro are both complete; pause/resume/scale-loss on either scale stops and restores both tracks; a hold on one track does not stop the other's current step; no micros = no belt run; only micros = unload right after the last one. Exactly one belt unload per batch; a micro line whose auger does not reach a micros conveyor blocks release.
- Backend tests per stage: micro scale used; conveyor runs at major-to-micro and micro-to-major transitions and not between micros; failed-to-empty; capacity fault; hopper-not-empty blocks the next batch; pause/resume/abort with material in the hopper; recovery after restart in a micro sub-state.
- Browser-check the settings fields and queue display on a scratch backend.
- Hardware (not possible here): micro scale zero/span, conveyor unload time with real material, VFD start order and speeds, behaviour with the micro scale unplugged.

## Decisions (resolved)
1. Micro bins are the normal bin type; micro-ness comes from the connections.
2. Sequence: majors first, micros onto the belt, one unload at the end. (The PLC unloads the belt whenever the next recipe line is a major or the recipe ends, so with recipes ordered majors-then-micros it behaves the same; it only differs for a recipe with micros in the middle, which we do not support.)
3. Timer-based dosing and weight stop setpoint: dropped.
4. VFD: shared VFD dialog in Settings; auger sidebar selects one and hides its own analog output.
5. No initial cleanout run before the first micro (dropped).
6. Micros and majors dose concurrently; the belt unloads only after both tracks finish.
7. A tolerance hold on one track does not stop the other track (confirmed); pause, e-stop, scale loss and dosing errors stop both.

## Order and size
0, then 1, 2 and 3 together as one change (they cannot be tested apart), then 4, 5, 6, 7. Stages 1-4 are the core (roughly the size of the earlier dosing-error work); 5 and 6 are smaller.
