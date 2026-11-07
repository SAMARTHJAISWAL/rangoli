/**
 * The shared document is a set of operations. Every operation is created by
 * one peer, numbered by that peer (seq = 1, 2, 3, ...) and stamped with a
 * Lamport clock. Operations are immutable and idempotent to apply, so peers
 * can exchange them in any order, any number of times, and still converge.
 */

/** Board coordinates run from 0 to SIZE on both axes; the centre is SIZE / 2. */
export const SIZE = 10_000;
export const CENTRE = SIZE / 2;

export type Brush = 'powder' | 'chalk' | 'petal' | 'diya' | 'dot';
export const BRUSHES: readonly Brush[] = ['powder', 'chalk', 'petal', 'diya', 'dot'];

/** Rangoli colours, named after what the powder is traditionally made from. */
export const PALETTE = [
  { name: 'Sindoor', hex: '#d62839' },
  { name: 'Marigold', hex: '#f28c18' },
  { name: 'Haldi', hex: '#f6c90e' },
  { name: 'Mehendi', hex: '#3d8b37' },
  { name: 'Peacock', hex: '#0e8a96' },
  { name: 'Neel', hex: '#3b3fa6' },
  { name: 'Rani', hex: '#d2338a' },
  { name: 'Chalk', hex: '#f7f1e3' },
] as const;

/** Brush widths in board units. */
export const SIZES = [45, 90, 160] as const;

/** Allowed rotational symmetries. 1 means none. */
export const FOLDS = [1, 4, 6, 8, 12] as const;
export type Fold = (typeof FOLDS)[number];

/**
 * Every limit is a property of a single operation, so every peer accepts or
 * rejects the same operation the same way, whatever else it has seen. (A limit
 * on the whole document would make the outcome depend on arrival order.)
 * They also keep a misbehaving or hostile peer from exhausting memory.
 */
export const LIMITS = {
  pointsPerStroke: 2_000,
  /** Total path length of one stroke, in board units (the board is 10,000 wide). */
  strokeLength: 60_000,
  targetsPerErase: 5_000,
  /** Highest seq one author may use. */
  seqPerAuthor: 20_000,
  /** Lamport clocks saturate here instead of running away (2^40). */
  lamport: 1_099_511_627_776,
  opsPerMessage: 400,
  /** Serialized size of one ops message, in characters. */
  messageChars: 900_000,
} as const;

/** Total length of a flat [x0, y0, x1, y1, ...] polyline. */
export function pathLength(pts: readonly number[]): number {
  let len = 0;
  for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!);
  return len;
}

interface OpBase {
  /** Peer that created the operation. */
  peer: string;
  /** 1, 2, 3, ... per peer, with no gaps. */
  seq: number;
  /** Lamport timestamp: decides drawing order and last-writer-wins. */
  lamport: number;
}

export interface StrokeOp extends OpBase {
  k: 's';
  brush: Brush;
  /** Index into PALETTE. */
  color: number;
  /** Index into SIZES. */
  size: number;
  fold: Fold;
  mirror: boolean;
  /** Flattened [x0, y0, x1, y1, ...] in board units, integers. */
  pts: number[];
}

export interface EraseOp extends OpBase {
  k: 'e';
  /** Ids of the strokes to remove. */
  targets: string[];
}

export interface NightOp extends OpBase {
  k: 'n';
  /** Lights out: the board goes dark and the diyas glow. */
  on: boolean;
}

export type Op = StrokeOp | EraseOp | NightOp;

/** Highest contiguous seq received from each peer. */
export type StateVector = Record<string, number>;

export const opId = (op: { peer: string; seq: number }): string => `${op.peer}/${op.seq}`;
