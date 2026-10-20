import { describe, expect, it, vi, beforeEach } from 'vitest';

// chatCompletion is the only RN-coupled import in the service. Mock it
// at the module level so vitest's pure-Node runner doesn't try to
// resolve the proxy URL / native fetch path.
const chatCompletionMock = vi.fn();
vi.mock('../../utils/ai-client', () => ({
  chatCompletion: (...args: unknown[]) => chatCompletionMock(...args),
}));

import {
  parseRecommendationPayload,
  generateOnboardingRecommendations,
  regenerateMandateOnly,
  regenerateMandateDownstream,
  regenerateHabit,
  regenerateTodo,
  shouldDisambiguate,
  getLastParseFailReason,
  type ReflectionInput,
  type RecommendedMandate,
} from '../pulse-recommendations';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REFLECTION: ReflectionInput = {
  bestVersion:
    'I want to be present with my family, do work that matters to me, write again, and take better care of my body. I want to be the kind of person my kids respect.',
  stop: 'Doom-scrolling after dinner.',
  continue: 'Morning walks with the dog.',
  focus: 'Shipping the novel and getting back into the gym.',
};

const M1 = 'm-a1b2c3d4';
const M2 = 'm-e5f6g7h8';
const M3 = 'm-i9j0k1l2';

function validPayload(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    mandates: [
      // 5 words.
      { id: M1, title: 'Be present with my family', category: 'PERSONAL', rationaleSource: 'bestVersion', rationale: 'Names the family commitment you led with when you described who you want to become.' },
      // 4 words.
      { id: M2, title: 'Master the writing craft', category: 'BUSINESS', rationaleSource: 'continue', rationale: 'Names the writing thread that ran through your reflection on what you want to continue.' },
      // 4 words.
      { id: M3, title: 'Take care of myself', category: 'PERSONAL', rationaleSource: 'focus', rationale: 'Names the body item you flagged when you talked about what to focus on next.' },
    ],
    // NEX-57: each mandate carries a POOL of 2-3 habit options + 2-3
    // downstream actions. Pulse classifies downstream into recurring vs
    // one-time per the NEX-60 decision tree. M3 demonstrates a mandate
    // whose downstream is entirely recurring (no one-time todos).
    habits: [
      // M1: 2 habits (DISTINCT angles on the family mandate)
      { title: 'Phone-free dinners', daysOfWeek: [0,1,2,3,4,5,6], mandateId: M1, rationale: 'Anchors presence with family by removing the device that pulls attention from the room.' },
      { title: 'Saturday family ritual', daysOfWeek: [6], mandateId: M1, rationale: 'Reserves one weekly anchor for the people you most want to see clearly here.' },
      // M2: 2 habits
      { title: 'Daily writing', daysOfWeek: [1,2,3,4,5], mandateId: M2, rationale: 'Builds the craft mandate one weekday session at a time before context fragments.' },
      { title: 'Morning pages', daysOfWeek: [0,1,2,3,4,5,6], mandateId: M2, rationale: 'Empties the mind onto the page before email and noise crowd the morning.' },
      // M3: 2 habits
      { title: 'Morning walk, 20 min', daysOfWeek: [0,1,2,3,4,5,6], mandateId: M3, rationale: 'Anchors the body mandate in a daily move that costs nothing and resets attention.' },
      { title: 'Strength training', daysOfWeek: [1,3,5], mandateId: M3, rationale: 'Builds resilience that aging without practice quietly takes away each year now.' },
    ],
    recurringTodos: [
      // M3: 2 recurring intentions (untracked, no one-time todos).
      // Canonical NEX-60 classification case lives here.
      { title: 'Move three times this week', daysOfWeek: [1,3,5], mandateId: M3, rationale: 'Gives the body mandate a cadence without burning the recovery the user already needs.' },
      { title: 'Stretch each evening', daysOfWeek: [0,1,2,3,4,5,6], mandateId: M3, rationale: 'A daily reset that asks nothing of you and gives the body a small moment.' },
    ],
    todos: [
      // M1: 2 todos
      { title: 'Plan one weekend activity with the kids', mandateId: M1, rationale: 'Turns presence into a deliberate choice on the calendar rather than a quiet wish.' },
      { title: 'Call your parents Sunday', mandateId: M1, rationale: 'Closes a recurring family loop the mandate has been quietly carrying for weeks.' },
      // M2: 2 todos
      { title: 'Outline the next chapter of your novel', mandateId: M2, rationale: 'Turns the craft mandate into a concrete artifact you can actually finish this week.' },
      { title: 'Submit one essay this month', mandateId: M2, rationale: 'Names an external deadline so the practice has something pulling it forward into the world.' },
      // M3: 0 todos (downstream satisfied entirely by recurringTodos)
    ],
    ...overrides,
  });
}

