import { describe, expect, it } from 'vitest';
import { rmsLevel } from './mic-meter';

describe('rmsLevel', () => {
  it('returns 0 for an empty buffer', () => {
    expect(rmsLevel(new Uint8Array(0))).toBe(0);
  });

  it('returns 0 for silence (all samples at center 128)', () => {
    expect(rmsLevel(new Uint8Array(512).fill(128))).toBe(0);
  });

  it('approaches 1 for a full-scale square wave', () => {
    const buf = new Uint8Array(512);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 2 ? 255 : 0;
    expect(rmsLevel(buf)).toBeGreaterThan(0.97);
  });

  it('scales with amplitude (half-scale DC offset → ~0.5)', () => {
    expect(rmsLevel(new Uint8Array(512).fill(192))).toBeCloseTo(0.5, 1);
  });
});
