// Pure helpers for motor load (amps) monitoring and the load-to-feeder-speed controller.
// Ported from the PLC project's M40 hammermill logic: ScaleTrans, MovingAverage, the Lo/Hi Warn/Pause limits with
// on-delays, and the PID that holds hammermill amps by trimming the corn auger VFD speed.

export const scaleLinear = (pct: number, lo: number, hi: number): number => lo + (pct / 100) * (hi - lo);

export class MovingAverage {
  private buf: number[] = [];
  constructor(private size: number) {}
  push(v: number): number {
    this.buf.push(v);
    if (this.buf.length > this.size) this.buf.shift();
    return this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
  }
  reset() { this.buf = []; }
}

// On-delay timer: true once `cond` has been true for `delayMs`; a false cond resets it.
export class OnDelay {
  private t = 0;
  tick(cond: boolean, dtMs: number, delayMs: number): boolean {
    this.t = cond ? this.t + dtMs : 0;
    return cond && this.t >= delayMs;
  }
}

export interface PidTune { kp: number; tiSec: number; tdSec: number } // kp: % speed per amp; ti/td 0 = term off

// Velocity-form PID (output increments, clamped), so there is no integrator to wind up and switching from manual is
// bumpless: the caller seeds `out` with the current speed. Direct-acting: load below setpoint raises speed.
export class LoadPid {
  private e1 = 0;
  private e2 = 0;
  private primed = false;
  reset() { this.primed = false; }
  step(sp: number, pv: number, out: number, dtSec: number, t: PidTune, lo: number, hi: number): number {
    const e = sp - pv;
    if (!this.primed) { this.e1 = this.e2 = e; this.primed = true; }
    const du = t.kp * ((e - this.e1)
      + (t.tiSec > 0 ? (dtSec / t.tiSec) * e : 0)
      + (t.tdSec > 0 ? (t.tdSec / dtSec) * (e - 2 * this.e1 + this.e2) : 0));
    this.e2 = this.e1; this.e1 = e;
    return Math.min(hi, Math.max(lo, out + du));
  }
}

// Relay-feedback autotune (Astrom-Hagglund), the same job as the PLC's PIDAT. Drives the output base +/- d around the
// setpoint with hysteresis, measures the limit cycle (period Tu, amplitude a), then Ku = 4d/(pi a) and the Ziegler-Nichols
// PI rule: Kp = 0.45 Ku, Ti = Tu/1.2. Direct-acting plant (more output = more load).
// shortcut: PI only (no D) and ZN's fairly lively response; if the output clamps asymmetrically d is overestimated, so Kp reads a little high.
export interface TuneResult { kp: number; tiSec: number; tuSec: number; ku: number }
export class RelayTuner {
  private t = 0;
  private dir: 1 | -1;
  private sw: number[] = [];
  private highs: number[] = [];
  private lows: number[] = [];
  private ext: number;
  constructor(private sp: number, private base: number, private d: number, private hyst: number, private lo: number, private hi: number, pv0: number, private timeoutSec = 900) {
    this.dir = pv0 < sp ? 1 : -1;
    this.ext = pv0;
  }
  step(pv: number, dtSec: number): { out: number; done?: TuneResult; failed?: string } {
    this.t += dtSec;
    this.ext = this.dir === 1 ? Math.max(this.ext, pv) : Math.min(this.ext, pv);
    if ((this.dir === 1 && pv > this.sp + this.hyst) || (this.dir === -1 && pv < this.sp - this.hyst)) {
      (this.dir === 1 ? this.highs : this.lows).push(this.ext);
      this.sw.push(this.t);
      this.dir = this.dir === 1 ? -1 : 1;
      this.ext = pv;
    }
    const out = Math.min(this.hi, Math.max(this.lo, this.base + this.dir * this.d));
    const n = this.sw.length;
    if (n >= 6 && this.highs.length >= 2 && this.lows.length >= 2) {
      const tu = (this.sw[n - 1] - this.sw[n - 5]) / 2;
      const hs = this.highs.slice(-2), ls = this.lows.slice(-2);
      const a = (hs[0] + hs[1] - ls[0] - ls[1]) / 4;
      if (tu > 0 && a > 0) {
        const ku = (4 * this.d) / (Math.PI * a);
        return { out, done: { kp: Math.round(0.45 * ku * 1000) / 1000, tiSec: Math.round((tu / 1.2) * 10) / 10, tuSec: tu, ku } };
      }
      return { out, failed: 'No usable oscillation measured' };
    }
    if (this.t > this.timeoutSec) return { out, failed: 'Timed out - load did not cross the setpoint (check step size and hysteresis)' };
    return { out };
  }
}
