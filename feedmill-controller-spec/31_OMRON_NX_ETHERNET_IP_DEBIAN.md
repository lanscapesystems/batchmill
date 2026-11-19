# 31 — Omron NX EtherNet/IP I/O on Debian, including an NX1P2 bench option

**Status:** Proposed implementation and bench-validation guide, 2026-11-12. No hardware communication or timing tests have been performed for this document. **Superseded for now:** per project decision, EtherNet/IP is a deferred future path — the current, only-supported production fieldbus is EtherCAT (NX-ECC), covered in [03 Equipment and I/O](03_EQUIPMENT_AND_IO.md) and implemented by `ethercat-rt/io_daemon.c` + `src/ethercat.ts`. Everything below (including "current production baseline" in the next section) describes that deferred path, not what is built.

## Recommendation and project fit

Use the available **NX1P2 to begin bench development now**, with a small PLC program exposing command and status images to Debian. Start with explicit EtherNet/IP tag reads/writes to prove mapping, freshness, output inhibition and recovery. Evaluate cyclic tag data links separately if the bench needs to prove the project's response-time target.

Retain **NX-EIC202 with a Debian EtherNet/IP scanner** as the current production baseline. An NX1P2 can serve as an I/O gateway, but adopting it permanently is an architecture decision: it introduces PLC code, a second execution cycle and a separate configuration artifact. It is not a transparent replacement for the coupler or proof that the coupler driver works.

This guide follows [01 Architecture](01_ARCHITECTURE.md), [03 Equipment and I/O](03_EQUIPMENT_AND_IO.md), [11 Faults and safety](11_FAULTS_AND_SAFETY.md), and [15 Interfaces](15_INTERFACES_AND_EVENTS.md). Debian continues to own batching, routes, equipment sequencing and output arbitration. Browser/API code never accesses hardware directly. Serial scales remain a separate adapter.

The researched coupler is **NX-EIC202**. Treat “EIC20x” as a family shorthand, not a verified compatibility claim for every suffix. Record the exact product and revision before selecting its manual and EDS.

## 1. Connection choices

| Choice | Debian role | Omron role | What it proves |
|---|---|---|---|
| NX-EIC202 cyclic I/O | EtherNet/IP originator/scanner | Adapter exposing an NX terminal I/O image | Intended production I/O path |
| NX1P2 explicit tag access | CIP tag client | PLC with published network variables and I/O gateway program | Fastest bench path for application integration; timing remains unproven |
| NX1P2 cyclic tag data links | Originator or target, according to supported stack/configuration | Complementary tag-data-link endpoint plus I/O gateway program | Cyclic PLC gateway path; different connection setup from EIC202 |

EtherNet/IP uses CIP over Ethernet/IP networking. An ordinary TCP socket, HTTP client or Modbus library does not implement an EtherNet/IP scanner. Explicit request/reply messaging and cyclic implicit I/O are distinct capabilities.

