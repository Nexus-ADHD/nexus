import { Platform } from 'react-native';
import * as Calendar from 'expo-calendar';
import { useCalendarSourcesStore, type ExternalCalendarEvent } from '../state/calendar-sources-store';
import { useAppState } from '../state/app-state';

export type ConnectedCalendarProvider = 'apple' | 'google' | 'outlook';

function isIOS(): boolean {
  return Platform.OS === 'ios';
}

export interface ConnectedCalendarEvent {
  id: string;
  title: string;
  time?: string;
  startDate: string;
  endDate: string;
  startISO: string;
  endISO: string;
  allDay?: boolean;
  notes?: string | null;
  location?: string | null;
  url?: string | null;
  calendarColor?: string | null;
  calendarId?: string | null;
  calendarName?: string | null;
  provider: ConnectedCalendarProvider;
  source: 'apple_calendar' | 'external_calendar';
  cal: string;
}

function toDisplayTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function mapAppleEvent(event: any, colorByCalendarId: Record<string, string>): ConnectedCalendarEvent {
  const startISO = new Date(event.startDate).toISOString();
  const endISO = new Date(event.endDate ?? event.startDate).toISOString();
  return {
    id: String(event.id),
    title: String(event.title || 'Untitled event'),
    time: toDisplayTime(startISO),
    startDate: startISO,
    endDate: endISO,
    startISO,
    endISO,
    allDay: event.allDay ?? false,
    notes: event.notes ?? null,
    location: event.location ?? null,
    url: event.url ?? null,
    calendarColor: event.calendarId ? (colorByCalendarId[event.calendarId] ?? null) : null,
    calendarId: event.calendarId ?? null,
    calendarName: event.calendarId ?? null,
    provider: 'apple',
    source: 'apple_calendar',
    cal: 'APPLE CALENDAR',
  };
}

export async function fetchAppleCalendarEventsWindow(
  startDate: Date,
  endDate: Date,
): Promise<ConnectedCalendarEvent[]> {
  // EventKit is iOS-only. Without this guard, on Android expo-calendar would
  // query the device calendar and we'd mislabel those events provider:'apple'.
  if (!isIOS()) return [];

  const permission = await Calendar.requestCalendarPermissionsAsync();
  if (permission.status !== 'granted') return [];

  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const calendarIds = calendars.map((calendar: any) => calendar.id).filter(Boolean);
  if (!calendarIds.length) return [];

  const colorByCalendarId: Record<string, string> = {};
  calendars.forEach((calendar: any) => {
    if (calendar.id && calendar.color) colorByCalendarId[calendar.id] = calendar.color;
  });

  const events = await Calendar.getEventsAsync(calendarIds, startDate, endDate);
  return events.map((event: any) => mapAppleEvent(event, colorByCalendarId));
}

function mapExternalEvent(event: ExternalCalendarEvent): ConnectedCalendarEvent {
  return {
    ...event,
    time: toDisplayTime(event.startDate),
    provider: event.provider,
    source: 'external_calendar',
  };
}

export async function fetchConnectedCalendarEventsWindow(input: {
  startDate: Date;
  endDate: Date;
  includeApple?: boolean;
}): Promise<ConnectedCalendarEvent[]> {
  const includeApple = input.includeApple !== false;
  const batches = await Promise.allSettled([
    includeApple
      ? fetchAppleCalendarEventsWindow(input.startDate, input.endDate)
      : Promise.resolve([]),
    useCalendarSourcesStore
      .getState()
      .syncWindow(input.startDate, input.endDate)
      .then((events) => events.map(mapExternalEvent)),
  ]);

  return batches
    .filter((result): result is PromiseFulfilledResult<ConnectedCalendarEvent[]> => result.status === 'fulfilled')
    .flatMap((result) => result.value)
    .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
}

/**
 * App-level calendar refresher. Fetches the today+tomorrow connected-calendar
 * window and lifts it into the store (`appleEventsWindow`) so the widget bridge
 * can see events on ANY tab — not just Home.
 *
 * Before this, only home-screen's fetchTodayAppleEvents wrote the store, so
 * leaving the app on Command/Orbit/Inbox/Align left appleEventsWindow empty and
 * syncWidgetAfterMutation wrote an events-less snapshot — the widget's calendar
 * went blank (the "leave the app on certain tabs" bug).
 *
 * Never triggers a permission prompt: if Apple calendar access isn't already
 * granted we pass includeApple:false (which skips requestCalendarPermissionsAsync
 * entirely) and still refresh any connected Google/Outlook sources. Home keeps
 * its own prompting fetch for first-grant.
 */
export async function refreshCalendarWindowIntoStore(): Promise<void> {
  try {
    // Wait for the external-calendar accounts to rehydrate from AsyncStorage
    // before fetching. On a cold start this can run before hydration, when
    // accounts is still the empty initial value — syncWindow would then
    // return nothing and we'd blank the window for Google/Outlook-only users.
    // hasHydrated() short-circuits to true once rehydration has completed, so
    // foreground refreshes never wait. A 3s cap guarantees we never hang.
    const calPersist = useCalendarSourcesStore.persist;
    if (calPersist && !calPersist.hasHydrated()) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        const unsub = calPersist.onFinishHydration(finish);
        setTimeout(() => {
          unsub?.();
          finish();
        }, 3000);
      });
    }

    const perm = await Calendar.getCalendarPermissionsAsync();
    const includeApple = perm.status === 'granted';

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfTomorrow = new Date();
    endOfTomorrow.setDate(endOfTomorrow.getDate() + 1);
    endOfTomorrow.setHours(23, 59, 59, 999);

    // fetchConnectedCalendarEventsWindow already returns events sorted by
    // start, and startISO/endISO are required strings — no fallbacks or
    // re-sort needed here.
    const events = await fetchConnectedCalendarEventsWindow({
      startDate: startOfToday,
      endDate: endOfTomorrow,
      includeApple,
    });
    const mapped = events.map((e) => ({
      id: e.id,
      title: e.title,
      startISO: e.startISO,
      endISO: e.endISO,
      provider: e.provider,
      cal: e.cal,
    }));

    useAppState.getState().setAppleEventsWindow(mapped);
  } catch {
    /* silent — calendar refresh failures are non-fatal */
  }
}

