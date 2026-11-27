/*
 * feedmill io_daemon — cyclic EtherCAT I/O exchange for the whole rack
 * (digital + analog in both directions), plus edge-counted rotation
 * sensors. Supersedes rotation_counter.c, which only handled the
 * rotation-sensor case; this generalizes the same approach to every
 * configured point.
 *
 * WHY THIS EXISTS: the Node backend's control scan runs every 100ms —
 * fine for ordinary digital/analog I/O, but not for a shaft sensor
 * producing a pulse roughly every 40ms (see the header this file
 * replaced for the aliasing math), and Node itself has no way to touch
 * the EtherCAT process image at all. This program runs its own tight
 * EtherCAT cyclic loop (ecrt — the IgH EtherCAT Master's realtime API)
 * at the master's configured cycle time:
 *   - reads every configured DI/AI point each cycle and republishes
 *     the values to a small JSON state file (rotation-flagged DI
 *     channels also get an edge count, same as before);
 *   - reads desired DO/AO values from a small text command file
 *     (written by Node) and writes them into the process image every
 *     cycle, so the bus always carries the latest commanded outputs.
 * The Node backend reads the state file and writes the command file
 * once per scan; it never touches raw PDOs. This program does no
 * control logic of its own — that stays in src/mill.ts.
 *
 * FAIL-SAFE: if the command file's sequence number stops ADVANCING (Node
 * backend down, or the link between them broken) for COMMAND_STALE_US,
 * every DO/AO is forced to zero/off regardless of its last commanded
 * value — do not rely on EtherCAT output state alone as a safety function
 * (see omron_nx_ethercat_linux_configuration.md's commissioning
 * restrictions). Freshness is driven by that sequence number INSIDE the
 * command file (see reader_thread), not file mtime; re-reading an
 * UNCHANGED seq must NOT refresh the deadline (an earlier revision did,
 * which meant a dead backend's last command could never go stale at
 * all). The daemon also carries no output state across its own restart —
 * every DO/AO starts at 0 until the first fully-valid command image is
 * parsed.
 *
 * BUS VALIDITY: every cycle gates on ms.link_up && ds.wc_state ==
 * EC_WC_COMPLETE (see run_cycle) before touching inputs or outputs from
 * domain_pd — an incomplete working counter no longer silently reads
 * garbage or writes a command into a half-exchanged image. The result
 * is published as "healthy" in the state file for the backend to act on
 * (src/mill.ts's updateBusHealth) rather than just displaying stale data.
 *
 * CONFIG IS GENERATED, NOT HAND-WRITTEN: feedmill-backend writes this
 * program's config file itself (generateIoConf()/syncIoConf() in
 * src/ethercat.ts) from the configured rack + every signal mapped to
 * an equipment port — see io.conf.example for the format, but never
 * hand-edit the real file at /etc/feedmill/io.conf.
 *
 * STATUS: written against the documented ecrt API from memory. NOT
 * compiled or run against real IgH headers/hardware in this session.
 * CONFIRMED on real hardware (an NX-ECC203 + NX-OD5256 + NX-ID5442): the DI
 * read path works end to end (16 points sharing one 0x6022:01 entry,
 * addressed per-bit), and the DO write path with the PDO dedup fix
 * (registered[] cache) plus the command-heartbeat fix (ioDaemon.ts
 * always rewriting, see git history) — forced outputs no longer dropped
 * out ~2s after being set. The bus-validity gate, sequence-based command
 * protocol, and edge-interval RPM fields in this revision are NOT yet
 * re-confirmed against real hardware. Before trusting it:
 *
 *   1. Build on the Debian target once the IgH master + dev headers
 *      are installed (the install/install.sh script does this):
 *        gcc -O2 -Wall -o io-daemon io_daemon.c -lethercat -lpthread -lrt
 *
 *   2. Vendor/product ID and the PDO entry list are no longer hand
 *      -maintained tables — src/ethercat.ts's verifyEthercatRack() reads
 *      them live off the bus (`ethercat slaves -p 0 -v` / `ethercat pdos
 *      -p 0`) whenever the HMI's Read Rack runs, and this file's config
 *      is generated from that. CONFIRMED on a real NX-ECC203: the coupler
 *      + every NX module behind it is ONE EtherCAT slave (position 0),
 *      not one per card — so every "slave" line below is that same
 *      coupler, and a digital card's 16 points all share ONE PDO entry
 *      (e.g. 0x6022:01, 16 bit), addressed as a BIT within it, not 16
 *      separate entries. The config's explicit bit field (below) carries
 *      that addressing — this program does not compute it from a point
 *      number. Those two CLI commands' output format is parsed by
 *      getSlaveProductId()/getRackPdoEntries() in ethercat.ts — if Read
 *      Rack comes back with cards stuck "ok" but channels missing from
 *      here, check those regexes against your IgH version's actual output
 *      first.
 *
 *   3. Analog (AI/AO) and SCALE (NX-RS1201 weight) entries are each their
 *      OWN whole PDO entry (one per channel, not packed into bits like
 *      digital) — AI/AO assumed 16-bit signed, SCALE assumed 32-bit
 *      signed, both byte-aligned. UNVERIFIED — no real analog/RS1201 PDO
 *      dump seen yet; confirm per module against the W565/W519 manuals.
 *      Registration assumes the slave's default (SII/ESI) PDO mapping
 *      already exposes the index:subindex used; if the active mapping
 *      differs, call ecrt_slave_config_pdos() with an explicit sync
 *      -manager/PDO list before ecrt_slave_config_reg_pdo_entry().
 *
 *   4. Run as its own systemd service (feedmill-io-daemon.service),
 *      independent of the Node backend's lifecycle — see that unit.
 */

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <time.h>
#include <signal.h>
#include <unistd.h>
#include <pthread.h>
#include <sched.h>
#include <sys/mman.h>
#include <ecrt.h>

