import { describe, expect, it } from 'vitest';
import { copies, expand } from '../src/core/symmetry';
import { CENTRE } from '../src/core/types';

const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

describe('symmetry', () => {
  it('makes fold copies, doubled by mirroring', () => {
    for (const fold of [1, 4, 6, 8, 12]) {
      expect(expand([6000, 5000], fold, false)).toHaveLength(fold);
      expect(expand([6000, 5000], fold, true)).toHaveLength(copies(fold, true));
    }
  });

  it('rotates about the centre by 360°/fold', () => {
    const out = expand([CENTRE + 1000, CENTRE], 4, false);
    close(out[0]!, [CENTRE + 1000, CENTRE]);
    close(out[1]!, [CENTRE, CENTRE + 1000]);
    close(out[2]!, [CENTRE - 1000, CENTRE]);
    close(out[3]!, [CENTRE, CENTRE - 1000]);
  });

  it('keeps every copy at the same distance from the centre', () => {
    const p = [CENTRE + 321, CENTRE - 1234];
    const r = Math.hypot(321, 1234);
    for (const copy of expand(p, 12, true)) expect(Math.hypot(copy[0]! - CENTRE, copy[1]! - CENTRE)).toBeCloseTo(r, 6);
  });

  it('mirrors across the vertical axis', () => {
    const [orig, mirrored] = expand([CENTRE + 700, CENTRE + 200], 1, true);
    close(orig!, [CENTRE + 700, CENTRE + 200]);
    close(mirrored!, [CENTRE - 700, CENTRE + 200]);
  });
});
