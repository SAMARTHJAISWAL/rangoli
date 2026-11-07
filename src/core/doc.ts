import { LIMITS, opId, type EraseOp, type NightOp, type Op, type StateVector, type StrokeOp } from './types';
import { fnv1a } from './rng';

/** What a renderer has to do after an operation was applied. */
export type Change = 'none' | 'append' | 'full' | 'night';

/** Total order used for drawing: Lamport time, then peer id, then seq. */
export function compareOps(a: Op, b: Op): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.peer !== b.peer) return a.peer < b.peer ? -1 : 1;
  return a.seq - b.seq;
}

/**
 * The shared rangoli, as a state-based CRDT over an operation log.
 *
 * - Strokes form a set; erasures form a second set of removed ids, and a
 *   removed id stays removed even if its stroke arrives later (remove wins).
 * - Visible strokes are drawn in compareOps order, which every peer computes
 *   the same way, so the layering is identical everywhere.
 * - Night mode is a last-writer-wins register ordered by compareOps.
 *
 * Applying an operation is idempotent and commutative, so two peers that have
 * received the same set of operations show the same picture, whatever order
 * the operations arrived in.
 */
export class RangoliDoc {
  private readonly ops = new Map<string, Op>();
  private readonly strokes = new Map<string, StrokeOp>();
  private readonly erased = new Set<string>();
  /** Per peer: highest contiguous seq, plus any seqs received beyond it. */
  private readonly contiguous = new Map<string, number>();
  private readonly ahead = new Map<string, Set<number>>();
  private nightOp: NightOp | null = null;
  private clock = 0;
  /** Cached visible strokes in drawing order; null when it must be rebuilt. */
  private ordered: StrokeOp[] | null = [];

  constructor(readonly self: string) {}

  get size(): number {
    return this.ops.size;
  }

  get lamport(): number {
    return this.clock;
  }

  get night(): boolean {
    return this.nightOp?.on ?? false;
  }

  has(id: string): boolean {
    return this.ops.has(id);
  }

  /** Apply an operation from anyone (including this peer). Idempotent. */
  apply(op: Op): Change {
    const id = opId(op);
    if (this.ops.has(id)) return 'none';
    this.ops.set(id, op);
    this.clock = Math.max(this.clock, op.lamport);
    this.markSeq(op.peer, op.seq);

    switch (op.k) {
      case 's': {
        this.strokes.set(id, op);
        if (this.erased.has(id)) return 'none';
        const list = this.ordered;
        if (list && (list.length === 0 || compareOps(list[list.length - 1]!, op) < 0)) {
          list.push(op);
          return 'append';
        }
        this.ordered = null;
        return 'full';
      }
      case 'e': {
        let changed = false;
        for (const t of op.targets) {
          if (this.erased.has(t)) continue;
          this.erased.add(t);
          if (this.strokes.has(t)) changed = true;
        }
        if (!changed) return 'none';
        this.ordered = null;
        return 'full';
      }
      case 'n': {
        if (this.nightOp && compareOps(this.nightOp, op) >= 0) return 'none';
        const was = this.night;
        this.nightOp = op;
        return was === op.on ? 'none' : 'night';
      }
    }
  }

  /** Create, apply and return a new operation by this peer. */
  local<T extends Op = Op>(body: OpBody<T>): T {
    const seq = (this.contiguous.get(this.self) ?? 0) + 1;
    // Peers would reject it, so never create it. (A fresh page load gets a fresh author id.)
    if (seq > LIMITS.seqPerAuthor) throw new RangeError('This page has made too many changes; reload to continue.');
    // Saturate rather than overflow: a peer that pushed the clock to the cap
    // cannot make everyone else's operations invalid. Ties are broken by (peer, seq).
    const lamport = Math.min(this.clock + 1, LIMITS.lamport);
    const op = { ...body, peer: this.self, seq, lamport } as unknown as T;
    this.apply(op);
    return op;
  }

  /** Visible strokes in drawing order. */
  visible(): readonly StrokeOp[] {
    if (!this.ordered) {
      this.ordered = [...this.strokes.values()].filter((s) => !this.erased.has(opId(s))).sort(compareOps);
    }
    return this.ordered;
  }

  /** This peer's visible strokes, newest last (for undo). */
  ownVisible(): StrokeOp[] {
    return this.visible().filter((s) => s.peer === this.self);
  }

  stateVector(): StateVector {
    return Object.fromEntries(this.contiguous);
  }

  /** Every operation the holder of `sv` has not seen, in a valid apply order. */
  missingFor(sv: StateVector): Op[] {
    const out: Op[] = [];
    for (const op of this.ops.values()) {
      if (op.seq > (sv[op.peer] ?? 0)) out.push(op);
    }
    return out.sort((a, b) => (a.peer === b.peer ? a.seq - b.seq : compareOps(a, b)));
  }

  /** All operations, for saving. */
  all(): Op[] {
    return this.missingFor({});
  }

  /** A short hash of what is on screen: equal fingerprints mean identical pictures. */
  fingerprint(): string {
    const ids = this.visible().map(opId).join(',');
    return `${fnv1a(ids).toString(16)}:${this.visible().length}:${this.night ? 1 : 0}`;
  }

  private markSeq(peer: string, seq: number): void {
    let c = this.contiguous.get(peer) ?? 0;
    if (seq <= c) return;
    let ahead = this.ahead.get(peer);
    if (seq !== c + 1) {
      if (!ahead) this.ahead.set(peer, (ahead = new Set()));
      ahead.add(seq);
      return;
    }
    c = seq;
    while (ahead?.delete(c + 1)) c++;
    this.contiguous.set(peer, c);
    if (ahead && ahead.size === 0) this.ahead.delete(peer);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An operation before this peer numbers and timestamps it. */
export type OpBody<T extends Op = Op> = DistributiveOmit<T, 'peer' | 'seq' | 'lamport'>;

export type { EraseOp, NightOp, StrokeOp };
