import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/core/types';
import { parseMessage, parseOp } from '../src/core/wire';

const good = { k: 's', peer: 'abcdef12', seq: 3, lamport: 9, brush: 'diya', color: 2, size: 1, fold: 8, mirror: true, pts: [10, 20, 30, 40] };

describe('wire validation', () => {
  it('accepts a well-formed stroke and copies it', () => {
    const op = parseOp(good);
    expect(op).toEqual(good);
    expect(op).not.toBe(good);
  });

  it('drops unknown fields', () => {
    expect(parseOp({ ...good, extra: 'x' })).toEqual(good);
  });

  it.each([
    ['bad peer id', { ...good, peer: 'AB' }],
    ['seq 0', { ...good, seq: 0 }],
    ['fractional lamport', { ...good, lamport: 1.5 }],
    ['unknown brush', { ...good, brush: 'spray' }],
    ['colour out of range', { ...good, color: 8 }],
    ['fold not allowed', { ...good, fold: 7 }],
    ['odd number of coordinates', { ...good, pts: [1, 2, 3] }],
    ['point off the board', { ...good, pts: [1, 10_001] }],
    ['no points', { ...good, pts: [] }],
    ['too many points', { ...good, pts: new Array((LIMITS.pointsPerStroke + 1) * 2).fill(5) }],
    ['mirror not boolean', { ...good, mirror: 1 }],
  ])('rejects a stroke with %s', (_, x) => {
    expect(parseOp(x)).toBeNull();
  });

  it('validates erase targets', () => {
    const base = { k: 'e', peer: 'abcdef12', seq: 1, lamport: 1 };
    expect(parseOp({ ...base, targets: ['abcdef12/3'] })).not.toBeNull();
    expect(parseOp({ ...base, targets: [] })).toBeNull();
    expect(parseOp({ ...base, targets: ['abcdef12/0'] })).toBeNull();
    expect(parseOp({ ...base, targets: ['__proto__/1'] })).toBeNull();
  });

  it('keeps the valid operations of a message and drops the rest', () => {
    const m = parseMessage({ t: 'ops', ops: [good, { nope: 1 }, good] });
    expect(m?.t === 'ops' && m.ops.length).toBe(2);
  });

  it('cleans presence names and rejects half-specified cursors', () => {
    expect(parseMessage({ t: 'here', p: { peer: 'abcdef12', name: ' Kaju\u0007 Katli ', x: 5, y: 6 } })).toEqual({
      t: 'here',
      p: { peer: 'abcdef12', name: 'Kaju Katli', x: 5, y: 6 },
    });
    expect(parseMessage({ t: 'here', p: { peer: 'abcdef12', name: 'A', x: 5, y: null } })).toBeNull();
    expect(parseMessage({ t: 'here', p: { peer: 'abcdef12', name: 'A', x: null, y: null } })).not.toBeNull();
  });

  it('rejects a state vector that tries to set a prototype', () => {
    expect(parseMessage(JSON.parse('{"t":"sv","sv":{"__proto__":{"x":1}}}'))).toBeNull();
  });

  it('rejects unknown message types', () => {
    expect(parseMessage({ t: 'eval', code: 'alert(1)' })).toBeNull();
  });
});
