/**
 * An in-memory network for testing the sync engine: messages go through
 * JSON (as on the wire), take a random delay, may be dropped or duplicated, and
 * links can be cut and restored. Time is simulated and fully deterministic.
 */
import { rng } from '../src/core/rng';
import type { Transport } from '../src/core/sync';
import type { Message } from '../src/core/wire';

interface Pending {
  at: number;
  order: number;
  to: string;
  from: string;
  data: string;
}

export interface NetOptions {
  seed: number;
  drop?: number;
  dup?: number;
  maxDelay?: number;
}

export class Net {
  now = 0;
  private queue: Pending[] = [];
  private order = 0;
  private readonly nodes = new Map<string, MemTransport>();
  private readonly cut = new Set<string>();
  readonly rand: () => number;
  delivered = 0;

  constructor(private readonly opts: NetOptions) {
    this.rand = rng(opts.seed);
  }

  /** Create a transport. It meets the other peers when start() is called (after its engine is wired up). */
  join(id: string): MemTransport {
    return new MemTransport(id, this);
  }

  start(t: MemTransport): void {
    for (const other of this.nodes.values()) this.link(t, other);
    this.nodes.set(t.id, t);
  }

  leave(id: string): void {
    const t = this.nodes.get(id);
    if (!t) return;
    this.nodes.delete(id);
    for (const other of this.nodes.values()) {
      if (!this.isCut(id, other.id)) other.onLeave?.(id);
    }
    this.queue = this.queue.filter((p) => p.to !== id && p.from !== id);
  }

  partition(a: string, b: string): void {
    if (this.isCut(a, b)) return;
    this.cut.add(pair(a, b));
    this.queue = this.queue.filter((p) => pair(p.from, p.to) !== pair(a, b));
    this.nodes.get(a)?.onLeave?.(b);
    this.nodes.get(b)?.onLeave?.(a);
  }

  heal(a: string, b: string): void {
    if (!this.cut.delete(pair(a, b))) return;
    const ta = this.nodes.get(a);
    const tb = this.nodes.get(b);
    if (ta && tb) this.link(ta, tb);
  }

  healAll(): void {
    for (const key of [...this.cut]) {
      const [a, b] = key.split('|') as [string, string];
      this.heal(a, b);
    }
  }

  isCut(a: string, b: string): boolean {
    return this.cut.has(pair(a, b));
  }

  send(from: string, msg: Message, to?: string): void {
    const targets = to ? [to] : [...this.nodes.keys()].filter((id) => id !== from);
    for (const target of targets) {
      if (!this.nodes.has(target) || this.isCut(from, target)) continue;
      if (this.rand() < (this.opts.drop ?? 0)) continue;
      const copies = this.rand() < (this.opts.dup ?? 0) ? 2 : 1;
      for (let c = 0; c < copies; c++) {
        this.queue.push({
          at: this.now + 1 + this.rand() * (this.opts.maxDelay ?? 50),
          order: this.order++,
          to: target,
          from,
          data: JSON.stringify(msg),
        });
      }
    }
  }

  /** Deliver everything due up to time t. */
  runUntil(t: number): void {
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at || a.order - b.order);
      const next = this.queue[0];
      if (!next || next.at > t) break;
      this.queue.shift();
      this.now = next.at;
      const node = this.nodes.get(next.to);
      if (!node || this.isCut(next.from, next.to)) continue;
      this.delivered++;
      node.onMessage?.(JSON.parse(next.data), next.from);
    }
    this.now = Math.max(this.now, t);
  }

  get idle(): boolean {
    return this.queue.length === 0;
  }

  private link(a: MemTransport, b: MemTransport): void {
    if (this.isCut(a.id, b.id)) return;
    a.onJoin?.(b.id);
    b.onJoin?.(a.id);
  }
}

class MemTransport implements Transport {
  readonly name = 'memory';
  onMessage: ((msg: unknown, from: string) => void) | null = null;
  onJoin: ((peer: string) => void) | null = null;
  onLeave: ((peer: string) => void) | null = null;

  constructor(
    readonly id: string,
    private readonly net: Net,
  ) {}

  send(msg: Message, to?: string): void {
    this.net.send(this.id, msg, to);
  }

  close(): void {
    this.net.leave(this.id);
  }
}

const pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
