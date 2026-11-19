# 25 - Ingredients and micro ingredients

Status: required category separation, 2026-11-09.

## Catalog and assignments

Maintain separate Ingredients and Micro ingredients catalogs. Each material has a stable ID and explicit category (MAIN or MICRO); neither its name nor quantity determines its category in the production backend. Main ingredient assignments belong to ingredient bins and their mixer-feeding augers. Micro ingredient assignments belong to individual micro-system hoppers feeding the weighed drag. Reject cross-category assignments and recipe references.

The prototype uses separate example name lists and categorizes earlier local demo data without discarding balances or historical transactions. Existing example entries retain their location IDs; these are not physical installation assignments. Production migration must explicitly reconcile any incompatible existing location assignment rather than silently relocate material or reclassify occupied equipment.

## Recipes and weighing

Show Ingredients and Micro ingredients as separate recipe sections with category-specific selectors. Recipe revision stores both groups, their target quantities/units and eligible source rules. Nominal batch mass and formula percentages include both groups exactly once. Micro groups may be empty. The batch plan resolves main lines to mixer weighing and micro lines to the selected micro system's hopper/drag weighing; do not transfer lines implicitly between groups. Frozen queued and active recipe revisions retain their original material identities and routing requirements.

## Inventory and receiving

Within Inventory provide Ingredients / Micro ingredients selection without adding a seventh main tab. Scope balances, ingredient selector, usage totals, shipment entry, shipment/mix-use history and assignment controls to the selected category. Keep the main period selection consistent across both groups. Shipment locations must match the selected material category; record category and ingredient ID on the immutable transaction. Historical usage remains associated with the original material/category after a bin or hopper assignment changes.

Display micro quantities with suitable configured resolution; do not round a small ingredient target to zero in storage or computation. Units and rounding policies remain explicit per material/scale.

## Backend additions

Add category to ingredient master, recipe lines, assignment records and ledger projections. Inventory and recipe queries support category filtering. Validate category against source equipment and enabled micro-system capacity before admitting a batch. A recipe requiring micros cannot run without configured eligible micro equipment. Category changes for an existing material with references require a reviewed migration; ordinary recipe editing cannot perform that migration.

## Prototype verification

Check category-specific recipe choices, combined nominal mass, independent line editing, separate inventory filters and shipment destinations, no cross-category log leakage, and preservation of previously queued recipe revisions.
