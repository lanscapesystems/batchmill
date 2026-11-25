// Shared input monitor helper (PLC Phase 3: one threshold helper instead of five near-identical copies).
// A two-sided debounce: the output follows `raw` only after it has held its new value for the on-delay (going true)
// or the off-delay (going false). Level switches, and any later indicator / jam switch, use this one.
export class Debounce {
  private pendingMs = 0;
  constructor(public state: boolean) {}
  step(raw: boolean, dtMs: number, onDelayMs: number, offDelayMs: number): boolean {
    if (raw === this.state) { this.pendingMs = 0; return this.state; }
    this.pendingMs += dtMs;
    if (this.pendingMs >= (raw ? onDelayMs : offDelayMs)) { this.state = raw; this.pendingMs = 0; }
    return this.state;
  }
}
