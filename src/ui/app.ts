import { RangoliDoc, type Change, type OpBody } from '../core/doc';
import { hueFor, nameFor } from '../core/names';
import { samplePattern } from '../core/pattern';
import { randomId, rng } from '../core/rng';
import { SyncEngine, type Transport } from '../core/sync';
import { BRUSHES, FOLDS, LIMITS, PALETTE, SIZES, opId, pathLength, type Brush, type Fold, type Op, type StrokeOp } from '../core/types';
import { parseOp, type LiveStroke } from '../core/wire';
import { Board } from '../render/board';
import { width } from '../render/brushes';
import { P2PTransport } from '../net/p2p';
import { TabsTransport } from '../net/tabs';
import { brushIcon } from './icons';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** localStorage, which may be missing or throw (private mode, blocked storage). */
const storage = (area: () => Storage) => ({
  get(key: string): string | null {
    try {
      return area().getItem(key);
    } catch {
      return null;
    }
  },
  /** False if the browser refused (storage full or unavailable): the board still works, it just isn't saved. */
  set(key: string, value: string): boolean {
    try {
      area().setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
});
/** Shared by every tab of this browser: the saved board and your name. */
const store = storage(() => localStorage);
/** This tab only (kept across reloads): which author ids are yours, for undo. */
const tabStore = storage(() => sessionStorage);

/** Caps on short-lived things other people can create, so nobody can flood your screen. */
const CAP = { live: 24, people: 50 } as const;

const BRUSH_LABEL: Record<Brush, string> = { powder: 'Powder', chalk: 'Chalk', petal: 'Petals', diya: 'Diya', dot: 'Kolam dots' };

interface Drawing {
  id: string;
  pts: number[];
  sent: number;
  pointer: number;
}

export class App {
  readonly room: string;
  readonly me: string;
  /** Author ids this browser has used in this room (for undo). */
  readonly mine: Set<string>;
  readonly name: string;
  readonly doc: RangoliDoc;
  readonly engine: SyncEngine;
  readonly board: Board;
  brush: Brush = 'powder';
  color = 1;
  size = 1;
  fold: Fold = 8;
  mirror = true;
  private drawing: Drawing | null = null;
  private lastLiveSend = 0;
  private lastPresence = 0;
  private saveTimer = 0;
  private readonly people = new Map<string, { name: string; at: number }>();
  private toastTimer = 0;
  private peopleQueued = false;
  private saveWarned = false;
  /** Length so far of the stroke being drawn, in board units. */
  private drawnLength = 0;
  private lastFrame = performance.now();

  constructor() {
    this.room = App.roomFromHash();
    // A fresh author id for every page load: two tabs of one browser must never
    // number operations from the same counter. The ids this tab used before are
    // remembered per room, so undo still reaches strokes drawn before a reload.
    this.me = randomId(12);
    this.mine = new Set([...App.remembered(this.room), this.me]);
    tabStore.set(`rangoli:mine:${this.room}`, JSON.stringify([...this.mine].slice(-50)));
    this.name = store.get('rangoli:name') ?? nameFor(rng(Date.now() ^ Math.floor(Math.random() * 1e9)));
    store.set('rangoli:name', this.name);

    this.doc = new RangoliDoc(this.me);
    this.load();

    const params = new URLSearchParams(location.search);
    const net = params.get('net');
    const transports: Transport[] = [new TabsTransport(this.room)];
    if (net !== 'local') {
      const p2p = new P2PTransport(this.room);
      p2p.onError = (e) => this.toast(`Couldn't join the room: ${e}`);
      transports.push(p2p);
    }

    this.board = new Board($('board'), () => this.doc.visible());
    this.board.night = this.doc.night;
    this.engine = new SyncEngine(this.doc, transports, {
      change: (c, op) => this.onChange(c, op),
      live: (s) => this.onLive(s),
      liveEnd: (id) => this.board.live.delete(id),
      presence: (p) => {
        if (!this.people.has(p.peer) && this.people.size >= CAP.people) return;
        this.people.set(p.peer, { name: p.name, at: Date.now() });
        if (p.x !== null && p.y !== null) this.board.cursors.set(p.peer, { name: p.name, hue: hueFor(p.name), x: p.x, y: p.y, at: performance.now() });
        else this.board.cursors.delete(p.peer);
        this.queuePeople();
      },
      gone: (author) => {
        this.people.delete(author);
        this.board.cursors.delete(author);
        this.renderPeople();
      },
      burst: (b) => this.board.burst(b),
      peers: () => this.queuePeople(),
    });

    this.buildTools();
    this.bindBoard();
    this.bindActions();
    this.bindKeys();
    new ResizeObserver(() => this.board.resize()).observe($('board'));
    this.board.resize();
    this.renderPeople();
    this.syncButtons();

    setInterval(() => this.engine.gossip(), 4000);
    setInterval(() => this.sendPresence(null, true), 5000);
    setInterval(() => this.renderPeople(), 5000);
    window.addEventListener('pagehide', (e) => {
      if (!e.persisted) this.engine.close();
    });
    // Back/forward cache: the connections did not survive, so start afresh.
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) location.reload();
    });
    window.addEventListener('hashchange', () => {
      if (App.roomFromHash() !== this.room) location.reload();
    });
    requestAnimationFrame((t) => this.loop(t));
    this.sendPresence(null, true);

    // Someone opening an invite link should see the board arrive, not a welcome
    // screen: wait a moment, and greet only if the board is still empty and nobody is here.
    if (this.doc.size === 0 && !params.has('nowelcome')) {
      setTimeout(() => {
        if (this.doc.size === 0 && this.engine.peerCount() === 0) this.welcome();
      }, 1200);
    }
  }

  static remembered(room: string): string[] {
    try {
      const ids = JSON.parse(tabStore.get(`rangoli:mine:${room}`) ?? '[]') as unknown;
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && /^[a-z0-9]{6,24}$/.test(x)) : [];
    } catch {
      return [];
    }
  }

  /** The room id lives in the URL fragment, which browsers never send to a server. */
  static roomFromHash(): string {
    const m = /^#([a-z0-9]{6,24})$/.exec(location.hash);
    if (m) return m[1]!;
    const id = randomId(10);
    history.replaceState(null, '', `${location.pathname}${location.search}#${id}`);
    return id;
  }

  // ---- Document changes -------------------------------------------------------

  private onChange(change: Change, op: Op | null): void {
    if (op?.k === 's') {
      this.board.live.delete(opId(op));
    }
    if (change === 'append' && op?.k === 's') this.board.append(op);
    else if (change === 'full') this.board.redraw();
    else if (change === 'night') {
      this.board.night = this.doc.night;
      this.syncButtons();
    }
    this.scheduleSave();
  }

  private onLive(s: LiveStroke): void {
    if (this.doc.has(s.id)) return;
    const cur = this.board.live.get(s.id);
    if (s.from === 0) {
      if (!cur && this.board.live.size >= CAP.live) return;
      this.board.live.set(s.id, { ...s, pts: s.pts.slice(), at: performance.now() });
      return;
    }
    if (!cur) return;
    const pts = cur.pts as number[];
    // Accept only the continuation of what we have, within the limits a finished stroke must meet;
    // a gap just waits for the finished stroke.
    if (s.from * 2 !== pts.length || (pts.length + s.pts.length) / 2 > LIMITS.pointsPerStroke) return;
    const joined = pts.length ? [pts[pts.length - 2]!, pts[pts.length - 1]!, ...s.pts] : s.pts;
    if (pathLength(pts) + pathLength(joined) > LIMITS.strokeLength) return;
    pts.push(...s.pts);
    cur.at = performance.now();
  }

  private local(body: OpBody): Op {
    const op = this.doc.local<Op>(body);
    this.engine.publish(op);
    if (op.k === 's') this.board.append(op);
    else this.onChange(op.k === 'n' ? 'night' : 'full', op);
    this.scheduleSave();
    return op;
  }

  // ---- Drawing ------------------------------------------------------------------

  private bindBoard(): void {
    const fx = this.board.fx;
    fx.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.drawing) return;
      fx.setPointerCapture(e.pointerId);
      const [x, y] = this.board.toBoard(e.clientX, e.clientY);
      const seq = (this.doc.stateVector()[this.me] ?? 0) + 1;
      this.drawing = { id: `${this.me}/${seq}`, pts: [x, y], sent: 0, pointer: e.pointerId };
      this.drawnLength = 0;
      this.updateLive(true);
      e.preventDefault();
    });
    fx.addEventListener('pointermove', (e) => {
      const [x, y] = this.board.toBoard(e.clientX, e.clientY);
      this.board.pointer = e.pointerType === 'mouse' ? { x, y, fold: this.fold, mirror: this.mirror } : null;
      this.sendPresence([x, y]);
      const d = this.drawing;
      if (!d || d.pointer !== e.pointerId) return;
      let full = false;
      for (const ev of e.getCoalescedEvents?.() ?? [e]) {
        const [cx, cy] = this.board.toBoard(ev.clientX, ev.clientY);
        const lx = d.pts[d.pts.length - 2]!;
        const ly = d.pts[d.pts.length - 1]!;
        const step = Math.hypot(cx - lx, cy - ly);
        if (step < Math.max(10, width({ size: this.size }) * 0.12)) continue;
        // Stop exactly at the limits every peer checks, so the finished stroke is never rejected.
        if (d.pts.length / 2 >= LIMITS.pointsPerStroke || this.drawnLength + step > LIMITS.strokeLength) {
          full = true;
          break;
        }
        d.pts.push(cx, cy);
        this.drawnLength += step;
      }
      if (full) {
        this.finish();
        return;
      }
      this.updateLive(false);
    });
    const end = (e: PointerEvent) => {
      if (this.drawing?.pointer === e.pointerId) this.finish();
    };
    fx.addEventListener('pointerup', end);
    fx.addEventListener('pointercancel', end);
    fx.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse') {
        this.board.pointer = null;
        this.sendPresence(null, true);
      }
    });
  }

  private style(): Pick<StrokeOp, 'brush' | 'color' | 'size' | 'fold' | 'mirror'> {
    return { brush: this.brush, color: this.color, size: this.size, fold: this.fold, mirror: this.mirror };
  }

  private updateLive(first: boolean): void {
    const d = this.drawing!;
    this.board.live.set(d.id, { id: d.id, ...this.style(), pts: d.pts, at: performance.now() });
    const now = performance.now();
    if (!first && now - this.lastLiveSend < 45) return;
    this.lastLiveSend = now;
    const from = d.sent;
    const pts = d.pts.slice(from * 2, from * 2 + 400);
    this.engine.live({ id: d.id, ...this.style(), pts, from });
    d.sent = from + pts.length / 2;
  }

  private finish(): void {
    const d = this.drawing;
    if (!d) return;
    this.drawing = null;
    this.board.live.delete(d.id);
    const op = this.local({ k: 's', ...this.style(), pts: d.pts.slice() });
    // If something else used our next number meanwhile, the preview others see has a different id.
    if (opId(op) !== d.id) this.engine.liveEnd(d.id);
  }

  private sendPresence(at: [number, number] | null, force = false): void {
    const now = performance.now();
    if (!force && now - this.lastPresence < 70) return;
    this.lastPresence = now;
    const p = at ?? (this.board.pointer ? [this.board.pointer.x, this.board.pointer.y] : null);
    this.engine.presence({ peer: this.me, name: this.name, x: p ? p[0] : null, y: p ? p[1] : null });
  }

  // ---- Tools and actions ----------------------------------------------------------

  private buildTools(): void {
    const radios = <T,>(host: HTMLElement, items: readonly T[], render: (b: HTMLButtonElement, v: T, i: number) => void, pick: (v: T) => void) => {
      host.replaceChildren();
      items.forEach((v, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        render(b, v, i);
        b.addEventListener('click', () => {
          pick(v);
          this.syncButtons();
        });
        host.appendChild(b);
      });
    };
    radios($('brushes'), BRUSHES, (b, v, i) => {
      b.className = 'tool';
      b.dataset.brush = v;
      b.innerHTML = `${brushIcon(v)}<span>${BRUSH_LABEL[v]}</span>`;
      b.title = `${BRUSH_LABEL[v]} (${i + 1})`;
    }, (v) => (this.brush = v));
    radios($('colours'), PALETTE, (b, c, i) => {
      b.className = 'swatch';
      b.dataset.color = String(i);
      b.style.setProperty('--c', c.hex);
      b.title = c.name;
      b.setAttribute('aria-label', c.name);
    }, (c) => (this.color = PALETTE.indexOf(c)));
    radios($('sizes'), SIZES, (b, _v, i) => {
      b.className = 'segbtn';
      b.dataset.size = String(i);
      b.textContent = ['Fine', 'Medium', 'Bold'][i]!;
    }, (v) => (this.size = SIZES.indexOf(v)));
    radios($('folds'), FOLDS, (b, f) => {
      b.className = 'segbtn';
      b.dataset.fold = String(f);
      b.textContent = f === 1 ? 'Off' : `${f}×`;
      b.title = f === 1 ? 'No symmetry' : `${f}-fold symmetry`;
    }, (f) => (this.fold = f));
  }

  private syncButtons(): void {
    const set = (sel: string, on: (b: HTMLElement) => boolean) => {
      for (const b of document.querySelectorAll<HTMLElement>(sel)) b.setAttribute('aria-checked', String(on(b)));
    };
    set('#brushes [role=radio]', (b) => b.dataset.brush === this.brush);
    set('#colours [role=radio]', (b) => b.dataset.color === String(this.color));
    set('#sizes [role=radio]', (b) => b.dataset.size === String(this.size));
    set('#folds [role=radio]', (b) => b.dataset.fold === String(this.fold));
    $('btn-mirror').setAttribute('aria-pressed', String(this.mirror));
    $('btn-mirror').toggleAttribute('disabled', this.fold === 1);
    $('btn-night').setAttribute('aria-pressed', String(this.doc.night));
    $('btn-night').textContent = this.doc.night ? 'Lights on' : 'Lights out';
    $('btn-guides').setAttribute('aria-pressed', String(this.board.guides));
    document.documentElement.classList.toggle('is-night', this.doc.night);
  }

  private bindActions(): void {
    $('btn-mirror').addEventListener('click', () => {
      this.mirror = !this.mirror;
      this.syncButtons();
    });
    $('btn-undo').addEventListener('click', () => this.undo());
    $('btn-night').addEventListener('click', () => this.toggleNight());
    $('btn-burst').addEventListener('click', () => this.firework());
    $('btn-pattern').addEventListener('click', () => this.sample());
    $('btn-guides').addEventListener('click', () => {
      this.board.guides = !this.board.guides;
      this.board.redraw();
      this.syncButtons();
    });
    $('btn-save').addEventListener('click', () => void this.save());
    $('btn-invite').addEventListener('click', () => void this.invite());
    const confirm = $<HTMLDialogElement>('confirm-clear');
    $('btn-clear').addEventListener('click', () => {
      if (this.doc.visible().length === 0) return this.toast('The board is already empty.');
      confirm.showModal();
    });
    confirm.addEventListener('close', () => {
      if (confirm.returnValue === 'clear') this.clear();
    });
  }

  private bindKeys(): void {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || document.querySelector('dialog[open]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.undo();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= BRUSHES.length) this.brush = BRUSHES[n - 1]!;
      else if (e.key === 'm') this.mirror = !this.mirror;
      else if (e.key === 'n') this.toggleNight();
      else if (e.key === 'f') this.firework();
      else if (e.key === 'g') $('btn-guides').click();
      else return;
      this.syncButtons();
    });
  }

  undo(): void {
    const last = this.doc.visible().findLast((st) => this.mine.has(st.peer));
    if (!last) return this.toast('Nothing of yours to undo.');
    this.local({ k: 'e', targets: [opId(last)] });
  }

  clear(): void {
    const targets = this.doc.visible().map(opId);
    for (let i = 0; i < targets.length; i += LIMITS.targetsPerErase) {
      this.local({ k: 'e', targets: targets.slice(i, i + LIMITS.targetsPerErase) });
    }
  }

  toggleNight(): void {
    this.local({ k: 'n', on: !this.doc.night });
  }

  firework(at?: [number, number]): void {
    const r = Math.random;
    const b = { x: at?.[0] ?? Math.round(2500 + r() * 5000), y: at?.[1] ?? Math.round(2000 + r() * 4000), seed: Math.floor(r() * 0xffffffff) };
    this.board.burst(b);
    this.engine.burst(b);
  }

  sample(): void {
    for (const s of samplePattern()) this.local(s);
    this.toast('Added a sample rangoli. Draw around it, or undo it stroke by stroke.');
  }

  private async save(): Promise<void> {
    const blob = await this.board.snapshot();
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rangoli-${this.room}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  private async invite(): Promise<void> {
    const url = location.href;
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: 'Draw a rangoli with me', text: 'Join my Diwali rangoli board:', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      this.toast('Link copied. Anyone with it can draw on this board.');
    } catch {
      this.toast(`Share this link: ${url}`, 8000);
    }
  }

  private welcome(): void {
    const d = $<HTMLDialogElement>('welcome');
    d.addEventListener('close', () => {
      if (d.returnValue === 'sample' && this.doc.size === 0) this.sample();
    }, { once: true });
    d.showModal();
  }

  // ---- People, status, saving ---------------------------------------------------------

  private queuePeople(): void {
    if (this.peopleQueued) return;
    this.peopleQueued = true;
    requestAnimationFrame(() => {
      this.peopleQueued = false;
      this.renderPeople();
    });
  }

  renderPeople(): void {
    const now = Date.now();
    for (const [k, p] of this.people) if (now - p.at > 20000) this.people.delete(k);
    const count = Math.max(this.engine.peerCount(), this.people.size);
    $('status-text').textContent = count === 0 ? 'Just you · invite someone' : `${count + 1} drawing here`;
    $('status').classList.toggle('live', count > 0);
    const list = $('people');
    list.replaceChildren();
    const add = (name: string, you: boolean) => {
      const li = document.createElement('li');
      li.style.setProperty('--h', String(hueFor(name)));
      li.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="who"></span>`;
      li.querySelector('.who')!.textContent = you ? `${name} (you)` : name;
      list.appendChild(li);
    };
    add(this.name, true);
    for (const p of this.people.values()) add(p.name, false);
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      const ops = this.doc.all();
      if (!store.set(`rangoli:room:${this.room}`, JSON.stringify({ v: 1, ops })) && !this.saveWarned) {
        this.saveWarned = true;
        this.toast('This board is too big to keep in your browser. It stays in the room while someone has it open; save an image to keep a copy.', 7000);
      }
    }, 800);
  }

  private load(): void {
    const raw = store.get(`rangoli:room:${this.room}`);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as { v?: number; ops?: unknown[] };
      if (saved.v !== 1 || !Array.isArray(saved.ops)) return;
      for (const o of saved.ops) {
        const op = parseOp(o);
        if (op) this.doc.apply(op);
      }
    } catch {
      /* corrupt save: start empty */
    }
  }

  toast(text: string, ms = 3200): void {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.hidden = true), ms);
  }

  // ---- Animation ------------------------------------------------------------------------

  private loop(now: number): void {
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    if (!document.hidden) this.board.frame(now, dt);
    requestAnimationFrame((t) => this.loop(t));
  }
}
