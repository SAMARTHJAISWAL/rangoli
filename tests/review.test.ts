/**
 * Regression tests for problems found in review: a hostile peer must not be
 * able to break the room for everyone, and a stroke must look the same whether
 * you watched it being drawn or received it finished.
 */
import { describe, expect, it } from 'vitest';
import { RangoliDoc } from '../src/core/doc';
import { SyncEngine, chunks } from '../src/core/sync';
import { LIMITS, type Op, type StrokeOp } from '../src/core/types';
import { parseOp } from '../src/core/wire';
import { forget, geometry, type StrokeLike } from '../src/render/brushes';
import { Net } from './net';

const style = { brush: 'powder', color: 1, size: 1, fold: 8, mirror: true } as const;

describe('a hostile Lamport clock', () => {
  it('cannot stop everyone else from drawing', () => {
    const evil = parseOp({ k: 'n', peer: 'evilpeer', seq: 1, lamport: LIMITS.lamport, on: true })!;
    expect(evil).not.toBeNull();
    expect(parseOp({ ...evil, lamport: LIMITS.lamport + 1 })).toBeNull();

    const a = new RangoliDoc('aaaaaaaa');
    const b = new RangoliDoc('bbbbbbbb');
    a.apply(evil);
    b.apply(evil);
    const ops: Op[] = [];
    for (let i = 0; i < 5; i++) ops.push(a.local<StrokeOp>({ k: 's', ...style, pts: [100 * i, 50] }));
    ops.push(a.local({ k: 'n', on: false }));
    for (const op of ops) {
      // Saturated, not overflowed: still valid on the wire.
      expect(op.lamport).toBe(LIMITS.lamport);
      expect(parseOp(JSON.parse(JSON.stringify(op)))).toEqual(op);
      b.apply(op);
    }
    expect(b.visible()).toHaveLength(5);
    expect(b.fingerprint()).toBe(a.fingerprint());
  });
});

describe('per-operation limits', () => {
  it('reject seqs beyond the per-author limit', () => {
    expect(parseOp({ k: 'n', peer: 'abcdef12', seq: LIMITS.seqPerAuthor + 1, lamport: 1, on: true })).toBeNull();
  });

  it('reject strokes longer than the length limit, however few points', () => {
    const zigzag: number[] = [];
    for (let i = 0; i < 20; i++) zigzag.push(i % 2 ? 10_000 : 0, i % 2 ? 10_000 : 0);
    expect(parseOp({ k: 's', peer: 'abcdef12', seq: 1, lamport: 1, ...style, size: 0, pts: zigzag })).toBeNull();
  });

  it('a document has no total cap, so acceptance never depends on arrival order', () => {
    const d = new RangoliDoc('aaaaaaaa');
    for (let i = 0; i < 60_000; i++) d.apply({ k: 'n', peer: `p${String(i).padStart(7, '0')}`, seq: 1, lamport: 1, on: i % 2 === 0 });
    expect(d.size).toBe(60_000);
  });
});

describe('stroke geometry', () => {
  const brushes = ['powder', 'petal', 'dot', 'diya', 'chalk'] as const;

  it('is identical whether the stroke grew point by point or arrived finished', () => {
    for (const brush of brushes) {
      const pts = [5200, 5200, 5600, 5300, 6100, 5500, 6600, 5900, 7000, 6400];
      const id = `abcdef12/${brush.length}`;
      const live: StrokeLike = { id, key: `live:${id}`, ...style, brush, pts: [] };
      // As seen by someone watching: one point first, then more and more.
      for (let n = 1; n <= pts.length / 2; n++) geometry({ ...live, pts: pts.slice(0, n * 2) });
      const watched = geometry({ ...live, pts }).data.slice();
      forget(live.key!);
      const fresh = geometry({ id, ...style, brush, pts }).data.slice();
      forget(id);
      expect(watched, brush).toEqual(fresh);
    }
  });

  it('stays bounded for the worst stroke the limits allow', () => {
    const pts: number[] = [];
    // Back and forth along one line: the longest path allowed, packed into the fewest points.
    for (let i = 0; i < 7; i++) pts.push(i % 2 ? 9_999 : 1, 5_000);
    const s: StrokeLike = { id: 'abcdef12/9', ...style, size: 0, pts };
    expect(parseOp({ k: 's', peer: 'abcdef12', seq: 9, lamport: 1, ...style, size: 0, pts })).not.toBeNull();
    expect(geometry(s).data.length).toBeLessThanOrEqual(160_000);
    forget(s.id);
  });
});

describe('sync messages', () => {
  it('are split by size as well as by count', () => {
    const big: StrokeOp[] = [];
    for (let i = 1; i <= 400; i++) {
      big.push({ k: 's', peer: 'abcdef12', seq: i, lamport: i, ...style, pts: new Array(2000).fill(5000) });
    }
    const parts = chunks(big);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(JSON.stringify({ t: 'ops', ops: p }).length).toBeLessThan(LIMITS.messageChars + 1000);
    expect(parts.flat()).toHaveLength(400);
  });

  it('a flood of state-vector requests gets one answer, not one per request', () => {
    const net = new Net({ seed: 4 });
    const doc = new RangoliDoc('victim01');
    const t = net.join('victim01');
    new SyncEngine(doc, [t], {}, () => net.now);
    net.start(t);
    for (let i = 0; i < 50; i++) doc.local({ k: 's', ...style, pts: [i * 10, 10] });
    const evil = net.join('evilpeer');
    let answers = 0;
    evil.onMessage = (m) => {
      if ((m as { t: string }).t === 'ops') answers++;
    };
    net.start(evil);
    net.runUntil(100); // the normal answer to the join
    const before = answers;
    for (let i = 0; i < 100; i++) net.send('evilpeer', { t: 'sv', sv: {} }, 'victim01');
    net.runUntil(200);
    expect(answers - before).toBeLessThanOrEqual(1);
  });
});
