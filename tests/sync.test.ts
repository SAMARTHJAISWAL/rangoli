import { describe, expect, it } from 'vitest';
import { RangoliDoc } from '../src/core/doc';
import { SyncEngine } from '../src/core/sync';
import { opId, type Op, type StrokeOp } from '../src/core/types';
import { Net } from './net';

interface Peer {
  id: string;
  doc: RangoliDoc;
  engine: SyncEngine;
}

let made = 0;

function setup(n: number, net: Net): Peer[] {
  const peers: Peer[] = [];
  for (let i = 0; i < n; i++) {
    const id = `peer${(made++).toString(36).padStart(4, '0')}`;
    const doc = new RangoliDoc(id);
    const t = net.join(id);
    const engine = new SyncEngine(doc, [t], {}, () => net.now);
    net.start(t);
    peers.push({ id, doc, engine });
  }
  return peers;
}

function draw(p: Peer, x: number): Op {
  const op = p.doc.local<StrokeOp>({ k: 's', brush: 'petal', color: 2, size: 0, fold: 6, mirror: false, pts: [x, 5000, x + 10, 5100] });
  p.engine.publish(op);
  return op;
}

/** Let the network run with periodic gossip until it is quiet. */
function settle(net: Net, peers: Peer[]): void {
  for (let round = 0; round < 40; round++) {
    net.runUntil(net.now + 200);
    for (const p of peers) p.engine.gossip(net.rand);
    if (net.idle && new Set(peers.map((p) => p.doc.fingerprint())).size === 1 && round > 2) break;
  }
  net.runUntil(net.now + 1000);
}

describe('SyncEngine', () => {
  it('a late joiner receives the whole picture', () => {
    const net = new Net({ seed: 1 });
    const [a, b] = setup(2, net);
    for (let i = 0; i < 25; i++) draw(i % 2 ? a! : b!, 1000 + i * 100);
    net.runUntil(1000);
    const [c] = setup(1, net);
    settle(net, [a!, b!, c!]);
    expect(c!.doc.visible()).toHaveLength(25);
    expect(c!.doc.fingerprint()).toBe(a!.doc.fingerprint());
  });

  it('sends large backlogs in several messages', () => {
    const net = new Net({ seed: 2 });
    const [a] = setup(1, net);
    for (let i = 0; i < 1000; i++) draw(a!, 100 + (i % 9000));
    const [b] = setup(1, net);
    settle(net, [a!, b!]);
    expect(b!.doc.size).toBe(1000);
  });

  it('peers that drew apart during a partition converge after it heals', () => {
    const net = new Net({ seed: 3 });
    const [a, b, c] = setup(3, net);
    net.partition(a!.id, b!.id);
    net.partition(a!.id, c!.id);
    draw(a!, 100);
    draw(b!, 200);
    const target = draw(c!, 300);
    b!.engine.publish(b!.doc.local({ k: 'e', targets: [opId(target)] }));
    net.runUntil(500);
    expect(a!.doc.visible()).toHaveLength(1);
    net.healAll();
    settle(net, [a!, b!, c!]);
    expect(new Set([a, b, c].map((p) => p!.doc.fingerprint())).size).toBe(1);
    expect(a!.doc.visible().map((s) => s.pts[0])).toEqual([100, 200]);
  });

  it('converges under random drawing, erasing, loss, duplication, partitions and churn', () => {
    const SEEDS = Number(process.env.SYNC_SEEDS ?? 300);
    for (let seed = 1; seed <= SEEDS; seed++) {
      const net = new Net({ seed, drop: 0.1, dup: 0.05, maxDelay: 80 });
      const r = net.rand;
      const peers = setup(2 + Math.floor(r() * 4), net);
      const everyOp: Op[] = [];
      for (let step = 0; step < 80; step++) {
        const p = peers[Math.floor(r() * peers.length)]!;
        const roll = r();
        if (roll < 0.5) everyOp.push(draw(p, Math.floor(r() * 9000)));
        else if (roll < 0.62 && p.doc.ownVisible().length) {
          const op = p.doc.local({ k: 'e', targets: [opId(p.doc.ownVisible().at(-1)!)] });
          p.engine.publish(op);
          everyOp.push(op);
        } else if (roll < 0.67 && p.doc.visible().length) {
          const op = p.doc.local({ k: 'e', targets: p.doc.visible().map(opId) });
          p.engine.publish(op);
          everyOp.push(op);
        } else if (roll < 0.72) {
          const op = p.doc.local({ k: 'n', on: !p.doc.night });
          p.engine.publish(op);
          everyOp.push(op);
        } else if (roll < 0.8) {
          const q = peers[Math.floor(r() * peers.length)]!;
          if (q !== p) net.partition(p.id, q.id);
        } else if (roll < 0.86) {
          const q = peers[Math.floor(r() * peers.length)]!;
          net.heal(p.id, q.id);
        }
        net.runUntil(net.now + r() * 60);
      }
      net.healAll();
      settle(net, peers);
      const reference = new RangoliDoc('referenc');
      for (const op of everyOp) reference.apply(op);
      for (const p of peers) {
        expect(p.doc.fingerprint(), `seed ${seed}, ${p.id}`).toBe(reference.fingerprint());
      }
    }
  });

  it('ignores malformed and hostile messages', () => {
    const net = new Net({ seed: 9 });
    const [a] = setup(1, net);
    const evil = net.join('evilpeer');
    net.start(evil);
    const junk: unknown[] = [
      null,
      42,
      { t: 'ops', ops: [{ k: 's', peer: 'x', seq: 1, lamport: 1 }] },
      { t: 'ops', ops: [{ k: 's', peer: 'evilpeer', seq: 1, lamport: 1, brush: 'powder', color: 99, size: 0, fold: 4, mirror: false, pts: [1, 2] }] },
      { t: 'ops', ops: [{ k: 's', peer: 'evilpeer', seq: 1, lamport: 1, brush: 'powder', color: 0, size: 0, fold: 5, mirror: false, pts: [1, 2] }] },
      { t: 'ops', ops: [{ k: 's', peer: 'evilpeer', seq: 1, lamport: 1, brush: 'powder', color: 0, size: 0, fold: 4, mirror: false, pts: [1, 2, 3] }] },
      { t: 'ops', ops: [{ k: 'e', peer: 'evilpeer', seq: 1, lamport: 1, targets: ['../../x'] }] },
      { t: 'ops', ops: new Array(10_000).fill(0) },
      JSON.parse('{"t":"sv","sv":{"__proto__":{"polluted":1}}}'),
      { t: 'here', p: { peer: 'evilpeer', name: 'x'.repeat(500), x: 1, y: 1 } },
    ];
    for (const m of junk) net.send('evilpeer', m as never, a!.id);
    net.runUntil(1000);
    expect(a!.doc.size).toBe(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
