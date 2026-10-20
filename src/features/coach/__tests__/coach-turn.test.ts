import { describe, expect, it } from 'vitest';
import { COACH_SYSTEM_PROMPT } from '../../../ai/prompts';
import { MODELS } from '../../../utils/ai-models';
import {
  COACH_MODEL,
  SAFETY_HANDOFF_LINE,
  buildCoachContext,
  buildCoachMessages,
  checkReplyTone,
  classifySafety,
  coachResponseFormat,
  needsForActions,
  habitNamesOnly,
  parseCoachTurn,
} from '../coach-turn';
import { appendMessage, emptyCoachThread, type CoachMessage } from '../coach-thread';

const NOW = new Date(2026, 8, 2, 10, 0, 0, 0); // Wed 2026-09-02 10:00 local

const msg = (i: number, role: 'user' | 'coach', kind: CoachMessage['kind'] = 'turn'): CoachMessage => ({
  id: `m${i}`,
  role,
  text: `line ${i}`,
  at: 1000 + i,
  kind,
});

describe('COACH_MODEL', () => {
  it('is the COACH tier (NEX-305 no-dead-tier contract)', () => {
    expect(COACH_MODEL).toBe(MODELS.COACH);
    expect(coachResponseFormat('kimi-k2.6')).toEqual({ type: 'json_object' });
    expect(coachResponseFormat('gpt-4.1-mini').type).toBe('json_schema');
  });
});

describe('buildCoachContext (S1.1)', () => {
  const input = {
    name: 'J',
    todayKey: '2026-09-02',
    dayOfWeek: 'Wednesday',
    todayIntention: 'Ship the thread',
    habitPatterns: 'Read: 5/7 days, skipped Mon & Tue. Meditation: 7/7 days. Yoga: 2/7 days, skipped Wed & Thu',
    todayHabitProgress: '1 of 3 habits done',
    pendingTasks: 'Call the school',
    todayScore: 62,
    yesterdayScore: 40,
    weekAvgScore: 55,
    bestDayThisWeek: 'Monday (80)',
    topHabitReps: 'Meditation (142 reps)',
    mandatesSummary: 'PERSONAL: 2.',
    mandatesDetail: '- Be the steady one\n- Read daily',
  };

  it('never carries the skipped clause, the weakest day, or a per-habit ratio', () => {
    const ctx = buildCoachContext(input);
    expect(ctx).not.toMatch(/skipped/i);
    expect(ctx).not.toMatch(/Weakest day/);
    expect(ctx).not.toMatch(/\d+\/\d+ days/);
    expect(ctx).toContain('Habits: Read, Meditation, Yoga');
  });

  it('includes the mandates block exactly once and the intention', () => {
    const ctx = buildCoachContext(input);
    expect(ctx.split('Their mandates:').length - 1).toBe(1);
    expect(ctx).toContain('Be the steady one');
    expect(ctx).toContain('Today\'s intention: "Ship the thread"');
    expect(ctx).toContain('Best day: Monday (80)');
  });

  it('says so under Pause Mode and copes with an empty input', () => {
    expect(buildCoachContext({ pausedNow: true })).toContain('Pause Mode active');
    expect(buildCoachContext({})).toBe('');
  });

  it('habitNamesOnly keeps names, drops ratios, clauses and a paused marker', () => {
    expect(habitNamesOnly('Yoga: 2/7 days, skipped Wed & Thu')).toBe('Yoga');
    expect(habitNamesOnly('A: 1/7 days, skipped Mon. B: 7/7 days.')).toBe('A, B');
    expect(habitNamesOnly('Read: paused. Meditation: 7/7 days')).toBe('Read, Meditation');
  });
});

