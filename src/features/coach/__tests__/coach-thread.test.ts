import { describe, expect, it } from 'vitest';
import {
  COACH_CONTEXT_MESSAGES,
  COACH_THREAD_CAP,
  appendMessage,
  clearPendingPlan,
  clearThread,
  coachMessageId,
  contextMessages,
  dropStalePlanOnRestore,
  emptyCoachThread,
  isCoachThreadEmpty,
  markPlanApplying,
  mergeCoachThreads,
  newestMessageAt,
  openerForDay,
  sanitizeCoachThread,
  setOpener,
  setPendingPlan,
  type CoachMessage,
  type CoachPendingPlan,
  type CoachThread,
} from '../coach-thread';

const msg = (i: number, role: 'user' | 'coach' = 'user', at = 1000 + i): CoachMessage => ({
  id: `m${i}`,
  role,
  text: `line ${i}`,
  at,
  kind: 'turn',
});

const plan = (createdAt = 5000, applyingAt: number | null = null): CoachPendingPlan => ({
  proposalKey: `k${createdAt}`,
  actions: [{ type: 'inbox_add', title: 'Read chapter 1' }],
  hasCalendar: false,
  createdAt,
  applyingAt,
});

function threadWith(n: number, extra: Partial<CoachThread> = {}): CoachThread {
  let t = emptyCoachThread();
  for (let i = 0; i < n; i += 1) t = appendMessage(t, msg(i, i % 2 ? 'coach' : 'user'));
  return { ...t, ...extra };
}

describe('appendMessage (S1.4)', () => {
  it('caps at COACH_THREAD_CAP, dropping the oldest, and keeps the pending plan', () => {
    const t = setPendingPlan(threadWith(COACH_THREAD_CAP), plan());
    const next = appendMessage(t, msg(999, 'user', 99999));
    expect(next.messages).toHaveLength(COACH_THREAD_CAP);
    expect(next.messages[0].id).toBe('m1');
    expect(next.messages[next.messages.length - 1].id).toBe('m999');
    expect(next.pendingPlan).toEqual(plan());
  });

  it('replaces a message with the same id instead of duplicating it', () => {
    const t = appendMessage(appendMessage(emptyCoachThread(), msg(1)), { ...msg(1), text: 'edited' });
    expect(t.messages).toHaveLength(1);
    expect(t.messages[0].text).toBe('edited');
  });
});

describe('contextMessages', () => {
  it('returns exactly the newest COACH_CONTEXT_MESSAGES', () => {
    const t = threadWith(15);
    const ctx = contextMessages(t);
    expect(ctx).toHaveLength(COACH_CONTEXT_MESSAGES);
    expect(ctx[0].id).toBe('m3');
    expect(ctx[ctx.length - 1].id).toBe('m14');
  });
});

describe('clearThread (S1.4)', () => {
  it('empties messages, plan and opener, sets the tombstone, keeps the speech preference', () => {
    const t = setOpener(setPendingPlan(threadWith(3, { speakReplies: true }), plan()), { text: 'Morning.', dayKey: '2026-09-02' });
    const cleared = clearThread(t, 777);
    expect(cleared.messages).toEqual([]);
    expect(cleared.pendingPlan).toBeNull();
    expect(cleared.pendingOpener).toBeNull();
    expect(cleared.clearedAt).toBe(777);
    expect(cleared.speakReplies).toBe(true);
    expect(isCoachThreadEmpty(cleared)).toBe(true);
  });
});

describe('pending plan lifecycle (S2.5)', () => {
  it('markPlanApplying stamps once and is idempotent', () => {
    const t = setPendingPlan(emptyCoachThread(), plan());
    const a = markPlanApplying(t, 10);
    const b = markPlanApplying(a, 20);
    expect(a.pendingPlan?.applyingAt).toBe(10);
    expect(b).toBe(a);
    expect(markPlanApplying(emptyCoachThread(), 5).pendingPlan).toBeNull();
  });

  it('clearPendingPlan drops it; dropStalePlanOnRestore drops only an applying plan', () => {
    const fresh = setPendingPlan(emptyCoachThread(), plan());
    expect(clearPendingPlan(fresh).pendingPlan).toBeNull();
    expect(dropStalePlanOnRestore(fresh)).toEqual({ thread: fresh, dropped: null });
    const applying = markPlanApplying(fresh, 10);
    const out = dropStalePlanOnRestore(applying);
    expect(out.thread.pendingPlan).toBeNull();
    expect(out.dropped?.applyingAt).toBe(10);
  });
});

