import { BRUSHES, FOLDS, LIMITS, PALETTE, SIZE, SIZES, pathLength, type Op, type StateVector, type StrokeOp } from './types';

/**
 * Everything that arrives from another peer is untrusted. These validators
 * accept only well-formed messages within the limits, and build fresh objects
 * so no unexpected fields (or prototypes) leak into the document.
 */

/** Ephemeral messages: shown while they matter, never stored. */
export interface LiveStroke {
  /** Id the finished stroke will have. */
  id: string;
  brush: StrokeOp['brush'];
  color: number;
  size: number;
  fold: StrokeOp['fold'];
  mirror: boolean;
  /** Points added since the previous live message. */
  pts: number[];
  /** Index in the stroke of the first point in pts. */
  from: number;
}

export interface Presence {
  /** The sender's author id (the same on every transport it uses). */
  peer: string;
  /** Display name, e.g. "Kaju Katli". */
  name: string;
  /** Cursor position in board units, or null when the pointer left the board. */
  x: number | null;
  y: number | null;
}

export interface Burst {
  x: number;
  y: number;
  seed: number;
}

export type Message =
  | { t: 'sv'; sv: StateVector }
  | { t: 'ops'; ops: Op[] }
  | { t: 'live'; s: LiveStroke }
  | { t: 'live-end'; id: string }
  | { t: 'here'; p: Presence }
  | { t: 'burst'; b: Burst };

const PEER = /^[a-z0-9]{6,24}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isInt = (x: unknown, lo: number, hi: number): x is number => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
const isPeer = (x: unknown): x is string => typeof x === 'string' && PEER.test(x);
const isOpId = (x: unknown): x is string => {
  if (typeof x !== 'string') return false;
  const slash = x.indexOf('/');
  return slash > 0 && isPeer(x.slice(0, slash)) && /^[1-9][0-9]{0,8}$/.test(x.slice(slash + 1));
};

function points(x: unknown, maxPoints: number, minPoints: number): number[] | null {
  if (!Array.isArray(x) || x.length % 2 !== 0) return null;
  if (x.length / 2 > maxPoints || x.length / 2 < minPoints) return null;
  for (const v of x) if (!isInt(v, 0, SIZE)) return null;
  return x.slice() as number[];
}

const style = (x: Record<string, unknown>) =>
  (BRUSHES as readonly unknown[]).includes(x.brush) &&
  isInt(x.color, 0, PALETTE.length - 1) &&
  isInt(x.size, 0, SIZES.length - 1) &&
  (FOLDS as readonly unknown[]).includes(x.fold) &&
  typeof x.mirror === 'boolean';

export function parseOp(x: unknown): Op | null {
  if (!isObj(x)) return null;
  if (!isPeer(x.peer) || !isInt(x.seq, 1, LIMITS.seqPerAuthor) || !isInt(x.lamport, 1, LIMITS.lamport)) return null;
  const base = { peer: x.peer, seq: x.seq, lamport: x.lamport };
  switch (x.k) {
    case 's': {
      if (!style(x)) return null;
      const pts = points(x.pts, LIMITS.pointsPerStroke, 1);
      if (!pts || pathLength(pts) > LIMITS.strokeLength) return null;
      return {
        k: 's',
        ...base,
        brush: x.brush as StrokeOp['brush'],
        color: x.color as number,
        size: x.size as number,
        fold: x.fold as StrokeOp['fold'],
        mirror: x.mirror as boolean,
        pts,
      };
    }
    case 'e': {
      if (!Array.isArray(x.targets) || x.targets.length === 0 || x.targets.length > LIMITS.targetsPerErase) return null;
      if (!x.targets.every(isOpId)) return null;
      return { k: 'e', ...base, targets: (x.targets as string[]).slice() };
    }
    case 'n':
      if (typeof x.on !== 'boolean') return null;
      return { k: 'n', ...base, on: x.on };
    default:
      return null;
  }
}

export function parseMessage(x: unknown): Message | null {
  if (!isObj(x)) return null;
  switch (x.t) {
    case 'sv': {
      if (!isObj(x.sv)) return null;
      const entries = Object.entries(x.sv);
      if (entries.length > 10_000) return null;
      const sv: StateVector = {};
      for (const [k, v] of entries) {
        if (!isPeer(k) || !isInt(v, 0, 999_999_999)) return null;
        sv[k] = v;
      }
      return { t: 'sv', sv };
    }
    case 'ops': {
      if (!Array.isArray(x.ops) || x.ops.length > LIMITS.opsPerMessage) return null;
      const ops: Op[] = [];
      for (const o of x.ops) {
        const op = parseOp(o);
        if (op) ops.push(op);
      }
      return { t: 'ops', ops };
    }
    case 'live': {
      const s = x.s;
      if (!isObj(s) || !isOpId(s.id) || !style(s) || !isInt(s.from, 0, LIMITS.pointsPerStroke)) return null;
      const pts = points(s.pts, 200, 0);
      if (!pts || pathLength(pts) > LIMITS.strokeLength) return null;
      return {
        t: 'live',
        s: {
          id: s.id,
          brush: s.brush as StrokeOp['brush'],
          color: s.color as number,
          size: s.size as number,
          fold: s.fold as StrokeOp['fold'],
          mirror: s.mirror as boolean,
          pts,
          from: s.from,
        },
      };
    }
    case 'live-end':
      return isOpId(x.id) ? { t: 'live-end', id: x.id } : null;
    case 'here': {
      const p = x.p;
      if (!isObj(p) || !isPeer(p.peer) || typeof p.name !== 'string' || p.name.length > 32) return null;
      const name = p.name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (!name) return null;
      const onBoard = isInt(p.x, 0, SIZE) && isInt(p.y, 0, SIZE);
      if (!onBoard && !(p.x === null && p.y === null)) return null;
      return { t: 'here', p: { peer: p.peer, name, x: onBoard ? (p.x as number) : null, y: onBoard ? (p.y as number) : null } };
    }
    case 'burst': {
      const b = x.b;
      if (!isObj(b) || !isInt(b.x, 0, SIZE) || !isInt(b.y, 0, SIZE) || !isInt(b.seed, 0, 0xffffffff)) return null;
      return { t: 'burst', b: { x: b.x, y: b.y, seed: b.seed } };
    }
    default:
      return null;
  }
}

export { isPeer, isOpId };
