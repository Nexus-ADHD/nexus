import { describe, it, expect } from 'vitest';
import {
  initialBreakdownOfferState,
  reduceBreakdownOffer,
  type BreakdownOfferState,
} from '../breakdown-offer-reducer';

const gen = (s: BreakdownOfferState) => reduceBreakdownOffer(s, { type: 'generate', grain: 'several' });
const resolved = (s: BreakdownOfferState, steps = ['a', 'b'], stepIds = ['1', '2']) =>
  reduceBreakdownOffer(s, { type: 'generate_resolved', steps, stepIds });

describe('reduceBreakdownOffer', () => {
  it('offered → generating on a grain tap (grain recorded, error cleared)', () => {
    const s = gen(initialBreakdownOfferState());
    expect(s.phase).toBe('generating');
    expect(s.grain).toBe('several');
  });

  it('ignores a second grain tap while generating (double-tap guard)', () => {
    const s = gen(initialBreakdownOfferState());
    expect(reduceBreakdownOffer(s, { type: 'generate', grain: 'fine' })).toBe(s);
  });

  it('generating → generated carries steps + stepIds', () => {
    const s = resolved(gen(initialBreakdownOfferState()));
    expect(s.phase).toBe('generated');
    expect(s.steps).toEqual(['a', 'b']);
    expect(s.stepIds).toEqual(['1', '2']);
  });

  it('an empty resolve is treated as a (no-blame) failure, back to offered', () => {
    const s = reduceBreakdownOffer(gen(initialBreakdownOfferState()), {
      type: 'generate_resolved',
      steps: [],
      stepIds: [],
    });
    expect(s.phase).toBe('offered');
    expect(s.error).toBe(true);
  });

  it('a stale resolve after undo is ignored (no resurrection / orphan rows)', () => {
    const generated = resolved(gen(initialBreakdownOfferState()));
    const reverted = reduceBreakdownOffer(generated, { type: 'undo' });
    expect(reverted.phase).toBe('reverted');
    // a late resolve lands now — must be dropped
    expect(reduceBreakdownOffer(reverted, { type: 'generate_resolved', steps: ['x'], stepIds: ['9'] })).toBe(
      reverted,
    );
  });

  it('generate_failed returns to offered with error; retry clears it', () => {
    const failed = reduceBreakdownOffer(gen(initialBreakdownOfferState()), { type: 'generate_failed' });
    expect(failed.phase).toBe('offered');
    expect(failed.error).toBe(true);
    expect(gen(failed).error).toBe(false); // fresh attempt clears
  });

  it('undo only applies to a generated row', () => {
    const offered = initialBreakdownOfferState();
    expect(reduceBreakdownOffer(offered, { type: 'undo' })).toBe(offered);
    const generating = gen(offered);
    expect(reduceBreakdownOffer(generating, { type: 'undo' })).toBe(generating);
  });
});