describe('buildCoachMessages (S1.1)', () => {
  it('sends the coach system prompt with the context, exactly the last 12 turns, and the new line', () => {
    let thread = emptyCoachThread();
    for (let i = 0; i < 15; i += 1) thread = appendMessage(thread, msg(i, i % 2 ? 'coach' : 'user'));
    const out = buildCoachMessages({ context: 'Name: J.', thread, userText: 'new line' });
    expect(out[0].role).toBe('system');
    expect(out[0].content.startsWith(COACH_SYSTEM_PROMPT)).toBe(true);
    expect(out[0].content).toContain('What you know:\nName: J.');
    expect(out).toHaveLength(1 + 12 + 1);
    expect(out[1].content).toBe('line 3');
    expect(out[out.length - 2].content).toBe('line 14');
    expect(out[out.length - 1]).toEqual({ role: 'user', content: 'new line' });
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(6);
  });

  it('skips thread notes and the opener (neither is a prior turn of the conversation)', () => {
    let thread = appendMessage(emptyCoachThread(), msg(0, 'coach', 'opener'));
    thread = appendMessage(thread, msg(1, 'user'));
    thread = appendMessage(thread, msg(2, 'coach', 'note'));
    const out = buildCoachMessages({ context: '', thread, userText: 'x' });
    expect(out.map((m) => m.content)).toEqual([out[0].content, 'line 1', 'x']);
    expect(out[1].role).toBe('user');
    expect(out[0].content).toContain('(nothing yet)');
  });

  it('classifyTurnError sorts timeouts, offline and forwarded API failures', async () => {
    const { classifyTurnError, failedTurnLine } = await import('../coach-turn');
    const t = new Error('x'); t.name = 'AiTimeoutError';
    expect(classifyTurnError(t)).toEqual({ line: 'timeout', kind: 'timeout', status: null });
    expect(classifyTurnError(new Error('Network request failed')).line).toBe('offline');
    expect(classifyTurnError(new Error('AI request failed (400): bad'))).toEqual({ line: 'invalid-json', kind: 'ai_request_failed', status: 400 });
    expect(classifyTurnError('?').kind).toBe('error');
    expect(failedTurnLine('timeout')).toMatch(/too long/);
    expect(failedTurnLine('offline')).not.toMatch(/[!—]/);
  });

  it('classifyTurnError keeps a wedged session lookup distinct from a slow network (builds 255/256)', async () => {
    const { classifyTurnError, failureCode } = await import('../coach-turn');
    const s = new Error('Auth session lookup timed out.'); s.name = 'SessionTimeoutError';
    // Same retry line for the person, a different kind for the report: the
    // request never left the phone, which is not what "timeout" says.
    expect(classifyTurnError(s)).toEqual({ line: 'timeout', kind: 'session-timeout', status: null });
    expect(classifyTurnError(new Error('AI returned no content')).kind).toBe('no-content');
    expect(failureCode('session-timeout')).toBe('session-timeout');
    expect(failureCode('ai_request_failed', { status: 401 })).toBe('http 401');
    expect(failureCode('ai_request_failed', { status: null })).toBe('http');
    expect(failureCode('tone', { violations: ['em-dash', 'command'] })).toBe('tone: em-dash, command');
    expect(failureCode('invalid-json')).toBe('invalid-json');
    expect(failureCode('error')).toBe('unknown');
  });
});

describe('classifySafety (S1.3)', () => {
  it('hits the vocabularies', () => {
    expect(classifySafety("I don't want to be alive anymore").category).toBe('self-harm');
    expect(classifySafety('he hits me when he drinks').category).toBe('abuse');
    expect(classifySafety('my dad is having chest pain right now').category).toBe('medical');
    expect(classifySafety('I am going to hurt him for real').category).toBe('harm-to-others');
  });

  it('does not hit ordinary talk', () => {
    for (const t of ['killing it at work today', 'my daughter is thirteen and her environment is inconsistent', 'I feel stuck', 'this deadline is brutal']) {
      expect(classifySafety(t).hit, t).toBe(false);
    }
  });

  it('the hand-off line obeys §18', () => {
    expect(SAFETY_HANDOFF_LINE).not.toMatch(/[!—]/);
    expect(checkReplyTone(SAFETY_HANDOFF_LINE).ok).toBe(true);
  });
});

describe('checkReplyTone (S1.2)', () => {
  it('flags absence counts, commands, exclamation, em dash, diagnosis', () => {
    expect(checkReplyTone("You haven't logged yoga in 4 days.").violations).toContain('absence-count');
    expect(checkReplyTone('You missed three sessions this week.').violations).toContain('absence-count');
    expect(checkReplyTone('You need to call her tonight.').violations).toContain('command');
    expect(checkReplyTone("Don't forget the school meeting.").violations).toContain('command');
    expect(checkReplyTone('Great start!').violations).toContain('exclamation');
    expect(checkReplyTone('One rep — that is enough.').violations).toContain('em-dash');
    expect(checkReplyTone('It sounds like you have ADHD.').violations).toContain('diagnosis');
  });

  it('passes on-voice replies', () => {
    for (const r of [
      'Thirteen, and the ground keeps moving. What does a good week look like right now?',
      'Here is a first shape. It is small on purpose.',
      'One rep. The next one is tomorrow at six.',
      'Five of seven days on reading. That holds.',
    ]) {
      expect(checkReplyTone(r), r).toEqual({ ok: true, violations: [] });
    }
  });
});

