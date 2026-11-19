# Omron NX EtherCAT I/O with a Debian/Linux Feed Mill Controller

**Project:** Batch Mill — configurable Linux-based feed mill control system  
**Scope:** Omron NX-ECC203 EtherCAT coupler, NX digital/analog I/O, NX-RS1201 load cell module, IgH/EtherLab EtherCAT master, and the role of Sysmac Studio.  
**Status:** Design and commissioning notes. Hardware behavior and module-specific object mappings must be verified on a test system before production use.

## Executive summary

- An **Omron NX-ECC203** EtherCAT coupler can be connected to a dedicated Ethernet interface on a Debian/Linux PC running an EtherCAT master, such as **IgH EtherCAT Master (EtherLab)**. No Omron PLC is required for normal EtherCAT I/O operation.
- **Sysmac Studio is not required as a runtime component** of the feed mill controller. Its value without an Omron PLC is principally local coupler/module configuration, local I/O checking, troubleshooting, and use as an engineering reference.
- Standard digital I/O can often be used with default process-data mappings, but discovery, startup settings, and actual PDO layout must be verified.
- Analog I/O and the **NX-RS1201** may need parameter settings and commissioning. Some settings can be accessed by a third-party EtherCAT master through **CoE/SDO**; cyclic measurements and commands use **PDOs**. Never assume every setting is accessible through a particular mechanism without checking that module's manual.
- The NX-RS1201 documents calibration commands usable from a controller program. This provides a path toward performing calibration from the mill's own HMI, but **command mapping, persistence, and error behavior must be tested with the NX-ECC203 and Linux master**.
- The recommended end state is a **Sysmac-independent commissioning and operating workflow**, with Sysmac Studio kept as an optional engineering/diagnostic tool if needed.

## 1. Suggested system architecture

```text
Debian industrial PC
  ├── Ethernet port 1: plant LAN / browser HMI / administration
  └── Ethernet port 2: dedicated EtherCAT master interface
         │
         └── NX-ECC203 EtherCAT coupler
                ├── NX digital input modules
                ├── NX digital output modules
                ├── NX analog input/output modules
                └── NX-RS1201 load cell input module
```

- EtherCAT runs directly over an Ethernet interface; **ordinary IP addressing is not used for slave cyclic communication**.
- Daisy-chain stations using the EtherCAT IN/OUT ports or use EtherCAT-compatible junction hardware for branches; do not treat the EtherCAT segment as a conventional switched Ethernet LAN.
- Keep the EtherCAT cyclic thread separate from web UI, database, inventory, and recipe execution workloads.
- An initial **5 ms cycle** is a reasonable experimental starting point, **not a guaranteed response time**. Test end-to-end latency, jitter, module conversion/filter delays, and fault recovery against the project's approximately 30 ms ordinary-I/O response goal.

## 2. Linux EtherCAT master setup (outline)

Recommended starting implementation: **IgH/EtherLab EtherCAT Master** on Debian, preferably with a tested PREEMPT_RT kernel and a dedicated, compatible NIC.

1. Identify the dedicated interface: `ip -br link`.
2. Identify its MAC address: `cat /sys/class/net/<interface>/address`.
3. Build/install IgH for the **specific installed kernel** and select a verified Ethernet driver (generic driver may be suitable for bench testing).
4. Configure the master, for example with the NIC MAC address in `/etc/ethercat.conf`:

   ```ini
   MASTER0_DEVICE="aa:bb:cc:dd:ee:ff"
   DEVICE_MODULES="generic"
   ```

5. Start the installed EtherCAT service (the service/command depends on the package and installation method; some installations provide `ethercatctl start`).
6. Verify devices using EtherLab CLI commands such as:

   ```bash
   sudo ethercat master
   sudo ethercat slaves
   sudo ethercat pdos -p 1
   sudo ethercat sdos -p 1
   ```

7. Obtain matching Omron ESI/XML device descriptions and confirm vendor/product IDs, module order, process data and supported CoE objects.
8. Register PDO entries in the application; verify working counter and AL states; establish a safe-state response for communications loss.

**Important:** The displayed slave position (`-p 1` above) is illustrative; actual position depends on the scanned network and installed module exposure. Commands, driver availability, and service integration vary by IgH release and kernel.

## 3. What Sysmac Studio provides without an Omron PLC

