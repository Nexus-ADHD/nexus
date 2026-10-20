/**
 * NEX-312 — the listening waveform's geometry.
 *
 * The trace REPLACES the words "I'm listening.", so its honesty matters more
 * than its looks: a frozen or absent trace would be a worse lie than the
 * sentence it replaced. These tests pin the two properties that protect that —
 * it never collapses to an invisible flat line, and it refuses to render at all
 * when the amplitude source cannot back it up.
 *
 * (Pure geometry only. The metering SOURCE is a device question and is not
 * simulated here; see the spike note in waveform-model.ts.)
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeDb,
  followLevel,
  pushLevel,
  idleHistory,
  barHeights,
  shouldShowWaveform,
  BAR_COUNT,
  IDLE_LEVEL,
  MIN_DB,
  ATTACK,
  RELEASE,
} from '../waveform-model';

describe('normalizeDb — real device values, not just the happy path', () => {
  it('maps the dBFS range onto 0..1', () => {
    expect(normalizeDb(0)).toBe(1);
    expect(normalizeDb(MIN_DB)).toBe(0);
    expect(normalizeDb(MIN_DB / 2)).toBeCloseTo(0.5, 5);
  });

  it('handles silence, clipping and the pre-first-sample gap', () => {
    expect(normalizeDb(-Infinity)).toBe(0); // true digital silence
    expect(normalizeDb(-200)).toBe(0);      // below the floor
    expect(normalizeDb(5)).toBe(1);         // clipping reports positive
    expect(normalizeDb(undefined)).toBe(0); // no sample yet
    expect(normalizeDb(null)).toBe(0);
    expect(normalizeDb(NaN)).toBe(0);
    expect(normalizeDb('loud')).toBe(0);
  });
});

describe('followLevel — asymmetric, because latency reads as "it did not hear me"', () => {
  it('rises faster than it falls', () => {
    const rise = followLevel(0, 1) - 0;
    const fall = 1 - followLevel(1, 0);
    expect(rise).toBeGreaterThan(fall);
    expect(rise).toBeCloseTo(ATTACK, 5);
    expect(fall).toBeCloseTo(RELEASE, 5);
  });

  it('converges toward the target and never overshoots', () => {
    let v = 0;
    for (let i = 0; i < 50; i++) v = followLevel(v, 1);
    expect(v).toBeGreaterThan(0.99);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('stays inside 0..1 for any garbage input', () => {
    for (const [p, n] of [[-5, 5], [NaN, 0.5], [0.5, NaN], [2, -2]] as const) {
      const out = followLevel(p as number, n as number);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
    }
  });
});

describe('pushLevel — a scrolling window, newest last', () => {
  it('appends and caps at size, dropping the oldest', () => {
    let h: number[] = [];
    for (let i = 0; i < BAR_COUNT + 10; i++) h = pushLevel(h, i / 100);
    expect(h).toHaveLength(BAR_COUNT);
    expect(h[h.length - 1]).toBeCloseTo((BAR_COUNT + 9) / 100, 5);
  });

  it('tolerates a garbage history', () => {
    expect(pushLevel(null as any, 0.5)).toEqual([0.5]);
    expect(pushLevel(undefined as any, 0.5)).toEqual([0.5]);
  });
});

describe('barHeights — never a flat dead line', () => {
  it('floors every bar at IDLE_LEVEL even in total silence', () => {
    const bars = barHeights(new Array(BAR_COUNT).fill(0));
    expect(bars).toHaveLength(BAR_COUNT);
    // A zero bar would read as "not listening", the exact anxiety this removes.
    for (const b of bars) expect(b).toBeGreaterThan(0);
  });

  it('left-pads a short history so the trace never grows in like a loading bar', () => {
    expect(barHeights([0.9])).toHaveLength(BAR_COUNT);
    expect(barHeights([])).toHaveLength(BAR_COUNT);
  });

  it('tapers toward the edges so it reads as a breath, not a chart', () => {
    const flat = new Array(BAR_COUNT).fill(1);
    const bars = barHeights(flat);
    const mid = Math.floor(BAR_COUNT / 2);
    expect(bars[mid]).toBeGreaterThan(bars[0]);
    expect(bars[mid]).toBeGreaterThan(bars[BAR_COUNT - 1]);
  });

  it('keeps every bar inside 0..1 whatever went in', () => {
    for (const b of barHeights([5, -5, NaN, Infinity, 0.5] as number[])) {
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
  });

  it('idleHistory is a full, at-rest buffer', () => {
    const h = idleHistory();
    expect(h).toHaveLength(BAR_COUNT);
    expect(new Set(h)).toEqual(new Set([IDLE_LEVEL]));
  });
});

describe('shouldShowWaveform — the text comes back the moment the trace cannot be honest', () => {
  const base = { listening: true, meteringAvailable: true, reduceMotion: false };

  it('shows only while listening WITH a live amplitude source', () => {
    expect(shouldShowWaveform(base)).toBe(true);
  });

  it('falls back to the words when not listening', () => {
    expect(shouldShowWaveform({ ...base, listening: false })).toBe(false);
  });

  it('falls back to the words when the metering tap is unavailable', () => {
    // This is the load-bearing case: the whole feature is a swap, so if the
    // source fails the sentence must return rather than leaving a dead trace.
    expect(shouldShowWaveform({ ...base, meteringAvailable: false })).toBe(false);
  });

  it('falls back to the words under Reduce Motion', () => {
    expect(shouldShowWaveform({ ...base, reduceMotion: true })).toBe(false);
  });
});
