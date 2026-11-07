import { randomId } from '../core/rng';
import type { Transport } from '../core/sync';
import type { Message } from '../core/wire';

type Envelope =
  | { kind: 'hello'; from: string; reply: boolean }
  | { kind: 'bye'; from: string }
  | { kind: 'beat'; from: string }
  | { kind: 'msg'; from: string; to?: string; msg: Message };

/**
 * Other tabs of the same browser, over a BroadcastChannel. Works offline, and
 * the end-to-end tests use it to check syncing without the network. Tabs that
 * stop sending heartbeats (closed, crashed, frozen) are dropped after a few seconds.
 */
export class TabsTransport implements Transport {
  readonly name = 'tabs';
  onMessage: ((msg: unknown, from: string) => void) | null = null;
  onJoin: ((peer: string) => void) | null = null;
  onLeave: ((peer: string) => void) | null = null;
  readonly id = randomId(10);
  private readonly channel: BroadcastChannel;
  private readonly seen = new Map<string, number>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(roomId: string) {
    this.channel = new BroadcastChannel(`rangoli:${roomId}`);
    this.channel.onmessage = (e: MessageEvent<Envelope>) => this.receive(e.data);
    this.post({ kind: 'hello', from: this.id, reply: false });
    this.timer = setInterval(() => {
      this.post({ kind: 'beat', from: this.id });
      const now = Date.now();
      for (const [peer, at] of this.seen) {
        if (now - at > 6000) {
          this.seen.delete(peer);
          this.onLeave?.(peer);
        }
      }
    }, 2000);
  }

  send(msg: Message, to?: string): void {
    if (this.seen.size === 0) return;
    this.post(to ? { kind: 'msg', from: this.id, to, msg } : { kind: 'msg', from: this.id, msg });
  }

  close(): void {
    clearInterval(this.timer);
    this.post({ kind: 'bye', from: this.id });
    this.channel.close();
  }

  private post(e: Envelope): void {
    this.channel.postMessage(e);
  }

  private receive(e: Envelope): void {
    if (!e || typeof e !== 'object' || typeof e.from !== 'string' || e.from === this.id) return;
    const known = this.seen.has(e.from);
    if (e.kind === 'bye') {
      if (known) {
        this.seen.delete(e.from);
        this.onLeave?.(e.from);
      }
      return;
    }
    this.seen.set(e.from, Date.now());
    if (!known) {
      this.onJoin?.(e.from);
      if (e.kind !== 'hello' || !e.reply) this.post({ kind: 'hello', from: this.id, reply: true });
    }
    if (e.kind === 'msg' && (!e.to || e.to === this.id)) this.onMessage?.(structuredClone(e.msg), e.from);
  }
}
