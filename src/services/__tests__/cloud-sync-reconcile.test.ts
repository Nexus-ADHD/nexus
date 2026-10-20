import { describe, expect, it } from 'vitest';
import { CLOUD_SYNC_PAYLOAD_KEYS } from '../cloud-sync-payload';
import { CLOUD_SYNC_FIELD_POLICIES, reconcileCloudState } from '../cloud-sync-reconcile';

const row = (id: string, title = id) => ({ id, title });
const merge = (base: any, local: any, remote: any) => reconcileCloudState(base, local, remote);

describe('sync field policy inventory', () => {
  it('assigns a policy to every and only outbound field', () => {
    expect(Object.keys(CLOUD_SYNC_FIELD_POLICIES).sort()).toEqual([...CLOUD_SYNC_PAYLOAD_KEYS].sort());
  });
});

describe('baseline-aware reconciliation', () => {
  it.each([null, '2026-09-06', '2026-09-13'])(
    'preserves and deduplicates same-week additions with baseline week %s', (baselineDate) => {
      const base = baselineDate === null ? null : { weeklyWins: ['shared'], weeklyWinsDate: baselineDate };
      const local = { weeklyWins: ['shared', 'phone'], weeklyWinsDate: '2026-09-13' };
      const remote = { weeklyWins: ['shared', 'tablet'], weeklyWinsDate: '2026-09-13' };
      const result = merge(base, local, remote);
      expect(result.payload).toEqual({ weeklyWins: ['phone', 'shared', 'tablet'], weeklyWinsDate: '2026-09-13' });
      expect(result.payload).toEqual(merge(base, remote, local).payload);
      expect(result.conflicts).toEqual([]);
    },
  );

  it('preserves trusted same-week removals without treating last week as deletion history', () => {
    const base = { weeklyWins: ['removed', 'shared'], weeklyWinsDate: '2026-09-13' };
    const local = { ...base, weeklyWins: ['shared', 'phone'] };
    const remote = { ...base, weeklyWins: [...base.weeklyWins, 'tablet'] };
    expect(merge(base, local, remote).payload.weeklyWins).toEqual(['phone', 'shared', 'tablet']);
    expect(merge({ ...base, weeklyWinsDate: '2026-09-06' }, local, remote).payload.weeklyWins)
      .toEqual(['phone', 'removed', 'shared', 'tablet']);
    const cleared = merge(base, { ...base, weeklyWins: [] }, base);
    expect(cleared.payload.weeklyWins).toEqual([]);
    expect(cleared.allowEmptyFields).toContain('weeklyWins');
  });

  it('never combines wins from different weeks or replaces a new-install restore with a merge', () => {
    const base = { weeklyWins: ['old'], weeklyWinsDate: '2026-09-06' };
    const local = { weeklyWins: ['phone'], weeklyWinsDate: '2026-09-13' };
    const remote = { weeklyWins: ['tablet'], weeklyWinsDate: '2026-09-20' };
    const result = merge(base, local, remote);
    expect([local, remote]).toContainEqual(result.payload);
    expect(result.payload).toEqual(merge(base, remote, local).payload);
    expect(reconcileCloudState(null, local, { ...remote, weeklyWinsDate: local.weeklyWinsDate }, true).payload)
      .toEqual({ ...remote, weeklyWinsDate: local.weeklyWinsDate });
  });

  it.each(['inbox', 'recurringRules', 'recurringToDos', 'pillars', 'leadTimeActions', 'horizonReviews', 'badges'])(
    'preserves independent additions and edits within %s', (field) => {
      const base = { [field]: [row('base')] };
      const local = { [field]: [row('base', 'edited'), row('phone')] };
      const remote = { [field]: [row('base'), row('tablet')] };
      expect(merge(base, local, remote).payload[field]).toEqual([row('base', 'edited'), row('phone'), row('tablet')]);
    },
  );

  it('merges disjoint edits to the same entity without a conflict', () => {
    const base = { inbox: [{ id: 'a', title: 'before', completed: false }] };
    const local = { inbox: [{ id: 'a', title: 'after', completed: false }] };
    const remote = { inbox: [{ id: 'a', title: 'before', completed: true }] };
    const result = merge(base, local, remote);
    expect(result.payload.inbox).toEqual([{ id: 'a', title: 'after', completed: true }]);
    expect(result.conflicts).toEqual([]);
  });

  it('uses a symmetric tie and reports conflicting values for recovery', () => {
    const base = { inbox: [row('a', 'original')] };
    const left = { inbox: [row('a', 'alpha')] };
    const right = { inbox: [row('a', 'omega')] };
    const first = merge(base, left, right);
    expect(first.payload).toEqual(merge(base, right, left).payload);
    expect(first.payload.inbox).toEqual([row('a', 'omega')]);
    expect(first.conflicts).toEqual(['inbox.a.title']);
  });

  it('allows trusted last-entity removal but retains unknown empty-install defenses', () => {
    const local = { inbox: [row('a')], recurringRules: [row('rule')] };
    const remote = { inbox: [], recurringRules: [] };
    const known = merge(local, local, remote);
    expect(known.payload.inbox).toEqual([]);
    expect(known.payload.recurringRules).toEqual([]);
    expect(known.allowEmptyFields.sort()).toEqual(['inbox', 'recurringRules']);
    const unknown = merge(null, local, remote);
    expect(unknown.payload.inbox).toEqual(local.inbox);
    expect(unknown.allowEmptyFields).toEqual([]);
    expect(unknown.unknownHistory).toBe(true);
  });

  it('retains edits in delete-versus-edit and marks a conflict', () => {
    const base = { inbox: [row('a')] };
    const local = { inbox: [] };
    const remote = { inbox: [row('a', 'edited')] };
    expect(merge(base, local, remote).payload.inbox).toEqual(remote.inbox);
    expect(merge(base, remote, local).payload.inbox).toEqual(remote.inbox);
    expect(merge(base, local, remote).conflicts).toContain('inbox.a');
  });

  it('merges daily task and Orbit map buckets by entity id', () => {
    for (const field of ['dailyTasks', 'orbitDays']) {
      const base = { [field]: { monday: [row('a')] } };
      const local = { [field]: { monday: [row('a'), row('b')], tuesday: [row('c')] } };
      const remote = { [field]: { monday: [row('a'), row('d')], wednesday: [row('e')] } };
      const result = merge(base, local, remote).payload[field];
      expect(result.monday).toEqual([row('a'), row('b'), row('d')]);
      expect(result.tuesday).toEqual([row('c')]);
      expect(result.wednesday).toEqual([row('e')]);
    }
  });

  it('reconciles map-key deletions and primitive sets with a baseline', () => {
    const base = { goalHabitMap: { habit: ['a', 'b'], removed: ['x'] } };
    const local = { goalHabitMap: { habit: ['a', 'b', 'c'] } };
    const remote = { goalHabitMap: { habit: ['b', 'd'], removed: ['x'] } };
    expect(merge(base, local, remote).payload.goalHabitMap).toEqual({ habit: ['b', 'c', 'd'] });
  });

  it('reconciles overrides by ruleId, and quote history by stable content identity', () => {
    const base = { nextWeekRuleOverrides: { day: [{ ruleId: 'a', title: 'before' }] }, recentWisdomHistory: [] };
    const quote = { dateKey: 'day', quote: 'a', author: 'author' };
    const local = { ...base, nextWeekRuleOverrides: { day: [{ ruleId: 'a', title: 'local' }] }, recentWisdomHistory: [quote] };
    const remote = { ...base, nextWeekRuleOverrides: { day: [...base.nextWeekRuleOverrides.day, { ruleId: 'b', title: 'new' }] }, recentWisdomHistory: [{ ...quote, quote: 'b' }] };
    const result = merge(base, local, remote).payload;
    expect(result.nextWeekRuleOverrides.day).toEqual([{ ruleId: 'a', title: 'local' }, { ruleId: 'b', title: 'new' }]);
    expect(result.recentWisdomHistory).toHaveLength(2);
    expect(result.recentWisdomHistory.every((entry: any) => !('__syncId' in entry))).toBe(true);
  });

  it('keeps intention text/date/completion and other dated values coherent', () => {
    const base = { morningIntention: 'before', morningIntentionDate: 'day-1', morningIntentionCompletedDate: null };
    const local = { morningIntention: 'z-local', morningIntentionDate: 'day-2', morningIntentionCompletedDate: 'day-2' };
    const remote = { morningIntention: 'a-remote', morningIntentionDate: 'day-3', morningIntentionCompletedDate: null };
    expect(merge(base, local, remote).payload).toEqual(local);
    expect(merge(base, remote, local).payload).toEqual(local);
    expect(merge(null, local, { morningIntention: null, morningIntentionDate: null, morningIntentionCompletedDate: null }).payload).toEqual(local);
  });

  it('keeps a streak count paired with the date from that same side', () => {
    const base = { habitStreaks: { run: 3 }, habitStreakUpdatedDate: { run: '2026-09-10' } };
    const local = { habitStreaks: { run: 4 }, habitStreakUpdatedDate: { run: '2026-09-11' } };
    const remote = { habitStreaks: { run: 0 }, habitStreakUpdatedDate: { run: '2026-09-12' } };
    expect(merge(base, local, remote).payload).toEqual(local);
    expect(merge(base, remote, local).payload).toEqual(local);
  });

  it('removes known stale streak keys after rename without treating legacy omission as deletion', () => {
    const base = { habitStreaks: { old: 3 }, habitStreakUpdatedDate: { old: 'day' } };
    const remote = { habitStreaks: { renamed: 3 }, habitStreakUpdatedDate: { renamed: 'day' } };
    expect(merge(base, base, remote).payload).toEqual(remote);
    expect(merge(base, base, {}).payload).toEqual(base);
  });

  it('opts into exact habitLog replacement only with a trusted valid baseline', () => {
    const base = { habitLog: [{ id: 'a', timestamp: 10 }, { id: 'b', timestamp: 20 }] };
    const local = { habitLog: [...base.habitLog, { id: 'c', timestamp: 30 }] };
    const remote = { habitLog: [{ id: 'b', timestamp: 20 }] };
    const result = merge(base, local, remote);
    expect(result.payload.habitLog).toEqual([{ id: 'b', timestamp: 20 }, { id: 'c', timestamp: 30 }]);
    expect(result.reconciledHabitLog).toBe(true);
    expect(merge(null, local, remote).reconciledHabitLog).toBe(false);
  });

  it('adds XP for distinct proven completion events and dedupes the same event', () => {
    const base = { habitLog: [], totalXP: 100 };
    const local = { habitLog: [{ id: 'a' }], totalXP: 110 };
    const remote = { habitLog: [{ id: 'b' }], totalXP: 110 };
    const result = reconcileCloudState(base, local, remote, false, 10);
    expect(result.payload.totalXP).toBe(120);
    expect(result.conflicts).not.toContain('totalXP');
    expect(reconcileCloudState(base, local, local, false, 10).payload.totalXP).toBe(110);
  });

  it('subtracts distinct proven undos and does not sum ambiguous arbitrary rewards', () => {
    const base = { habitLog: [{ id: 'a' }, { id: 'b' }], totalXP: 120 };
    const local = { habitLog: [{ id: 'a' }], totalXP: 110 };
    const remote = { habitLog: [{ id: 'b' }], totalXP: 110 };
    expect(reconcileCloudState(base, local, remote, false, 10).payload.totalXP).toBe(100);
    const ambiguous = reconcileCloudState(base, { ...local, totalXP: 130 }, { ...remote, totalXP: 140 }, false, 10);
    expect(ambiguous.payload.totalXP).toBe(140);
    expect(ambiguous.conflicts).toContain('totalXP');
  });

  it('passes Coach, consent and activation to their specialized existing mergers', () => {
    const remote = { coachThread: { clearedAt: 50, messages: [] }, weeklyEmailConsent: 'denied', weeklyEmailConsentUpdatedAt: 'new', activatedDate: 'oldest' };
    expect(merge(null, { coachThread: { messages: [row('a')] }, weeklyEmailConsent: 'granted', activatedDate: 'newer' }, remote).payload).toEqual(remote);
  });

  it('does not treat absent fields in an older payload as top-level clears', () => {
    const base = { softMode: true, inbox: [row('a')] };
    expect(merge(base, base, { inbox: [row('a')] }).payload.softMode).toBe(true);
  });

  it('never imports foreign timezone/quote-cache values into the local device', () => {
    const local = { timezone: 'local', dailyWisdomQuotes: ['local'], dailyWisdomDate: 'local' };
    expect(merge(null, local, { timezone: 'remote', dailyWisdomQuotes: ['remote'], dailyWisdomDate: 'remote' }).payload).toEqual(local);
  });
});