#define MAX_CHANNELS 256
#define MAX_SLAVES   32
#define COMMAND_STALE_US 2000000ULL /* 2s with no fresh command file -> force outputs safe */

typedef enum { DIR_DI, DIR_DO, DIR_AI, DIR_AO, DIR_SCALE } chan_dir_t;

typedef struct {
    char       signal_id[32];  /* e.g. "I:03.00" / "O:03.00" / "AI:05.00" — matches buildSignals() in mill.ts */
    int        slave_idx;      /* index into slaves[] */
    uint16_t   pdo_index;
    uint8_t    pdo_subindex;
    chan_dir_t dir;
    unsigned   cfg_bit;        /* from config: DI/DO point's bit position within the registered word; 0 and unused for AI/AO/SCALE */
    bool       counted;        /* DI only: also edge-count (rotation sensors) */
    unsigned   offset;         /* final byte offset into the domain process image, computed at setup time */
    unsigned   bit;            /* final bit position within that byte (DI/DO only) */
    bool       last_state;     /* DI only — edge detection */
    uint64_t   count;          /* DI+counted only — accessed via __atomic builtins from both threads */
    uint64_t   last_edge_us;
    uint64_t   edge_interval_us; /* DI+counted only — time since the PREVIOUS edge, for RPM; 0 until a 2nd edge arrives */
    int32_t    value;          /* current reading (DI 0/1, AI raw int16) or desired output (DO/AO) — atomic */
} channel_t;

typedef struct {
    uint16_t position;
    uint32_t vendor_id;
    uint32_t product_id;
    ec_slave_config_t *sc;
} slave_t;

static channel_t channels[MAX_CHANNELS];
static int n_channels = 0;
static slave_t slaves[MAX_SLAVES];
static int n_slaves = 0;
static long cycle_us = 4000;
static char state_path[256] = "/run/feedmill/io-state.json";
static char command_path[256] = "/run/feedmill/io-command.txt";
static volatile bool running = true;
static uint64_t daemon_start_us = 0; /* captured once in main(); published so the backend can detect a daemon restart */

/* Bus health + diagnostic counters, written every cycle by the RT thread
 * (atomic stores only, no I/O) and read/logged by the writer thread —
 * keeps even the once-a-second diagnostic fprintf off the RT path. */
static volatile unsigned diag_link_up = 0;
static volatile unsigned diag_slaves = 0;
static volatile unsigned diag_wc = 0;
static volatile unsigned diag_wc_state = 0;
static volatile bool bus_healthy = false; /* false until the first fully-healthy cycle */

static void on_signal(int sig) { (void)sig; running = false; }

static uint64_t now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ULL + (uint64_t)(ts.tv_nsec / 1000);
}

/* ---- tiny dependency-free config-file parser ---- */

static int find_slave(uint16_t position) {
    for (int i = 0; i < n_slaves; i++) if (slaves[i].position == position) return i;
    return -1;
}

