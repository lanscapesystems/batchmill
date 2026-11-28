// Decoders for the continuous serial output of common weight indicators. Each takes one CR/LF-delimited line and returns the
// weight, a reason the indicator itself calls it unusable, or null if the line is not a weight frame.
import type { ScaleConfig, ScaleFormat } from './types.js';

export type ScaleLine = { weight: number; motion?: boolean } | { bad: string } | null;

// sign may be padded away from the digits ("-  12.5") or trail them ("12.5-")
const DEFAULT_WEIGHT_REGEX = '[+-]?[ \\t]*(?:\\d+\\.?\\d*|\\.\\d+)(?:-(?![\\w.]))?';

/** The weight in one line of plain text, or null if the pattern finds none. */
export function parseWeight(line: string, re = new RegExp(DEFAULT_WEIGHT_REGEX)): number | null {
  let s = re.exec(line)?.[0].replace(/\s/g, '');
  if (!s) return null;
  if (s.endsWith('-')) s = '-' + s.slice(0, -1).replace(/^[+-]/, '');
  const weight = Number(s);
  return Number.isFinite(weight) ? weight : null;
}

// Rice Lake stream (STR1, and consolidated STR5), 480 manual §9.3: STX polarity weight(7) unit gross/net status
function riceLake(line: string): ScaleLine {
  const m = /\x02([ +-])(.{7})[A-Za-z ][A-Za-z ]([ A-Z])/.exec(line);
  if (!m) return null;
  const [, sign, digits, status] = m;
  if (status === 'O') return { bad: 'over or under range' };
  if (!' ZM'.includes(status)) return { bad: status === 'I' ? 'reading invalid' : `unknown status "${status}"` };
  const weight = parseWeight(sign + digits);
  return weight === null ? null : { weight, motion: status === 'M' };
}

// Mettler Toledo continuous, standard and short (COM-570 manual app. G): STX SWA SWB SWC weight(6) [tare(6)] CR [checksum].
// Sign and decimal point are in the status bytes.
// shortcut: the optional checksum is not verified (it trails the CR); verify it if line noise ever shows up as weight jumps
function toledo(line: string): ScaleLine {
  const body = line.slice(line.lastIndexOf('\x02') + 1);
  if (!line.includes('\x02') || (body.length !== 9 && body.length !== 15)) return null;
  const [a, b, c] = [0, 1, 2].map(i => body.charCodeAt(i));
  const digits = body.slice(3, 9);
  if (![a, b, c].every(s => s & 0x20) || !/^ *\d+$/.test(digits)) return null; // bit 5 is always set in all three
  if (b & 0x04) return { bad: 'over capacity or under zero' };
  if (c & 0x10) return { bad: 'expanded (x10) output is not supported' };
  const places = (a & 0x07) - 2; // 0..7 = x100, x10, x1, then 1..5 decimal places
  const magnitude = places < 0 ? Number(digits) * 10 ** -places : Number(digits) / 10 ** places;
  return { weight: b & 0x02 ? -magnitude : magnitude, motion: !!(b & 0x08) };
}

// A&D standard format (AD-4329A manual §11/12): ST|US|OL , GS|NT|.. , signed data (point or comma decimal) unit
function andStandard(line: string): ScaleLine {
  const m = /(ST|US|OL),\s*(?:([A-Z][A-Z~ ]),)?([^A-Za-z]*)/.exec(line);
  if (!m) return null;
  const [, state, kind, data] = m;
  if (state === 'OL') return { bad: 'over range' };
  if (kind && /^[TP]/.test(kind)) return null; // tare lines are not the weight
  const s = data.replace(/\s/g, '').replace(',', '.');
  return /^[+-](\d+\.?\d*|\.\d+)$/.test(s) ? { weight: Number(s), motion: state === 'US' } : null;
}

// Avery Weigh-Tronix WI-120 layout as emulated by the Rice Lake 480 (STR3): CR polarity weight unit g|n status ETX
function weighTronix(line: string): ScaleLine {
  const m = /([+-])\s*(\d+\.?\d*|\.\d+)\s*(?:lb|kg|oz|tn|t|g)?(?![\w.])([ gnmo]*)\x03?\s*$/.exec(line);
  if (!m) return null;
  const [, sign, digits, flags] = m;
  if (flags.includes('o')) return { bad: 'over or under range' };
  return { weight: Number(sign + digits), motion: flags.includes('m') };
}

// The Sysmac project's ScaleComms ladder: the weight is the text between the first prefix and the first suffix character,
// and the scale is moving if the motion character appears anywhere. Like the ladder, no line length is enforced.
export function plcDecoder(cfg: Partial<ScaleConfig>): (line: string) => ScaleLine {
  return line => {
    const from = line.indexOf(cfg.prefixChar!), to = line.indexOf(cfg.suffixChar!);
    if (from < 0 || to <= from) return null;
    const s = line.slice(from + 1, to).replace(/\s/g, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    return { weight: Number(s), motion: !!cfg.motionChar && line.includes(cfg.motionChar) };
  };
}

export function plcConfigError(c: Partial<ScaleConfig>): string | null {
  const hex = /^[0-7][0-9a-f]$/i;
  if (!hex.test(c.startCode ?? '') || !hex.test(c.endCode ?? '')) return 'Line start and line end must each be an ASCII hex byte, 00 to 7F';
  if (parseInt(c.startCode!, 16) === parseInt(c.endCode!, 16)) return 'Line start and line end must differ';
  if (c.prefixChar?.length !== 1 || c.suffixChar?.length !== 1 || c.prefixChar === c.suffixChar) return 'Prefix and suffix must be two different single characters';
  if ((c.motionChar?.length ?? 0) > 1) return 'The moving character must be one character, or blank';
  return null;
}

/** Splits the complete frames off a receive buffer. CR or LF ends a line; with hex codes a frame runs from start to end code. */
export function splitFrames(buf: string, codes?: { startCode: string; endCode: string }): { lines: string[]; rest: string } {
  const [start, end] = codes ? [codes.startCode, codes.endCode].map(h => String.fromCharCode(parseInt(h, 16))) : [];
  const lines = buf.split(codes ? end! : /[\r\n]/);
  const rest = lines.pop()!;
  if (!codes) return { lines, rest };
  return { lines: lines.flatMap(l => { const i = l.lastIndexOf(start!); return i < 0 ? [] : [l.slice(i) + end]; }), rest };
}

export const SCALE_DECODERS: Record<Exclude<ScaleFormat, '' | 'plc'>, (line: string) => ScaleLine> = {
  ricelake: riceLake, toledo, and: andStandard, weightronix: weighTronix,
};
