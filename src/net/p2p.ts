import { joinRoom, type Room } from 'trystero/nostr';
import type { Transport } from '../core/sync';
import type { Message } from '../core/wire';

/**
 * WebRTC data channels between browsers, found through public Nostr relays
 * (trystero). The relays only carry the connection handshake, encrypted with
 * the room id, which is never sent anywhere; drawings go browser to browser.
 */
export class P2PTransport implements Transport {
  readonly name = 'p2p';
  onMessage: ((msg: unknown, from: string) => void) | null = null;
  onJoin: ((peer: string) => void) | null = null;
  onLeave: ((peer: string) => void) | null = null;
  onError: ((error: string) => void) | null = null;
  private readonly room: Room;
  private readonly sendRaw: (data: string, opts?: { target?: string }) => Promise<void>;

  constructor(roomId: string) {
    this.room = joinRoom({ appId: 'rangoli-diwali-v1', password: roomId }, `room-${roomId}`, {
      onJoinError: (e) => this.onError?.(e.error),
    });
    const action = this.room.makeAction<string>('m');
    this.sendRaw = (data, opts) => action.send(data, opts);
    action.onMessage = (data, { peerId }) => {
      if (typeof data !== 'string' || data.length > 4_000_000) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      this.onMessage?.(parsed, peerId);
    };
    this.room.onPeerJoin = (peer) => this.onJoin?.(peer);
    this.room.onPeerLeave = (peer) => this.onLeave?.(peer);
  }

  send(msg: Message, to?: string): void {
    if (Object.keys(this.room.getPeers()).length === 0) return;
    this.sendRaw(JSON.stringify(msg), to ? { target: to } : undefined).catch(() => {});
  }

  close(): void {
    void this.room.leave();
  }
}