When connected directly to the NX-ECC203 through its supported USB/service connection, Sysmac Studio may be used for these **local NX station engineering tasks**:

| Function | Relevance without Omron PLC |
|---|---|
| Discover/check installed NX module arrangement | Relevant for commissioning |
| Configure NX Unit operation parameters | Relevant for analog, load cell, and specialty units |
| Transfer applicable settings to the coupler/units | Relevant |
| Local I/O checking and diagnostics supported by the coupler | Relevant for bench/field troubleshooting |
| Omron PLC project synchronization and PLC variable monitoring | **Not applicable** without an Omron PLC |
| PLC-program forcing/debugging | **Not applicable** without an Omron PLC |
| PLC-specific network/project functions | **Not applicable** or not available via standalone coupler USB workflow |

**Do not confuse a feature of an NX module with a feature provided by Sysmac Studio.** Filtering, diagnostics, and calibration are module capabilities; Sysmac Studio is one means of configuring or invoking them.

### Practical conclusion

Sysmac Studio is **not inherently required** for routine operation. It can shorten initial engineering and troubleshooting, but should not become a dependency of the production Linux application unless a specific needed module configuration is unavailable or unverified through EtherCAT.

## 4. Module-specific considerations

### Standard 24 VDC digital I/O

- Expected operation: cyclic **PDO** reads/writes from Linux.
- Defaults may suffice for straightforward digital input/output exchange.
- Confirm module identity, channel-to-PDO mapping, watchdog behavior, sourcing/sinking conventions, and module/output power arrangements.
- Do not assume that a coupler and all attached units are usable without any startup parameterization; verify the actual station.

### Analog input and output units

Potentially relevant parameters include:

- Voltage/current measurement or output range (only where the specific module supports the selected range).
- Channel enablement, scaling, filter or averaging options.
- Sensor fault detection and diagnostic/status reporting.
- Analog-output fallback behavior on bus loss.

**Configuration paths:** Depending on the unit, settings may be defaults, CoE **SDO** objects, startup download parameters, or local Sysmac Studio configuration. Check the **exact module model and revision** before claiming that a given parameter is writable from Linux.

### NX-RS1201 load cell input unit

Potentially useful feed mill functions include:

- Raw/processed weight readings and appropriate diagnostic states.
- Zero/span calibration with a known test weight, subject to the module's supported procedure.
- Equivalent-input calibration where appropriate.
- Tare/zero operations and filtering/stability-related settings where supported.
- Fault detection (including sensor/wiring issues) and calibration validation.

**Important distinction:** Omron documentation describes **calibration from a user program** using command/response process-data fields, including named fields such as:

- `Ch1 Calibration Command SID`
- `Ch1 Calibration Command`
- `Ch1 Calibration Data`
- `Ch1 Calibration Command Response SID`
- `Ch1 Calibration Command Response`

A Linux application can potentially implement that command/response handshake using the appropriate EtherCAT mapping. The procedure must be validated with the actual NX-ECC203, NX-RS1201 firmware/version, and master. **Do not assume all calibration functions, filtering parameters, or trace functionality are exposed through cyclic PDOs.** Some may require SDO settings or Sysmac Studio.

For the feed mill, separate **routine tare/zero** from **metrological span calibration**, and require explicit commissioning authorization for calibration changes.

## 5. EtherCAT configuration mechanisms

| Mechanism | Purpose in this project |
|---|---|
| **ESI/XML device descriptions** | Identify device capabilities and help define/configure PDOs and CoE properties |
| **PDOs (cyclic process data)** | Continuous digital/analog readings, digital outputs, and any supported RS1201 calibration command/status fields |
| **SDOs (CoE object dictionary)** | Read/write supported device and module parameters; read diagnostic/configuration data where provided |
| **Startup parameter writes** | Establish a reproducible commissioned state when units require nondefault settings |
| **Nonvolatile save/restart procedures** | Preserve selected settings when the specific unit's documentation supports them |
| **Sysmac Studio USB workflow** | Optional local configuration, I/O check, troubleshooting, and engineering comparison |

Omron's **NX-series EtherCAT Coupler Units User's Manual (W519)** describes using an EtherCAT master from another manufacturer for applicable configuration operations, including CoE parameter access. Follow the specified sequence and distinguish settings applied immediately from those needing a module restart or nonvolatile save.

## 6. Proposed feed mill installer features