static chan_dir_t parse_dir(const char *s) {
    if (strcmp(s, "DI") == 0) return DIR_DI;
    if (strcmp(s, "DO") == 0) return DIR_DO;
    if (strcmp(s, "AI") == 0) return DIR_AI;
    if (strcmp(s, "SCALE") == 0) return DIR_SCALE;
    return DIR_AO;
}

static void load_config(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) { fprintf(stderr, "io_daemon: cannot open config %s\n", path); exit(1); }
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        if (line[0] == '#' || line[0] == '\n') continue;
        char kw[32];
        if (sscanf(line, "%31s", kw) != 1) continue;

        if (strcmp(kw, "cycle_us") == 0) {
            sscanf(line, "%31s %ld", kw, &cycle_us);

        } else if (strcmp(kw, "state_path") == 0) {
            sscanf(line, "%31s %255s", kw, state_path);

        } else if (strcmp(kw, "command_path") == 0) {
            sscanf(line, "%31s %255s", kw, command_path);

        } else if (strcmp(kw, "slave") == 0) {
            unsigned pos; unsigned long vid, pid;
            if (sscanf(line, "%31s %u %lx %lx", kw, &pos, &vid, &pid) != 4) {
                fprintf(stderr, "io_daemon: bad slave line: %s", line); exit(1);
            }
            if (n_slaves >= MAX_SLAVES) { fprintf(stderr, "io_daemon: too many slaves\n"); exit(1); }
            slaves[n_slaves].position = (uint16_t)pos;
            slaves[n_slaves].vendor_id = (uint32_t)vid;
            slaves[n_slaves].product_id = (uint32_t)pid;
            n_slaves++;

        } else if (strcmp(kw, "channel") == 0) {
            char sig[32], dirstr[8], flag[8];
            unsigned pos; unsigned long idx, sub; unsigned bit;
            flag[0] = '\0';
            int nf = sscanf(line, "%31s %31s %u %7s %lx %lx %u %7s", kw, sig, &pos, dirstr, &idx, &sub, &bit, flag);
            if (nf != 7 && nf != 8) {
                fprintf(stderr, "io_daemon: bad channel line: %s", line); exit(1);
            }
            int si = find_slave((uint16_t)pos);
            if (si < 0) {
                fprintf(stderr, "io_daemon: channel %s references undeclared slave %u (add a 'slave' line first)\n", sig, pos);
                exit(1);
            }
            if (n_channels >= MAX_CHANNELS) { fprintf(stderr, "io_daemon: too many channels\n"); exit(1); }
            channel_t *c = &channels[n_channels++];
            memset(c, 0, sizeof(*c));
            snprintf(c->signal_id, sizeof(c->signal_id), "%s", sig); /* truncates safely; strncpy triggers -Wstringop-truncation here */
            c->slave_idx = si;
            c->dir = parse_dir(dirstr);
            c->pdo_index = (uint16_t)idx;
            c->pdo_subindex = (uint8_t)sub;
            c->cfg_bit = bit;
            c->counted = (nf == 8 && strcmp(flag, "count") == 0);
        }
    }
    fclose(f);
    if (n_channels == 0) {
        /* Not an error -- the normal state before anything's been commissioned
         * (fresh install, or the rack config was just cleared). Exiting here
         * used to crash-loop every 2s until systemd's restart limiter parked
         * the unit in a permanent failed state. main() checks n_channels and
         * idles instead of touching EtherCAT at all. */
        fprintf(stderr, "io_daemon: no channels configured yet -- idling (commission a rack in the HMI, then Read Rack)\n");
    }
}

/* ---- state-file writer thread (non-realtime; the RT thread never touches disk) ---- */

