import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  connectExternalCalendar,
  deleteExternalCalendarToken,
  fetchExternalCalendarEvents,
  type ExternalCalendarAccount,
  type ExternalCalendarEvent,
  type ExternalCalendarProvider,
} from '../services/external-calendars';

interface CalendarSourcesState {
  accounts: ExternalCalendarAccount[];
  eventsWindow: ExternalCalendarEvent[];
  lastSyncedAt: number | null;
  syncError: string | null;
  connectProvider: (provider: ExternalCalendarProvider) => Promise<ExternalCalendarAccount>;
  disconnectAccount: (accountId: string) => Promise<void>;
  syncWindow: (startDate: Date, endDate: Date) => Promise<ExternalCalendarEvent[]>;
  clearEventsWindow: () => void;
}

export const useCalendarSourcesStore = create<CalendarSourcesState>()(
  persist(
    (set, get) => ({
      accounts: [],
      eventsWindow: [],
      lastSyncedAt: null,
      syncError: null,

      connectProvider: async (provider) => {
        const account = await connectExternalCalendar(provider);
        set((state) => {
          const withoutExisting = state.accounts.filter(
            (a) => !(a.provider === account.provider && a.externalAccountId === account.externalAccountId),
          );
          return {
            accounts: [account, ...withoutExisting],
            syncError: null,
          };
        });
        return account;
      },

      disconnectAccount: async (accountId) => {
        await deleteExternalCalendarToken(accountId);
        set((state) => ({
          accounts: state.accounts.filter((account) => account.id !== accountId),
          eventsWindow: state.eventsWindow.filter((event) => event.providerAccountId !== accountId),
        }));
      },

      syncWindow: async (startDate, endDate) => {
        const accounts = get().accounts;
        if (!accounts.length) {
          set({ eventsWindow: [], lastSyncedAt: Date.now(), syncError: null });
          return [];
        }

        const results = await Promise.allSettled(
          accounts.map((account) => fetchExternalCalendarEvents(account, startDate, endDate)),
        );

        const events = results
          .filter((result): result is PromiseFulfilledResult<ExternalCalendarEvent[]> => result.status === 'fulfilled')
          .flatMap((result) => result.value)
          .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());

        const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
        const now = Date.now();
        set((state) => ({
          eventsWindow: events,
          lastSyncedAt: now,
          syncError: rejected?.reason instanceof Error ? rejected.reason.message : null,
          accounts: state.accounts.map((account) => ({ ...account, lastSyncedAt: now })),
        }));

        return events;
      },

      clearEventsWindow: () => set({ eventsWindow: [] }),
    }),
    {
      name: 'nexus-calendar-sources-store',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        accounts: state.accounts,
        lastSyncedAt: state.lastSyncedAt,
      }),
    },
  ),
);

export type { ExternalCalendarAccount, ExternalCalendarEvent, ExternalCalendarProvider };

