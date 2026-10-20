import { describe, it, expect } from 'vitest';
import {
  reduceStructuredStart,
  initialStructuredStartState,
  formatRemaining,
  DURATION_PRESETS_MS,
  type StructuredStartState,
} from '../structured-start-machine';

const r = reduceStructuredStart;
const init = initialStructuredStartState;

// Walk to a given phase via the canonical happy path.
function stated(text = 'call the dentist'): StructuredStartState {
  return r(init(), { type: 'set_intention', text });
}
function reflecting(text = 'call the dentist'): StructuredStartState {
  return r(stated(text), { type: 'reflect' });
}
function offered(): StructuredStartState {
  return r(reflecting(), { type: 'offer_timer' });
}
function running(durationMs = 600_000): StructuredStartState {
  return r(offered(), { type: 'start_timer', durationMs });
}

describe('set_intention', () => {
  it('records the text in stating, no-ops elsewhere', () => {
    expect(stated('x').intention).toBe('x');
    // once reflecting, the intention is locked
    expect(r(reflecting('x'), { type: 'set_intention', text: 'y' }).intention).toBe('x');
  });
});

describe('reflect — guards a blank intention', () => {
  it('blocks empty / whitespace, allows non-blank', () => {
    expect(r(init(), { type: 'reflect' }).phase).toBe('stating'); // no intention
    expect(r(stated('   '), { type: 'reflect' }).phase).toBe('stating'); // whitespace only
    expect(reflecting('do the thing').phase).toBe('reflecting');
  });
});

describe('offer_timer / start_timer', () => {
  it('offer only from reflecting; start only from offer with a positive duration', () => {
    expect(offered().phase).toBe('timer_offer');
    expect(r(reflecting(), { type: 'start_timer', durationMs: 600_000 }).phase).toBe('reflecting'); // not from reflecting
    const run = running(600_000);
    expect(run.phase).toBe('running');
    expect(run.durationMs).toBe(600_000);
    expect(run.remainingMs).toBe(600_000);
    // non-positive duration ignored
    expect(r(offered(), { type: 'start_timer', durationMs: 0 }).phase).toBe('timer_offer');
    expect(r(offered(), { type: 'start_timer', durationMs: -5 }).phase).toBe('timer_offer');
  });
});

describe('tick — only while running, clamps, auto-finishes at zero', () => {
  it('decrements while running', () => {
    expect(r(running(), { type: 'tick', remainingMs: 540_000 }).remainingMs).toBe(540_000);
  });
  it('clamps a negative remaining and moves to done', () => {
    const s = r(running(), { type: 'tick', remainingMs: -200 });
    expect(s.phase).toBe('done');
    expect(s.remainingMs).toBe(0);
  });
  it('exactly zero → done', () => {
    expect(r(running(), { type: 'tick', remainingMs: 0 }).phase).toBe('done');
  });
  it('ignored when paused (no background drift past pause)', () => {
    const paused = r(running(), { type: 'pause' });
    const after = r(paused, { type: 'tick', remainingMs: 1000 });
    expect(after).toBe(paused); // unchanged reference
  });
});

describe('pause / resume', () => {
  it('pause only from running, resume only from paused; remaining preserved', () => {
    const run = r(running(), { type: 'tick', remainingMs: 300_000 });
    const paused = r(run, { type: 'pause' });
    expect(paused.phase).toBe('paused');
    expect(paused.remainingMs).toBe(300_000); // preserved across pause
    const resumed = r(paused, { type: 'resume' });
    expect(resumed.phase).toBe('running');
    expect(resumed.remainingMs).toBe(300_000);
    // invalid transitions no-op
    expect(r(run, { type: 'resume' })).toBe(run);
    expect(r(paused, { type: 'pause' })).toBe(paused);
  });
});

describe('finish — early "I am done"', () => {
  it('reaches done from running and from paused, nowhere else', () => {
    expect(r(running(), { type: 'finish' }).phase).toBe('done');
    expect(r(r(running(), { type: 'pause' }), { type: 'finish' }).phase).toBe('done');
    expect(r(reflecting(), { type: 'finish' }).phase).toBe('reflecting'); // no timer to finish
  });
});

describe('reset', () => {
  it('returns to the initial stating state', () => {
    expect(r(running(), { type: 'reset' })).toEqual(init());
  });
});

describe('formatRemaining', () => {
  it('M:SS, zero-padded seconds, never negative, null → 0:00', () => {
    expect(formatRemaining(null)).toBe('0:00');
    expect(formatRemaining(0)).toBe('0:00');
    expect(formatRemaining(-5000)).toBe('0:00');
    expect(formatRemaining(9000)).toBe('0:09');
    expect(formatRemaining(59_000)).toBe('0:59');
    expect(formatRemaining(60_000)).toBe('1:00');
    expect(formatRemaining(600_000)).toBe('10:00');
    expect(formatRemaining(1_500_000)).toBe('25:00');
  });
});

describe('DURATION_PRESETS_MS', () => {
  it('is the calm 10/25/50-minute set, ascending', () => {
    expect(DURATION_PRESETS_MS).toEqual([600_000, 1_500_000, 3_000_000]);
    const sorted = [...DURATION_PRESETS_MS].sort((a, b) => a - b);
    expect(DURATION_PRESETS_MS).toEqual(sorted);
  });
});
