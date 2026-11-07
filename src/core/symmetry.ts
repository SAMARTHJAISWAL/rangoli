import { CENTRE } from './types';

/**
 * Expand one drawn polyline into its symmetric copies around the board centre:
 * `fold` rotations, each optionally mirrored across the axis of the first one.
 * Rangoli and kolam are traditionally built this way, so a single stroke turns
 * into a whole petal ring.
 *
 * Returns fold (or 2 × fold with mirror) polylines as flat [x, y, ...] arrays.
 */
export function expand(pts: readonly number[], fold: number, mirror: boolean): number[][] {
  const out: number[][] = [];
  for (let k = 0; k < fold; k++) {
    const a = (2 * Math.PI * k) / fold;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    out.push(transform(pts, cos, sin, false));
    if (mirror) out.push(transform(pts, cos, sin, true));
  }
  return out;
}

function transform(pts: readonly number[], cos: number, sin: number, flip: boolean): number[] {
  const out = new Array<number>(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i]! - CENTRE;
    // Mirror across the vertical axis through the centre, then rotate.
    const y = pts[i + 1]! - CENTRE;
    const mx = flip ? -x : x;
    out[i] = CENTRE + mx * cos - y * sin;
    out[i + 1] = CENTRE + mx * sin + y * cos;
  }
  return out;
}

/** Number of copies a stroke produces. */
export const copies = (fold: number, mirror: boolean): number => fold * (mirror ? 2 : 1);
