import { CENTRE, PALETTE, type Fold, type StrokeOp } from './types';

export type StrokeBody = Omit<StrokeOp, 'peer' | 'seq' | 'lamport'>;

const colour = (name: (typeof PALETTE)[number]['name']): number => PALETTE.findIndex((c) => c.name === name);

/** Polar point (radius in board units, angle in radians, 0 = right, clockwise on screen) to board coordinates. */
function polar(r: number, a: number): [number, number] {
  return [Math.round(CENTRE + r * Math.cos(a)), Math.round(CENTRE + r * Math.sin(a))];
}

function curve(n: number, f: (u: number) => [number, number]): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const [r, a] = f(i / n);
    pts.push(...polar(r, a));
  }
  return pts;
}

function stroke(brush: StrokeBody['brush'], c: number, size: number, fold: Fold, pts: number[], mirror = false): StrokeBody {
  return { k: 's', brush, color: c, size, fold, mirror, pts };
}

/**
 * A classic eight-fold rangoli, built from the same strokes a person could
 * draw: a lotus of nested powder petals, a ring of marigold, kolam dots, a
 * peacock-blue wave, chalk scallops and sixteen diyas. Inserting it creates
 * ordinary strokes, so everyone sees it and anyone can undo or draw over it.
 */
export function samplePattern(): StrokeBody[] {
  const S = Math.PI / 4; // one eighth of a turn
  const out: StrokeBody[] = [];

  // Centre: a turmeric disc drawn as a spiral, with a vermilion ring.
  out.push(stroke('powder', colour('Haldi'), 2, 1, curve(60, (u) => [40 + 330 * u, u * Math.PI * 7])));
  out.push(stroke('powder', colour('Sindoor'), 1, 8, curve(12, (u) => [470, (u - 0.05) * S * 1.1])));

  // Lotus: each petal is three nested outlines, so it looks filled.
  const petal = (inner: number, outer: number, half: number, offset: number) => (u: number): [number, number] => {
    const t = u < 0.5 ? u * 2 : (1 - u) * 2; // out along one side, back along the other
    const side = u < 0.5 ? 1 : -1;
    return [inner + (outer - inner) * t, offset + side * half * Math.pow(Math.sin(Math.PI * Math.min(t, 0.999) * 0.98 + 0.02), 0.8) * (1 - 0.35 * t)];
  };
  for (const [name, scale, size] of [
    ['Rani', 1, 1],
    ['Sindoor', 0.62, 1],
    ['Haldi', 0.28, 0],
  ] as const) {
    out.push(stroke('powder', colour(name), size, 8, curve(40, petal(560, 560 + 1000 * (0.55 + 0.45 * scale), 0.3 * scale, 0))));
  }
  // Leaves between the petals.
  out.push(stroke('powder', colour('Mehendi'), 1, 8, curve(30, petal(980, 1650, 0.13, S / 2))));
  out.push(stroke('powder', colour('Mehendi'), 0, 8, curve(18, petal(1060, 1520, 0.05, S / 2))));

  // Marigold ring and kolam dots.
  out.push(stroke('petal', colour('Marigold'), 2, 8, curve(16, (u) => [1820, u * S])));
  out.push(stroke('petal', colour('Haldi'), 1, 8, curve(16, (u) => [1960, (u + 0.5) * S])));
  out.push(stroke('dot', colour('Chalk'), 1, 8, curve(12, (u) => [2190, u * S])));

  // Peacock wave: two crests per eighth.
  out.push(stroke('powder', colour('Peacock'), 1, 8, curve(48, (u) => [2480 + 150 * Math.sin(u * Math.PI * 4), u * S * 1.02])));
  out.push(stroke('powder', colour('Neel'), 0, 8, curve(48, (u) => [2480 - 160 * Math.sin(u * Math.PI * 4), u * S * 1.02])));

  // Chalk circle with neel scallops outside it.
  out.push(stroke('chalk', colour('Chalk'), 1, 8, curve(16, (u) => [2780, u * S * 1.02])));
  out.push(stroke('powder', colour('Rani'), 1, 8, curve(36, (u) => [2830 + 260 * Math.abs(Math.sin(u * Math.PI * 2)), u * S])));
  out.push(stroke('dot', colour('Haldi'), 0, 8, curve(4, (u) => [3020, (u + 0.125) * S * 0.5 * 2])));

  // Sixteen diyas around the edge and one in the middle.
  out.push(stroke('diya', colour('Sindoor'), 1, 8, [...polar(3480, 0)]));
  out.push(stroke('diya', colour('Peacock'), 1, 8, [...polar(3480, S / 2)]));
  out.push(stroke('diya', colour('Rani'), 2, 1, [...polar(0, 0)]));
  return out;
}
