# 16 — Open Decisions and Required Field Data

> Current process refinement: [19 - Confirmed material flow and batch coordination](19_CONFIRMED_PROCESS_FLOW.md) supersedes conflicting assumptions below. The mixer itself is weighed; each ingredient bin has a discharge auger; optional stuffer and parallel micro preparation are supported. Installed assets are selected by configuration; earlier installation counts were illustrative.

This document deliberately separates assumptions from confirmed requirements. A future developer should NOT implement the following as settled facts.

## Mechanical process

1. RESOLVED: the mixer itself is weighed and has one motor. Scale indicator details remain open.
2. RESOLVED: every ingredient bin has its own discharge auger feeding the mixer directly or through an optional shared stuffer. Configure actual equipment identities and stuffer enablement.
3. Exact equipment inventory (motor count, starters/VFDs, gates, augers, conveyors, diverters, run/fault feedback).
4. Are all eight finished bins reachable from the mixer? What are the actual gate/auger routes, sensors, cleanout times and capacity constraints?
5. Which ingredient bins can HM-01 refill? From what intake/source, through which equipment, and what automatic destination priority?
6. Do hammer mill feeder/dust collection devices have extra required interlocks? Detailed OEM start/stop sequences.
7. Is finished-bin inventory tracked and what physical loadout measures exist?

## Instrumentation and controls

8. Exact NX-EIC202 coupler firmware, installed NX I/O module models and slot layout, cyclic assemblies, output failure modes and communication timeout settings.
9. Exact scale manufacturer/indicator model, serial protocol, transmission rate, units and stability status information.
10. Hardware E-stop risk assessment, safety-rated components, actuator safe states, and independent motor stop circuit design.
11. Which operations *specifically* need <30 ms physical-input-to-output response and under what fault/loading conditions?
12. Selected industrial PC model, Debian compatibility, auto power restoration, Linux hardware-watchdog support, storage power-loss protection and DC brownout behavior.

## Operational policy

13. Batch-size ranges, recipe approval and tolerance rules, ingredient substitution/source-selection rules.
14. Paused batch handling, operator override permission, mid-batch power loss recovery and residual vessel material policy.
15. Automatic hammer-fill priorities, simultaneous fill and batch use constraints, runtimes, alarm latencies.
16. How to measure received ingredient amounts when no scale exists; reconciliation/estimate policy.
17. Users/roles, network isolation, remote support, reporting, backups and retention.

## Immediate development priorities

A. Capture physical equipment survey and wiring export.  
B. Confirm mixer weighing architecture and scale model.  
C. Produce actual material graph with equipment IDs, routes, switch feedback and actuator fail states.  
D. Validate the NX-EIC202 cyclic driver and disconnection behavior on a bench.  
E. Verify boot-after-power and watchdog behavior of chosen PC before procurement commitment.
