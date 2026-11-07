import { fnv1a, gauss, rng } from '../core/rng';
import { CENTRE, PALETTE, SIZES, type Brush, type Fold } from '../core/types';

/** Everything needed to draw a stroke; StrokeOp and live strokes both fit. */
export interface StrokeLike {
  /** The stroke's op id: seeds all of its randomness. */
  id: string;
  /** Cache entry to use, if not the id (live previews keep their own). */
  key?: string;
  brush: Brush;
  color: number;
  size: number;
  fold: Fold;
  mirror: boolean;
  pts: readonly number[];
}

/**
 * Brushes draw a stroke once in board units; symmetry is applied by drawing
 * the same path under each rotation (and mirror) of the canvas transform.
 * All randomness is seeded from the stroke id, so every peer draws the same
 * grains, petals and lamps in the same places.
 */
export function drawStroke(ctx: CanvasRenderingContext2D, s: StrokeLike, scale: number): void {
  if (s.brush === 'diya') {
    // Lamps stay upright: only their positions follow the symmetry.
    const hex = PALETTE[s.color]?.hex ?? '#ffffff';
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    for (const d of diyaSpots(s)) drawDiya(ctx, d.x, d.y, d.s, hex);
    ctx.restore();
    return;
  }
  const geo = geometry(s);
  for (let k = 0; k < s.fold; k++) {
    for (const flip of s.mirror ? [false, true] : [false]) {
      ctx.save();
      setSymmetry(ctx, scale, (2 * Math.PI * k) / s.fold, flip);
      paint(ctx, s, geo);
      ctx.restore();
    }
  }
}

/** Canvas transform that maps board units to pixels, rotated by `angle` about the centre and optionally mirrored. */
export function setSymmetry(ctx: CanvasRenderingContext2D, scale: number, angle: number, flip: boolean): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.translate(CENTRE, CENTRE);
  ctx.rotate(angle);
  if (flip) ctx.scale(-1, 1);
  ctx.translate(-CENTRE, -CENTRE);
}

export const width = (s: { size: number }): number => SIZES[s.size] ?? SIZES[1];

// ---- Geometry, cached per stroke id ------------------------------------------

/** Precomputed, seeded detail for one stroke. Grows as a live stroke gets longer. */
interface Geometry {
  points: number;
  /** powder: x, y, r, shade per grain. petal/dot/diya: x, y, angle, scale per stamp. */
  data: number[];
  /** Arc length carried over to the next segment, for even spacing. */
  carry: number;
}

const cache = new Map<string, Geometry>();
/** Upper bound on stamp data per stroke (4 numbers per grain or stamp), whatever the input. */
const MAX_STAMP_DATA = 4 * 40_000;
/** Total numbers kept across all cached strokes (about 64 MB); least recently used strokes go first. */
const CACHE_BUDGET = 8_000_000;
let cached = 0;

export function forget(id: string): void {
  const g = cache.get(id);
  if (!g) return;
  cached -= g.data.length;
  cache.delete(id);
}

export function geometry(s: StrokeLike): Geometry {
  const key = s.key ?? s.id;
  let g = cache.get(key);
  const n = s.pts.length / 2;
  if (g && g.points <= n) {
    // Mark as recently used.
    cache.delete(key);
    cache.set(key, g);
  } else {
    if (g) forget(key);
    g = { points: 0, data: [], carry: 0 };
    cache.set(key, g);
  }
  if (g.points < n) {
    const before = g.data.length;
    extend(g, s, n);
    cached += g.data.length - before;
    for (const [id, old] of cache) {
      if (cached <= CACHE_BUDGET || old === g) break;
      forget(id);
    }
  }
  return g;
}

function extend(g: Geometry, s: StrokeLike, n: number): void {
  const w = width(s);
  const seedBase = fnv1a(s.id);
  const p = s.pts;
  // The first point is stamped exactly once, from its own random stream and with no
  // direction, so it comes out the same whether the stroke had one point or many at the time.
  if (g.points === 0) {
    stampAt(g, s, p[0]!, p[1]!, 0, rng(seedBase), w, true);
    g.points = 1;
  }
  for (let i = g.points; i < n; i++) {
    // Seeded per segment, so a stroke drawn live and the same stroke redrawn later match exactly.
    const r = rng(seedBase ^ Math.imul(i, 0x9e3779b1));
    segment(g, s, p[2 * i - 2]!, p[2 * i - 1]!, p[2 * i]!, p[2 * i + 1]!, r, w);
  }
  g.points = n;
}

