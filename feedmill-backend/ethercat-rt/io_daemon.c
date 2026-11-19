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
 * FAIL-SAFE: if the command file stops being updated (Node backend
 * down, or the link between them broken) for COMMAND_STALE_US, every
 * DO/AO is forced to zero/off regardless of its last commanded value —
 * do not rely on EtherCAT output state alone as a safety function
 * (see omron_nx_ethercat_linux_configuration.md's commissioning
 * restrictions).
 *
 * CONFIG IS GENERATED, NOT HAND-WRITTEN: feedmill-backend writes this
 * program's config file itself (generateIoConf()/syncIoConf() in
 * src/ethercat.ts) from the configured rack + every signal mapped to
 * an equipment port — see io.conf.example for the format, but never
 * hand-edit the real file at /etc/feedmill/io.conf.
 *
 * STATUS: written against the documented ecrt API from memory. NOT
 * compiled or run against real IgH headers/hardware in this session.
 * Before trusting it:
 *
 *   1. Build on the Debian target once the IgH master + dev headers
 *      are installed (the install/install.sh script does this):
 *        gcc -O2 -Wall -o io-daemon io_daemon.c -lethercat -lpthread -lrt
 *
 *   2. Confirm the vendor/product IDs and PDO index:subindex against
 *      the REAL slaves, then fix NX_CARD_PRODUCT_ID / NX_DI_PDO /
 *      NX_DO_PDO / NX_AI_PDO / NX_AO_PDO in src/types.ts (NOT this
 *      file's config — it's generated from those tables) — on the
 *      target:
 *        ethercat slaves -v                  # vendor_id / product_id
 *        ethercat pdos -p <slave position>   # pdo index:subindex per point
 *
 *   3. This assumes every AI/AO entry is a 16-bit signed word and every
 *      SCALE (NX-RS1201 weight) entry is a 32-bit signed value, both at
 *      a byte-aligned offset — true for Omron NX-AD/NX-DA's documented
 *      default mapping, but confirm per module, including the RS1201's
 *      actual weight-value width/format in the W565 manual. Registration
 *      assumes
 *      the slave's default (SII/ESI) PDO mapping already exposes the
 *      index:subindex used; if the active mapping differs, call
 *      ecrt_slave_config_pdos() with an explicit sync-manager/PDO list
 *      before ecrt_slave_config_reg_pdo_entry().
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
#include <sys/stat.h>
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
    bool       counted;        /* DI only: also edge-count (rotation sensors) */
    unsigned   offset;         /* byte offset into the domain process image, set at config time */
    unsigned   bit;            /* bit position within that byte (DI/DO only) */
    bool       last_state;     /* DI only — edge detection */
    uint64_t   count;          /* DI+counted only — accessed via __atomic builtins from both threads */
    uint64_t   last_edge_us;
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
            unsigned pos; unsigned long idx, sub;
            flag[0] = '\0';
            int nf = sscanf(line, "%31s %31s %u %7s %lx %lx %7s", kw, sig, &pos, dirstr, &idx, &sub, flag);
            if (nf != 6 && nf != 7) {
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
            strncpy(c->signal_id, sig, sizeof(c->signal_id) - 1);
            c->slave_idx = si;
            c->dir = parse_dir(dirstr);
            c->pdo_index = (uint16_t)idx;
            c->pdo_subindex = (uint8_t)sub;
            c->counted = (nf == 7 && strcmp(flag, "count") == 0);
        }
    }
    fclose(f);
    if (n_channels == 0) { fprintf(stderr, "io_daemon: no channels configured\n"); exit(1); }
}

/* ---- state-file writer thread (non-realtime; the RT thread never touches disk) ---- */

static void *writer_thread(void *arg) {
    (void)arg;
    char tmp_path[280];
    snprintf(tmp_path, sizeof(tmp_path), "%s.tmp", state_path);
    while (running) {
        FILE *f = fopen(tmp_path, "w");
        if (f) {
            fprintf(f, "{\"atUs\":%llu,\"inputs\":{", (unsigned long long)now_us());
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
                fprintf(f, "%s\"%s\":{\"count\":%llu,\"lastEdgeUs\":%llu}",
                        first ? "" : ",", c->signal_id,
                        (unsigned long long)cnt, (unsigned long long)edge);
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

static void *reader_thread(void *arg) {
    (void)arg;
    time_t last_mtime = 0;
    uint64_t last_applied_us = now_us();
    while (running) {
        struct stat st;
        if (stat(command_path, &st) == 0) {
            if (st.st_mtime != last_mtime) {
                last_mtime = st.st_mtime;
                last_applied_us = now_us();
                FILE *f = fopen(command_path, "r");
                if (f) {
                    char line[256];
                    while (fgets(line, sizeof(line), f)) {
                        char kw[16], sig[32]; long val;
                        if (line[0] == '#' || line[0] == '\n') continue;
                        if (sscanf(line, "%15s %31s %ld", kw, sig, &val) == 3 && strcmp(kw, "output") == 0) {
                            channel_t *c = find_output_channel(sig);
                            if (c) __atomic_store_n(&c->value, (int32_t)val, __ATOMIC_RELAXED);
                        }
                    }
                    fclose(f);
                }
            }
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
        c->offset = (unsigned)off;
        c->bit = bitpos;
    }

    if (ecrt_domain_size(domain) <= 0) { fprintf(stderr, "io_daemon: empty domain\n"); exit(1); }
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

    uint64_t t = now_us();
    for (int i = 0; i < n_channels; i++) {
        channel_t *c = &channels[i];
        switch (c->dir) {
        case DIR_DI: {
            bool state = read_bit(c->offset, c->bit);
            if (c->counted && state && !c->last_state) {
                __atomic_fetch_add(&c->count, 1, __ATOMIC_RELAXED);
                __atomic_store_n(&c->last_edge_us, t, __ATOMIC_RELAXED);
            }
            c->last_state = state;
            __atomic_store_n(&c->value, state ? 1 : 0, __ATOMIC_RELAXED);
            break;
        }
        case DIR_AI:
            __atomic_store_n(&c->value, read_i16(c->offset), __ATOMIC_RELAXED);
            break;
        case DIR_SCALE:
            __atomic_store_n(&c->value, read_i32(c->offset), __ATOMIC_RELAXED);
            break;
        case DIR_DO:
            write_bit(c->offset, c->bit, __atomic_load_n(&c->value, __ATOMIC_RELAXED) != 0);
            break;
        case DIR_AO:
            write_i16(c->offset, (int16_t)__atomic_load_n(&c->value, __ATOMIC_RELAXED));
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
    load_config(argv[1]);

    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

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
