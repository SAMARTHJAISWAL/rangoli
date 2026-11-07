import { RangoliDoc, type Change } from './doc';
import { LIMITS, type Op, type StateVector } from './types';
import { parseMessage, type Burst, type LiveStroke, type Message, type Presence } from './wire';

/**
 * A way to reach other peers: WebRTC through trystero in the app, a
 * BroadcastChannel between tabs of one browser, or an in-memory network in
 * tests. Peer ids are only meaningful within one transport.
 */
export interface Transport {
  readonly name: string;
  send(msg: Message, to?: string): void;
  onMessage: ((msg: unknown, from: string) => void) | null;
  onJoin: ((peer: string) => void) | null;
  onLeave: ((peer: string) => void) | null;
  close(): void;
}

export interface SyncEvents {
  change?(change: Change, op: Op | null): void;
  live?(s: LiveStroke): void;
  liveEnd?(id: string): void;
  presence?(p: Presence): void;
  gone?(author: string): void;
  burst?(b: Burst): void;
  peers?(count: number): void;
}

/**
 * Keeps a RangoliDoc in sync with every reachable peer.
 *
 * The protocol is state-vector anti-entropy: when two peers meet, each sends
 * the highest contiguous seq it holds from every author ("sv"); the other
 * answers with every operation above those numbers ("ops"). New local
 * operations are pushed to everyone at once, and a periodic sv exchange with a
 * random peer repairs anything lost on the way. Because applying operations is
 * idempotent and commutative, duplicates and reordering are harmless.
 */
export class SyncEngine {
  /** transport index + ":" + transport peer id → author id (learned from presence). */
  private readonly links = new Map<string, string | null>();
  private readonly lastSv = new Map<string, number>();
  private readonly lastAnswer = new Map<string, number>();

  constructor(
    readonly doc: RangoliDoc,
    private readonly transports: Transport[],
    private readonly on: SyncEvents = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    transports.forEach((t, i) => {
      t.onJoin = (peer) => {
        this.links.set(`${i}:${peer}`, null);
        this.emitPeers();
        t.send({ t: 'sv', sv: doc.stateVector() }, peer);
      };
      t.onLeave = (peer) => {
        const key = `${i}:${peer}`;
        this.lastSv.delete(key);
        this.lastAnswer.delete(key);
        const author = this.links.get(key);
        this.links.delete(key);
        if (author && ![...this.links.values()].includes(author)) this.on.gone?.(author);
        this.emitPeers();
      };
      t.onMessage = (raw, from) => this.receive(i, from, raw);
    });
  }

  /** Number of distinct people connected (by author id where known). */
  peerCount(): number {
    const authors = new Set<string>();
    let unknown = 0;
    for (const a of this.links.values()) {
      if (a) authors.add(a);
      else unknown++;
    }
    authors.delete(this.doc.self);
    return authors.size + unknown;
  }

  /** Apply a locally created operation (already in the doc) and push it to everyone. */
  publish(op: Op): void {
    this.broadcast({ t: 'ops', ops: [op] });
  }

  live(s: LiveStroke): void {
    this.broadcast({ t: 'live', s });
  }

  liveEnd(id: string): void {
    this.broadcast({ t: 'live-end', id });
  }

  presence(p: Presence): void {
    this.broadcast({ t: 'here', p });
  }

  burst(b: Burst): void {
    this.broadcast({ t: 'burst', b });
  }

  /** Anti-entropy round: ask one random peer per transport what we are missing. */
  gossip(rand: () => number = Math.random): void {
    const keys = [...this.links.keys()];
    if (keys.length === 0) return;
    const key = keys[Math.floor(rand() * keys.length)]!;
    const [i, peer] = split(key);
    this.transports[i]?.send({ t: 'sv', sv: this.doc.stateVector() }, peer);
  }

  close(): void {
    for (const t of this.transports) t.close();
  }

  private broadcast(msg: Message): void {
    for (const t of this.transports) t.send(msg);
  }

  private receive(i: number, from: string, raw: unknown): void {
    const msg = parseMessage(raw);
    if (!msg) return;
    const t = this.transports[i]!;
    const key = `${i}:${from}`;
    if (!this.links.has(key)) {
      // A message can arrive before the join callback on some transports.
      this.links.set(key, null);
      this.emitPeers();
    }
    switch (msg.t) {
      case 'sv': {
        // Answering means sending possibly the whole board, so at most a few times a second per peer.
        const now = this.now();
        if (now - (this.lastAnswer.get(key) ?? -Infinity) < 300) break;
        this.lastAnswer.set(key, now);
        for (const ops of chunks(this.doc.missingFor(msg.sv))) t.send({ t: 'ops', ops }, from);
        if (hasMore(msg.sv, this.doc.stateVector())) this.requestFrom(t, key, from);
        break;
      }
      case 'ops': {
        let gap = false;
        for (const op of msg.ops) {
          const change = this.doc.apply(op);
          if (change !== 'none') this.on.change?.(change, op);
          if (op.seq > (this.doc.stateVector()[op.peer] ?? 0)) gap = true;
        }
        if (gap) this.requestFrom(t, key, from);
        break;
      }
      case 'live':
        this.on.live?.(msg.s);
        break;
      case 'live-end':
        this.on.liveEnd?.(msg.id);
        break;
      case 'here': {
        if (msg.p.peer === this.doc.self) break;
        const before = this.links.get(key);
        this.links.set(key, msg.p.peer);
        if (before !== msg.p.peer) this.emitPeers();
        this.on.presence?.(msg.p);
        break;
      }
      case 'burst':
        this.on.burst?.(msg.b);
        break;
    }
  }

  /** Send our state vector to one peer, at most once a second per peer. */
  private requestFrom(t: Transport, key: string, peer: string): void {
    const now = this.now();
    if (now - (this.lastSv.get(key) ?? -Infinity) < 1000) return;
    this.lastSv.set(key, now);
    t.send({ t: 'sv', sv: this.doc.stateVector() }, peer);
  }

  private emitPeers(): void {
    this.on.peers?.(this.peerCount());
  }
}

/** Split operations into messages under both the count and the size limit. */
export function chunks(ops: Op[]): Op[][] {
  const out: Op[][] = [];
  let cur: Op[] = [];
  let size = 0;
  for (const op of ops) {
    const n = JSON.stringify(op).length + 1;
    if (cur.length && (cur.length >= LIMITS.opsPerMessage || size + n > LIMITS.messageChars)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(op);
    size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Does `theirs` hold anything beyond `mine`? */
function hasMore(theirs: StateVector, mine: StateVector): boolean {
  for (const [peer, seq] of Object.entries(theirs)) if (seq > (mine[peer] ?? 0)) return true;
  return false;
}

function split(key: string): [number, string] {
  const c = key.indexOf(':');
  return [Number(key.slice(0, c)), key.slice(c + 1)];
}