// ─── parseRecommendationPayload — happy path ─────────────────────────────────

describe('parseRecommendationPayload — happy path', () => {
  it('parses a fully-formed response', () => {
    const result = parseRecommendationPayload(validPayload());
    expect(result).not.toBeNull();
    expect(result!.mandates).toHaveLength(3);
    expect(result!.habits).toHaveLength(6);
    expect(result!.todos.length).toBeGreaterThanOrEqual(3);
    expect(result!.mandates[0].id).toBe(M1);
    expect(result!.mandates[0].slotId).toBe(M1);
    expect(result!.mandates[0].rationaleSource).toBe('bestVersion');
    expect(result!.habits[0].mandateId).toBe(M1);
  });

  it('strips markdown fences before parsing', () => {
    const wrapped = '```json\n' + validPayload() + '\n```';
    const result = parseRecommendationPayload(wrapped);
    expect(result).not.toBeNull();
    expect(result!.mandates).toHaveLength(3);
  });

  it('accepts 5 mandates with matching habit count', () => {
    const M4 = 'm-extra04';
    const M5 = 'm-extra05';
    const raw = JSON.parse(validPayload());
    raw.mandates.push(
      { id: M4, title: 'Build a strong body', category: 'PERSONAL', rationaleSource: 'focus', rationale: 'Names the body work you keep saying you want to come back to this year.' },
      { id: M5, title: 'Lead my team well', category: 'BUSINESS', rationaleSource: 'continue', rationale: 'Names the leadership thread you flagged as something you want to keep getting right.' },
    );
    // NEX-57: 2 habits + 2 downstream per new mandate.
    raw.habits.push(
      { title: 'Strength training', daysOfWeek: [1,3,5], mandateId: M4, rationale: 'Operationalizes the body mandate three weekdays a week without burning recovery.' },
      { title: 'Daily mobility, 10 min', daysOfWeek: [0,1,2,3,4,5,6], mandateId: M4, rationale: 'Keeps the body loose with a daily move that costs almost nothing.' },
      { title: 'Daily 1:1 check-ins', daysOfWeek: [1,2,3,4,5], mandateId: M5, rationale: 'Builds the leadership mandate one short conversation at a time, before issues compound.' },
      { title: 'Weekly team review', daysOfWeek: [5], mandateId: M5, rationale: 'Names what is happening on the team so you stop being surprised on Mondays.' },
    );
    raw.todos.push(
      { title: 'Book a session with a trainer', mandateId: M4, rationale: 'Closes the gap between intent and a concrete plan the mandate demands.' },
      { title: 'Schedule your overdue physical', mandateId: M4, rationale: 'Closes a long-pending body item you have been quietly carrying for months.' },
      { title: 'Schedule weekly team retrospective', mandateId: M5, rationale: 'Reserves space for the team leadership work the mandate asks you to actually do.' },
      { title: 'Send a check-in note to each report', mandateId: M5, rationale: 'Names what is actually happening so you stop being surprised on Mondays here.' },
    );
    const result = parseRecommendationPayload(JSON.stringify(raw));
    expect(result).not.toBeNull();
    expect(result!.mandates).toHaveLength(5);
    expect(result!.habits).toHaveLength(10);
  });

});

// ─── parseRecommendationPayload — malformed input ────────────────────────────

