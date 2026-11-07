import { rng } from '../core/rng';
import { CENTRE, SIZE, opId, type StrokeOp } from '../core/types';
import { diyaSpots, drawFlame, drawStroke, forget, setSymmetry, width, type DiyaSpot, type StrokeLike } from './brushes';
import { alive, drawFirework, makeFirework, type Firework } from './fireworks';
import type { Burst } from '../core/wire';

export interface Cursor {
  name: string;
  hue: number;
  x: number;
  y: number;
}

/**
 * Two stacked canvases. `base` holds the floor and every finished stroke and is
 * only redrawn when the picture changes. `fx` is redrawn every frame: strokes in
 * progress, the night overlay, glowing flames, fireworks and other people's cursors.
 */
export class Board {
  readonly base: HTMLCanvasElement;
  readonly fx: HTMLCanvasElement;
  private readonly bctx: CanvasRenderingContext2D;
  private readonly fctx: CanvasRenderingContext2D;
  /** Pixels per board unit (device pixels). */
  private scale = 0.1;
  private px = 0;
  private spots: DiyaSpot[] = [];
  private fireworks: Firework[] = [];
  private nightLevel = 0;
  guides = true;
  night = false;
  /** Strokes being drawn right now, by anyone. */
  readonly live = new Map<string, StrokeLike & { at: number }>();
  readonly cursors = new Map<string, Cursor & { at: number }>();
  /** The local pointer, for the symmetry preview. */
  pointer: { x: number; y: number; fold: number; mirror: boolean } | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly strokes: () => readonly StrokeOp[],
  ) {
    this.base = el.querySelector<HTMLCanvasElement>('#base')!;
    this.fx = el.querySelector<HTMLCanvasElement>('#fx')!;
    this.bctx = this.base.getContext('2d')!;
    this.fctx = this.fx.getContext('2d')!;
  }

  /** Fit the board to its container; returns true if the size changed. */
  resize(): boolean {
    const rect = this.el.getBoundingClientRect();
    const css = Math.floor(Math.min(rect.width, rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const px = Math.max(64, Math.min(4096, Math.round(css * dpr)));
    if (px === this.px) return false;
    this.px = px;
    for (const c of [this.base, this.fx]) {
      c.width = px;
      c.height = px;
      c.style.width = `${css}px`;
      c.style.height = `${css}px`;
    }
    this.scale = px / SIZE;
    this.redraw();
    return true;
  }

  /** Board units from a pointer event's client coordinates. */
  toBoard(clientX: number, clientY: number): [number, number] {
    const r = this.fx.getBoundingClientRect();
    const x = ((clientX - r.left) / r.width) * SIZE;
    const y = ((clientY - r.top) / r.height) * SIZE;
    return [Math.round(Math.min(SIZE, Math.max(0, x))), Math.round(Math.min(SIZE, Math.max(0, y)))];
  }

  /** Full redraw of the floor and every finished stroke. */
  redraw(): void {
    const ctx = this.bctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.floor(ctx);
    this.spots = [];
    for (const s of this.strokes()) this.paint(s);
  }

  /** Draw one more finished stroke on top. */
  append(s: StrokeOp): void {
    this.paint(s);
  }

  forgetStroke(id: string): void {
    forget(id);
  }

  burst(b: Burst): void {
    if (this.fireworks.length >= 12) return; // a sky can only hold so many
    this.fireworks.push(makeFirework(b, performance.now() / 1000));
  }

  private paint(op: StrokeOp): void {
    const s: StrokeLike = { ...op, id: opId(op) };
    drawStroke(this.bctx, s, this.scale);
    this.bctx.setTransform(1, 0, 0, 1, 0, 0);
    if (s.brush === 'diya') this.spots.push(...diyaSpots(s));
  }

  /** The floor: warm sandstone with a little grain, plus faint guide rings and kolam dots. */
  private floor(ctx: CanvasRenderingContext2D): void {
    const k = this.scale;
    const g = ctx.createRadialGradient(this.px / 2, this.px / 2, 0, this.px / 2, this.px / 2, this.px * 0.72);
    g.addColorStop(0, '#f1dcc0');
    g.addColorStop(0.7, '#e3c39c');
    g.addColorStop(1, '#c99e74');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.px, this.px);
    const r = rng(7);
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = r() < 0.5 ? 'rgba(120, 72, 36, 0.07)' : 'rgba(255, 248, 235, 0.12)';
      const s = (1 + r() * 2.2) * Math.max(1, this.px / 900);
      ctx.fillRect(r() * this.px, r() * this.px, s, s);
    }
    if (!this.guides) return;
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.strokeStyle = 'rgba(122, 70, 36, 0.16)';
    ctx.lineWidth = 12;
    for (let rad = 600; rad < CENTRE; rad += 600) {
      ctx.beginPath();
      ctx.arc(CENTRE, CENTRE, rad, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([40, 60]);
    for (let a = 0; a < 8; a++) {
      ctx.beginPath();
      ctx.moveTo(CENTRE, CENTRE);
      ctx.lineTo(CENTRE + Math.cos((a * Math.PI) / 4) * CENTRE * 0.98, CENTRE + Math.sin((a * Math.PI) / 4) * CENTRE * 0.98);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(122, 70, 36, 0.22)';
    for (let x = 400; x < SIZE; x += 600) {
      for (let y = 400; y < SIZE; y += 600) {
        ctx.beginPath();
        ctx.arc(x, y, 22, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** Draw one animation frame of the effects layer. */
  frame(nowMs: number, dt: number): void {
    const ctx = this.fctx;
    const t = nowMs / 1000;
    const k = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.px, this.px);

    // Strokes in progress (expire if their author went quiet).
    for (const [id, s] of this.live) {
      if (nowMs - s.at > 6000) {
        this.live.delete(id);
        continue;
      }
      // Previews have their own geometry cache entry: the finished stroke is always computed from
      // scratch, so a made-up preview can never change how a real stroke looks.
      if (s.pts.length >= 2) drawStroke(ctx, { ...s, key: `live:${id}` }, k);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Night: ease the darkness in and out.
    const target = this.night ? 1 : 0;
    this.nightLevel += (target - this.nightLevel) * Math.min(1, dt * 3);
    if (Math.abs(this.nightLevel - target) < 0.002) this.nightLevel = target;
    const night = this.nightLevel;

    const spots = this.spots.slice();
    for (const [id, s] of this.live) if (s.brush === 'diya') spots.push(...diyaSpots({ ...s, key: `live:${id}` }));
    const flames = spots.map((d) => ({ x: d.x + 1.12 * d.s, y: d.y - 0.5 * d.s, d }));

    if (night > 0) {
      // Darkness with a pool of light cut out around every flame, so the lamps
      // light up the colours near them instead of washing over everything.
      const shade = this.shadeCanvas();
      const sc = shade.getContext('2d')!;
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.globalCompositeOperation = 'source-over';
      sc.clearRect(0, 0, this.px, this.px);
      sc.fillStyle = `rgba(14, 8, 32, ${0.8 * night})`;
      sc.fillRect(0, 0, this.px, this.px);
      sc.setTransform(k, 0, 0, k, 0, 0);
      sc.globalCompositeOperation = 'destination-out';
      for (const f of flames) {
        const flick = 1 + 0.05 * Math.sin(t * 7.3 + f.d.phase) + 0.03 * Math.sin(t * 17.1 + f.d.phase * 2);
        const radius = f.d.s * 4.6 * flick;
        const g = sc.createRadialGradient(f.x, f.y, 0, f.x, f.y, radius);
        g.addColorStop(0, 'rgba(0, 0, 0, 0.9)');
        g.addColorStop(0.35, 'rgba(0, 0, 0, 0.42)');
        g.addColorStop(1, 'rgba(0, 0, 0, 0)');
        sc.fillStyle = g;
        sc.fillRect(f.x - radius, f.y - radius, radius * 2, radius * 2);
      }
      ctx.drawImage(shade, 0, 0);
    }

    // A warm halo at each flame, stronger at night.
    ctx.save();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    for (const f of flames) {
      const radius = f.d.s * (1.4 + 1.4 * night);
      const glow = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, radius);
      glow.addColorStop(0, `rgba(255, 196, 110, ${0.28 + 0.3 * night})`);
      glow.addColorStop(1, 'rgba(255, 130, 40, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(f.x - radius, f.y - radius, radius * 2, radius * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const d of spots) drawFlame(ctx, d.x + 1.12 * d.s, d.y - 0.42 * d.s, d.s * 0.55, t, d.phase);
    ctx.restore();

    // Fireworks.
    this.fireworks = this.fireworks.filter((f) => alive(f, t));
    if (this.fireworks.length) {
      ctx.save();
      ctx.setTransform(k, 0, 0, k, 0, 0);
      for (const f of this.fireworks) drawFirework(ctx, f, t);
      ctx.restore();
    }

    // Where the local pointer's copies will land.
    if (this.pointer && this.pointer.fold > 1) {
      ctx.save();
      for (let i = 0; i < this.pointer.fold; i++) {
        for (const flip of this.pointer.mirror ? [false, true] : [false]) {
          setSymmetry(ctx, k, (2 * Math.PI * i) / this.pointer.fold, flip);
          ctx.beginPath();
          ctx.arc(this.pointer.x, this.pointer.y, 34, 0, Math.PI * 2);
          ctx.fillStyle = night > 0.5 ? 'rgba(255, 230, 190, 0.5)' : 'rgba(90, 40, 20, 0.35)';
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Other people's cursors.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const font = Math.max(11, Math.round(this.px / 70));
    ctx.font = `600 ${font}px Hind, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    for (const [id, c] of this.cursors) {
      if (nowMs - c.at > 15000) {
        this.cursors.delete(id);
        continue;
      }
      const x = c.x * k;
      const y = c.y * k;
      ctx.beginPath();
      ctx.arc(x, y, font * 0.42, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${c.hue} 80% 52%)`;
      ctx.fill();
      ctx.lineWidth = font * 0.14;
      ctx.strokeStyle = '#fff8ec';
      ctx.stroke();
      const label = c.name;
      const w = ctx.measureText(label).width + font * 0.9;
      ctx.fillStyle = `hsl(${c.hue} 70% 32% / 0.92)`;
      roundRect(ctx, x + font * 0.7, y - font * 0.75, w, font * 1.5, font * 0.4);
      ctx.fill();
      ctx.fillStyle = '#fff8ec';
      ctx.fillText(label, x + font * 1.15, y + 1);
    }
  }

  private shade: HTMLCanvasElement | null = null;

  private shadeCanvas(): HTMLCanvasElement {
    if (!this.shade) this.shade = document.createElement('canvas');
    if (this.shade.width !== this.px) {
      this.shade.width = this.px;
      this.shade.height = this.px;
    }
    return this.shade;
  }

  /** The board as a PNG blob, including the night overlay and flames. */
  async snapshot(): Promise<Blob | null> {
    const c = document.createElement('canvas');
    c.width = this.px;
    c.height = this.px;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(this.base, 0, 0);
    ctx.drawImage(this.fx, 0, 0);
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }

  brushRadius(s: { size: number }): number {
    return width(s) / 2;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
