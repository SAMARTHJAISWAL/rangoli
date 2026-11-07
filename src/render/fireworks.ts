import { rng } from '../core/rng';
import { PALETTE } from '../core/types';
import { shade } from './brushes';
import type { Burst } from '../core/wire';

/**
 * A firework burst, the same on every screen: particle directions, speeds and
 * colours all come from the burst's seed. Positions are computed in closed form
 * from the age, so a burst looks right at any frame rate.
 */
export interface Firework {
  x: number;
  y: number;
  born: number;
  particles: Float32Array; // vx, vy, colour index, size per particle
}

const COUNT = 150;
const LIFE = 2.2; // seconds
const DRAG = 1.6; // 1/s
const GRAVITY = 900; // board units / s²

export function makeFirework(b: Burst, now: number): Firework {
  const r = rng(b.seed);
  const colours = [Math.floor(r() * 7), Math.floor(r() * 7)];
  const p = new Float32Array(COUNT * 4);
  const ring = r() < 0.5;
  for (let i = 0; i < COUNT; i++) {
    const a = (i / COUNT) * Math.PI * 2 + r() * 0.08;
    const speed = ring ? 3300 + r() * 350 : 900 + r() * 3200;
    p[i * 4] = Math.cos(a) * speed;
    p[i * 4 + 1] = Math.sin(a) * speed;
    p[i * 4 + 2] = colours[i % 2]!;
    p[i * 4 + 3] = 34 + r() * 40;
  }
  return { x: b.x, y: b.y, born: now, particles: p };
}

export const alive = (f: Firework, now: number): boolean => now - f.born < LIFE;

function at(f: Firework, i: number, t: number): [number, number] {
  const k = (1 - Math.exp(-DRAG * t)) / DRAG;
  return [f.x + f.particles[i * 4]! * k, f.y + f.particles[i * 4 + 1]! * k + 0.5 * GRAVITY * t * t];
}

/** Draw in board units (the caller sets the transform). */
export function drawFirework(ctx: CanvasRenderingContext2D, f: Firework, now: number): void {
  const t = now - f.born;
  if (t < 0 || t >= LIFE) return;
  const fade = 1 - t / LIFE;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = 0; i < COUNT; i++) {
    const [x, y] = at(f, i, t);
    const [px, py] = at(f, i, Math.max(0, t - 0.12));
    const hex = PALETTE[f.particles[i * 4 + 2]!]?.hex ?? '#ffffff';
    const sparkle = 0.6 + 0.4 * Math.abs(Math.sin(t * 20 + i));
    const w = f.particles[i * 4 + 3]! * (0.4 + 0.6 * fade);
    // A coloured streak with a white-hot head.
    ctx.strokeStyle = shade(hex, 0.25);
    ctx.globalAlpha = fade * sparkle;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.fillStyle = '#fff6e0';
    ctx.globalAlpha = fade * sparkle * 0.9;
    ctx.beginPath();
    ctx.arc(x, y, w * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }
  // The flash at the centre.
  if (t < 0.25) {
    const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, 900);
    g.addColorStop(0, `rgba(255, 240, 200, ${0.8 * (1 - t / 0.25)})`);
    g.addColorStop(1, 'rgba(255, 200, 120, 0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(f.x - 900, f.y - 900, 1800, 1800);
  }
  ctx.restore();
}