/** Distance between stamps along the path, per brush. */
const spacing = (b: Brush, w: number): number =>
  b === 'powder' ? w * 0.09 : b === 'chalk' ? Infinity : b === 'petal' ? w * 0.75 : b === 'dot' ? w * 1.7 : w * 5;

function segment(g: Geometry, s: StrokeLike, x0: number, y0: number, x1: number, y1: number, r: () => number, w: number): void {
  const step = spacing(s.brush, w);
  if (!Number.isFinite(step)) return;
  const len = Math.hypot(x1 - x0, y1 - y0);
  if (len === 0) return;
  const ux = (x1 - x0) / len;
  const uy = (y1 - y0) / len;
  const angle = Math.atan2(uy, ux);
  let t = step - g.carry;
  while (t <= len && g.data.length < MAX_STAMP_DATA) {
    stampAt(g, s, x0 + ux * t, y0 + uy * t, angle, r, w, false);
    t += step;
  }
  g.carry = len - (t - step);
}

function stampAt(g: Geometry, s: StrokeLike, x: number, y: number, angle: number, r: () => number, w: number, first: boolean): void {
  switch (s.brush) {
    case 'powder': {
      // A dab of grains, normally distributed across the stroke's width.
      const nx = -Math.sin(angle);
      const ny = Math.cos(angle);
      const count = first ? 40 : 4;
      for (let k = 0; k < count; k++) {
        const across = gauss(r) * w * (first ? 0.22 : 0.26);
        const along = (r() - 0.5) * w * (first ? 0.4 : 0.1);
        g.data.push(x + nx * across + Math.cos(angle) * along, y + ny * across + Math.sin(angle) * along, w * (0.025 + r() * 0.04), r() * 2 - 1);
      }
      break;
    }
    case 'petal':
      g.data.push(x, y, angle + (r() - 0.5) * 0.5 + (r() < 0.5 ? 0.35 : -0.35), 0.8 + r() * 0.4);
      break;
    case 'dot':
      g.data.push(x, y, 0, 0.85 + r() * 0.3);
      break;
    case 'diya':
      if (first || g.data.length === 0 || Math.hypot(x - g.data[g.data.length - 4]!, y - g.data[g.data.length - 3]!) > w * 4) {
        g.data.push(x, y, 0, 0.95 + r() * 0.1);
      }
      break;
    case 'chalk':
      break;
  }
}

// ---- Painting ---------------------------------------------------------------------

function paint(ctx: CanvasRenderingContext2D, s: StrokeLike, g: Geometry): void {
  const hex = PALETTE[s.color]?.hex ?? '#ffffff';
  const w = width(s);
  switch (s.brush) {
    case 'powder':
      return powder(ctx, s, g, hex, w);
    case 'chalk':
      return chalk(ctx, s, hex, w);
    case 'petal':
      return petals(ctx, g, hex, w);
    case 'dot':
      return dots(ctx, g, hex, w);
    case 'diya':
      return; // drawn upright by drawStroke
  }
}

function path(ctx: CanvasRenderingContext2D, pts: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!, pts[1]!);
  if (pts.length === 2) ctx.lineTo(pts[0]! + 0.1, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
}

function powder(ctx: CanvasRenderingContext2D, s: StrokeLike, g: Geometry, hex: string, w: number): void {
  // A soft bed of colour, then the individual grains on top.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  path(ctx, s.pts);
  ctx.strokeStyle = hex;
  ctx.globalAlpha = 0.78;
  ctx.lineWidth = w * 0.62;
  ctx.stroke();
  ctx.globalAlpha = 1;
  const light = shade(hex, 0.28);
  const dark = shade(hex, -0.3);
  const d = g.data;
  for (const [style, pick] of [
    [hex, (v: number) => Math.abs(v) <= 0.45],
    [light, (v: number) => v > 0.45],
    [dark, (v: number) => v < -0.45],
  ] as const) {
    ctx.fillStyle = style;
    ctx.beginPath();
    for (let i = 0; i < d.length; i += 4) {
      if (!pick(d[i + 3]!)) continue;
      const rr = d[i + 2]!;
      ctx.rect(d[i]! - rr, d[i + 1]! - rr, rr * 2, rr * 2);
    }
    ctx.fill();
  }
}

