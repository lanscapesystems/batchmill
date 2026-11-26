// Pure helpers for the batch engine (mill.ts): targets, freefall calibration, warnings, flow paths. No state, so they are easy to test.
import type { FlowConnection } from './types.js';

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Recipe lines scaled to a requested batch size (all lines, micros included). No size = the recipe as written. */
export function scaleLines<T extends { target: number }>(lines: T[], targetMass?: number): T[] {
  const total = lines.reduce((s, l) => s + l.target, 0);
  if (!(targetMass && targetMass > 0) || total <= 0) return lines.map(l => ({ ...l }));
  const k = targetMass / total;
  return lines.map(l => ({ ...l, target: Math.round(l.target * k * 100) / 100 }));
}

/** Tolerance for a step in lbs: the bin's own setting, else 2 % of the target. */
export const toleranceFor = (binTol: unknown, target: number): number => {
  const t = Number(binTol);
  return Number.isFinite(t) && t > 0 ? t : target * 0.02;
};

/**
 * PLC freefall correction: adjust = |actual - target| x strength%, over target = more freefall (stop earlier),
 * under target = less (stop later). `cap` limits the adjust (auto mode); the operator's Update ignores it. Never below 0.
 */
export function freefallAdjust(actual: number, target: number, freefall: number, strengthPct: number, cap?: number): { adjust: number; newFreefall: number } {
  const err = actual - target;
  let adjust = Math.abs(err) * (strengthPct / 100);
  if (cap !== undefined && Number.isFinite(cap)) adjust = Math.min(adjust, Math.max(0, cap));
  const raw = err > 0 ? freefall + adjust : err < 0 ? freefall - adjust : freefall;
  return { adjust: err === 0 ? 0 : adjust, newFreefall: Math.max(0, Math.round(raw * 100) / 100) };
}

/** Equipment reachable downstream of `from` (follows connections out of each node). */
function downstream(from: string, connections: FlowConnection[]): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const n = queue.shift()!;
    for (const c of connections) if (c.from === n && !seen.has(c.to)) { seen.add(c.to); queue.push(c.to); }
  }
  return seen;
}

/** A bin may be marked Not tracked only if everything it discharges to ends in a hammermill (augers in between are fine). */
export function feedsOnlyHammermill(binId: string, connections: FlowConnection[], typeOf: (id: string) => string | undefined): boolean {
  if (!connections.some(c => c.from === binId)) return false;
  const reach = downstream(binId, connections);
  let hammermill = false;
  for (const id of reach) {
    const t = typeOf(id);
    if (t === 'hammermill') hammermill = true;
    if (t === 'bin' || t === 'finished_bin' || t === 'mixer') return false;
  }
  return hammermill;
}

/** Shortest connection path from -> to (both included), or null. */
export function flowPath(from: string, to: string, connections: FlowConnection[]): string[] | null {
  const prev = new Map<string, string>([[from, '']]);
  const queue = [from];
  while (queue.length && !prev.has(to)) {
    const cur = queue.shift()!;
    for (const c of connections) if (c.from === cur && !prev.has(c.to)) { prev.set(c.to, cur); queue.push(c.to); }
  }
  if (!prev.has(to)) return null;
  const path = [to];
  for (let n = prev.get(to)!; n; n = prev.get(n)!) path.unshift(n);
  return path;
}