describe('opener (S3.2)', () => {
  it('returns the stored opener only for its own day', () => {
    const t = setOpener(emptyCoachThread(), { text: 'Day open.', dayKey: '2026-09-02' });
    expect(openerForDay(t, '2026-09-02')?.text).toBe('Day open.');
    expect(openerForDay(t, '2026-09-03')).toBeNull();
  });
});

describe('sanitizeCoachThread (S1.6 shape contract)', () => {
  it('returns an empty thread for garbage', () => {
    expect(sanitizeCoachThread(undefined)).toEqual(emptyCoachThread());
    expect(sanitizeCoachThread('nope')).toEqual(emptyCoachThread());
    expect(sanitizeCoachThread([])).toEqual(emptyCoachThread());
  });

  it('drops malformed messages, dedupes ids, sorts by time, caps, and validates the plan', () => {
    const raw = {
      messages: [
        { id: 'b', role: 'coach', text: 'two', at: 2 },
        { id: 'a', role: 'user', text: 'one', at: 1, kind: 'opener' },
        { id: 'a', role: 'user', text: 'dupe', at: 3 },
        { id: 'c', role: 'alien', text: 'x', at: 4 },
        { id: 'd', role: 'user', text: 'no time' },
        'string',
      ],
      pendingPlan: { proposalKey: 'k', actions: [{ type: 'inbox_add', title: 'x' }, { nope: true }], createdAt: 9, applyingAt: 'soon' },
      pendingOpener: { text: 'hi', dayKey: '2026-09-02' },
      clearedAt: 'never',
      speakReplies: 'yes',
    };
    const t = sanitizeCoachThread(raw);
    expect(t.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(t.messages[0].kind).toBe('opener');
    expect(t.messages[1].kind).toBe('turn');
    expect(t.pendingPlan?.actions).toHaveLength(1);
    expect(t.pendingPlan?.applyingAt).toBeNull();
    expect(t.pendingOpener).toEqual({ text: 'hi', dayKey: '2026-09-02', at: 0 });
    expect(t.clearedAt).toBeNull();
    // Not a boolean: the default, which is on.
    expect(t.speakReplies).toBe(true);
  });

  it('spoken replies default on, and sanitize honours an explicit false on every write (the toggle and Clear must not undo it)', () => {
    expect(emptyCoachThread().speakReplies).toBe(true);
    expect(sanitizeCoachThread({ messages: [] }).speakReplies).toBe(true);
    // A fresh thread whose person tapped the speaker off: false stays false.
    const openerOnly = { messages: [{ id: 'o', role: 'coach', text: 'Morning.', at: 1, kind: 'opener' }], speakReplies: false };
    expect(sanitizeCoachThread(openerOnly).speakReplies).toBe(false);
    // Clear keeps the preference on an emptied thread.
    const cleared = clearThread(sanitizeCoachThread(openerOnly), 5);
    expect(sanitizeCoachThread(cleared).speakReplies).toBe(false);
    expect(sanitizeCoachThread({ ...openerOnly, speakReplies: true }).speakReplies).toBe(true);
  });

  it('every surviving row satisfies the type, whatever went in', () => {
    const t = sanitizeCoachThread({ messages: Array.from({ length: 80 }, (_, i) => ({ id: `m${i}`, role: 'user', text: String(i), at: i })) });
    expect(t.messages).toHaveLength(COACH_THREAD_CAP);
    for (const m of t.messages) {
      expect(typeof m.id).toBe('string');
      expect(['user', 'coach']).toContain(m.role);
      expect(typeof m.at).toBe('number');
    }
  });
});

describe('mergeCoachThreads (S1.5)', () => {
  it('keeps local when inbound is empty with no tombstone (fresh-device guard)', () => {
    const local = threadWith(3);
    expect(mergeCoachThreads(local, emptyCoachThread())).toEqual(local);
    expect(mergeCoachThreads(local, undefined)).toEqual(local);
  });

  it('a newer inbound tombstone clears the local thread', () => {
    const local = threadWith(3); // newest at 1002
    const out = mergeCoachThreads(local, { ...emptyCoachThread(), clearedAt: 5000 });
    expect(out.messages).toEqual([]);
    expect(out.pendingPlan).toBeNull();
    expect(out.clearedAt).toBe(5000);
  });

  it('an older inbound tombstone does not clear newer local messages', () => {
    const local = threadWith(3); // 1000..1002
    const out = mergeCoachThreads(local, { ...emptyCoachThread(), clearedAt: 500 });
    expect(out.messages).toHaveLength(3);
    expect(out.clearedAt).toBe(500);
  });

  it('a newer local tombstone beats older inbound messages', () => {
    const local = { ...emptyCoachThread(), clearedAt: 9000 };
    const inbound = threadWith(3);
    expect(mergeCoachThreads(local, inbound)).toEqual(local);
  });

  it('unions messages by id, sorted, capped, and restores an inbound thread onto an empty device', () => {
    const inbound = threadWith(4);
    const out = mergeCoachThreads(emptyCoachThread(), inbound);
    expect(out.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
    const local = appendMessage(emptyCoachThread(), msg(9, 'user', 1500));
    const merged = mergeCoachThreads(local, inbound);
    expect(merged.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm9']);
  });

  it('the newest tombstone prunes older content from BOTH sides on the union path', () => {
    // Device A cleared at 2000; device B kept talking after that (3000+) but
    // still carries the pre-clear messages (1000..1002), a pre-clear plan and
    // a pre-clear opener. Only the post-clear content survives on both.
    const local = { ...emptyCoachThread(), clearedAt: 2000 };
    let inbound = threadWith(3);
    inbound = appendMessage(inbound, msg(50, 'user', 3000));
    inbound = appendMessage(inbound, msg(51, 'coach', 3001));
    inbound = setOpener(setPendingPlan(inbound, plan(1500)), { text: 'old', dayKey: '2026-09-02', at: 1500 });
    const out = mergeCoachThreads(local, inbound);
    expect(out.messages.map((m) => m.id)).toEqual(['m50', 'm51']);
    expect(out.pendingPlan).toBeNull();
    expect(out.pendingOpener).toBeNull();
    expect(out.clearedAt).toBe(2000);
    // And the mirror: local has newer content, inbound carries a newer tombstone than local's old rows.
    const mirror = mergeCoachThreads(inbound, local);
    expect(mirror.messages.map((m) => m.id)).toEqual(['m50', 'm51']);
    expect(mirror.pendingPlan).toBeNull();
    // An opener-only device (no messages yet) receiving an OLDER tombstone keeps its fresh opener.
    const openerOnly = setOpener(emptyCoachThread(), { text: 'fresh', dayKey: '2026-09-02', at: 2500 });
    expect(mergeCoachThreads(openerOnly, { ...emptyCoachThread(), clearedAt: 2000 }).pendingOpener?.text).toBe('fresh');
    expect(mergeCoachThreads({ ...emptyCoachThread(), clearedAt: 2000 }, openerOnly).pendingOpener?.text).toBe('fresh');
    // A same-day opener stored AFTER the clear survives, so a cleared thread keeps its fresh line.
    const fresh = setOpener({ ...emptyCoachThread(), clearedAt: 2000 }, { text: 'fresh', dayKey: '2026-09-02', at: 2500 });
    expect(mergeCoachThreads(fresh, inbound).pendingOpener?.text).toBe('fresh');
  });

  it('prefers the newer pending plan, but a locally applying plan always wins', () => {
    const local = setPendingPlan(threadWith(1), plan(100));
    const inbound = setPendingPlan(threadWith(1), plan(200));
    expect(mergeCoachThreads(local, inbound).pendingPlan?.createdAt).toBe(200);
    const applying = markPlanApplying(local, 150);
    expect(mergeCoachThreads(applying, inbound).pendingPlan?.createdAt).toBe(100);
  });

  it('keeps the local speech preference and the newer opener', () => {
    const local = setOpener(threadWith(1, { speakReplies: true }), { text: 'old', dayKey: '2026-09-01', at: 1 });
    const inbound = setOpener(threadWith(1), { text: 'new', dayKey: '2026-09-02', at: 2 });
    const out = mergeCoachThreads(local, inbound);
    expect(out.speakReplies).toBe(true);
    expect(out.pendingOpener?.text).toBe('new');
  });
});

describe('helpers', () => {
  it('newestMessageAt is 0 for an empty thread', () => {
    expect(newestMessageAt(emptyCoachThread())).toBe(0);
    expect(newestMessageAt(threadWith(3))).toBe(1002);
  });

  it('coachMessageId is unique across rapid calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => coachMessageId(1)));
    expect(ids.size).toBe(50);
  });
});

describe('unmarkPlanApplying', () => {
  it('lifts the stamp so a bailed execution leaves the plan offered', async () => {
    const mod = await import('../coach-thread');
    const stamped = mod.markPlanApplying(mod.setPendingPlan(mod.emptyCoachThread(), plan()), 10);
    const lifted = mod.unmarkPlanApplying(stamped);
    expect(lifted.pendingPlan?.applyingAt).toBeNull();
    expect(mod.unmarkPlanApplying(lifted)).toBe(lifted);
    expect(mod.unmarkPlanApplying(mod.emptyCoachThread()).pendingPlan).toBeNull();
  });
});
