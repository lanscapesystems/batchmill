# 15 — Interfaces, Commands and Domain Events

## Design intent

Define interfaces early so simulator, Linux EIP hardware layer, future alternative PLC, database, and browser can be implemented independently.

**Status note**: the C++ interfaces and events below describe the deferred future split-service architecture (see [01 Architecture](01_ARCHITECTURE.md)), not the current `feedmill-backend` implementation. The current backend has no `IIOAdapter`/simulated-adapter layer — I/O goes through `ethercat-rt/io_daemon.c` and `src/ethercat.ts` as described there, and there is no simulator mode in the production backend.

## Interfaces (C++ concepts/pseudocode)

```cpp
struct SignalSample { SignalId id; Value value; MonoTime sampled_at; Quality quality; };
struct OutputIntent { EquipmentId owner; SignalId signal; Value desired;
                      MonoTime expires_at; uint64_t control_generation; };
struct ScaleReading { ScaleId id; double weight; Unit unit; MonoTime sampled_at;
                      bool stable, overload, communication_valid; };

interface IIOAdapter {
    Inputs snapshot();
    WriteResult apply_authorized_outputs(OutputImage image);
    LinkStatus health();
};
interface IScaleAdapter { ScaleReading latest(); LinkStatus health(); };
interface IEquipmentController { Decision request(Command command, OperationId owner); };
interface IRouteManager { Result<Reservation> reserve(RouteId, OperationId); };
interface IBatchExecutor { Decision handle(BatchCommand); BatchSnapshot snapshot(); };
interface IEventStore { CommitResult append_transactionally(EventBatch events); };
```

Pseudocode only; actual C++ design should use concrete types/ownership and explicit error handling.

## Events

`InstallationActivated`, `EquipmentStateChanged`, `RouteReserved`, `RouteReleased`, `BatchStarted`, `IngredientDoseStarted`, `IngredientDoseFinalized`, `BatchPaused`, `BatchFaulted`, `BatchDischarged`, `BatchCompleted`, `HammerFillStarted`, `HammerFillStopped`, `ScaleFaulted`, `InventoryAdjusted`, `AlarmRaised`, `AlarmCleared`, `OperatorActionAudited`.

Each event: stable ID, type, entity/operation IDs, installation + recipe/config revisions, monotonic process timestamp plus wall-clock UTC, actor if applicable, relevant measured values/quality, causation/correlation IDs, schema version.

## Command validation

Every command must be checked for authorized actor, compatible state, fresh control generation, device commissioning, physical interlocks, safety status and resource reservation. Commands are not direct I/O writes.

## Durable idempotency

Each external command carries a request ID. Each inventory or batch-finalization event has a deterministic idempotency key. Replaying a command after reconnect/power loss must not double-deduct inventory or repeat a discharge cycle.

## Simulator support

`IIOAdapter` and `IScaleAdapter` have deterministic simulated implementations with injected delay, stale frames, communication loss, wrong feedback, stuck outputs, sensor contradictions and power-restoration tests.
