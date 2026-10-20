import { describe, expect, it } from 'vitest';
import { resolveMandateEcho } from '../mandate-echo';

// NEX-202: the echo resolves only for a user-confirmed link to a still-present,
// non-blank mandate. Anything else => null (silence beats a misquote).

const pillars = [
  { id: 'p1', title: 'I am someone who finishes what I start.' },
  { id: 'p2', title: '  I move my body\n every day.  ' },
  { id: 'p3', title: '   ' }, // blank-ish
];

describe('resolveMandateEcho (NEX-202)', () => {
  it('returns the echo when a confirmed link points at a present mandate', () => {
    const echo = resolveMandateEcho({ mandateEchoPillarId: 'p1' }, pillars);
    expect(echo).toEqual({ pillarId: 'p1', text: 'I am someone who finishes what I start.' });
  });

  it('collapses internal whitespace and newlines to a single line', () => {
    const echo = resolveMandateEcho({ mandateEchoPillarId: 'p2' }, pillars);
    expect(echo).toEqual({ pillarId: 'p2', text: 'I move my body every day.' });
  });

  it('returns null when the rule has no confirmed echo link', () => {
    expect(resolveMandateEcho({ mandateEchoPillarId: null }, pillars)).toBeNull();
    expect(resolveMandateEcho({ mandateEchoPillarId: undefined }, pillars)).toBeNull();
    expect(resolveMandateEcho({}, pillars)).toBeNull();
  });

  it('returns null when the linked mandate was deleted (stale guard)', () => {
    expect(resolveMandateEcho({ mandateEchoPillarId: 'gone' }, pillars)).toBeNull();
  });

  it('returns null when the linked mandate has a blank/whitespace-only title', () => {
    expect(resolveMandateEcho({ mandateEchoPillarId: 'p3' }, pillars)).toBeNull();
  });

  it('returns null for missing/!array inputs', () => {
    expect(resolveMandateEcho(null, pillars)).toBeNull();
    expect(resolveMandateEcho({ mandateEchoPillarId: 'p1' }, null)).toBeNull();
    expect(resolveMandateEcho({ mandateEchoPillarId: 'p1' }, undefined)).toBeNull();
  });
});