function chalk(ctx: CanvasRenderingContext2D, s: StrokeLike, hex: string, w: number): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  path(ctx, s.pts);
  ctx.strokeStyle = hex;
  ctx.lineWidth = w * 0.3;
  ctx.globalAlpha = 0.95;
  ctx.stroke();
  ctx.lineWidth = w * 0.12;
  ctx.strokeStyle = shade(hex, 0.35);
  ctx.globalAlpha = 0.8;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function petals(ctx: CanvasRenderingContext2D, g: Geometry, hex: string, w: number): void {
  const edge = shade(hex, -0.35);
  const centre = shade(hex, 0.3);
  const d = g.data;
  for (let i = 0; i < d.length; i += 4) {
    const len = w * 0.95 * d[i + 3]!;
    ctx.save();
    ctx.translate(d[i]!, d[i + 1]!);
    ctx.rotate(d[i + 2]!);
    // A teardrop petal pointing along its angle.
    ctx.beginPath();
    ctx.moveTo(-len * 0.5, 0);
    ctx.bezierCurveTo(-len * 0.2, -len * 0.42, len * 0.35, -len * 0.3, len * 0.55, 0);
    ctx.bezierCurveTo(len * 0.35, len * 0.3, -len * 0.2, len * 0.42, -len * 0.5, 0);
    const grad = ctx.createLinearGradient(-len * 0.5, 0, len * 0.55, 0);
    grad.addColorStop(0, edge);
    grad.addColorStop(0.45, hex);
    grad.addColorStop(1, centre);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = len * 0.04;
    ctx.strokeStyle = edge;
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

function dots(ctx: CanvasRenderingContext2D, g: Geometry, hex: string, w: number): void {
  const d = g.data;
  const hi = shade(hex, 0.45);
  for (let i = 0; i < d.length; i += 4) {
    const r = w * 0.3 * d[i + 3]!;
    ctx.beginPath();
    ctx.arc(d[i]!, d[i + 1]!, r, 0, Math.PI * 2);
    ctx.fillStyle = hex;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(d[i]! - r * 0.3, d[i + 1]! - r * 0.3, r * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = hi;
    ctx.globalAlpha = 0.7;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

/** Size of a diya's bowl, in board units, for a given brush width. */
export const diyaScale = (w: number): number => w * 2.9;

/** A clay diya seen from slightly above, rim painted in the chosen colour. The flame is drawn separately (it moves). */
export function drawDiya(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, hex: string): void {
  ctx.save();
  ctx.translate(x, y);
  // Shadow on the floor.
  ctx.beginPath();
  ctx.ellipse(0, s * 0.42, s * 0.95, s * 0.22, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(40, 18, 8, 0.28)';
  ctx.fill();
  // Bowl.
  ctx.beginPath();
  ctx.moveTo(-s, 0);
  ctx.bezierCurveTo(-s * 0.9, s * 0.62, s * 0.6, s * 0.62, s * 0.95, 0.05 * s);
  ctx.quadraticCurveTo(s * 1.25, -s * 0.12, s * 1.32, -s * 0.3);
  ctx.quadraticCurveTo(s * 0.9, -s * 0.18, s * 0.5, -s * 0.2);
  ctx.closePath();
  const clay = ctx.createLinearGradient(0, -s * 0.3, 0, s * 0.55);
  clay.addColorStop(0, '#d9733a');
  clay.addColorStop(0.55, '#a8461d');
  clay.addColorStop(1, '#6e2a10');
  ctx.fillStyle = clay;
  ctx.fill();
  // Painted band.
  ctx.beginPath();
  ctx.moveTo(-s * 0.94, s * 0.14);
  ctx.bezierCurveTo(-s * 0.7, s * 0.42, s * 0.55, s * 0.42, s * 0.88, s * 0.14);
  ctx.lineWidth = s * 0.11;
  ctx.strokeStyle = hex;
  ctx.stroke();
  for (let k = -3; k <= 3; k++) {
    ctx.beginPath();
    ctx.arc(k * s * 0.24, s * 0.4 - Math.abs(k) * s * 0.025, s * 0.045, 0, Math.PI * 2);
    ctx.fillStyle = '#fff3d6';
    ctx.fill();
  }
  // Oil and rim.
  ctx.beginPath();
  ctx.ellipse(0, 0, s, s * 0.24, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#5a230c';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, 0.02 * s, s * 0.82, s * 0.15, 0, 0, Math.PI * 2);
  const oil = ctx.createLinearGradient(0, -s * 0.15, 0, s * 0.15);
  oil.addColorStop(0, '#f2b33d');
  oil.addColorStop(1, '#b06d12');
  ctx.fillStyle = oil;
  ctx.fill();
  // Wick.
  ctx.beginPath();
  ctx.moveTo(s * 0.98, -s * 0.2);
  ctx.lineTo(s * 1.12, -s * 0.42);
  ctx.lineWidth = s * 0.07;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#3a2210';
  ctx.stroke();
  ctx.restore();
}

/** Where a diya's flame sits, relative to the diya's centre, in diya-scale units. */
export const FLAME_OFFSET = { x: 1.12, y: -0.5 };

/** A flickering flame. `t` is seconds; `phase` keeps neighbouring flames out of step. */
export function drawFlame(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, t: number, phase: number): void {
  const flicker = 1 + 0.09 * Math.sin(t * 9.1 + phase) + 0.05 * Math.sin(t * 23.7 + phase * 1.7);
  const sway = 0.12 * Math.sin(t * 3.3 + phase * 0.6);
  const h = s * 0.95 * flicker;
  const wdt = s * 0.32;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(sway * 0.4);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-wdt, -h * 0.2, -wdt * 0.6, -h * 0.65, sway * s * 0.3, -h);
  ctx.bezierCurveTo(wdt * 0.6, -h * 0.65, wdt, -h * 0.2, 0, 0);
  const grad = ctx.createLinearGradient(0, 0, 0, -h);
  grad.addColorStop(0, '#ff7a1a');
  grad.addColorStop(0.35, '#ffc23d');
  grad.addColorStop(1, 'rgba(255, 244, 200, 0.9)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(0, -h * 0.28, wdt * 0.32, h * 0.22, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 240, 0.85)';
  ctx.fill();
  ctx.restore();
}

/** Lighten (amount > 0) or darken (amount < 0) a #rrggbb colour. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount)),
  );
  return `rgb(${ch[0]}, ${ch[1]}, ${ch[2]})`;
}

export interface DiyaSpot {
  /** Centre of the bowl, board units. */
  x: number;
  y: number;
  /** Bowl size, board units. */
  s: number;
  /** Flicker phase, so neighbouring flames move out of step. */
  phase: number;
}

/**
 * Every diya a stroke places, after symmetry, upright, with coincident copies
 * (a lamp on an axis of symmetry) merged.
 */
export function diyaSpots(s: StrokeLike): DiyaSpot[] {
  if (s.brush !== 'diya') return [];
  const g = geometry(s);
  const w = width(s);
  const seed = fnv1a(s.id);
  const out: DiyaSpot[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < g.data.length; i += 4) {
    const size = diyaScale(w) * g.data[i + 3]!;
    const lx0 = g.data[i]! - CENTRE;
    const ly = g.data[i + 1]! - CENTRE;
    for (let k = 0; k < s.fold; k++) {
      const a = (2 * Math.PI * k) / s.fold;
      for (const flip of s.mirror ? [false, true] : [false]) {
        const lx = flip ? -lx0 : lx0;
        const x = CENTRE + lx * Math.cos(a) - ly * Math.sin(a);
        const y = CENTRE + lx * Math.sin(a) + ly * Math.cos(a);
        const key = `${Math.round(x / 20)},${Math.round(y / 20)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ x, y, s: size, phase: (((seed >>> (out.length % 24)) % 628) / 100 + out.length * 1.7) % 100 });
      }
    }
  }
  return out;
}
