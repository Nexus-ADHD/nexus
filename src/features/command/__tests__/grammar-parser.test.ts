import { describe, expect, it } from 'vitest';
import {
  parseCaptureGrammar,
  stripCaptureFraming,
  normalizeAiTitle,
  CAPTURE_FRAMING_PREFIXES,
} from '../grammar-parser';
import { resolveCaptureTier, hasExplicitDate, hasExplicitTime } from '../confidence-tier';
import type { ProposedAction } from '../../../utils/recurrence';

// Fixed clock: Wed 2026-06-17 12:00 local (getDay() === 3). Deterministic dates:
//   today = 2026-06-17, tomorrow = 2026-06-18, next Friday = 2026-06-19,
//   next Saturday = 2026-06-20.
const NOW = new Date(2026, 5, 17, 12, 0, 0);

function one(result: ProposedAction[] | null): ProposedAction {
  expect(result).not.toBeNull();
  expect(result).toHaveLength(1);
  return (result as ProposedAction[])[0];
}

describe('parseCaptureGrammar — recurring_add (habit, cadence only)', () => {
  it('"add a new habit: meditation daily" → every-day habit', () => {
    const a = one(parseCaptureGrammar('add a new habit: meditation daily', NOW));
    expect(a.type).toBe('recurring_add');
    expect(a.title).toBe('Meditation');
    expect(a.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('"create a habit to read my mantras twice a day" → timesPerDay 2', () => {
    const a = one(parseCaptureGrammar('create a habit to read my mantras twice a day', NOW));
    expect(a.title).toBe('Read my mantras');
    expect(a.timesPerDay).toBe(2);
    expect(a.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('cadence + identity verb ("meditate every morning") → habit with a time block', () => {
    const a = one(parseCaptureGrammar('meditate every morning', NOW));
    expect(a.type).toBe('recurring_add');
    expect(a.title).toBe('Meditate');
    expect(a.preferredTimeBlock).toBe('morning');
    expect(a.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('"go to the gym daily" → habit', () => {
    expect(one(parseCaptureGrammar('go to the gym daily', NOW)).title).toBe('Go to the gym');
  });

  it('"add a habit stretching" → empty days flagged for the chip', () => {
    const a = one(parseCaptureGrammar('add a habit stretching', NOW));
    expect(a.title).toBe('Stretching');
    expect(a.daysOfWeek).toEqual([]);
    expect(a.missingFields).toEqual(['daysOfWeek']);
  });

  it('"on weekends" / plural "<weekday>s" / abbrev "every fri" cadences', () => {
    expect(one(parseCaptureGrammar('exercise on weekends', NOW)).daysOfWeek).toEqual([0, 6]);
    expect(one(parseCaptureGrammar('meditate fridays', NOW)).daysOfWeek).toEqual([5]);
    const fri = one(parseCaptureGrammar('meditate every fri', NOW));
    expect(fri.title).toBe('Meditate');
    expect(fri.daysOfWeek).toEqual([5]);
  });

  it('boundaries: chores, intervals, and clock-bearing habits defer to AI', () => {
    expect(parseCaptureGrammar('take out the trash every day', NOW)).toBeNull();
    expect(parseCaptureGrammar('submit invoices every friday', NOW)).toBeNull();
    expect(parseCaptureGrammar('read every other friday', NOW)).toBeNull();
    expect(parseCaptureGrammar('meditate at 6am every day', NOW)).toBeNull(); // clock → AI
  });

  it('boundary: cessation / "break the habit" wording is NOT a new habit → AI', () => {
    expect(parseCaptureGrammar('quit smoking habit', NOW)).toBeNull();
    expect(parseCaptureGrammar('break the habit of scrolling', NOW)).toBeNull();
    expect(parseCaptureGrammar('reduce screen time habit', NOW)).toBeNull();
    expect(parseCaptureGrammar('i have a bad habit of biting nails', NOW)).toBeNull();
  });

  it('boundary: a one-off time-of-day with "habit" defers (not a recurring routine)', () => {
    // "this morning" is one-off, not "every morning" — must not become a timed habit.
    expect(parseCaptureGrammar('add a habit meditate this morning', NOW)).toBeNull();
    expect(parseCaptureGrammar('add a habit read in the evening', NOW)).toBeNull();
    // the recurring form still fires with a block:
    expect(one(parseCaptureGrammar('meditate every morning', NOW)).preferredTimeBlock).toBe('morning');
  });
});

describe('parseCaptureGrammar — todo_add (date only, no time)', () => {
  it('"pick up dry cleaning friday" → next Friday, no time', () => {
    const a = one(parseCaptureGrammar('pick up dry cleaning friday', NOW));
    expect(a.type).toBe('todo_add');
    expect(a.title).toBe('Pick up dry cleaning');
    expect(a.dateStr).toBe('2026-06-19');
    expect(a.time).toBeUndefined();
  });

  it('weekday resolves to TODAY when today is that weekday', () => {
    expect(one(parseCaptureGrammar('email the team wednesday', NOW)).dateStr).toBe('2026-06-17');
  });

  it('"tonight" resolves to today (a supported date token), title cleaned', () => {
    const a = one(parseCaptureGrammar('help with dinner tonight', NOW));
    expect(a.type).toBe('todo_add');
    expect(a.title).toBe('Help with dinner');
    expect(a.dateStr).toBe('2026-06-17');
  });

  it('"finish report by friday" / "pick up milk on saturday" — trailing connector stripped', () => {
    expect(one(parseCaptureGrammar('finish report by friday', NOW)).title).toBe('Finish report');
    const milk = one(parseCaptureGrammar('pick up milk on saturday', NOW));
    expect(milk.title).toBe('Pick up milk');
    expect(milk.dateStr).toBe('2026-06-20');
  });

  it('keeps a duration in the title (no clock present)', () => {
    const a = one(parseCaptureGrammar('workout for 1 hour tomorrow', NOW));
    expect(a.type).toBe('todo_add');
    expect(a.title).toBe('Workout for 1 hour');
    expect(a.dateStr).toBe('2026-06-18');
  });

  it('boundaries: an AMBIGUOUS clock, a time-of-day, or an appointment → AI', () => {
    expect(parseCaptureGrammar('call the bank tomorrow at 3', NOW)).toBeNull(); // bare ambiguous clock
    expect(parseCaptureGrammar('send report tomorrow by 3', NOW)).toBeNull(); // connector bare clock
    expect(parseCaptureGrammar('call the bank tomorrow at 3:30', NOW)).toBeNull(); // colon, no meridiem, 1-12 → ambiguous
    expect(parseCaptureGrammar('dentist tomorrow', NOW)).toBeNull(); // appointment noun
  });
});

// NEX-316: "next <weekday>" is now resolved offline (chrono) instead of punted.
// NOW = Wed 2026-06-17. chrono reads "next <weekday>" as the weekday of NEXT week
// (not the same-week coming one), so "next friday" → 2026-06-26 — the very
// this-coming-vs-following ambiguity that gates the irreversible calendar path.
describe('parseCaptureGrammar — next <weekday> resolution (NEX-316)', () => {
  it('a reversible to-do takes the resolved next-weekday date directly (strips "next friday")', () => {
    const a = one(parseCaptureGrammar('submit report next friday', NOW));
    expect(a.type).toBe('todo_add');
    expect(a.title).toBe('Submit report');
    expect(a.dateStr).toBe('2026-06-26'); // chrono: Friday of next week
  });

  it('an IRREVERSIBLE calendar write off an ambiguous next-weekday is medium, not a silent high write', () => {
    const grammar = parseCaptureGrammar('add flag football to the calendar for next thursday at 11:30am', NOW);
    const a = one(grammar);
    expect(a.type).toBe('calendar_add');
    expect(a.title).toBe('Flag football'); // "to the calendar", "for", "next thursday", "at 11:30am" all stripped
    expect(a.confidence).toBe('medium'); // ambiguous → not auto-executed
    // The tier gate captures a non-high calendar_add to a VISIBLE Inbox item (Law A),
    // never a silent EventKit write of the guessed date, and never "I couldn't sort that".
    const res = resolveCaptureTier(grammar!, 'add flag football to the calendar for next thursday at 11:30am', NOW);
    expect(res.tier).toBe('high'); // the inbox capture itself is high-ready
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0].type).toBe('inbox_add');
    expect(res.actions[0].title).toBe('Flag football');
  });

  it('a non-ambiguous calendar date (tomorrow) still writes directly at high', () => {
    const a = one(parseCaptureGrammar('add lunch to my calendar tomorrow at 12pm', NOW));
    expect(a.type).toBe('calendar_add');
    expect(a.confidence).toBe('high');
  });
});

describe('parseCaptureGrammar — clock resolution (NEX-258)', () => {
  it('clock + explicit date → todo_add{dateStr, time}, title strips both (either order)', () => {
    const a = one(parseCaptureGrammar('remind me to call mom tomorrow at 10pm', NOW));
    expect(a.type).toBe('todo_add');
    expect(a.title).toBe('Call mom');
    expect(a.dateStr).toBe('2026-06-18');
    expect(a.time).toBe('22:00');
    // reversed order strips both too
    const b = one(parseCaptureGrammar('call mom at 10pm tomorrow', NOW));
    expect(b.title).toBe('Call mom');
    expect(b.dateStr).toBe('2026-06-18');
    expect(b.time).toBe('22:00');
  });

  it('resolves the unambiguous forms', () => {
    expect(one(parseCaptureGrammar('pay rent friday at noon', NOW)).time).toBe('12:00');
    expect(one(parseCaptureGrammar('backup at midnight tomorrow', NOW)).time).toBe('00:00');
    expect(one(parseCaptureGrammar('standup tomorrow at 15:30', NOW)).time).toBe('15:30');
    expect(one(parseCaptureGrammar('call mom tomorrow at 9:00pm', NOW)).time).toBe('21:00'); // single token, not double-counted
    expect(one(parseCaptureGrammar('file taxes tomorrow at 12pm', NOW)).time).toBe('12:00'); // 12pm → noon
    expect(one(parseCaptureGrammar('log day tomorrow at 12am', NOW)).time).toBe('00:00'); // 12am → midnight
    const at = one(parseCaptureGrammar('call mom @ 3pm tomorrow', NOW)); // "@" + meridiem still RESOLVES (not over-deferred)
    expect(at.time).toBe('15:00');
    expect(at.title).toBe('Call mom'); // no "@ 3pm" left in title
  });

  it('clock with NO date → time-only todo (no dateStr) for the When? chip', () => {
    const a = one(parseCaptureGrammar('remind me to take meds at 10pm', NOW));
    expect(a.type).toBe('todo_add');
    expect(a.title).toBe('Take meds');
    expect(a.time).toBe('22:00');
    expect(a.dateStr).toBeUndefined();
  });

  it('time-only todo flows through resolveCaptureTier to the one-tap "When?" chip, preserving time', () => {
    const res = resolveCaptureTier(
      parseCaptureGrammar('remind me to take meds at 10pm', NOW) as ProposedAction[],
      'remind me to take meds at 10pm',
      NOW,
    );
    expect(res.tier).toBe('medium');
    expect(res.clarification?.fieldKey).toBe('date');
    // patching the date keeps the resolved time
    const patched = { ...res.actions[0], ...res.clarification!.chips[0].patch };
    expect(patched.time).toBe('22:00');
    expect(patched.dateStr).toBeTruthy();
  });

  it('still defers: ambiguous, mid-title, multiple, time-of-day, appointment clocks', () => {
    expect(parseCaptureGrammar('call the bank at 3', NOW)).toBeNull(); // ambiguous bare hour
    expect(parseCaptureGrammar('call mom @ 3 tomorrow', NOW)).toBeNull(); // ambiguous "@" clock — hasClock must catch it (no "@ 3" left in title)
    expect(parseCaptureGrammar('watch the 7pm show tomorrow', NOW)).toBeNull(); // mid-title clock
    expect(parseCaptureGrammar('ping team at 9am or 5pm tomorrow', NOW)).toBeNull(); // two clocks
    expect(parseCaptureGrammar('read Midnight Library tomorrow', NOW)).toBeNull(); // stray clock word mid-title
    expect(parseCaptureGrammar('dentist tomorrow at 9am', NOW)).toBeNull(); // appointment noun + clock
  });

  it('does not strip a non-clock trailing number from the title', () => {
    const a = one(parseCaptureGrammar('buy 3 apples tomorrow', NOW));
    expect(a.title).toBe('Buy 3 apples');
    expect(a.dateStr).toBe('2026-06-18');
    expect(a.time).toBeUndefined();
  });

  it('strips a trailing bare 24h clock (resolver↔stripper parity, no connector)', () => {
    const a = one(parseCaptureGrammar('standup 15:30', NOW));
    expect(a.type).toBe('todo_add');
    expect(a.time).toBe('15:30');
    expect(a.title).toBe('Standup'); // clock must NOT be left in the title
    expect(a.dateStr).toBeUndefined();
  });

  it('strips a comma left between a clock and a date token', () => {
    const a = one(parseCaptureGrammar('call mom at 10pm, tomorrow', NOW));
    expect(a.time).toBe('22:00');
    expect(a.dateStr).toBe('2026-06-18');
    expect(a.title).toBe('Call mom'); // no dangling "at 10pm," in the title
  });

  it('strips by/around connectors on word-clocks (resolver↔stripper parity)', () => {
    const a = one(parseCaptureGrammar('pay rent by noon friday', NOW));
    expect(a.time).toBe('12:00');
    expect(a.dateStr).toBe('2026-06-19');
    expect(a.title).toBe('Pay rent'); // not "Pay rent by"
  });
});

describe('parseCaptureGrammar — inbox_add (framing, no schedule)', () => {
  it('"set a reminder to spray the wash deck" → inbox, title stripped', () => {
    const a = one(parseCaptureGrammar('set a reminder to spray the wash deck', NOW));
    expect(a.type).toBe('inbox_add');
    expect(a.title).toBe('Spray the wash deck');
  });

  it('boundary: a framed VAGUE time-of-day capture defers to AI (so it can schedule/ask)', () => {
    expect(parseCaptureGrammar('remind me to call the bank this afternoon', NOW)).toBeNull();
    // NEX-258: a framed capture with an UNAMBIGUOUS clock now resolves offline as
    // a time-only todo (was deferred); see the clock-resolution suite above.
    const a = one(parseCaptureGrammar('remind me to call the bank at 3pm', NOW));
    expect(a.type).toBe('todo_add');
    expect(a.title).toBe('Call the bank');
    expect(a.time).toBe('15:00');
  });

  it('boundary: a bare brain-dump with no framing defers to AI (align inference)', () => {
    expect(parseCaptureGrammar('think about Q1 strategy', NOW)).toBeNull();
  });
});

describe('parseCaptureGrammar — calendar_add (NEX-241, explicit calendar + date + time)', () => {
  it('explicit calendar phrase + date + unambiguous clock → calendar_add with exact local ISO', () => {
    const r = parseCaptureGrammar('add standup to my calendar tomorrow at 9am', NOW)!;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      type: 'calendar_add',
      title: 'Standup', // "add" verb + "to my calendar" + "tomorrow at 9am" all stripped
      startISO: '2026-06-18T09:00:00',
      endISO: '2026-06-18T10:00:00', // default 60-min
      confidence: 'high',
    });
    expect(r[0].startISO).not.toMatch(/Z/); // naive-local, never UTC
  });

  it('"calendar" (no "my"), weekday date, noon, with a duration', () => {
    const r = parseCaptureGrammar('schedule lunch with Sam on my calendar friday at noon for 90 minutes', NOW)!;
    expect(r[0]).toMatchObject({
      type: 'calendar_add',
      title: 'Lunch with Sam',
      startISO: '2026-06-19T12:00:00', // Fri after Wed 6/17
      endISO: '2026-06-19T13:30:00', // 90 min
    });
  });

  it('defers (→ AI) on no time, no date, ambiguous/multiple clocks, or "habit"', () => {
    expect(parseCaptureGrammar('put it on my calendar', NOW)).toBeNull(); // no date/time
    expect(parseCaptureGrammar('add dentist to my calendar tomorrow', NOW)).toBeNull(); // no time
    expect(parseCaptureGrammar('add review to my calendar tomorrow at 3', NOW)).toBeNull(); // ambiguous clock
    expect(parseCaptureGrammar('block on my calendar tomorrow at 3pm at noon', NOW)).toBeNull(); // two clocks
    expect(parseCaptureGrammar('add a habit to my calendar tomorrow at 9am', NOW)).toBeNull(); // "habit" wins → AI
    expect(parseCaptureGrammar('the 7pm panel on my calendar tomorrow', NOW)).toBeNull(); // mid-title clock, no schedule time
  });

  it('defers a RECURRING calendar utterance → AI (so it emits calendar_add with recurrence)', () => {
    // A recurring cadence means a REPEATING event; the offline grammar never
    // builds recurrence, so it must defer rather than write a wrong one-off.
    expect(parseCaptureGrammar('add a workout to my calendar every sunday at 10am', NOW)).toBeNull();
    expect(parseCaptureGrammar('block a run on my calendar every weekday at 6am', NOW)).toBeNull();
    expect(parseCaptureGrammar('add a check-in to my calendar every day at 9pm', NOW)).toBeNull();
    // A one-off explicit-calendar utterance still resolves offline (not over-deferred).
    expect(one(parseCaptureGrammar('add standup to my calendar tomorrow at 9am', NOW)).type).toBe(
      'calendar_add'
    );
  });

  it('NEVER writes a PAST event — a passed clock today defers to the AI', () => {
    // NOW is 2026-06-17 12:00. "today at 9am" is in the past → defer.
    expect(parseCaptureGrammar('add sync to my calendar today at 9am', NOW)).toBeNull();
    // A still-future today clock fires.
    const r = parseCaptureGrammar('add sync to my calendar today at 3pm', NOW)!;
    expect(r[0]).toMatchObject({ type: 'calendar_add', startISO: '2026-06-17T15:00:00' });
  });

  it('duration out of range falls back to 60-min (never start === end)', () => {
    for (const phrase of [
      'add x to my calendar tomorrow at 9am for 13 hours',
      'add x to my calendar tomorrow at 9am for 0 minutes',
      'add x to my calendar tomorrow at 9am for 999 minutes',
    ]) {
      const r = parseCaptureGrammar(phrase, NOW)!;
      expect(new Date(r[0].endISO!).getTime()).toBeGreaterThan(new Date(r[0].startISO!).getTime());
    }
    // 600 (max) and 12h (max) are accepted as-is.
    expect(parseCaptureGrammar('add x to my calendar tomorrow at 9am for 600 minutes', NOW)![0].endISO)
      .toBe('2026-06-18T19:00:00');
  });

  it('a mid-title number is NOT consumed as the duration (connector-anchored)', () => {
    // "45 minute" is part of the title, not "for 45 minutes" → 60-min default.
    const r = parseCaptureGrammar('add 45 minute review to my calendar tomorrow at 2pm', NOW)!;
    expect(r[0]).toMatchObject({
      type: 'calendar_add',
      title: '45 minute review', // interior number kept
      startISO: '2026-06-18T14:00:00',
      endISO: '2026-06-18T15:00:00', // +60, NOT +45
    });
  });
});

describe('parseCaptureGrammar — fall-through cases', () => {
  it('compound text → AI (detected on raw text before stripping)', () => {
    expect(parseCaptureGrammar('call mom tomorrow and email dad', NOW)).toBeNull();
  });

  it('empty / whitespace → null', () => {
    expect(parseCaptureGrammar('', NOW)).toBeNull();
    expect(parseCaptureGrammar('   ', NOW)).toBeNull();
  });

  it('unresolvable or invalid date → AI', () => {
    expect(parseCaptureGrammar('finish the deck next week', NOW)).toBeNull();
    expect(parseCaptureGrammar('remind me to file taxes 2026-02-31', NOW)).toBeNull();
  });

  it('two disagreeing date tokens → AI (no hijack)', () => {
    expect(parseCaptureGrammar('remind me to renew 2026-06-20 cert tomorrow', NOW)).toBeNull();
    expect(parseCaptureGrammar('email friday about thursday plans', NOW)).toBeNull();
    expect(parseCaptureGrammar('remind me to file taxes today tomorrow', NOW)).toBeNull(); // two relatives
  });
});

describe('framing-prefix boundary (no mid-word slicing)', () => {
  it('"i need to" must not slice "tomatoes" / "toner"', () => {
    expect(parseCaptureGrammar('i need tomatoes', NOW)).toBeNull(); // not inbox "Matoes"
    const a = one(parseCaptureGrammar('i need toner tomorrow', NOW)); // not todo "Ner"
    expect(a.type).toBe('todo_add');
    expect(a.title).toBe('I need toner');
    expect(a.dateStr).toBe('2026-06-18');
  });

  it('interior weekday-like words are preserved (only the trailing date is stripped)', () => {
    expect(one(parseCaptureGrammar('remind me to prep the sat materials tomorrow', NOW)).title).toBe(
      'Prep the sat materials',
    );
    expect(one(parseCaptureGrammar('remind me to email Thu about friday', NOW)).title).toBe('Email Thu about');
  });
});

describe('stripCaptureFraming — rule-16 parity', () => {
  it('strips every framing prefix and capitalizes', () => {
    for (const prefix of CAPTURE_FRAMING_PREFIXES) {
      expect(stripCaptureFraming(`${prefix} do the thing`)).toBe('Do the thing');
    }
  });

  it('strips trailing politeness', () => {
    expect(stripCaptureFraming('remind me to water the plants please')).toBe('Water the plants');
    expect(stripCaptureFraming('clean the bins, thanks')).toBe('Clean the bins');
  });

  it('strips the longest matching prefix (no leftover fragment)', () => {
    expect(stripCaptureFraming('can you set a reminder to book a table')).toBe('Book a table');
  });

  it('leaves an unframed phrase unchanged but capitalized', () => {
    expect(stripCaptureFraming('spray the wash deck')).toBe('Spray the wash deck');
  });
});

describe('integration — grammar output survives resolveCaptureTier', () => {
  it('a dated to-do reaches the high tier (executes immediately)', () => {
    const text = 'pick up dry cleaning friday';
    const res = resolveCaptureTier(parseCaptureGrammar(text, NOW)!, text, NOW);
    expect(res.tier).toBe('high');
    expect(res.actions[0].type).toBe('todo_add');
  });

  it('a habit with no days reaches the medium tier ("Which days?")', () => {
    const text = 'add a habit stretching';
    const res = resolveCaptureTier(parseCaptureGrammar(text, NOW)!, text, NOW);
    expect(res.tier).toBe('medium');
    expect(res.clarification?.fieldKey).toBe('daysOfWeek');
  });

  it('an every-day habit reaches the high tier', () => {
    const text = 'meditate every morning';
    const res = resolveCaptureTier(parseCaptureGrammar(text, NOW)!, text, NOW);
    expect(res.tier).toBe('high');
    expect(res.actions[0].type).toBe('recurring_add');
  });
});

describe('calendar_add survives the resolveCaptureTier gate (NEX-241 — the irreversible-write contract)', () => {
  // The grammar emitting a calendar_add is necessary but NOT sufficient: prepareAction
  // downgrades it to Inbox unless validateProposedAction.valid && hasExplicitDate(raw)
  // && hasExplicitTime(raw) && confidence==='high'. These end-to-end tests pin that a
  // legit grammar event SURVIVES as a real calendar write with the exact local ISO —
  // the string handed to new Date() → createEventAsync with NO undo.
  it('POSITIVE: a firing utterance survives end-to-end as calendar_add with exact local ISO', () => {
    const text = 'add standup to my calendar tomorrow at 9am';
    const res = resolveCaptureTier(parseCaptureGrammar(text, NOW)!, text, NOW);
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatchObject({
      type: 'calendar_add', // survived — NOT downgraded to inbox_add
      startISO: '2026-06-18T09:00:00',
      endISO: '2026-06-18T10:00:00',
    });
    // The exact wall-clock the executor will write (local parse, hour preserved).
    expect(new Date(res.actions[0].startISO!).getHours()).toBe(9);
  });

  // GATE COUPLING: every date form and time form the grammar fires calendar on must
  // also satisfy the gate's INDEPENDENT DATE_RE/TIME_RE, or a valid grammar event would
  // silently downgrade to Inbox. This locks that coupling so a future grammar widening
  // (a date/time form the gate regexes don't list) is caught here, not in production.
  it('COUPLING: grammar date/time forms all pass hasExplicitDate / hasExplicitTime', () => {
    const dateForms = ['today', 'tonight', 'tonite', 'tomorrow', 'friday', 'saturday', '2026-06-18'];
    const timeForms = ['9am', '9:30am', '3pm', 'noon', 'midnight', '15:30'];
    for (const dt of dateForms) expect(hasExplicitDate(`x on my calendar ${dt}`)).toBe(true);
    for (const tm of timeForms) expect(hasExplicitTime(`x on my calendar tomorrow at ${tm}`)).toBe(true);
  });

  // NEGATIVE end-to-end: an under-evidenced calendar_add (here, hand-built to bypass the
  // grammar's own guards) is downgraded to a harmless Inbox capture — never a write.
  it('NEGATIVE: a calendar_add with no transcript date/time evidence downgrades to Inbox', () => {
    const action: ProposedAction = {
      type: 'calendar_add',
      title: 'Mystery',
      startISO: '2026-06-18T09:00:00',
      endISO: '2026-06-18T10:00:00',
      confidence: 'high',
    } as ProposedAction;
    // Raw transcript carries NO date/time words → gate must not let it write.
    const res = resolveCaptureTier([action], 'put mystery somewhere', NOW);
    expect(res.actions[0].type).toBe('inbox_add');
  });
});

describe('parseCaptureGrammar — time-of-day block + explicit date (NEX-262)', () => {
  it('a time-of-day block riding an explicit date fires as todo_add, block dropped', () => {
    const cases: [string, string, string][] = [
      ['wrap up the deck tomorrow afternoon', 'Wrap up the deck', '2026-06-18'],
      ['call mom friday evening', 'Call mom', '2026-06-19'],
      ['buy milk saturday morning', 'Buy milk', '2026-06-20'],
      ['water the plants tomorrow in the evening', 'Water the plants', '2026-06-18'],
    ];
    for (const [text, title, dateStr] of cases) {
      const a = one(parseCaptureGrammar(text, NOW));
      expect(a.type).toBe('todo_add');
      expect(a.title).toBe(title);
      expect(a.dateStr).toBe(dateStr);
      expect(a.time).toBeUndefined(); // never guess a clock from a block
    }
  });

  it('a BARE block mid-title stays a title word; only the date is stripped', () => {
    const a = one(parseCaptureGrammar('morning walk tomorrow', NOW));
    expect(a).toMatchObject({ type: 'todo_add', title: 'Morning walk', dateStr: '2026-06-18' });
  });

  it('a LEADING framed block is stripped from the title', () => {
    const a = one(parseCaptureGrammar('this afternoon walk the dog tomorrow', NOW));
    expect(a).toMatchObject({ type: 'todo_add', title: 'Walk the dog', dateStr: '2026-06-18' });
  });

  it('a POSSESSIVE block is kept in the title (not a schedule)', () => {
    const a = one(parseCaptureGrammar("review this morning's standup notes tomorrow", NOW));
    expect(a).toMatchObject({ type: 'todo_add', title: "Review this morning's standup notes", dateStr: '2026-06-18' });
  });

  it('still DEFERS a date-less time-of-day (would need a clock guess or a 2nd gate change)', () => {
    expect(parseCaptureGrammar('wrap up the deck this afternoon', NOW)).toBeNull();
    expect(parseCaptureGrammar('call mom in the evening', NOW)).toBeNull();
    expect(parseCaptureGrammar('do the morning routine', NOW)).toBeNull();
    expect(parseCaptureGrammar('night shift prep', NOW)).toBeNull();
    // appointment noun still defers even with a date + block
    expect(parseCaptureGrammar('morning meeting tomorrow', NOW)).toBeNull();
  });

  it('a degenerate title that strips to a lone schedule word defers (no junk "Tomorrow" to-do)', () => {
    // The framed block is the whole pre-date content → only the date token remains.
    expect(parseCaptureGrammar('this evening tomorrow', NOW)).toBeNull();
    expect(parseCaptureGrammar('this morning tomorrow', NOW)).toBeNull();
    expect(parseCaptureGrammar('in the morning tomorrow', NOW)).toBeNull();
    expect(parseCaptureGrammar('this afternoon friday', NOW)).toBeNull();
  });

  it('a trailing dangling article is cleaned, not left in the title', () => {
    const a = one(parseCaptureGrammar('review the evening tomorrow', NOW));
    expect(a.title).toBe('Review'); // "the" + "evening" + "tomorrow" all gone
    expect(a.dateStr).toBe('2026-06-18');
  });

  it('an emoji-only or non-Latin title is real content, not schedule residue', () => {
    expect(one(parseCaptureGrammar('🌙 tonight', NOW))).toMatchObject({ type: 'todo_add', title: '🌙', dateStr: '2026-06-17' });
    expect(one(parseCaptureGrammar('买菜 tomorrow', NOW))).toMatchObject({ type: 'todo_add', title: '买菜', dateStr: '2026-06-18' });
  });

  it('a date + block + unambiguous clock keeps the clock, drops the block', () => {
    const a = one(parseCaptureGrammar('wrap up the deck tomorrow afternoon at 3pm', NOW));
    expect(a).toMatchObject({ type: 'todo_add', title: 'Wrap up the deck', dateStr: '2026-06-18', time: '15:00' });
  });
});

// NEX-280 — the reported "orb hang" phrase parses OFFLINE on current code.
// The hang required the Tier-2 AI path (stale installed build, or a phrasing
// the grammar defers on); these pin the verbatim phrase and its variants so
// a grammar regression can't silently push them back onto the network.
describe('NEX-280 reported capture phrase', () => {
  const NOW280 = new Date(2026, 6, 2, 10, 0, 0);

  it('"Can you remind me to go to the store?" resolves offline as an inbox capture', () => {
    const r = parseCaptureGrammar('Can you remind me to go to the store?', NOW280);
    expect(r).not.toBeNull();
    expect(r![0]).toMatchObject({ type: 'inbox_add', confidence: 'high' });
  });

  it('the "tonight" variant resolves offline as a dated to-do (time-of-day rides the date)', () => {
    const r = parseCaptureGrammar('Can you remind me to go to the store tonight?', NOW280);
    expect(r).not.toBeNull();
    expect(r![0]).toMatchObject({ type: 'todo_add', dateStr: '2026-07-02' });
  });
});

// ─── NEX-302: normalizeAiTitle (deterministic Rule-16 enforcement) ───────────

describe('normalizeAiTitle — the shipped bug and its gates', () => {
  const cal = { hasSchedule: true, isCalendar: true };
  const sched = { hasSchedule: true, isCalendar: false };
  const bare = { hasSchedule: false, isCalendar: false };

  it('strips verbatim request framing from a calendar title (the NEX-302 bug)', () => {
    expect(normalizeAiTitle('Can you add podcast at 5 PM today?', cal)).toBe('Podcast');
  });

  it('strips a "could you please" frame + verb + article + schedule tail', () => {
    expect(normalizeAiTitle('Could you please schedule a dentist appointment tomorrow at 2pm', cal)).toBe(
      'Dentist appointment'
    );
  });

  it('strips the calendar connective phrase on calendar actions', () => {
    expect(normalizeAiTitle('Can you add lunch with Sarah to my calendar Friday at 1pm', cal)).toBe(
      'Lunch with Sarah'
    );
  });

  it('handles a framed compound reminder prefix ("can you please set a reminder to")', () => {
    expect(normalizeAiTitle('Can you please set a reminder to call mom', bare)).toBe('Call mom');
  });

  it('does NOT strip a non-scheduling verb behind the frame', () => {
    expect(normalizeAiTitle('Can you make sure the oven is off', sched)).toBe('Make sure the oven is off');
  });

  it('leaves a rhetorical unscheduled thought untouched', () => {
    expect(normalizeAiTitle('Can you believe he said that', bare)).toBe('Can you believe he said that');
  });

  it('calendar phrase + verb strips are calendar-only', () => {
    expect(normalizeAiTitle('Fix the double-entry in the calendar view', sched)).toBe(
      'Fix the double-entry in the calendar view'
    );
    expect(normalizeAiTitle('Add protein to smoothies', sched)).toBe('Add protein to smoothies');
  });

  it('bare leading calendar verb strips on calendar actions (extractCalendarTitle parity)', () => {
    expect(normalizeAiTitle('Add lunch with Sarah', cal)).toBe('Lunch with Sarah');
  });

  it('keeps a mid-title clock ("Call about the 3 PM meeting")', () => {
    expect(normalizeAiTitle('Call about the 3 PM meeting', sched)).toBe('Call about the 3 PM meeting');
  });

  it('keeps the schedule tail when the action carries NO schedule fields', () => {
    expect(normalizeAiTitle('Podcast at 5 pm', bare)).toBe('Podcast at 5 pm');
  });

  it('strips recurring cadence tails on scheduled actions', () => {
    expect(normalizeAiTitle('Meditate every morning', sched)).toBe('Meditate');
    expect(normalizeAiTitle('Water plants every other Friday', sched)).toBe('Water plants');
    expect(normalizeAiTitle('Submit invoices every 2 weeks', sched)).toBe('Submit invoices');
  });

  it('strips the duration tail on calendar actions only', () => {
    expect(normalizeAiTitle('Check-in with wife for 20 minutes', cal)).toBe('Check-in with wife');
    expect(normalizeAiTitle('Check-in with wife for 20 minutes', sched)).toBe(
      'Check-in with wife for 20 minutes'
    );
  });

  it('peels the redundant weekly tail ("…at 10am every week")', () => {
    expect(normalizeAiTitle('Workout every Sunday at 10am every week', cal)).toBe('Workout');
  });

  it('keeps a title whole when it carries ≥2 clocks (tail vs content is undecidable)', () => {
    expect(normalizeAiTitle('Move the 3pm call to 5pm', sched)).toBe('Move the 3pm call to 5pm');
  });

  it('cleans the dangling connector a stripped trailing clock leaves behind', () => {
    expect(normalizeAiTitle('Wait until 5pm', sched)).toBe('Wait');
    expect(normalizeAiTitle('Push the call to 5pm', sched)).toBe('Push the call');
  });

  it('never returns empty and never reverts to the verbatim question (progressive)', () => {
    const out = normalizeAiTitle('Can you add to my calendar at 5 pm?', cal);
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/can you/i);
  });

  it('preserves mixed-case first words (capitalize guard)', () => {
    expect(normalizeAiTitle('iOS review', bare)).toBe('iOS review');
    expect(normalizeAiTitle('call mom', bare)).toBe('Call mom');
  });

  it('is idempotent over every table entry', () => {
    const table: [string, { hasSchedule: boolean; isCalendar: boolean }][] = [
      ['Can you add podcast at 5 PM today?', cal],
      ['Could you please schedule a dentist appointment tomorrow at 2pm', cal],
      ['Can you please set a reminder to call mom', bare],
      ['Can you make sure the oven is off', sched],
      ['Can you believe he said that', bare],
      ['Meditate every morning', sched],
      ['Check-in with wife for 20 minutes', cal],
      ['Can you add to my calendar at 5 pm?', cal],
      ['iOS review', bare],
    ];
    for (const [title, opts] of table) {
      const once = normalizeAiTitle(title, opts);
      expect(normalizeAiTitle(once, opts)).toBe(once);
    }
  });
});

describe('NEX-302 — offline calendar title also sheds the request frame', () => {
  it('"can you add X to my calendar friday at 1pm" → title without the frame', () => {
    const a = one(parseCaptureGrammar('can you add lunch with Sarah to my calendar friday at 1pm', NOW));
    expect(a.type).toBe('calendar_add');
    expect(a.title).toBe('Lunch with Sarah');
  });
});

describe('explicit inbox list override (offline compound capture)', () => {
  it('the production incident: "add to my inbox: A, B, and C" → three inbox_add', () => {
    const result = parseCaptureGrammar(
      'add to my inbox: call the mortgage company, call the city, and change my bank accounts in my direct deposit',
      NOW,
    );
    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);
    expect((result as ProposedAction[]).map((a) => a.type)).toEqual([
      'inbox_add',
      'inbox_add',
      'inbox_add',
    ]);
    expect((result as ProposedAction[]).map((a) => a.title)).toEqual([
      'Call the mortgage company',
      'Call the city',
      'Change my bank accounts in my direct deposit',
    ]);
    // Every item is high confidence — resolveCaptureTier executes it immediately.
    for (const a of result as ProposedAction[]) expect(a.confidence).toBe('high');
  });

  it('strips the Oxford "and" from the trailing fragment', () => {
    const result = parseCaptureGrammar('put in my inbox milk, eggs, and bread', NOW);
    expect((result as ProposedAction[]).map((a) => a.title)).toEqual(['Milk', 'Eggs', 'Bread']);
  });

  it('"inbox this" / "inbox these" trigger the override', () => {
    expect(parseCaptureGrammar('inbox these: pay rent, book flights', NOW)).toHaveLength(2);
    expect(parseCaptureGrammar('inbox this taxes, invoices', NOW)).toHaveLength(2);
  });

  it('drops date/time framing under the override (verbatim capture, no schedule)', () => {
    const result = parseCaptureGrammar('add to my inbox: call the bank tomorrow, email Sam at 3pm', NOW);
    expect(result).toHaveLength(2);
    for (const a of result as ProposedAction[]) {
      expect(a.type).toBe('inbox_add');
      // No scheduling fields leak onto an explicit inbox capture.
      expect((a as any).dateStr).toBeUndefined();
      expect((a as any).time).toBeUndefined();
    }
  });

  it('a single explicit-inbox item (no list) is one inbox_add', () => {
    const a = one(parseCaptureGrammar('add to my inbox call the plumber', NOW));
    expect(a.type).toBe('inbox_add');
    expect(a.title).toBe('Call the plumber');
  });

  it('a comma-less "A and B" defers to the AI (ambiguous split)', () => {
    // A bare "and" is often mid-title ("call mom and dad") — a wrong offline
    // split is worse than the AI path, so this is left to the model.
    expect(parseCaptureGrammar('add to my inbox call mom and dad', NOW)).toBeNull();
  });

  it('does NOT fire when "inbox" is not the destination', () => {
    // "the email in my inbox is old" mentions inbox but issues no add-directive.
    expect(parseCaptureGrammar('the oldest email in my inbox is from March', NOW)).toBeNull();
  });
});

describe('explicit inbox list → resolveCaptureTier executes immediately', () => {
  it('the 3-item batch resolves to the high tier with all three kept', () => {
    const actions = parseCaptureGrammar(
      'add to my inbox: call the mortgage company, call the city, and change my direct deposit',
      NOW,
    ) as ProposedAction[];
    const resolution = resolveCaptureTier(
      actions,
      'add to my inbox: call the mortgage company, call the city, and change my direct deposit',
      NOW,
    );
    expect(resolution.tier).toBe('high');
    expect(resolution.actions).toHaveLength(3);
  });
});

describe('explicit inbox list — remainder anchors on the MATCHED directive, not the first "inbox" mention', () => {
  it('an earlier unrelated "inbox" mention is excluded from the captured list', () => {
    // Regression: the remainder used to be extracted via an independent
    // "first inbox in the string" search, which folded unrelated leading
    // text into the list when "inbox" appeared earlier for another reason.
    const result = parseCaptureGrammar(
      'my inbox is a mess, add to my inbox: buy milk, walk dog',
      NOW,
    ) as ProposedAction[];
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.title)).toEqual(['Buy milk', 'Walk dog']);
  });

  it('caps an unbounded single-item title at 200 chars, matching buildTranscriptInboxAction', () => {
    const long = 'a'.repeat(300);
    const a = one(parseCaptureGrammar(`add to my inbox ${long}`, NOW));
    expect(a.title.length).toBe(200);
    expect(a.title.endsWith('...')).toBe(true);
  });

  it('strips trailing exclamation/question marks along with periods', () => {
    const result = parseCaptureGrammar(
      'add to my inbox: call John!!!, email Sarah???',
      NOW,
    ) as ProposedAction[];
    expect(result.map((a) => a.title)).toEqual(['Call John', 'Email Sarah']);
  });
});