describe('parseRecommendationPayload — malformed input', () => {
  it('returns null for empty input', () => {
    expect(parseRecommendationPayload('')).toBeNull();
    expect(parseRecommendationPayload('   ')).toBeNull();
  });

  it('returns null for non-JSON garbage', () => {
    expect(parseRecommendationPayload('not even close to json')).toBeNull();
    expect(parseRecommendationPayload('{ unterminated')).toBeNull();
  });

  it('returns null when mandates field is missing', () => {
    const raw = JSON.parse(validPayload());
    delete raw.mandates;
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('returns null when a mandate is missing rationaleSource', () => {
    const raw = JSON.parse(validPayload());
    delete raw.mandates[0].rationaleSource;
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('returns null when rationaleSource is not a valid ReflectionKey', () => {
    const raw = JSON.parse(validPayload());
    raw.mandates[0].rationaleSource = 'inspiration';
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('returns null when a mandate is missing rationale', () => {
    const raw = JSON.parse(validPayload());
    delete raw.mandates[0].rationale;
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('returns null when a mandate rationale exceeds the 25-word parser cap', () => {
    const raw = JSON.parse(validPayload());
    raw.mandates[0].rationale = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + (i % 26))).join(' ');
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('returns null when mandate ids are duplicated', () => {
    const raw = JSON.parse(validPayload());
    raw.mandates[1].id = raw.mandates[0].id;
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });
});

// ─── parseRecommendationPayload — count validation ───────────────────────────

describe('parseRecommendationPayload — count validation', () => {
  it('rejects mandate count of 2', () => {
    const raw = JSON.parse(validPayload());
    raw.mandates = raw.mandates.slice(0, 2);
    raw.habits = raw.habits.slice(0, 2);
    raw.todos = raw.todos.filter((t: any) => t.mandateId === M1 || t.mandateId === M2);
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('rejects mandate count of 6', () => {
    const raw = JSON.parse(validPayload());
    for (let i = 4; i <= 6; i++) {
      const id = `m-extra0${i}`;
      raw.mandates.push({ id, title: 'Stay sharp every week', category: 'PERSONAL', rationaleSource: 'focus', rationale: 'Names a thread the user kept circling back to throughout this part of the reflection.' });
      raw.habits.push({ title: 'Plan weekly', daysOfWeek: [0], mandateId: id, rationale: 'Operationalizes the mandate by carving out a planning slot every single Sunday morning.' });
      raw.todos.push({ title: 'Schedule the Sunday planning slot', mandateId: id, rationale: 'Names a real recurring time so the mandate is not just a quiet wish.' });
    }
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('rejects a mandate that has no habit', () => {
    const raw = JSON.parse(validPayload());
    raw.habits = raw.habits.filter((h: any) => h.mandateId !== M1);
    // After filter we have 2 habits but still 3 mandates — habit count mismatch.
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  // NEX-60: the rule is "1 to 2 downstream actions per mandate" where
  // downstream = recurringTodos + todos. A mandate with zero of both fails.
  it('rejects a mandate that has zero downstream actions', () => {
    const raw = JSON.parse(validPayload());
    raw.todos = raw.todos.filter((t: any) => t.mandateId !== M3);
    raw.recurringTodos = raw.recurringTodos.filter((rt: any) => rt.mandateId !== M3);
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  // NEX-57: combined downstream rule bumped from 1-2 to 2-3 per mandate.
  // This test pushes M1 over the upper bound (M1 starts with 2 todos +
  // 2 added = 4 combined, which exceeds 3).
  it('rejects a mandate whose combined downstream exceeds 3', () => {
    const raw = JSON.parse(validPayload());
    raw.todos.push({ title: 'Extra todo for mandate one', mandateId: M1, rationale: 'A third todo that breaks the 2-3 per mandate rule for this fixture.' });
    raw.todos.push({ title: 'And another todo for mandate one', mandateId: M1, rationale: 'A fourth todo that breaks the 2-3 per mandate rule for this fixture.' });
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });
});

// ─── parseRecommendationPayload — mandateId linkage ──────────────────────────

describe('parseRecommendationPayload — mandateId linkage', () => {
  it('rejects a habit whose mandateId is not in the mandate list', () => {
    const raw = JSON.parse(validPayload());
    raw.habits[0].mandateId = 'm-doesnotexist';
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
    expect(getLastParseFailReason()).toContain('does not match');
  });

  it('rejects a todo whose mandateId is not in the mandate list', () => {
    const raw = JSON.parse(validPayload());
    raw.todos[0].mandateId = 'm-doesnotexist';
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
    expect(getLastParseFailReason()).toContain('does not match');
  });

  it('rejects a habit with missing mandateId', () => {
    const raw = JSON.parse(validPayload());
    delete raw.habits[0].mandateId;
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });
});

// ─── parseRecommendationPayload — length budgets ─────────────────────────────

describe('parseRecommendationPayload — length budgets', () => {
  const wordsN = (n: number) =>
    Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join(' ');

  it('accepts a mandate title at exactly the 6-word cap', () => {
    const raw = JSON.parse(validPayload());
    raw.mandates[0].title = wordsN(6);
    const result = parseRecommendationPayload(JSON.stringify(raw));
    expect(result).not.toBeNull();
    expect(result!.mandates[0].title).toBe(wordsN(6));
  });

  it('rejects a mandate title at 7 words', () => {
    const raw = JSON.parse(validPayload());
    raw.mandates[0].title = wordsN(7);
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
    expect(getLastParseFailReason()).toContain('mandate');
  });

  it('accepts a habit title at exactly the 4-word cap', () => {
    const raw = JSON.parse(validPayload());
    raw.habits[0].title = wordsN(4);
    expect(parseRecommendationPayload(JSON.stringify(raw))).not.toBeNull();
  });

  it('rejects a habit title at 5 words', () => {
    const raw = JSON.parse(validPayload());
    raw.habits[0].title = wordsN(5);
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('accepts a to-do title at exactly the 10-word cap', () => {
    const raw = JSON.parse(validPayload());
    raw.todos[0].title = wordsN(10);
    expect(parseRecommendationPayload(JSON.stringify(raw))).not.toBeNull();
  });

  it('rejects a to-do title at 11 words', () => {
    const raw = JSON.parse(validPayload());
    raw.todos[0].title = wordsN(11);
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('rejects an overlong rationale (over 25 words)', () => {
    const raw = JSON.parse(validPayload());
    raw.habits[0].rationale = wordsN(26);
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });
});

// ─── shouldDisambiguate (client-side gate) ───────────────────────────────────
//
// NEX-38: threshold flipped from "card 1 < 10 words AND others empty"
// to "total word count across all four cards < 40". The new model
// requires all four cards to have content, so the old "others empty"
// rule could never fire. The new threshold catches uniformly-thin
// answers where Pulse still wouldn't have enough signal.

describe('shouldDisambiguate', () => {
  it('triggers when total word count across all four cards is under 40', () => {
    // 4 + 3 + 4 + 4 = 15 words total. Far under 40.
    expect(
      shouldDisambiguate({
        bestVersion: 'I want to be better',
        stop: 'Doom scrolling',
        continue: 'Morning walks with dog',
        focus: 'Ship the novel quickly',
      }),
    ).toBe(true);
  });

  it('triggers when total is 39 (one word under the threshold)', () => {
    // 39 single-letter "words" so the count is exact.
    const words = (n: number) =>
      Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join(' ');
    expect(
      shouldDisambiguate({
        bestVersion: words(10),
        stop: words(10),
        continue: words(10),
        focus: words(9),
      }),
    ).toBe(true);
  });

  it('does NOT trigger when total is exactly 40 (predicate is strictly less than)', () => {
    const words = (n: number) =>
      Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join(' ');
    expect(
      shouldDisambiguate({
        bestVersion: words(10),
        stop: words(10),
        continue: words(10),
        focus: words(10),
      }),
    ).toBe(false);
  });

  it('does NOT trigger when one rich card alone exceeds the threshold', () => {
    // Card 1 carries 45 words; other cards are thin but non-empty.
    const words = (n: number) =>
      Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join(' ');
    expect(
      shouldDisambiguate({
        bestVersion: words(45),
        stop: 'a',
        continue: 'b',
        focus: 'c',
      }),
    ).toBe(false);
  });

  it('does NOT trigger when all four cards are uniformly rich', () => {
    expect(
      shouldDisambiguate({
        bestVersion: 'I want to be present with my family and do work that genuinely matters to me long term',
        stop: 'Doom-scrolling after dinner and the late-night phone habit that pulls me out of presence',
        continue: 'Morning walks with the dog and the daily writing block that I started three months ago',
        focus: 'Shipping the novel by end of year and finally getting back into a real exercise routine again',
      }),
    ).toBe(false);
  });

  it('treats whitespace-only fills as empty (zero-word contribution)', () => {
    // bestVersion 8 words + others whitespace = 8 total, under 40.
    expect(
      shouldDisambiguate({
        bestVersion: 'I want to be a better person daily',
        stop: '   ',
        continue: '',
        focus: '\n\t  ',
      }),
    ).toBe(true);
  });
});

// ─── generateOnboardingRecommendations ───────────────────────────────────────

describe('generateOnboardingRecommendations', () => {
  beforeEach(() => {
    chatCompletionMock.mockReset();
  });

  it('returns source=pulse on a valid response', async () => {
    chatCompletionMock.mockResolvedValueOnce(validPayload());
    const result = await generateOnboardingRecommendations(REFLECTION);
    expect(result.source).toBe('pulse');
    if (result.source !== 'pulse') return;
    expect(result.data.mandates).toHaveLength(3);
  });

  // NEX-35: the curated-defaults silent fallback is gone. Each failure
  // mode now surfaces as a discriminated `failed` result with a
  // specific reason so the UI can route to RetryScreen.
  it('returns failed/network on chatCompletion failure', async () => {
    chatCompletionMock.mockRejectedValueOnce(new Error('proxy down'));
    const result = await generateOnboardingRecommendations(REFLECTION);
    expect(result.source).toBe('failed');
    if (result.source !== 'failed') return;
    expect(result.reason).toBe('network');
  });

  it('returns failed/parse when both attempts are malformed (one silent retry)', async () => {
    chatCompletionMock
      .mockResolvedValueOnce('not json')
      .mockResolvedValueOnce('still not json');
    const result = await generateOnboardingRecommendations(REFLECTION);
    expect(result.source).toBe('failed');
    if (result.source !== 'failed') return;
    expect(result.reason).toBe('parse');
    expect(chatCompletionMock).toHaveBeenCalledTimes(2);
  });

  it('returns source=pulse when the silent retry parses after a malformed first response', async () => {
    chatCompletionMock
      .mockResolvedValueOnce('not json')
      .mockResolvedValueOnce(validPayload());
    const result = await generateOnboardingRecommendations(REFLECTION);
    expect(result.source).toBe('pulse');
    if (result.source !== 'pulse') return;
    expect(result.data.mandates).toHaveLength(3);
    expect(chatCompletionMock).toHaveBeenCalledTimes(2);
  });

  it('returns failed/parse when the silent retry throws (network on retry is still parse)', async () => {
    chatCompletionMock
      .mockResolvedValueOnce('not json')
      .mockRejectedValueOnce(new Error('proxy down'));
    const result = await generateOnboardingRecommendations(REFLECTION);
    expect(result.source).toBe('failed');
    if (result.source !== 'failed') return;
    expect(result.reason).toBe('parse');
  });

  it('returns failed/parse on schema violation (bad mandateId)', async () => {
    const raw = JSON.parse(validPayload());
    raw.habits[0].mandateId = 'm-orphan';
    chatCompletionMock
      .mockResolvedValueOnce(JSON.stringify(raw))
      .mockResolvedValueOnce(JSON.stringify(raw));
    const result = await generateOnboardingRecommendations(REFLECTION);
    expect(result.source).toBe('failed');
    if (result.source !== 'failed') return;
    expect(result.reason).toBe('parse');
  });

  it('returns failed/no_reflection when bestVersion is missing', async () => {
    const result = await generateOnboardingRecommendations({
      bestVersion: '',
      stop: '',
      continue: '',
      focus: '',
    });
    expect(result.source).toBe('failed');
    if (result.source !== 'failed') return;
    expect(result.reason).toBe('no_reflection');
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('returns needs_disambiguation when total reflection word count is under 40', async () => {
    const result = await generateOnboardingRecommendations({
      bestVersion: 'Be better',
      stop: 'Phone',
      continue: 'Walks',
      focus: 'Writing',
    });
    expect(result.source).toBe('needs_disambiguation');
    if (result.source !== 'needs_disambiguation') return;
    expect(result.disambiguationNeeded.question).toBeTruthy();
    expect(result.disambiguationNeeded.options.length).toBeGreaterThanOrEqual(2);
    expect(chatCompletionMock).not.toHaveBeenCalled();
  });

  it('skips the disambiguation gate when option is set', async () => {
    chatCompletionMock.mockResolvedValueOnce(validPayload());
    const result = await generateOnboardingRecommendations(
      { bestVersion: 'Be better', stop: '', continue: '', focus: '' },
      { skipDisambiguationGate: true },
    );
    expect(result.source).toBe('pulse');
    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
  });
});

// ─── regenerateMandateOnly ───────────────────────────────────────────────────

const MANDATE_FIXTURE: RecommendedMandate = {
  id: M1,
  slotId: M1,
  title: 'Be present with my family',
  category: 'PERSONAL',
  rationaleSource: 'bestVersion',
  rationale: 'Names the family commitment the user led with in their reflection.',
  refreshCount: 3,
};

describe('regenerateMandateOnly', () => {
  beforeEach(() => {
    chatCompletionMock.mockReset();
  });

  it('returns a new mandate with the same id on valid response', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        title: 'Show up for my family',
        category: 'PERSONAL',
        rationaleSource: 'bestVersion',
        rationale: 'Names the family thread you led with when you described who you want to become.',
      }),
    );
    const result = await regenerateMandateOnly({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).not.toBeNull();
    expect(result!.id).toBe(M1);
    expect(result!.slotId).toBe(M1);
    expect(result!.title).toBe('Show up for my family');
    expect(result!.rationale).toContain('family thread');
    // The function does NOT tick refreshCount — that's the reducer's job.
    expect(result!.refreshCount).toBe(0);
  });

  it('returns null on malformed response', async () => {
    chatCompletionMock.mockResolvedValueOnce('garbage');
    const result = await regenerateMandateOnly({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });

  it('returns null when the returned title overshoots the cap', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        title: 'A b c d e f g',  // 7 words
        category: 'PERSONAL',
        rationaleSource: 'bestVersion',
        rationale: 'Names a thread that does not actually exist in this synthesized test reflection.',
      }),
    );
    const result = await regenerateMandateOnly({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });

  it('returns null when the returned mandate is missing rationale', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        title: 'Show up for my family',
        category: 'PERSONAL',
        rationaleSource: 'bestVersion',
      }),
    );
    const result = await regenerateMandateOnly({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });

  it('returns null on chatCompletion failure', async () => {
    chatCompletionMock.mockRejectedValueOnce(new Error('proxy down'));
    const result = await regenerateMandateOnly({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });
});

// ─── regenerateMandateDownstream ─────────────────────────────────────────────

describe('regenerateMandateDownstream', () => {
  beforeEach(() => {
    chatCompletionMock.mockReset();
  });

  it('returns a pool of habits and 2 downstream on a valid response', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        habits: [
          {
            title: 'Phone-free dinners',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            rationale: 'Anchors presence with family by removing the device that pulls attention from the room.',
          },
          {
            title: 'Saturday family ritual',
            daysOfWeek: [6],
            rationale: 'Reserves one weekly anchor for the people you most want to see clearly here.',
          },
        ],
        todos: [
          {
            title: 'Plan one weekend activity with the kids',
            rationale: 'Turns presence into a deliberate choice on the calendar rather than a quiet wish.',
          },
          {
            title: 'Call your parents Sunday evening',
            rationale: 'Closes a recurring family loop the mandate has been carrying silently.',
          },
        ],
      }),
    );
    const result = await regenerateMandateDownstream({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).not.toBeNull();
    expect(result!.habits).toHaveLength(2);
    expect(result!.habits.every((h) => h.mandateId === M1)).toBe(true);
    expect(result!.todos).toHaveLength(2);
    expect(result!.todos.every((t) => t.mandateId === M1)).toBe(true);
    // Fresh slotIds.
    expect(result!.habits[0].slotId).toContain(M1);
    expect(result!.todos[0].slotId).toContain(M1);
  });

  it('accepts a cascade with 2-3 habits and 2 downstream split across buckets', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        habits: [
          {
            title: 'Daily writing',
            daysOfWeek: [1, 2, 3, 4, 5],
            rationale: 'Builds the writing mandate one weekday session at a time before context fragments.',
          },
          {
            title: 'Morning pages',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            rationale: 'Empties the mind onto the page before email and noise crowd the morning.',
          },
          {
            title: 'Evening reading',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            rationale: 'Refills the well that the writing mandate depends on every single evening.',
          },
        ],
        recurringTodos: [
          {
            title: 'Submit one essay this month',
            daysOfWeek: [5],
            rationale: 'A recurring intention without streak pressure that still gives the craft cadence.',
          },
        ],
        todos: [
          {
            title: 'Outline the next chapter of your novel',
            rationale: 'Turns the craft mandate into a concrete artifact you can actually finish this week.',
          },
        ],
      }),
    );
    const result = await regenerateMandateDownstream({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).not.toBeNull();
    expect(result!.habits).toHaveLength(3);
    expect(result!.recurringTodos).toHaveLength(1);
    expect(result!.todos).toHaveLength(1);
  });

  it('returns null when combined downstream count is zero', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        habits: [
          { title: 'Daily walk', daysOfWeek: [0], rationale: 'A short rationale that fits inside the rationale word cap easily.' },
          { title: 'Strength training', daysOfWeek: [1,3,5], rationale: 'A second short rationale that fits inside the cap for this fixture.' },
        ],
        todos: [],
      }),
    );
    const result = await regenerateMandateDownstream({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });

  it('returns null when habit title overshoots the cap', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        habits: [
          { title: 'A b c d e', daysOfWeek: [0], rationale: 'Operationalizes the mandate effectively as a short daily moment in the morning routine.' }, // 5 words
          { title: 'Morning sit', daysOfWeek: [0], rationale: 'A second valid habit so only the first one triggers the cap rejection.' },
        ],
        todos: [
          { title: 'Plan something concrete this week', rationale: 'A reasonable rationale here.' },
          { title: 'Book one weekend with the kids', rationale: 'A second reasonable rationale.' },
        ],
      }),
    );
    const result = await regenerateMandateDownstream({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });

  it('returns null on chatCompletion failure', async () => {
    chatCompletionMock.mockRejectedValueOnce(new Error('proxy down'));
    const result = await regenerateMandateDownstream({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });
});

// ─── regenerateHabit ─────────────────────────────────────────────────────────

describe('regenerateHabit', () => {
  beforeEach(() => {
    chatCompletionMock.mockReset();
  });

  it('returns a new habit with the same slotId on valid response', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        title: 'Evening reflection',
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        rationale: 'Closes the day with the family mandate by naming what you saw and what you missed.',
      }),
    );
    const result = await regenerateHabit({ slotId: 'h-original-slot', mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).not.toBeNull();
    expect(result!.slotId).toBe('h-original-slot');
    expect(result!.mandateId).toBe(M1);
    expect(result!.title).toBe('Evening reflection');
    expect(result!.refreshCount).toBe(0);
  });

  it('returns null when habit title overshoots the cap', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        title: 'A b c d e',  // 5 words
        daysOfWeek: [0],
        rationale: 'A rationale that fits inside the cap to keep this fixture valid for the test.',
      }),
    );
    const result = await regenerateHabit({ slotId: 'h-slot', mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });

  it('returns null on chatCompletion failure', async () => {
    chatCompletionMock.mockRejectedValueOnce(new Error('proxy down'));
    const result = await regenerateHabit({ slotId: 'h-slot', mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });
});

// ─── regenerateTodo ──────────────────────────────────────────────────────────

describe('regenerateTodo', () => {
  beforeEach(() => {
    chatCompletionMock.mockReset();
  });

  it('returns a new todo with the same slotId on valid response', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        title: 'Plan one weekend activity with the kids',
        rationale: 'Turns presence into a deliberate choice on the calendar rather than a quiet wish.',
      }),
    );
    const result = await regenerateTodo({ slotId: 't-original-slot', mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).not.toBeNull();
    expect(result!.slotId).toBe('t-original-slot');
    expect(result!.mandateId).toBe(M1);
    expect(result!.refreshCount).toBe(0);
  });

  it('returns null when todo title overshoots the cap', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        title: 'a b c d e f g h i j k', // 11 words
        rationale: 'A rationale that fits inside the cap.',
      }),
    );
    const result = await regenerateTodo({ slotId: 't-slot', mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });

  it('returns null on chatCompletion failure', async () => {
    chatCompletionMock.mockRejectedValueOnce(new Error('proxy down'));
    const result = await regenerateTodo({ slotId: 't-slot', mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });
});

// ─── NEX-60 — three-bucket coverage ──────────────────────────────────────────

describe('parseRecommendationPayload — three-bucket (NEX-60)', () => {
  it('parses recurringTodos with daysOfWeek and links them to mandates', () => {
    const result = parseRecommendationPayload(validPayload());
    expect(result).not.toBeNull();
    expect(result!.recurringTodos).toHaveLength(2);
    expect(result!.recurringTodos[0].mandateId).toBe(M3);
    expect(result!.recurringTodos[0].daysOfWeek).toEqual([1, 3, 5]);
    expect(result!.recurringTodos[0].slotId).toMatch(/^rt-/);
    expect(result!.recurringTodos[0].refreshCount).toBe(0);
  });

  it('accepts a mandate whose only downstream actions are recurringTodos (zero todos)', () => {
    // M3 has 2 recurringTodos and 0 todos in the canonical fixture —
    // demonstrates that a mandate can satisfy the 2-3 downstream rule
    // entirely via the recurring bucket.
    const result = parseRecommendationPayload(validPayload());
    expect(result).not.toBeNull();
    expect(result!.recurringTodos.filter((rt) => rt.mandateId === M3)).toHaveLength(2);
    expect(result!.todos.filter((t) => t.mandateId === M3)).toHaveLength(0);
  });

  // NEX-57: combined downstream rule is 2-3 per mandate.
  it('rejects a mandate whose recurringTodos + todos combined exceed 3', () => {
    const raw = JSON.parse(validPayload());
    // M3 starts with 2 recurringTodos + 0 todos = 2. Push 2 more recurring
    // to bring combined to 4, which exceeds the 2-3 cap.
    raw.recurringTodos.push(
      {
        title: 'Walk the dog at dusk',
        daysOfWeek: [0,1,2,3,4,5,6],
        mandateId: M3,
        rationale: 'A third recurring intention that pushes the combined downstream count over the cap.',
      },
      {
        title: 'Foam roll before bed',
        daysOfWeek: [0,1,2,3,4,5,6],
        mandateId: M3,
        rationale: 'A fourth recurring intention that pushes the combined downstream count over the cap.',
      },
    );
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('rejects a recurringTodo whose mandateId is not in the mandate list', () => {
    const raw = JSON.parse(validPayload());
    raw.recurringTodos[0].mandateId = 'm-doesnotexist';
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
    expect(getLastParseFailReason()).toContain('does not match');
  });

  it('rejects a recurringTodo title at 9 words (over the 8-word cap)', () => {
    const raw = JSON.parse(validPayload());
    raw.recurringTodos[0].title = Array.from({ length: 9 }, (_, i) => String.fromCharCode(97 + i)).join(' ');
    expect(parseRecommendationPayload(JSON.stringify(raw))).toBeNull();
  });

  it('parses an optional dueDate on a todo when present', () => {
    const raw = JSON.parse(validPayload());
    raw.todos[0].dueDate = '2026-05-17';
    const result = parseRecommendationPayload(JSON.stringify(raw));
    expect(result).not.toBeNull();
    expect(result!.todos[0].dueDate).toBe('2026-05-17');
    expect(result!.todos[1].dueDate).toBeUndefined();
  });
});

describe('regenerateMandateDownstream — three-bucket (NEX-60)', () => {
  beforeEach(() => {
    chatCompletionMock.mockReset();
  });

  it('returns recurringTodos with daysOfWeek and stable slotIds', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        habits: [
          {
            title: 'Morning sit',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            rationale: 'Anchors the mandate in a single short practice before the day pulls attention apart.',
          },
          {
            title: 'Evening reflection',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            rationale: 'Closes the day with the mandate by naming what you saw and what you missed.',
          },
        ],
        recurringTodos: [
          {
            title: 'Walk three times this week',
            daysOfWeek: [1, 3, 5],
            rationale: 'A recurring intention without streak pressure that still gives the body cadence.',
          },
          {
            title: 'Stretch each evening briefly',
            daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
            rationale: 'A daily reset that asks nothing of you and gives the body a small moment.',
          },
        ],
        todos: [],
      }),
    );
    const result = await regenerateMandateDownstream({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).not.toBeNull();
    expect(result!.habits).toHaveLength(2);
    expect(result!.recurringTodos).toHaveLength(2);
    expect(result!.recurringTodos[0].mandateId).toBe(M1);
    expect(result!.recurringTodos[0].daysOfWeek).toEqual([1, 3, 5]);
    expect(result!.recurringTodos[0].slotId).toMatch(/^rt-/);
    expect(result!.todos).toHaveLength(0);
  });

  it('accepts a cascade payload that omits recurringTodos entirely', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        habits: [
          { title: 'Morning sit', daysOfWeek: [0], rationale: 'A short rationale that fits inside the cap.' },
          { title: 'Evening reflection', daysOfWeek: [0], rationale: 'A second short rationale that fits inside the cap.' },
        ],
        todos: [
          { title: 'Book one weekend activity for the kids', rationale: 'A reasonable concrete one-time action.' },
          { title: 'Schedule dinner with your spouse Friday', rationale: 'A second reasonable concrete one-time action.' },
        ],
      }),
    );
    const result = await regenerateMandateDownstream({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).not.toBeNull();
    expect(result!.habits).toHaveLength(2);
    expect(result!.recurringTodos).toHaveLength(0);
    expect(result!.todos).toHaveLength(2);
  });

  it('returns null when combined downstream count is zero', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        habits: [
          { title: 'Morning sit', daysOfWeek: [0], rationale: 'A short rationale that fits inside the cap.' },
          { title: 'Evening reflection', daysOfWeek: [0], rationale: 'A second short rationale that fits inside the cap.' },
        ],
        recurringTodos: [],
        todos: [],
      }),
    );
    const result = await regenerateMandateDownstream({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });

  // NEX-57: combined downstream rule is 2-3 (was 1-2 in NEX-60).
  it('returns null when combined downstream count exceeds 3', async () => {
    chatCompletionMock.mockResolvedValueOnce(
      JSON.stringify({
        habits: [
          { title: 'Morning sit', daysOfWeek: [0], rationale: 'A short rationale that fits inside the cap.' },
          { title: 'Evening reflection', daysOfWeek: [0], rationale: 'A second short rationale that fits inside the cap.' },
        ],
        recurringTodos: [
          { title: 'Walk three times this week', daysOfWeek: [1,3,5], rationale: 'A reasonable recurring rationale here.' },
          { title: 'Read one chapter each evening', daysOfWeek: [1,2,3,4,5], rationale: 'A reasonable second recurring rationale.' },
        ],
        todos: [
          { title: 'Book one weekend activity for the kids', rationale: 'A reasonable one-time rationale.' },
          { title: 'Schedule dinner with your spouse Friday', rationale: 'A second reasonable one-time rationale.' },
        ],
      }),
    );
    const result = await regenerateMandateDownstream({ mandate: MANDATE_FIXTURE, reflection: REFLECTION });
    expect(result).toBeNull();
  });
});