For the NX1P2, Omron documents 32 connections, up to 600 bytes per connection, 3,000 packets/s including heartbeat, and a configurable 2–10,000 ms packet interval. These are device limits, not an end-to-end latency guarantee. Its local rack accepts up to eight NX Units; built-in point count and NPN/PNP output type depend on the full CPU suffix. See [NX1P2 specifications](https://www.ia.omron.com/products/family/3650/specification.html) and [model lineup](https://www.ia.omron.com/products/family/3650/lineup.html).

## 2. Debian software and network preparation

Suggested development packages, installed on the Debian target:

```sh
sudo apt update
sudo apt install build-essential cmake git pkg-config iproute2 ethtool tcpdump
ip -br address
ip route
```

Use a dedicated NIC and an isolated bench switch. Example addressing: Debian `192.168.50.10/24`, Omron `192.168.50.20/24`, engineering workstation `192.168.50.30/24`. These are proposed addresses; inspect existing settings before changing anything. Configure persistent addressing with the network manager already used by the installation. Avoid a default gateway on the dedicated I/O NIC.

Allow required peer traffic through the control-network firewall: TCP 44818 for EtherNet/IP sessions/explicit messages, UDP 2222 for cyclic I/O, and UDP 44818 if using discovery. Multicast connections additionally need a suitable switch/IGMP configuration; prefer supported unicast connections for the first isolated test. Omron publishes its [port/service table](https://automation-knowledge-base.omron.eu/support/solutions/articles/103000296740-tcp-udp-port-numbers-used-for-the-built-in-ethernet-ip-port).

Useful diagnostic commands; replace the interface name with the actual dedicated NIC:

```sh
ping -c 3 192.168.50.20
ip -s link show dev enp2s0
ethtool enp2s0
sudo tcpdump -ni enp2s0 'host 192.168.50.20 and (port 44818 or udp port 2222)'
```

Ping proves IP reachability only. Capture connection negotiation and cyclic packets when diagnosing failures; a TCP session does not establish that I/O is updating.

### Candidate libraries

* **EIPScanner:** C++ candidate for the EIC202 cyclic scanner. Its documented API includes `Forward_Open`, receive callbacks and periodic connection servicing. The application must service connections more frequently than their actual packet interval; do not copy a slow example loop into this controller. Omron compatibility, header accounting, connection limits and recovery still require bench testing. See the project's [implicit messaging documentation](https://eipscanner.readthedocs.io/en/latest/implicit_messaging.html).
* **libplctag:** C library usable from C++ for the initial NX1P2 explicit tag adapter. Upstream lists Omron NX/NJ support and an `omron-njnx` PLC selection. Confirm the selected release's connection attributes and NX1P2 behavior with a small scalar/array read before implementing the complete image. It is not a substitute for an EIC202 cyclic scanner. See the [upstream README](https://github.com/libplctag/libplctag/blob/release/README.md) and [connection attributes](https://github.com/libplctag/libplctag/wiki/All-Attributes).

Pin the chosen release/commit, record its license and build it in a reproducible development environment. Neither candidate is already integrated or validated by this guide. A supported commercial Linux scanner SDK is also an option if the open-source scanner fails the required compatibility or maintenance assessment.

Run the hardware service under a dedicated account and `systemd`, with explicit network readiness, bounded restart behavior and health reporting. Add only measured scheduling privileges. PREEMPT_RT, CPU affinity and memory locking are possible tuning steps after establishing a working baseline; they do not by themselves prove deterministic physical I/O response.

## 3. NX-EIC202 commissioning path

Omron describes the EIC202 as an EtherNet/IP coupler supporting up to 63 NX I/O Units. Actual usable layouts also depend on module compatibility and power budgets. Use the [coupler product documentation](https://www.ia.omron.com/products/family/3412/) and its [specifications](https://www.ia.omron.com/products/family/3412/specification.html).

1. Inventory the coupler firmware, NX module models/revisions, exact left-to-right order, terminal wiring, input filters and output fault settings. Check unit power and field power separately.
2. Use compatible Omron engineering software on a supported engineering workstation to configure the slave terminal. Archive the project, configuration exports and matching EDS. Debian is the runtime host; this design does not assume Omron's engineering tools run natively on Debian.
3. Obtain the actual input/output allocation and connection definition. Record input, output and configuration assembly instances, configuration payload, image lengths, and status/control fields. Do not infer byte lengths from the number of wired points.
4. Configure the Linux scanner from that definition: identity checks, connection path, ownership, transport/direction, requested intervals, timeout parameters and real-time format. Resolve whether library lengths include or exclude protocol headers, especially the Run/Idle header; distinguish application image bytes from wire bytes.
5. Establish communication with an inhibited output image. Validate terminal/module health and I/O-data validity before accepting any channel as fresh.
6. Toggle one isolated input at a time and verify its exact byte/bit. Exercise outputs individually with suitable indicator loads. Save a versioned map and compare it against the installed configuration on every deployment.

**Assembly IDs and lengths deliberately remain commissioning fields.** Numbers from another adapter or a library demonstration are not an Omron configuration. Use W536 and the matching EDS/export; Omron's [EIC202 third-party scanner quick start](https://automation-knowledge-base.omron.eu/support/solutions/articles/103000352857-quick-start-guide-for-configuring-nx-eic202-with-rockwell-automation) illustrates the configuration workflow, although its scanner is Rockwell rather than Debian.

Suggested profile fields:

```text
adapter_kind: omron_nx_eic202
address, vendor_id, device_type, product_code, accepted_revision
configuration_revision, expected_module_order
input_assembly, output_assembly, configuration_assembly
input_image_bytes, output_image_bytes, configuration_payload
o_to_t_rpi_us, t_to_o_rpi_us, timeout_parameters
transport_mode, realtime_header_format
signal_offsets, diagnostic_offsets, module_fault_policies
```

Implement an `IIOAdapter` around typed snapshots and authorized output images. Keep transport framing out of equipment logic. Publish receipt time, quality, link state, module faults and the configuration revision alongside the values.

## 4. Using the available NX1P2 as I/O

### Hardware and engineering setup

Read the full nameplate and firmware first. Back up the existing Sysmac project and controller contents before replacing any program. Use the **EtherNet/IP port** for Debian; the separate EtherCAT port serves a different network.

Check the exact output polarity, load ratings, commons and field supply before attaching bench loads. The NX1P2 does not provide NX-bus I/O field power; modules that obtain field power from that bus require the appropriate additional I/O power supply. Verify compatibility and supply calculations in [W578, NX1P2 hardware manual](https://files.omron.eu/downloads/latest/manual/en/w578_nx-series_nx1p2_cpu_unit_hardware_users_manual_en.pdf?v=1).

In compatible Sysmac Studio, configure the CPU/local modules, map physical I/O to program variables, and create a small cyclic gateway task. Publish dedicated command/status variables with the required network access settings. Do not expose unrestricted physical-output variables for clients to write.

### Start with explicit tag reads/writes

Create an `omron_nx1p2_explicit` adapter implementing the same project `IIOAdapter` contract as the simulator and future EIC202 adapter. Begin with a read-only test variable, then an input image, and finally a supervised output command to an isolated lamp.

Use compact arrays of fixed-width integers for the first wire contract. Define element sizes, byte order, bit assignments, lengths and schema revision explicitly. Avoid assuming that a C++ structure has the same padding or BOOL packing as an IEC structure.

Proposed application contract, not Omron built-in tags:

| Image | Fields |
|---|---|
| Debian → PLC | Schema revision, session identity, control generation, command sequence, arm request, output bits/words |
| PLC → Debian | Schema revision, PLC boot/session indication, accepted command sequence, input bits/words, applied output image, PLC heartbeat, armed state, rejection/fault flags |

Publish PLC telemetry even when disarmed. Distinguish applied output state from actual starter/actuator feedback; a commanded bit is not proof of motion.

Explicit writes may be split or observed across task scans. Use a defined staging/commit protocol or a verified coherent single-image transfer. A staging design writes a complete pending image while it is marked invalid, waits for successful completion, then publishes its commit sequence; the PLC copies and validates the image before applying it. Serialize writers, reject incomplete/mismatched sequences and test interruption at each phase. Use equivalent snapshot validation for multi-request status reads.

The PLC must enforce a local command-age timeout based on **its own monotonic elapsed time since an accepted, advancing command**. Never compare a Debian monotonic timestamp directly with a PLC clock. Repeated reads, duplicate sequence numbers or an unchanged ON image must not refresh the command lease.

Proposed gateway logic:

```text
On startup: disarm; invalidate command; apply defined inhibited image.
On complete command: validate schema, current session, sequence and permissions.
On newly accepted advancing generation/sequence: refresh local command-age timer.
If expired, invalid, faulted or explicitly disarmed: inhibit outputs; latch re-arm required.
Otherwise: apply validated image through the gateway's sole output writer.
Every task: publish inputs, accepted sequence, applied image and health.
```

Use a fresh handshake after either host restarts. Arm state must not be retained across power loss or restored by a queued old packet. Deliberate re-arm is separate from alarm acknowledgement. Decide and test wraparound/session handling rather than assuming counters never repeat.

The hardware service may only advance accepted command freshness while the control engine is producing fresh generations. A healthy communication loop endlessly sending an old ON command must eventually cause inhibition. PLC communications status alone cannot detect that condition.

### Cyclic tag data links as the second step

The NX1P2 supports cyclic tag data links, documented in [W506, built-in EtherNet/IP port manual](https://www.omron-ap.com/data_pdf/mnu/w506-e1-31_nx_nx1p_nj.pdf?id=3698). Configure matching published variables/tag sets and connection parameters with the applicable Omron tooling. Verify support for symbolic tag connection paths and direction in the chosen Linux stack.

Do not reuse the EIC202 assembly configuration for these tags. If the Linux stack only supports fixed assembly paths, NX1P2 cyclic interoperability is still unresolved. An alternative is for the PLC to originate links to a Linux adapter implementation, which requires adapter software on Linux rather than a scanner alone. Preserve the application lease and re-arm rules with either topology.

If explicit polling cannot meet timing, cyclic links are the next transport experiment. Moving complete fast equipment sequences into the PLC is another possible design, but would change the project's current control ownership and should be specified separately.

## 5. Timing and failure behavior

The project requires less than 30 ms physical-input-to-physical-output response on designated non-safety paths. Proposed initial cyclic settings are a 5 ms RPI and 5 ms control period **only where the actual device/stack supports them**. They are tuning hypotheses, not acceptance results. Explicit polling initially serves functional testing without a timing claim.

Budget the entire path:

```text
Input filter + input/module refresh + network publication wait
+ Linux receive/queue + control-cycle wait + computation
+ command transmission wait + output/module refresh + electrical response
```

For the NX1P2 gateway, include PLC task waits in both directions; for explicit access also include request/reply scheduling and retries. Two network directions and several asynchronous cycles consume more time than one RPI. Short input pulses can be missed by sampled I/O; rotation monitoring may require a compatible counter/capture function rather than ordinary bit polling.

Measure physical edges with an oscilloscope or logic analyzer under CPU, disk and network load. Record worst observed latency, jitter, missed transitions and test duration. Instrument software with monotonic timestamps to locate delays, but do not substitute packet timing for physical measurement.

Define process shutdown behavior per actuator. Set and physically verify EIC202/NX output-module behavior for connection loss; for the PLC option also verify CPU PROGRAM/STOP, task faults and PLC power loss. “All zero” is an image value, not proof that every valve or gate reaches its required process state.

Keep cyclic-connection supervision separate from any explicit-output watchdog described by the coupler. The NX1P2 application lease is an additional gateway mechanism. Neither a standard coupler, ordinary PLC gateway nor Linux watchdog supplies the project's independent personnel-safety function.

## 6. Bench acceptance sequence

Use isolated indicator loads and a documented expected response before connecting machine actuators.

1. Record models, firmware, wiring, engineering-tool version, library commit, network settings and image schema.
2. Prove read-only identity/status access and every input bit. Check invalid-data and disconnected quality reporting.
3. Prove every output individually, including feedback mapping and mutually exclusive gate commands.
4. Confirm startup, service restart and reconnect leave outputs inhibited until deliberate re-arm.
5. Kill the control engine while communications remain healthy. Confirm the control-generation lease expires and measure physical inhibition time.
6. Kill the hardware service, unplug Ethernet, interrupt field supply, reboot Debian, and power-cycle Omron. Record outputs and recovery for each fault separately.
7. For NX1P2, test frozen/duplicate commands, partial writes, stale sessions, rejected schemas, PLC STOP/PROGRAM and gateway task failure. Confirm new transport traffic alone cannot keep an old command alive.
8. Measure the designated physical response paths under load, plus communication-loss response and sensor pulse capture. Adjust intervals only after identifying the limiting term.
9. Archive the bench evidence and unresolved failures. Repeat coupler-specific mapping, timing and fault tests when EIC202 hardware becomes available.

## 7. Decision after the bench

| Criterion | NX-EIC202 | NX1P2 gateway |
|---|---|---|
| Existing availability | Not established | Available on the user's bench |
| Engineering artifacts | Coupler/NX layout, EDS, scanner profile | Sysmac project, I/O layout, gateway program, network schema |
| Application ownership | Matches present Debian control baseline | Matches baseline if PLC remains a bounded gateway |
| Expansion | Coupler supports a larger local NX terminal | Eight local NX Units; other expansion needs its own design |
| Additional logic | Primarily Debian service plus module behavior | Debian service plus maintained PLC lease/mapping code |
| Main validation risk | Linux scanner interoperability and module fault behavior | Tag interoperability, coherent transfer, gateway timing and restart behavior |

**Recommended next deliverable:** implement the common adapter interface and a minimal NX1P2 explicit-tag bench adapter, then capture functional and failure-test evidence. Choose permanent NX1P2 deployment only after its point count, expansion, measured timing, tool availability and maintenance burden fit the installation. It can avoid buying a coupler for initial experiments; it does not eliminate production qualification.

Still needed: full bench CPU suffix/firmware, available Sysmac software/license, attached NX module inventory, transistor/load wiring details, Debian PC/NIC details, actual EIC model if procured, and the exact signals requiring the 30 ms target. These are commissioning inputs, not reasons to delay read-only bench preparation.