The application's **Omron NX driver** should be separated from the high-level mill routing and batching logic. Logical point names must map to actual station/module/channel positions.

**Core features**

1. Discover EtherCAT slaves and show identity, firmware revision, station position and state.
2. Display detected NX coupler and I/O module order; verify against commissioned configuration.
3. Show per-channel input/output states, analog readings and diagnostics.
4. Provide assignment from physical channels to logical mill points (e.g., `BIN_07_LOW_LEVEL`, `AUGER_03_RUN_FB`, `MIXER_SCALE_WEIGHT`).
5. Support model-specific analog range and filter settings **only when documented and tested**.
6. Provide NX-RS1201 weight, health, zero/tare and calibration workflows after validating the command interface.
7. Store a versioned site configuration and record module replacements, settings and calibration events.
8. Detect station mismatch, EtherCAT state loss and communication faults; block unsafe restart.

**Commissioning restrictions**

- Only allow output tests under an explicit, controlled commissioning mode.
- Never rely on normal EtherCAT output control as the sole emergency-stop or personnel-safety function.
- Define safe output states, watchdog responses, startup permissives and loss-of-network behavior.
- Require authorization, audit trail and verification for scale calibration and saved hardware parameters.

## 7. Bench-test sequence before committing to a Sysmac-free installer

1. Obtain one NX-ECC203, a simple 24 V digital input unit, a digital output unit and the intended analog/RS1201 module(s).
2. Connect the coupler to the dedicated Debian EtherCAT NIC and supply the required 24 V system/I/O power.
3. Confirm device discovery, EtherCAT Operational state, PDO mapping and stable cyclic exchanges **without Sysmac Studio**.
4. Test power cycles, unplug/reconnect, master restart and channel fail-safe behavior.
5. For each analog module, test selected range, scaling, filtering, diagnostics, and parameter persistence from Linux.
6. For NX-RS1201, test basic weight readings, calibration handshake, tare/zero, sensor faults, and saved calibration after power cycling.
7. Compare with Sysmac Studio over direct USB only where necessary to establish reference settings or troubleshoot.
8. Document every model-specific CoE index/subindex, permitted range, readback expectation, save/restart rule and firmware dependency.
9. Benchmark input-to-commanded-output latency under CPU/disk/HMI load and during communications recovery.

**Acceptance criterion:** The intended site setup, routine scale service, and recovery procedures must be possible without Sysmac Studio before claiming the production installation is Sysmac-independent.

## 8. Outstanding verification items

- Confirm which exact NX digital, analog and RS1201 models/firmware revisions will be supported.
- Obtain current Omron ESI files and definitive PDO/SDO mapping for the NX-ECC203 + installed modules.
- Confirm whether each analog setting can be written/read/saved through the selected third-party EtherCAT master.
- Verify what RS1201 calibration operations are supported with NX-ECC203, their required mapping, and their persistence/validation steps.
- Determine which Sysmac Studio local USB diagnostic/checking functions are available with this specific coupler firmware and module set.
- Establish whether an initial Sysmac configuration is needed for any specialty unit under the selected defaults.
- Confirm real-world EtherCAT NIC/driver support and latency on the chosen Debian industrial PC.

## References

- Omron **W519**, *NX-series EtherCAT Coupler Units User's Manual*. In particular, consult sections/appendices on direct Sysmac Studio USB connection, third-party EtherCAT masters, CoE parameters and module settings.  
  https://files.omron.eu/downloads/latest/manual/en/w519_nx-series_ethercat_coupler_units_users_manual_en.pdf?v=1
- Omron **W565**, *NX-series Load Cell Input Unit User's Manual* (NX-RS1201), including calibration by user program.  
  https://files.omron.eu/downloads/latest/manual/en/w565_nx-series_load_cell_input_unit_users_manual_en.pdf?v=1
- Omron **P104**, *NX-series Load Cell Input Unit Setup Manual*.  
  https://files.omron.eu/downloads/latest/manual/en/p104_nx_series_load_cell_input_unit_setup_manual_en.pdf?v=1
- **IgH EtherCAT Master / EtherLab**: https://etherlab.org/ and https://gitlab.com/etherlab.org/ethercat

---

*These notes summarize architectural conclusions from the project discussion. They are not a substitute for checking the specific module manual, revision and safety requirements during implementation.*
