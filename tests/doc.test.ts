import { describe, expect, it } from 'vitest';
import { RangoliDoc } from '../src/core/doc';
import { rng } from '../src/core/rng';
import { opId, type Op, type StrokeOp } from '../src/core/types';

const stroke = (doc: RangoliDoc, x = 100): StrokeOp =>
  doc.local<StrokeOp>({ k: 's', brush: 'powder', color: 1, size: 1, fold: 8, mirror: true, pts: [x, 200, x + 50, 260] });

function shuffle<T>(xs: T[], r: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Three authors make interleaved strokes, erasures and night toggles, each seeing a random subset of the others' work. */
function randomHistory(seed: number): Op[] {
  const r = rng(seed);
  const docs = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].map((p) => new RangoliDoc(p));
  const all: Op[] = [];
  for (let step = 0; step < 60; step++) {
    const d = docs[Math.floor(r() * docs.length)]!;
    // Learn some of what others did, so Lamport clocks interleave.
    for (const op of all) if (r() < 0.3) d.apply(op);
    const roll = r();
    let op: Op;
    if (roll < 0.6 || d.visible().length === 0) op = stroke(d, Math.floor(r() * 9000));
    else if (roll < 0.85) {
      const v = d.visible();
      op = d.local({ k: 'e', targets: [opId(v[Math.floor(r() * v.length)]!)] });
    } else op = d.local({ k: 'n', on: r() < 0.5 });
    all.push(op);
  }
  return all;
}

describe('RangoliDoc', () => {
  it('numbers local operations 1, 2, 3 and advances the Lamport clock', () => {
    const d = new RangoliDoc('aaaaaaaa');
    const a = stroke(d);
    const b = stroke(d);
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(b.lamport).toBeGreaterThan(a.lamport);
    expect(d.stateVector()).toEqual({ aaaaaaaa: 2 });
  });

  it('applies an operation only once', () => {
    const a = new RangoliDoc('aaaaaaaa');
    const op = stroke(a);
    const b = new RangoliDoc('bbbbbbbb');
    expect(b.apply(op)).toBe('append');
    expect(b.apply(op)).toBe('none');
    expect(b.apply(structuredClone(op))).toBe('none');
    expect(b.visible()).toHaveLength(1);
  });

  it('converges whatever order the operations arrive in', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const ops = randomHistory(seed);
      const r = rng(seed * 7919);
      const prints = new Set<string>();
      for (let k = 0; k < 6; k++) {
        const d = new RangoliDoc('zzzzzzzz');
        // Shuffled, with duplicates.
        for (const op of shuffle([...ops, ...ops.filter(() => r() < 0.2)], r)) d.apply(op);
        prints.add(d.fingerprint());
      }
      expect(prints.size, `seed ${seed}`).toBe(1);
    }
  });

  it('draws strokes in Lamport order, ties broken by author', () => {
    const a = new RangoliDoc('aaaaaaaa');
    const b = new RangoliDoc('bbbbbbbb');
    const sa = stroke(a);
    const sb = stroke(b); // concurrent: both lamport 1
    const x = new RangoliDoc('xxxxxxxx');
    x.apply(sb);
    expect(x.apply(sa)).toBe('full'); // sorts before sb, so a full redraw is needed
    expect(x.visible().map((s) => s.peer)).toEqual(['aaaaaaaa', 'bbbbbbbb']);
    const later = stroke(x);
    expect(x.visible().at(-1)).toBe(later);
  });

  it('keeps a stroke erased even if the erasure arrives first', () => {
    const a = new RangoliDoc('aaaaaaaa');
    const s = stroke(a);
    const e = a.local({ k: 'e', targets: [opId(s)] });
    const b = new RangoliDoc('bbbbbbbb');
    expect(b.apply(e)).toBe('none');
    expect(b.apply(s)).toBe('none');
    expect(b.visible()).toHaveLength(0);
    expect(b.fingerprint()).toBe(a.fingerprint());
  });

  it('a concurrent stroke survives someone else clearing the board', () => {
    const a = new RangoliDoc('aaaaaaaa');
    const b = new RangoliDoc('bbbbbbbb');
    const s1 = stroke(a);
    b.apply(s1);
    const s2 = stroke(b); // b draws ...
    const clear = a.local({ k: 'e', targets: a.visible().map(opId) }); // ... while a clears what it can see
    a.apply(s2);
    b.apply(clear);
    expect(a.visible()).toEqual([s2]);
    expect(b.fingerprint()).toBe(a.fingerprint());
  });

  it('night mode is last-writer-wins', () => {
    const a = new RangoliDoc('aaaaaaaa');
    const b = new RangoliDoc('bbbbbbbb');
    const on = a.local({ k: 'n', on: true });
    const off = b.local({ k: 'n', on: false }); // concurrent, same lamport: b wins the tie
    for (const d of [a, b]) {
      d.apply(on);
      d.apply(off);
    }
    expect(a.night).toBe(false);
    expect(b.night).toBe(false);
    a.apply(b.local({ k: 'n', on: true }));
    expect(a.night).toBe(true);
  });

  it('tracks contiguous seqs and fills gaps', () => {
    const a = new RangoliDoc('aaaaaaaa');
    const ops = [stroke(a), stroke(a), stroke(a)];
    const b = new RangoliDoc('bbbbbbbb');
    b.apply(ops[2]!);
    expect(b.stateVector()).toEqual({});
    b.apply(ops[0]!);
    expect(b.stateVector()).toEqual({ aaaaaaaa: 1 });
    expect(a.missingFor(b.stateVector()).map((o) => o.seq)).toEqual([2, 3]);
    b.apply(ops[1]!);
    expect(b.stateVector()).toEqual({ aaaaaaaa: 3 });
    expect(a.missingFor(b.stateVector())).toEqual([]);
  });

  it('own strokes are listed for undo, newest last', () => {
    const a = new RangoliDoc('aaaaaaaa');
    const b = new RangoliDoc('bbbbbbbb');
    const first = stroke(a);
    a.apply(stroke(b));
    const second = stroke(a);
    expect(a.ownVisible()).toEqual([first, second]);
  });
});