static void *writer_thread(void *arg) {
    (void)arg;
    char tmp_path[280];
    snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", state_path);
    uint64_t last_diag_us = 0;
    while (running) {
        bool healthy = __atomic_load_n(&bus_healthy, __ATOMIC_RELAXED);
        uint64_t now = now_us();
        if (now - last_diag_us >= 1000000) {
            fprintf(stderr, "io_daemon: link=%u slaves=%u wc=%u wc_state=%u healthy=%u\n",
                    __atomic_load_n(&diag_link_up, __ATOMIC_RELAXED),
                    __atomic_load_n(&diag_slaves, __ATOMIC_RELAXED),
                    __atomic_load_n(&diag_wc, __ATOMIC_RELAXED),
                    __atomic_load_n(&diag_wc_state, __ATOMIC_RELAXED),
                    healthy);
            last_diag_us = now;
        }

        FILE *f = fopen(tmp_path, "w");
        if (f) {
            fprintf(f, "{\"atUs\":%llu,\"daemonStartUs\":%llu,\"healthy\":%s,\"inputs\":{",
                    (unsigned long long)now, (unsigned long long)daemon_start_us, healthy ? "true" : "false");
            bool first = true;
            for (int i = 0; i < n_channels; i++) {
                channel_t *c = &channels[i];
                if (c->dir != DIR_DI && c->dir != DIR_AI && c->dir != DIR_SCALE) continue;
                int32_t v = __atomic_load_n(&c->value, __ATOMIC_RELAXED);
                fprintf(f, "%s\"%s\":", first ? "" : ",", c->signal_id);
                if (c->dir == DIR_DI) fprintf(f, "%s", v ? "true" : "false");
                else fprintf(f, "%d", v);
                first = false;
            }
            fprintf(f, "},\"rotation\":{");
            first = true;
            for (int i = 0; i < n_channels; i++) {
                channel_t *c = &channels[i];
                if (!(c->dir == DIR_DI && c->counted)) continue;
                uint64_t cnt = __atomic_load_n(&c->count, __ATOMIC_RELAXED);
                uint64_t edge = __atomic_load_n(&c->last_edge_us, __ATOMIC_RELAXED);
                uint64_t interval = __atomic_load_n(&c->edge_interval_us, __ATOMIC_RELAXED);
                fprintf(f, "%s\"%s\":{\"count\":%llu,\"lastEdgeUs\":%llu,\"intervalUs\":%llu}",
                        first ? "" : ",", c->signal_id,
                        (unsigned long long)cnt, (unsigned long long)edge, (unsigned long long)interval);
                first = false;
            }
            fprintf(f, "}}\n");
            fclose(f);
            rename(tmp_path, state_path); /* atomic on the same filesystem — readers never see a half-written file */
        }
        usleep(20000); /* 20ms — comfortably ahead of the ~40ms rotation-pulse period this was originally built for */
    }
    return NULL;
}

/* ---- command-file reader thread (non-realtime; applies Node's desired outputs) ---- */

static channel_t *find_output_channel(const char *sig) {
    for (int i = 0; i < n_channels; i++) {
        if ((channels[i].dir == DIR_DO || channels[i].dir == DIR_AO) &&
            strcmp(channels[i].signal_id, sig) == 0) return &channels[i];
    }
    return NULL;
}

static void force_outputs_safe(void) {
    for (int i = 0; i < n_channels; i++) {
        if (channels[i].dir == DIR_DO || channels[i].dir == DIR_AO) {
            __atomic_store_n(&channels[i].value, 0, __ATOMIC_RELAXED);
        }
    }
}

/* Freshness is driven by a sequence number INSIDE the command file (first
 * line, "seq <N>"), not the file's mtime: st_mtime is only 1-second
 * resolution, so a start immediately followed by a stop within the same
 * wall-clock second could leave the daemon never noticing the second
 * write. Re-reading unconditionally every poll instead makes mtime
 * irrelevant. The whole file must parse cleanly (seq line + every
 * non-comment line a well-formed "output <sig> <val>") before ANY of it
 * is applied or the watchdog deadline is refreshed — a malformed or
 * half-written image is rejected outright rather than applied line-by-
 * line as it's parsed (which used to let the RT thread see a mix of an
 * old and new command on a torn read). */
typedef struct { char sig[32]; int32_t val; } pending_output_t;

