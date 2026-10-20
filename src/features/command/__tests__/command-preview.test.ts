import { describe, expect, it } from 'vitest';
import { projectCommandPreview, applyPreviewDate } from '../command-preview';

// Wed 2026-06-17 (matches grammar-parser.test NOW). next Thursday (chrono) = next
// week's Thursday 2026-06-25; the this-coming Thursday is 2026-06-18.
const NOW = new Date(2026, 5, 17, 12, 0, 0);

describe('projectCommandPreview', () => {
  it('returns null for empty / whitespace / ungrammatical input', () => {
    expect(projectCommandPreview('', NOW)).toBeNull();
    expect(projectCommandPreview('   ', NOW)).toBeNull();
    expect(projectCommandPreview('asdfjkl qwerty', NOW)).toBeNull();
  });

  it('previews a confident habit with no date chips', () => {
    const p = projectCommandPreview('meditate every day', NOW);
    expect(p).not.toBeNull();
    expect(p!.action.type).toBe('recurring_add');
    expect(p!.destinationLabel).toBe('Orbit / Habits');
    expect(p!.dateCandidates).toBeNull();
    expect(p!.sourceText).toBe('meditate every day');
  });

  it('previews a non-ambiguous calendar write with no date chips', () => {
    const p = projectCommandPreview('add lunch to my calendar tomorrow at 12pm', NOW);
    expect(p).not.toBeNull();
    expect(p!.action.type).toBe('calendar_add');
    expect(p!.destinationLabel).toBe('Calendar');
    expect(p!.dateCandidates).toBeNull(); // tomorrow is unambiguous
  });

  it('offers two date chips for an ambiguous next-weekday calendar write', () => {
    const p = projectCommandPreview('add flag football to the calendar for next thursday at 11:30am', NOW);
    expect(p).not.toBeNull();
    expect(p!.action.type).toBe('calendar_add');
    expect(p!.dateCandidates).not.toBeNull();
    const [thisChip, nextChip] = p!.dateCandidates!;
    expect(thisChip.dateStr).toBe('2026-06-18'); // this-coming Thursday
    expect(nextChip.dateStr).toBe('2026-06-25'); // next week's Thursday
    expect(thisChip.label.startsWith('This Thursday')).toBe(true);
    expect(nextChip.label.startsWith('Next Thursday')).toBe(true);
  });

  it('returns null for a compound (multi-action) capture — those stay on the submit flow', () => {
    expect(projectCommandPreview('add to my inbox: call the bank, call the city', NOW)).toBeNull();
  });
});

describe('applyPreviewDate', () => {
  it('moves start/end to the chosen date, preserves time-of-day + duration, marks high', () => {
    const action = {
      type: 'calendar_add' as const,
      title: 'Flag football',
      startISO: '2026-06-25T11:30:00',
      endISO: '2026-06-25T12:30:00',
      confidence: 'medium' as const,
    };
    const patched = applyPreviewDate(action, '2026-06-18');
    expect(patched.startISO).toBe('2026-06-18T11:30:00');
    expect(patched.endISO).toBe('2026-06-18T12:30:00'); // 60-min duration preserved
    expect(patched.confidence).toBe('high');
    expect(patched.title).toBe('Flag football');
  });
});
