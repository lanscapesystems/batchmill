# 07 — Recipes, Ingredient Bins and Inventory

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

## Function

Manage the ingredient master, formulas, bin contents, recipes and traceable on-hand quantities for up to 32 configurable ingredient bins.

## Ingredient master

`Ingredient(id, name, code, unit, density_optional, allergen/cross_contamination_flags_optional, active, metadata)`.

`Recipe(id, revision, name, nominal_batch_size, ingredient_lines, allowable_substitutions, tolerance_policy, approved_by, status)`; each ingredient line has target or percentage and permissible source rules.

Never silently change a running recipe if the editor saves a new revision. Batch snapshot stores the exact amounts and revisions used.

## Bin registry

Each enabled ingredient bin (up to 32) stores capacity, current ingredient assignment, usable/estimated inventory, optional physical level sensors, source/dispense routes, refill routes, tracking mode and status. One ingredient may be distributed among multiple bins; the batch engine selects the lowest-numbered bin first and fails over to the next if the active bin empties during dosing (see 05). Ingredient assignment can only be changed when the bin balance is below 100 lbs, enforced by the HMI. Each bin may have inventory tracking enabled or disabled; when disabled, only usage (batch consumption) is recorded and no balance/level is displayed.

## Inventory ledger

Immutable events with unique `transaction_id` and idempotency key:

- Receipt / intake (actual measured or explicit estimated quantity)
- Batch consumption (derived from valid *actual* ingredient weight, linked to batch and bin)
- Hammer-mill fill (measured or `ESTIMATED`, never infer exact pounds from level switches)
- Bin-to-bin transfer (source and destination linked)
- Manual count/correction (reason, operator, before/after)
- Disposal/loss/cleanout
- Reservation/availability hold (separate from physical quantity adjustment)

Inventory quantity = sum of signed posted inventory events (or maintained balance with transactional consistency checks). Ledger entries never overwrite original evidence; corrections are reversing/adjusting transactions.

## Key control rules

- Check inventory availability at planning and at batch start, with policy for stale/estimated balances.
- Full/empty switches indicate threshold state, not continuous precise inventory.
- Do not claim gram/lb-accurate hammer-mill fill weights without a measured mass/flow signal.
- Each batch should post each actual consumption **once**, even after replay/restart; use idempotency keys such as `(batch_id, ingredient_step_id, final_post)`.
- Track provenance and quality of quantity, including manual, scale-measured, calculated/estimated.

## UI

Ingredient catalogue; recipe versioning/approval; bin contents map; inventory by bin/ingredient; receiving; adjustments; history and reconciliation report; out-of-stock and low-stock alerts.

## Ingredient category refinement

[25 - Ingredients and micro ingredients](25_INGREDIENT_CATEGORIES.md) requires separate catalogs, recipe sections and inventory groups, with category-matched bin/hopper assignments and receiving. Combined batch totals include both groups; ledger history retains original material/category.