static void *reader_thread(void *arg) {
    (void)arg;
    uint64_t last_applied_us = now_us();
    uint64_t last_seq = 0;
    bool have_seq = false;
    while (running) {
        FILE *f = fopen(command_path, "r");
        if (f) {
            char line[256];
            bool ok = true;
            bool got_seq = false;
            uint64_t seq = 0;
            static pending_output_t pending[MAX_CHANNELS];
            int n_pending = 0;
            while (ok && fgets(line, sizeof(line), f)) {
                if (line[0] == '#' || line[0] == '\n') continue;
                char kw[16];
                if (sscanf(line, "%15s", kw) != 1) continue;
                if (strcmp(kw, "seq") == 0) {
                    unsigned long long v;
                    if (sscanf(line, "%15s %llu", kw, &v) != 2) { ok = false; break; }
                    seq = v; got_seq = true;
                } else if (strcmp(kw, "output") == 0) {
                    char sig[32]; long val;
                    if (sscanf(line, "%15s %31s %ld", kw, sig, &val) != 3) { ok = false; break; }
                    if (n_pending >= MAX_CHANNELS) { ok = false; break; }
                    snprintf(pending[n_pending].sig, sizeof(pending[n_pending].sig), "%s", sig);
                    pending[n_pending].val = (int32_t)val;
                    n_pending++;
                } else {
                    ok = false; break; /* unrecognized line — reject the whole image, don't guess */
                }
            }
            fclose(f);
            if (ok && got_seq && (!have_seq || seq != last_seq)) {
                for (int i = 0; i < n_pending; i++) {
                    channel_t *c = find_output_channel(pending[i].sig);
                    if (c) __atomic_store_n(&c->value, pending[i].val, __ATOMIC_RELAXED);
                }
                last_seq = seq;
                have_seq = true;
                last_applied_us = now_us();
            }
            /* seq unchanged (Node hasn't written since our last poll — the
             * normal case, since this thread polls every 20ms and Node
             * writes every ~100ms) or a malformed image: last_applied_us is
             * left alone either way. Re-reading a STATIC file proves only
             * that the file still exists, not that Node is still alive —
             * refreshing the deadline on an unchanged seq (an earlier
             * version of this code did) would mean a dead backend's last
             * command, including a forced-ON output, could never trip the
             * stale-command fail-safe at all. Only a seq that actually
             * ADVANCES counts as proof of life. */
        }
        if (now_us() - last_applied_us > COMMAND_STALE_US) {
            force_outputs_safe(); /* Node backend isn't updating commands — fail safe, not last-known-good */
        }
        usleep(20000);
    }
    force_outputs_safe();
    return NULL;
}

/* ---- realtime cyclic thread ---- */

static ec_master_t *master;
static ec_domain_t *domain;
static uint8_t *domain_pd;

/* Multiple channels (e.g. 16 DI/DO points) share the SAME PDO entry — one
 * whole word covers every point of a digital card. Re-registering that
 * identical (slave, index, subindex) once per channel is NOT a safe,
 * documented ecrt pattern (confirmed against a known-working bench tool
 * for this exact coupler, which registers each entry's position exactly
 * once per sync manager and computes every other bit's offset by hand) —
 * so register each unique entry once here and reuse its offset. */
typedef struct {
    int slave_idx;
    uint16_t pdo_index;
    uint8_t pdo_subindex;
    unsigned base_offset;
    unsigned base_bit; /* bit position IgH returned: nonzero for packed 1-bit BOOL entries (2/4-point cards) */
} registered_entry_t;

static registered_entry_t registered[MAX_CHANNELS];
static int n_registered = 0;

static int find_registered(int slave_idx, uint16_t index, uint8_t subindex, unsigned *out_offset, unsigned *out_bit) {
    for (int i = 0; i < n_registered; i++) {
        if (registered[i].slave_idx == slave_idx && registered[i].pdo_index == index &&
            registered[i].pdo_subindex == subindex) {
            *out_offset = registered[i].base_offset;
            *out_bit = registered[i].base_bit;
            return 1;
        }
    }
    return 0;
}

