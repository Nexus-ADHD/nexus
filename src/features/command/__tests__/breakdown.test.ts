import { describe, it, expect } from 'vitest';
import {
  looksBreakable,
  parseBreakdownSteps,
  normalizeGrain,
  GRAIN,
  GRAIN_ORDER,
  DEFAULT_GRAIN,
  MAX_BREAKDOWN_STEPS,
} from '../breakdown';

describe('looksBreakable — OFFER gate', () => {
  it('fires on multi-word vagueness phrases', () => {
    for (const t of [
      'deal with the taxes',
      'figure out the move',
      'get my taxes sorted',
      'get the garage organized',
      'sort out the insurance stuff',
      'take care of the car situation',
      'clean out the storage closet',
    ]) {
      expect(looksBreakable(t)).toBe(true);
    }
  });
  it('fires on clear length even without a marker', () => {
    expect(looksBreakable('prepare the quarterly board deck and the budget summary')).toBe(true);
  });
  it('does NOT fire on short, concrete, or trap-word captures (no condescension)', () => {
    for (const t of [
      'call mom',
      'buy milk',
      'meal plan', // bare "plan" must NOT fire
      'plan B',
      'milk and eggs', // single "and" must NOT fire
      'email Sarah',
      'water the plants',
      'pay rent',
      // substring leaks that must NOT fire (marker phrases are whole-word only)
      'network on tuesday', // contains "work on"
      'homework online', // contains "work on"
      'firework on the 4th', // contains "work on"
      'get going to the gym', // "get … going" no longer a marker
    ]) {
      expect(looksBreakable(t)).toBe(false);
    }
  });
  it('handles empty / nullish', () => {
    expect(looksBreakable('')).toBe(false);
    expect(looksBreakable(null)).toBe(false);
    expect(looksBreakable(undefined)).toBe(false);
  });
});

describe('GRAIN', () => {
  it('maps few/several/fine to ascending counts; default is several', () => {
    expect(GRAIN.few).toBeLessThan(GRAIN.several);
    expect(GRAIN.several).toBeLessThan(GRAIN.fine);
    expect(GRAIN_ORDER).toEqual(['few', 'several', 'fine']);
    expect(DEFAULT_GRAIN).toBe('several');
    expect(GRAIN.fine).toBeLessThanOrEqual(MAX_BREAKDOWN_STEPS);
  });
});

describe('parseBreakdownSteps', () => {
  it('reads {steps:[]}', () => {
    expect(parseBreakdownSteps({ steps: ['Gather forms', 'Open the portal'] })).toEqual([
      'Gather forms',
      'Open the portal',
    ]);
  });
  it('reads a bare array and a newline string', () => {
    expect(parseBreakdownSteps(['A', 'B'])).toEqual(['A', 'B']);
    expect(parseBreakdownSteps('A\nB\n')).toEqual(['A', 'B']);
  });
  it('strips numbering/bullets/trailing bang, drops blanks + dupes', () => {
    expect(
      parseBreakdownSteps('1. Gather forms\n2) Gather forms\n- Open portal\n\n• Submit it!'),
    ).toEqual(['Gather forms', 'Open portal', 'Submit it']);
  });
  it('§18: defensively replaces em/en dashes (AI output lands in a title)', () => {
    expect(parseBreakdownSteps(['Call the bank — ask about fees'])).toEqual([
      'Call the bank - ask about fees',
    ]);
    expect(parseBreakdownSteps(['Draft 9–5 schedule'])).toEqual(['Draft 9 - 5 schedule']);
  });
  it('caps at max', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Step ${i}`);
    expect(parseBreakdownSteps(many, 5)).toHaveLength(5);
    expect(parseBreakdownSteps(many)).toHaveLength(MAX_BREAKDOWN_STEPS);
  });
  it('returns [] for junk / empty', () => {
    expect(parseBreakdownSteps(null)).toEqual([]);
    expect(parseBreakdownSteps({})).toEqual([]);
    expect(parseBreakdownSteps({ steps: [] })).toEqual([]);
    expect(parseBreakdownSteps(42)).toEqual([]);
  });
});

describe('normalizeGrain', () => {
  it('passes valid grains, defaults otherwise', () => {
    expect(normalizeGrain('few')).toBe('few');
    expect(normalizeGrain('fine')).toBe('fine');
    expect(normalizeGrain('bogus')).toBe(DEFAULT_GRAIN);
    expect(normalizeGrain(undefined)).toBe(DEFAULT_GRAIN);
  });
});
