import { describe, it, expect, vi } from 'vitest';

// app-state.ts's runtime import chain pulls RN/Expo modules; the repo's vitest
// setup is pure-Node (see vitest.config.ts), so the three native-module edges
// are mocked here. Everything else (zustand store, reducers) runs for real.
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock('expo-constants', () => ({ default: { expoConfig: {} } }));

import { useAppState } from '../app-state';

// Regression guard for app/_layout.tsx's NotificationHandler effect, which
// keys its re-arm dep on the dailyWisdomQuotes ARRAY REFERENCE. That is only
// correct if every write path REPLACES the array (new reference) instead of
// mutating it in place — a content change must always imply a new reference.
describe('setDailyWisdom replace semantics', () => {
  it('replaces dailyWisdomQuotes with the passed array (new reference, no in-place mutation)', () => {
    const first = [{ quote: 'Begin.', author: 'A' }];
    useAppState.getState().setDailyWisdom(first, '2026-08-10', '');
    const afterFirst = useAppState.getState().dailyWisdomQuotes;
    expect(afterFirst).toBe(first);
    expect(afterFirst).toEqual([{ quote: 'Begin.', author: 'A' }]);

    const second = [{ quote: 'Again.', author: 'B' }];
    useAppState.getState().setDailyWisdom(second, '2026-08-10', 'win');
    const afterSecond = useAppState.getState().dailyWisdomQuotes;
    expect(afterSecond).toBe(second);
    expect(afterSecond).not.toBe(afterFirst);
    // The previous array was not mutated to match the new contents.
    expect(afterFirst).toEqual([{ quote: 'Begin.', author: 'A' }]);
    expect(useAppState.getState().dailyWisdomDate).toBe('2026-08-10');
    expect(useAppState.getState().dailyWisdomIntention).toBe('win');
  });

  it('setWisdomQuoteCount also clears via a fresh array reference', () => {
    useAppState.getState().setDailyWisdom([{ quote: 'Keep.', author: 'C' }], '2026-08-10', '');
    const before = useAppState.getState().dailyWisdomQuotes;
    useAppState.getState().setWisdomQuoteCount(3);
    const after = useAppState.getState().dailyWisdomQuotes;
    expect(after).toEqual([]);
    expect(after).not.toBe(before);
    // The old array is untouched.
    expect(before).toEqual([{ quote: 'Keep.', author: 'C' }]);
  });
});
