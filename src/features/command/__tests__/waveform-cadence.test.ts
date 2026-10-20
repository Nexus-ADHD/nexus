import { describe, it, expect } from 'vitest';
import { levelFromGrowth, idleBreath, nextWaveLevel, changeMagnitude, TICK_MS } from '../waveform-cadence';
import { IDLE_LEVEL } from '../waveform-model';

describe('levelFromGrowth', () => {
  it('returns 0 for no growth, negative growth, or non-finite input', () => {
    expect(levelFromGrowth(0)).toBe(0);
    expect(levelFromGrowth(-5)).toBe(0);
    expect(levelFromGrowth(NaN)).toBe(0);
    expect(levelFromGrowth(Infinity)).toBe(0); // non-finite guard fires first
  });

  it('lifts a single character off the floor but does not peg it', () => {
    const one = levelFromGrowth(1);
    expect(one).toBeGreaterThan(0.28);
    expect(one).toBeLessThan(0.5);
  });

  it('is monotonic in growth and saturates at 1', () => {
    expect(levelFromGrowth(2)).toBeGreaterThan(levelFromGrowth(1));
    expect(levelFromGrowth(6)).toBeGreaterThan(levelFromGrowth(3));
    expect(levelFromGrowth(1000)).toBe(1); // clamped
  });

  it('a normal spoken word (~5-6 chars/tick) lands in the expressive middle', () => {
    const word = levelFromGrowth(6);
    expect(word).toBeGreaterThan(0.6);
    expect(word).toBeLessThanOrEqual(1);
  });
});

describe('idleBreath', () => {
  it('stays within a gentle band just above idle for all ticks', () => {
    for (let t = 0; t < 200; t++) {
      const b = idleBreath(t);
      expect(b).toBeGreaterThanOrEqual(IDLE_LEVEL);
      expect(b).toBeLessThanOrEqual(IDLE_LEVEL + 0.06 + 1e-9);
    }
  });

  it('actually oscillates (not a constant)', () => {
    const vals = [0, 3, 6, 9, 12].map(idleBreath);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    expect(max - min).toBeGreaterThan(0.02);
  });

  it('tolerates a non-finite tick', () => {
    expect(Number.isFinite(idleBreath(NaN))).toBe(true);
    expect(idleBreath(NaN)).toBeGreaterThanOrEqual(IDLE_LEVEL);
  });
});

describe('nextWaveLevel', () => {
  it('always returns a value in 0..1', () => {
    for (let t = 0; t < 50; t++) {
      for (const g of [-3, 0, 1, 4, 20, NaN]) {
        const v = nextWaveLevel(Math.random(), g, t);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('rises fast toward a speech target (attack)', () => {
    // a burst of growth from a low level should jump most of the way in one step
    const v = nextWaveLevel(IDLE_LEVEL, 8, 1);
    expect(v).toBeGreaterThan(0.4);
  });

  it('never collapses below the idle breath during silence', () => {
    // decay from a high level with no growth: it settles toward the breath, not 0
    let level = 0.9;
    for (let t = 1; t <= 40; t++) {
      level = nextWaveLevel(level, 0, t);
      expect(level).toBeGreaterThanOrEqual(IDLE_LEVEL - 1e-9);
    }
    // after a long silence it is low (decayed) but still breathing, not pegged high
    expect(level).toBeLessThan(0.3);
  });

  it('speech pulls the level up above where pure silence would sit', () => {
    // same tick, same prev level: growth must not produce a LOWER level than silence
    const silent = nextWaveLevel(IDLE_LEVEL, 0, 5);
    const spoken = nextWaveLevel(IDLE_LEVEL, 6, 5);
    expect(spoken).toBeGreaterThan(silent);
  });
});

describe('changeMagnitude', () => {
  it('reports the change as the transcript lengthens', () => {
    const a = changeMagnitude(0, 5);
    expect(a).toEqual({ delta: 5, nextLen: 5 });
    const b = changeMagnitude(a.nextLen, 11);
    expect(b).toEqual({ delta: 6, nextLen: 11 });
  });

  it('pulses on a REVISION and does NOT suppress continued speech below an earlier peak', () => {
    // interim grows to 15, recognizer revises down to 5, user keeps speaking to 11
    const grow = changeMagnitude(0, 15);
    expect(grow.delta).toBe(15);
    const revise = changeMagnitude(grow.nextLen, 5); // correction
    expect(revise.delta).toBe(10); // activity, not zero
    const resume = changeMagnitude(revise.nextLen, 11); // 11 < earlier peak 15
    expect(resume.delta).toBe(6); // still registers — the monotonic-max bug is gone
  });

  it('settles to zero only when the transcript is stable (a real pause)', () => {
    const r = changeMagnitude(12, 12);
    expect(r.delta).toBe(0);
    expect(r.nextLen).toBe(12);
  });

  it('tolerates non-finite / negative inputs', () => {
    expect(changeMagnitude(NaN, 5)).toEqual({ delta: 5, nextLen: 5 });
    expect(changeMagnitude(10, NaN)).toEqual({ delta: 10, nextLen: 0 });
    expect(changeMagnitude(-3, -9)).toEqual({ delta: 0, nextLen: 0 });
  });
});

describe('TICK_MS', () => {
  it('is a sane sub-100ms cadence', () => {
    expect(TICK_MS).toBeGreaterThan(30);
    expect(TICK_MS).toBeLessThan(100);
  });
});