describe('parseCoachTurn', () => {
  const user = 'help me build a game plan for my daughter';

  it('fails open on invalid JSON and a missing reply (never silence)', () => {
    expect(parseCoachTurn('not json', { userText: user, now: NOW })).toEqual({ kind: 'failed', reason: 'invalid-json' });
    expect(parseCoachTurn('{"plan": null}', { userText: user, now: NOW })).toEqual({ kind: 'failed', reason: 'missing-reply' });
    expect(parseCoachTurn('{"reply": "   ", "plan": null}', { userText: user, now: NOW })).toEqual({ kind: 'failed', reason: 'missing-reply' });
  });

  it('a tone violation is a failed turn with the violation named', () => {
    const out = parseCoachTurn('{"reply": "You need to try harder!", "plan": null}', { userText: user, now: NOW });
    expect(out.kind).toBe('failed');
    if (out.kind === 'failed') {
      expect(out.reason).toBe('tone');
      expect(out.violations).toEqual(expect.arrayContaining(['command', 'exclamation']));
    }
  });

  it('an object wrapped in a sentence still parses; prose with no object does not', () => {
    expect(parseCoachTurn('Sure, here it is: {"reply": "What does a good week look like?", "plan": null} Hope that helps.', { userText: user, now: NOW }))
      .toEqual({ kind: 'reply', reply: 'What does a good week look like?' });
    expect(parseCoachTurn('I cannot produce that.', { userText: user, now: NOW })).toEqual({ kind: 'failed', reason: 'invalid-json' });
  });

  it('a plain reply, a null plan, and an empty actions array are all a reply (S2.3)', () => {
    expect(parseCoachTurn('```json\n{"reply": "What does a good week look like?", "plan": null}\n```', { userText: user, now: NOW }))
      .toEqual({ kind: 'reply', reply: 'What does a good week look like?' });
    expect(parseCoachTurn('{"reply": "Tell me more.", "plan": {"actions": []}}', { userText: user, now: NOW }).kind).toBe('reply');
  });

  it('a high-tier plan is returned awaiting the tap, with a proposal key and the calendar flag (S2.2)', () => {
    const raw = JSON.stringify({
      reply: 'Here is a first shape.',
      plan: {
        actions: [
          { type: 'recurring_add', title: 'Ten minutes with her, phones away', daysOfWeek: [1, 3, 5], preferredTimeBlock: 'evening', confidence: 'high', explanation: 'x' },
          { type: 'inbox_add', title: 'Read: The Whole-Brain Child, chapter 1', description: 'Siegel and Bryson', confidence: 'high', explanation: 'x' },
        ],
      },
    });
    const out = parseCoachTurn(raw, { userText: user, now: NOW });
    expect(out.kind).toBe('plan');
    if (out.kind === 'plan') {
      expect(out.plan.actions.map((a) => a.type)).toEqual(['recurring_add', 'inbox_add']);
      expect(out.plan.proposalKey).toMatch(/recurring_add/);
      expect(out.plan.hasCalendar).toBe(false);
      expect(out.plan.applyingAt).toBeNull();
      expect(out.plan.createdAt).toBe(NOW.getTime());
    }
  });

  it('an unknown action type is downgraded to inbox_add by coerceAction (S2.1)', () => {
    const raw = JSON.stringify({ reply: 'One thing.', plan: { actions: [{ type: 'check_in', title: 'How did it go?', confidence: 'high', explanation: 'x' }] } });
    const out = parseCoachTurn(raw, { userText: user, now: NOW });
    expect(out.kind).toBe('plan');
    if (out.kind === 'plan') expect(out.plan.actions[0].type).toBe('inbox_add');
  });

  it('a low-confidence plan yields needs, no executable actions (S2.2)', () => {
    const raw = JSON.stringify({ reply: 'A start.', plan: { actions: [{ type: 'recurring_add', title: 'Yoga', confidence: 'low', missingFields: ['daysOfWeek'], explanation: 'x' }] } });
    const out = parseCoachTurn(raw, { userText: user, now: NOW });
    expect(out.kind).toBe('needs');
    if (out.kind === 'needs') expect(out.needs).toEqual(['Yoga: needs daysOfWeek']);
  });

  it('a check-in whose date the coach chose is a plan: the card tap is the confirm (S2.7)', () => {
    const raw = JSON.stringify({
      reply: 'Here is a first shape.',
      plan: {
        actions: [
          { type: 'recurring_add', title: 'Ten minutes with her', daysOfWeek: [1, 3, 5], preferredTimeBlock: 'evening', confidence: 'high', explanation: 'x' },
          { type: 'todo_add', title: 'How did the ten minutes go this week?', dateStr: '2026-09-09', time: '20:00', confidence: 'high', explanation: 'x' },
        ],
      },
    });
    const out = parseCoachTurn(raw, { userText: user, now: NOW });
    expect(out.kind).toBe('plan');
    if (out.kind === 'plan') {
      expect(out.plan.actions.map((a) => a.type)).toEqual(['recurring_add', 'todo_add']);
      expect(out.plan.actions[1].dateStr).toBe('2026-09-09');
    }
  });

  it('a check-in the coach did NOT date, or dated at medium confidence, is a need', () => {
    const undated = JSON.stringify({ reply: 'A check-in.', plan: { actions: [{ type: 'todo_add', title: 'How did it go?', confidence: 'high', explanation: 'x' }] } });
    expect(parseCoachTurn(undated, { userText: user, now: NOW }).kind).toBe('needs');
    const unsure = JSON.stringify({ reply: 'A check-in.', plan: { actions: [{ type: 'todo_add', title: 'How did it go?', dateStr: '2026-09-09', confidence: 'medium', explanation: 'x' }] } });
    expect(parseCoachTurn(unsure, { userText: user, now: NOW }).kind).toBe('needs');
  });

  it('needsForActions names the title and the missing fields', () => {
    expect(needsForActions([{ type: 'recurring_add', title: 'Yoga' }])).toEqual(['Yoga: needs one more detail']);
  });
});
