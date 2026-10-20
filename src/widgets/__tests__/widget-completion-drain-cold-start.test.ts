/**
 * The drain's cold-start safety, and its limit.
 *
 * Unhydrated store (persist still reading AsyncStorage): every queued widget
 * tap would look like a tap for a deleted habit — dropped, and clearing the
 * queue would make that verdict permanent (user-reported: widget tap not
 * logged after opening the app, inconsistently — a hydration race). So an
 * unhydrated drain leaves the queue untouched for the next foreground.
 *
 * The guard keys on hydration ITSELF, never on an empty rule set: a hydrated
 * user can legitimately have zero habits (deleted them all), and then a stale
 * queued tap MUST drop+clear — otherwise it survives deletion and can apply
 * to a same-titled habit recreated later that day (Greptile P1 on #372).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getItem = vi.fn();
const setItem = vi.fn();
vi.mock('react-native-shared-group-preferences', () => ({
  default: { getItem, setItem },
}));

import { drainWidgetCompletions, PENDING_KEY } from '../widget-completion-drain';

const TODAY = '2026-08-04';
const tap = { id: 'a1', habitTitle: 'Meditation', dayKey: TODAY, at: 1 };

beforeEach(() => {
  getItem.mockReset();
  setItem.mockReset();
  getItem.mockResolvedValue(JSON.stringify([tap]));
});

describe('drainWidgetCompletions — cold-start guard', () => {
  it('leaves the queue untouched when the store is not hydrated yet', async () => {
    const logHabit = vi.fn();
    const state = { habitLog: [], recurringRules: [], logHabit };

    const result = await drainWidgetCompletions(() => state, TODAY, {
      isHydrated: () => false,
    });

    expect(result).toBeNull();
    expect(logHabit).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled(); // the tap survives for next foreground
  });

  it('applies and clears once hydrated with the habit present', async () => {
    const logHabit = vi.fn();
    const state = {
      habitLog: [],
      recurringRules: [{ title: 'Meditation', timesPerDay: 1 }],
      logHabit,
    };

    const result = await drainWidgetCompletions(() => state, TODAY, {
      isHydrated: () => true,
    });

    expect(logHabit).toHaveBeenCalledWith('Meditation');
    expect(setItem).toHaveBeenCalledWith(PENDING_KEY, '[]', expect.any(String));
    expect(result).toEqual({ applied: ['Meditation'] });
  });

  it('hydrated with ZERO habits (all deleted): the stale tap drops AND clears', async () => {
    // The P1 scenario: tap queued, then the final habit deleted. The tap must
    // not linger — a same-titled habit recreated later today must not inherit
    // a completion meant for the deleted one.
    const logHabit = vi.fn();
    const state = { habitLog: [], recurringRules: [], logHabit };

    const result = await drainWidgetCompletions(() => state, TODAY, {
      isHydrated: () => true,
    });

    expect(result).toBeNull();
    expect(logHabit).not.toHaveBeenCalled();
    expect(setItem).toHaveBeenCalledWith(PENDING_KEY, '[]', expect.any(String));
  });
});