static void setup_ethercat(void) {
    master = ecrt_request_master(0);
    if (!master) { fprintf(stderr, "io_daemon: ecrt_request_master failed\n"); exit(1); }
    domain = ecrt_master_create_domain(master);
    if (!domain) { fprintf(stderr, "io_daemon: create_domain failed\n"); exit(1); }

    for (int i = 0; i < n_slaves; i++) {
        slaves[i].sc = ecrt_master_slave_config(master, 0, slaves[i].position,
                                                 slaves[i].vendor_id, slaves[i].product_id);
        if (!slaves[i].sc) {
            fprintf(stderr, "io_daemon: slave_config failed for position %u\n", slaves[i].position);
            exit(1);
        }
    }

    for (int i = 0; i < n_channels; i++) {
        channel_t *c = &channels[i];
        ec_slave_config_t *sc = slaves[c->slave_idx].sc;

        unsigned base_off, base_bit;
        if (!find_registered(c->slave_idx, c->pdo_index, c->pdo_subindex, &base_off, &base_bit)) {
            unsigned bitpos = 0;
            int off = ecrt_slave_config_reg_pdo_entry(sc, c->pdo_index, c->pdo_subindex, domain, &bitpos);
            if (off < 0) {
                fprintf(stderr,
                    "io_daemon: failed to register PDO entry %04x:%02x for %s (slave pos %u) — "
                    "check it's in the slave's active PDO mapping (`ethercat pdos -p %u`)\n",
                    c->pdo_index, c->pdo_subindex, c->signal_id,
                    slaves[c->slave_idx].position, slaves[c->slave_idx].position);
                exit(1);
            }
            base_off = (unsigned)off;
            base_bit = bitpos;
            if (n_registered < MAX_CHANNELS) {
                registered[n_registered].slave_idx = c->slave_idx;
                registered[n_registered].pdo_index = c->pdo_index;
                registered[n_registered].pdo_subindex = c->pdo_subindex;
                registered[n_registered].base_offset = base_off;
                registered[n_registered].base_bit = base_bit;
                n_registered++;
            }
        }

        if (c->dir == DIR_DI || c->dir == DIR_DO) {
            c->offset = base_off + (base_bit + c->cfg_bit) / 8;
            c->bit = (base_bit + c->cfg_bit) % 8;
        } else {
            c->offset = base_off; /* AI/AO/SCALE: the whole registered word/dword, no bit addressing */
            c->bit = 0;
        }
    }

    if (ecrt_domain_size(domain) <= 0) { fprintf(stderr, "io_daemon: empty domain\n"); exit(1); }
    /* Matches the known-working bench tool's setup -- tells the master the
     * actual cyclic rate so its internal timing isn't left at a default
     * that may not match this cycle_us. */
    ecrt_master_set_send_interval(master, cycle_us);
    if (ecrt_master_activate(master)) { fprintf(stderr, "io_daemon: activate failed\n"); exit(1); }
    domain_pd = ecrt_domain_data(domain);
    if (!domain_pd) { fprintf(stderr, "io_daemon: domain_data failed\n"); exit(1); }
}

static inline bool read_bit(unsigned offset, unsigned bit) {
    return (domain_pd[offset] >> bit) & 1;
}
static inline void write_bit(unsigned offset, unsigned bit, bool v) {
    if (v) domain_pd[offset] |= (uint8_t)(1u << bit);
    else   domain_pd[offset] &= (uint8_t)~(1u << bit);
}
static inline int16_t read_i16(unsigned offset) {
    return (int16_t)(domain_pd[offset] | (domain_pd[offset + 1] << 8));
}
static inline int32_t read_i32(unsigned offset) {
    return (int32_t)((uint32_t)domain_pd[offset] | ((uint32_t)domain_pd[offset + 1] << 8) |
                      ((uint32_t)domain_pd[offset + 2] << 16) | ((uint32_t)domain_pd[offset + 3] << 24));
}
static inline void write_i16(unsigned offset, int16_t v) {
    domain_pd[offset] = (uint8_t)(v & 0xFF);
    domain_pd[offset + 1] = (uint8_t)((v >> 8) & 0xFF);
}

