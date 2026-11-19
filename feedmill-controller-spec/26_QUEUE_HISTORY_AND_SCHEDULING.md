# 26 - Queue history, weights and recurring batch orders

Status: required UI behavior; explicitly proposed execution policies, 2026-11-09.

## Queue and history

Queue includes current status, queued orders, scheduling and batch history. Selecting a queued or historical row expands ingredient and micro-ingredient targets and actuals, category, unit, variance and batch totals. Current-run weights are expandable as well. Pending actuals are unavailable, never target values presented as measurements. Retain finalized dosing actuals independently of the instantaneous mixer weight during discharge. Show partial actuals for aborted/interrupted runs without inventing a complete total.

Each real run has a unique batch ID, frozen recipe/configuration revisions, parent order/occurrence IDs, run ordinal, target/actual lines with quality, requested destination, actual destination, start/end times and outcome. Historical records remain available after an order leaves the queue. Sort newest first with stable tie-breaking and backend pagination. Keep canceled orders and aborted runs distinguishable; a canceled order is not a fabricated physical batch.

## Schedule fields (REQUIRED)

- Now: one-time release with a time selection.
- Every X days: positive integer interval, time and an explicit first-date anchor.
- Every selected weekday: multiple weekdays selectable, with a time selection.
- Quantity: positive integer field on the order; do not create duplicate queue entries to represent repeated runs.

Proposed quantity meaning: runs per scheduled release. One-time quantity N completes N sequential batches. Each recurrence releases N batches under one order/occurrence; its quantity field remains N while completed/remaining counts track execution. Clearly label this in the HMI. Completed individual runs each receive a separate history record; queue order duplication is prohibited.

## Proposed scheduling semantics

Store schedule type, time, installation timezone, interval/anchor or selected weekdays, schedule revision, next requested release, quantity and occurrence progress. Now uses today at the selected local time, becoming eligible immediately if that time has passed. An interval is calendar-day based, not elapsed multiples of 24 hours. A weekday schedule releases once on each selected local day, not once per checkbox submission.

Create a stable occurrence ID from order ID, schedule revision and planned release instant. Use durable transactional occurrence creation, run-number allocation, completion counting and next-release advancement so reconnect/restart cannot duplicate releases or consume quantity twice. At most one active main run exists. Preserve remaining quantity on pause/restart; abort is recorded but does not count as successful completion under the proposed policy. Material disposition still gates restart.

The prototype manually starts eligible runs and advances simulated process stages. It retains one queue row during a quantity sequence, increments completed count after a successful run, removes a finished one-time order, and advances a completed recurrence to its next future release. It does not automatically actuate a scheduled batch or update the physical inventory ledger.

Production decisions still requiring confirmation: unattended versus operator-authorized start, whether failed runs count, overlap between unfinished and newly due occurrences, missed-release handling, and whether recipe updates require schedule revision. Proposed prototype behavior skips missed recurrence times and does not overlap occurrences. Do not silently adopt that as commissioned production policy.

## Time and concurrency

Compute in the schedule's IANA timezone; store release instants in UTC. Prototype skips nonexistent daylight-saving times and chooses the earlier instant for an ambiguous repeated time. Production DST/missed-release policy must be visible and approved. Block timezone changes that would silently move existing recurring schedules; migrate them explicitly. Editing quantity below already completed runs is rejected. Editing an active occurrence is blocked in the prototype; production future-occurrence edits must not alter a running batch snapshot.

Revalidate material, source routes, destination, equipment modes, reservations and faults before every run, including subsequent runs of a quantity. Publish pending/blocked reasons and requested versus actual start. Queue/history projections update through revisioned events; UI expansion is presentation state, not a control command.

## Prototype checks

Expand queue/history weights; multi-weekday and calendar-interval scheduling; quantity two retains one row and produces two distinct histories; frozen recipe targets survive edits; completion persists across reload; DST gap/fold calculations; unavailable actuals remain unavailable.
