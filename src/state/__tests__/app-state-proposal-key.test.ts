import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppState } from '../app-state';

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.delete(key);
    }),
  },
}));

vi.mock('../../services/analytics', () => ({
  emitHabitLogged: vi.fn(),
  emitTodoCleared: vi.fn(),
  trackEvent: vi.fn(),
}));

describe('addInboxTask proposal receipts', () => {
  beforeEach(() => {
    storage.clear();
    useAppState.setState({ inbox: [] });
  });

  it('returns the existing id and does not insert a duplicate proposal', () => {
    const options = {
      source: 'manual' as const,
      status: 'NEW',
      proposalKey: 'plaud:reviewed-import-flow-v1:thumbnail-intro',
    };
    const firstId = useAppState.getState().addInboxTask('Finish the thumbnail', options);
    const secondId = useAppState.getState().addInboxTask('Duplicate title', options);

    expect(secondId).toBe(firstId);
    expect(useAppState.getState().inbox).toHaveLength(1);
    expect(useAppState.getState().inbox[0]).toMatchObject({
      id: firstId,
      title: 'Finish the thumbnail',
      proposalKey: options.proposalKey,
    });
  });
});