static void run_cycle(void) {
    ecrt_master_receive(master);
    ecrt_domain_process(domain);

    /* Per-cycle bus-validity gate: AL state alone (INIT/PREOP/SAFEOP/OP)
     * doesn't guarantee every registered PDO entry is actually part of a
     * complete exchange THIS cycle. Previously this was only logged once a
     * second and never consulted — inputs were read and outputs written
     * from domain_pd regardless of whether the exchange behind them was
     * complete. Now every read/write is gated: unhealthy means DI/AI/SCALE
     * hold their last good value (no live update) and DO/AO are forced to
     * 0 in the image, not whatever was last commanded — the published
     * "healthy" flag (writer_thread) is how the backend tells it apart
     * from a stale-but-plausible reading and inhibits control on it. */
    ec_master_state_t ms;
    ec_domain_state_t ds;
    ecrt_master_state(master, &ms);
    ecrt_domain_state(domain, &ds);
    bool healthy = ms.link_up && ds.wc_state == EC_WC_COMPLETE;
    __atomic_store_n(&bus_healthy, healthy, __ATOMIC_RELAXED);
    __atomic_store_n(&diag_link_up, ms.link_up, __ATOMIC_RELAXED);
    __atomic_store_n(&diag_slaves, ms.slaves_responding, __ATOMIC_RELAXED);
    __atomic_store_n(&diag_wc, ds.working_counter, __ATOMIC_RELAXED);
    __atomic_store_n(&diag_wc_state, ds.wc_state, __ATOMIC_RELAXED);

    uint64_t t = now_us();
    for (int i = 0; i < n_channels; i++) {
        channel_t *c = &channels[i];
        switch (c->dir) {
        case DIR_DI: {
            if (!healthy) break;
            bool state = read_bit(c->offset, c->bit);
            if (c->counted && state && !c->last_state) {
                uint64_t prev_edge = __atomic_load_n(&c->last_edge_us, __ATOMIC_RELAXED);
                __atomic_fetch_add(&c->count, 1, __ATOMIC_RELAXED);
                __atomic_store_n(&c->last_edge_us, t, __ATOMIC_RELAXED);
                if (prev_edge) __atomic_store_n(&c->edge_interval_us, t - prev_edge, __ATOMIC_RELAXED);
            }
            c->last_state = state;
            __atomic_store_n(&c->value, state ? 1 : 0, __ATOMIC_RELAXED);
            break;
        }
        case DIR_AI:
            if (healthy) __atomic_store_n(&c->value, read_i16(c->offset), __ATOMIC_RELAXED);
            break;
        case DIR_SCALE:
            if (healthy) __atomic_store_n(&c->value, read_i32(c->offset), __ATOMIC_RELAXED);
            break;
        case DIR_DO:
            write_bit(c->offset, c->bit, healthy && __atomic_load_n(&c->value, __ATOMIC_RELAXED) != 0);
            break;
        case DIR_AO:
            write_i16(c->offset, healthy ? (int16_t)__atomic_load_n(&c->value, __ATOMIC_RELAXED) : 0);
            break;
        }
    }

    ecrt_domain_queue(domain);
    ecrt_master_send(master);
}

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: %s <config-file>\n", argv[0]);
        return 1;
    }
    daemon_start_us = now_us();
    load_config(argv[1]);

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    if (n_channels == 0) {
        /* Nothing commissioned yet -- never touch EtherCAT (ecrt_master_activate
         * on an empty domain is rejected anyway). Still run the writer/reader
         * threads so the state file exists and reads as "running, nothing
         * configured" rather than "not running" to the Node backend. Exits
         * cleanly on SIGTERM; syncIoConf() restarts this unit once a real
         * config is written, which re-execs main() from the top. */
        pthread_t writer, reader;
        pthread_create(&writer, NULL, writer_thread, NULL);
        pthread_create(&reader, NULL, reader_thread, NULL);
        while (running) usleep(200000);
        pthread_join(writer, NULL);
        pthread_join(reader, NULL);
        return 0;
    }

    setup_ethercat();

    /* Lock memory and raise this thread's priority — standard practice for an
     * IgH realtime application. Needs root, or CAP_SYS_NICE + CAP_IPC_LOCK
     * and RLIMIT_MEMLOCK raised (the systemd unit grants both). Degrades to
     * normal scheduling rather than failing outright if they're unavailable. */
    if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
        fprintf(stderr, "io_daemon: mlockall failed (continuing without it)\n");
    }
    struct sched_param sp = { .sched_priority = 80 };
    if (pthread_setschedparam(pthread_self(), SCHED_FIFO, &sp) != 0) {
        fprintf(stderr, "io_daemon: SCHED_FIFO unavailable (continuing at normal priority)\n");
    }

    pthread_t writer, reader;
    pthread_create(&writer, NULL, writer_thread, NULL);
    pthread_create(&reader, NULL, reader_thread, NULL);

    struct timespec next;
    clock_gettime(CLOCK_MONOTONIC, &next);
    while (running) {
        run_cycle();
        next.tv_nsec += cycle_us * 1000L;
        while (next.tv_nsec >= 1000000000L) { next.tv_nsec -= 1000000000L; next.tv_sec++; }
        clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &next, NULL);
    }

    pthread_join(writer, NULL);
    pthread_join(reader, NULL);
    /* Leave the bus in a known-safe state on a clean stop, same as the
     * stale-command fail-safe above, rather than latching the last values. */
    force_outputs_safe();
    run_cycle();
    ecrt_master_deactivate(master);
    ecrt_release_master(master);
    return 0;
}
