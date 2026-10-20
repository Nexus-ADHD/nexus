// @ts-nocheck
import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { Animated } from 'react-native';
import {StyleSheet, Text, View, ScrollView, Pressable, Alert, AppState, FlatList, ActionSheetIOS, Platform, TextInput, Modal, Linking, useWindowDimensions} from 'react-native';

import { useAppState } from '../../src/state/app-state';
import { useShallow } from 'zustand/react/shallow';
import { selectTodayTaskRollup } from '../../src/state/selectors/today-rollup';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from 'react-native-draggable-flatlist';
import * as Calendar from 'expo-calendar';
import DateTimePicker from '@react-native-community/datetimepicker';
import tokens from '../../src/theme/tokens';
import { AdaptiveScreen } from '../../src/components/ui/AdaptiveScreen';
import { decideRecurringReconcile, resolveLink } from '../../src/features/orbit/recurring-reconcile';
import { selectRuleIdsToDelete } from '../../src/features/orbit/rule-delete-selection';
import { clearAppleLink, getAppleLink, hydrateAppleLinks, setAppleLink } from '../../src/state/apple-link-store';
import { ORBIT_ACTION_WIDTH, orbitSwipeMetrics } from '../../src/features/orbit/swipe-card-metrics';
import { haptic } from '../../src/utils/haptics';
import { selectJustPassedBlock, isNativeTimeBlock, nextFreeStart, localMinutesOf } from '../../src/utils/time-blocks';
import OrbitManualAddSheet from '../../src/components/orbit/OrbitManualAddSheet';
import { useFocusEffect } from 'expo-router';
import { wisdomIsStale } from '../../src/utils/wisdom-staleness';
import { generateWisdom, getFallbackQuotes } from '../../src/features/wisdom/wisdom-service';
import type { FallbackQuote } from '../../src/features/wisdom/wisdom-quotes';
import { Shimmer } from '../../src/components/ui/Shimmer';
import { ScheduleEditModal } from '../../src/features/orbit/ScheduleEditModal';
import { EventDetailSheet } from '../../src/features/orbit/EventDetailSheet';
import { LeadTimeCreateSheet, type LeadTimePrefill } from '../../src/components/lead-time/LeadTimeCreateSheet';
import { LeadTimeOrbitSection } from '../../src/components/lead-time/LeadTimeOrbitSection';
import { selectLeadTimeRollup } from '../../src/state/selectors/lead-time';
import { getLocalDateKey, normalizeFallbackDateKey } from '../../src/utils/recurrence';
import { syncWidgetAfterMutation } from '../../src/widgets/widget-bridge';
import { describeMoveTarget } from '../../src/state/move-recurring-occurrence';
import { normalize, stripEmoji } from '../../src/utils/text';
import { ambientGlowSoft } from '../../src/theme/glow';
import { fetchConnectedCalendarEventsWindow } from '../../src/services/calendar-events';


const BLOCK_FALLBACK_TIME: Record<string, string> = {
  morning: '09:00',
  afternoon: '13:00',
  evening: '17:00',
  night: '20:00',
};

const parseOrbitClockToMinutes = (value?: string | null) => {
  if (!value) return Number.POSITIVE_INFINITY;

  const raw = String(value).trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return Number.POSITIVE_INFINITY;

  let match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours * 60 + minutes;
  }

  match = raw.match(/^(\d{1,2}):(\d{2})(AM|PM)$/);
  if (match) {
    let hours = Number(match[1]);
    const minutes = Number(match[2]);
    const meridiem = match[3];
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
    return hours * 60 + minutes;
  }

  match = raw.match(/^(\d{1,2})(AM|PM)$/);
  if (match) {
    let hours = Number(match[1]);
    const meridiem = match[2];
    if (meridiem === 'PM' && hours < 12) hours += 12;
    if (meridiem === 'AM' && hours === 12) hours = 0;
    return hours * 60;
  }

  return Number.POSITIVE_INFINITY;
};

const getOrbitEventClock = (event: any) => {
  const explicitTime =
    typeof event?.time === 'string' && event.time.trim()
      ? event.time.trim()
      : '';

  const explicitLabel =
    typeof event?.timeLabel === 'string' && event.timeLabel.trim()
      ? event.timeLabel.trim()
      : '';

  const blockValue =
    typeof event?.preferredTimeBlock === 'string'
      ? BLOCK_FALLBACK_TIME[event.preferredTimeBlock.toLowerCase()] ?? ''
      : '';

  const direct = event?.startDate ?? event?.startISO;
  let directClock = '';
  if (direct) {
    const date = new Date(direct);
    if (!Number.isNaN(date.getTime())) {
      const hh = String(date.getHours()).padStart(2, '0');
      const mm = String(date.getMinutes()).padStart(2, '0');
      directClock = `${hh}:${mm}`;
    }
  }

  const isRoutineLike =
    event?.cal === 'ROUTINE' ||
    event?.source === 'routine' ||
    event?.source === 'recurring' ||
    event?.eventType === 'routine';

  if (isRoutineLike) {
    return explicitTime || blockValue || explicitLabel || directClock || '';
  }

  return explicitTime || explicitLabel || blockValue || directClock || '';
};

const getOrbitEventStartMs = (event: any, fallbackDateKey?: string | Date | null) => {
  if (typeof event?.sortStartMs === 'number' && Number.isFinite(event.sortStartMs)) {
    return event.sortStartMs;
  }

  const displayDateKey = getOrbitDisplayDateKey(event, fallbackDateKey);
  const preferredClock =
    event?.time ||
    event?.timeLabel ||
    (event?.preferredTimeBlock && ORBIT_TIME_BLOCK_FALLBACKS?.[event.preferredTimeBlock]
      ? ORBIT_TIME_BLOCK_FALLBACKS[event.preferredTimeBlock]
      : null);

  if (preferredClock && displayDateKey) {
    return buildRoutineDateFromKeyAndTime(
      displayDateKey,
      preferredClock,
      event?.preferredTimeBlock
    ).getTime();
  }

  if (event?.startDate) {
    const parsed = new Date(event.startDate).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }

  if (event?.startISO) {
    const parsed = new Date(event.startISO).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }

  return getStableRoutineSortMs(event, fallbackDateKey);
};

const formatOrbitTimelineTime = (event: any) => {
  const clock = getOrbitEventClock(event);
  const minutes = parseOrbitClockToMinutes(clock);

  const isRoutineLike =
    event?.cal === 'ROUTINE' ||
    event?.source === 'routine' ||
    event?.source === 'recurring' ||
    event?.eventType === 'routine';

  if (isRoutineLike && Number.isFinite(minutes)) {
    const base = new Date();
    base.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(base);
  }

  const direct = event?.startDate ?? event?.startISO;
  if (direct) {
    const parsed = new Date(direct);
    if (!Number.isNaN(parsed.getTime())) {
      return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
      }).format(parsed);
    }
  }

  if (Number.isFinite(minutes)) {
    const base = new Date();
    base.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }).format(base);
  }

  return typeof event?.time === 'string' ? event.time : '';
};


// All-day = starts at midnight, ends at 11:59 PM same day (or next midnight)
const isAllDayEvent = (event: any): boolean => {
  if (event?.allDay === true) return true;
  if (!event?.startDate) return false;
  const s = new Date(event.startDate);
  const e = event.endDate ? new Date(event.endDate) : s;
  const startMidnight = s.getHours() === 0 && s.getMinutes() === 0 && s.getSeconds() === 0;
  const durationMs = e.getTime() - s.getTime();
  return startMidnight && durationMs >= 23 * 60 * 60 * 1000;
};

const isAppleCalendarEvent = (event: any) => {
  const source = String(event?.source ?? '').toLowerCase();
  const cal = String(event?.cal ?? '').toLowerCase();
  const label = String(event?.calendarName ?? '').toLowerCase();
  const provider = String(event?.provider ?? '').toLowerCase();

  return (
    provider === 'apple' ||
    source.includes('apple') ||
    cal.includes('apple') ||
    label.includes('apple')
  );
};

const isExternalCalendarEvent = (event: any) => {
  const provider = String(event?.provider ?? '').toLowerCase();
  return provider === 'google' || provider === 'outlook' || event?.source === 'external_calendar';
};

const isReadOnlyCalendarEvent = (event: any) =>
  isAppleCalendarEvent(event) || isExternalCalendarEvent(event);

const isRoutineMirrorEvent = (event: any) => {
  const source = String(event?.source ?? '').toLowerCase();
  const cal = String(event?.cal ?? '').toUpperCase();
  const eventType = String(event?.eventType ?? '').toLowerCase();

  return (
    cal === 'ROUTINE' ||
    source === 'routine' ||
    source === 'recurring' ||
    eventType === 'routine'
  );
};

const formatRoutineTitleForDisplay = (title: any) => stripEmoji(String(title ?? ''));

const formatOrbitEventTitleForDisplay = (event: any, fallback = 'Untitled event') => {
  const title = event?.title ?? fallback;
  return isRoutineMirrorEvent(event) ? formatRoutineTitleForDisplay(title) : title;
};

const normalizeOrbitTitleForSync = (value?: string | null) =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const getOrbitDisplayDayKey = (event: any, baseDate?: Date) => {
  const direct = event?.startDate ?? event?.startISO;
  if (direct) {
    const parsed = new Date(direct);
    if (!Number.isNaN(parsed.getTime())) {
      const y = parsed.getFullYear();
      const m = String(parsed.getMonth() + 1).padStart(2, '0');
      const d = String(parsed.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  const fallback = new Date(baseDate ?? new Date());
  const y = fallback.getFullYear();
  const m = String(fallback.getMonth() + 1).padStart(2, '0');
  const d = String(fallback.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const orbitItemsMirrorEachOther = (a: any, b: any, baseDate?: Date) => {
  const oneAppleOneRoutine =
    (isAppleCalendarEvent(a) && isRoutineMirrorEvent(b)) ||
    (isAppleCalendarEvent(b) && isRoutineMirrorEvent(a));

  if (!oneAppleOneRoutine) return false;

  const appleEvent = isAppleCalendarEvent(a) ? a : b;
  const routineEvent = isRoutineMirrorEvent(a) ? a : b;

  // Primary: if routine has appleEventId matching apple event id — definitive match
  // handles renamed/rescheduled recurring calendar events
  if (routineEvent?.appleEventId && appleEvent?.id &&
      routineEvent.appleEventId === appleEvent.id) {
    return true;
  }

  // Fallback: same title + same day + within 30 min (widened for rescheduled events)
  const sameTitle =
    normalizeOrbitTitleForSync(a?.title) === normalizeOrbitTitleForSync(b?.title);

  if (!sameTitle) return false;

  const sameDay =
    getOrbitDisplayDayKey(a, baseDate) === getOrbitDisplayDayKey(b, baseDate);

  if (!sameDay) return false;

  const aStart = getOrbitEventStartMs(a, baseDate);
  const bStart = getOrbitEventStartMs(b, baseDate);

  if (!Number.isFinite(aStart) || !Number.isFinite(bStart)) return false;

  const diffMs = Math.abs(aStart - bStart);
  return diffMs <= 30 * 60 * 1000;
};


const routineItemsDuplicateEachOther = (a: any, b: any, baseDate?: Date) => {
  if (!(isRoutineMirrorEvent(a) && isRoutineMirrorEvent(b))) return false;

  const sameTitle =
    normalizeOrbitTitleForSync(a?.title) === normalizeOrbitTitleForSync(b?.title);

  if (!sameTitle) return false;

  const sameDay =
    getOrbitDisplayDayKey(a, baseDate) === getOrbitDisplayDayKey(b, baseDate);

  if (!sameDay) return false;

  const aStart = getOrbitEventStartMs(a, baseDate);
  const bStart = getOrbitEventStartMs(b, baseDate);

  if (!Number.isFinite(aStart) || !Number.isFinite(bStart)) return false;

  return Math.abs(aStart - bStart) <= 5 * 60 * 1000;
};

const eventsDuplicateForDisplay = (a: any, b: any, baseDate?: Date) => {
  return (
    orbitItemsMirrorEachOther(a, b, baseDate) ||
    routineItemsDuplicateEachOther(a, b, baseDate)
  );
};

const resolveRuleClock = (rule: any) => {
  if (typeof rule?.time === 'string' && rule.time.trim()) return rule.time.trim();

  if (typeof rule?.preferredTimeBlock === 'string') {
    return BLOCK_FALLBACK_TIME[String(rule.preferredTimeBlock).toLowerCase()] ?? '';
  }

  return '';
};

const recurringRuleMatchesRenderedEvent = (rule: any, event: any) => {
  const sameTitle =
    normalizeOrbitTitleForSync(rule?.title) === normalizeOrbitTitleForSync(event?.title);

  if (!sameTitle) return false;

  const ruleMinutes = parseOrbitClockToMinutes(resolveRuleClock(rule) || null);
  const eventMinutes = parseOrbitClockToMinutes(getOrbitEventClock(event) || null);

  const closeInTime =
    Number.isFinite(ruleMinutes) && Number.isFinite(eventMinutes)
      ? Math.abs(ruleMinutes - eventMinutes) <= 5
      : true;

  if (!closeInTime) return false;

  const eventAppleId = event?.appleEventId ?? null;
  if (eventAppleId) {
    return rule?.appleEventId === eventAppleId || !rule?.appleEventId;
  }

  return !rule?.appleEventId;
};

const findMatchingAppleEventForRoutine = (
  rule: any,
  appleEventsForDay: any[] = [],
  dayDate?: Date
) => {
  return appleEventsForDay.find((appleEvent: any) => {
    if (!appleEvent?.id) return false;
    if (!titlesMatchForRecurringSync(appleEvent?.title, rule?.title)) return false;

    const appleStart = getOrbitEventStartMs(appleEvent, dayDate);
    const ruleStart = getOrbitEventStartMs(
      {
        ...rule,
        source: 'routine',
        cal: 'ROUTINE',
        eventType: 'routine',
      },
      dayDate
    );

    if (!Number.isFinite(appleStart) || !Number.isFinite(ruleStart)) return false;

    return Math.abs(appleStart - ruleStart) <= 5 * 60 * 1000;
  }) ?? null;
};

const dedupeOrbitEventsForDisplay = (events: any[], baseDate?: Date) => {
  const preferredFirst = [...events].sort((a, b) => {
    const aRoutine = isRoutineMirrorEvent(a) ? 1 : 0;
    const bRoutine = isRoutineMirrorEvent(b) ? 1 : 0;

    if (aRoutine !== bRoutine) return bRoutine - aRoutine;

    const aApple = isAppleCalendarEvent(a) ? 1 : 0;
    const bApple = isAppleCalendarEvent(b) ? 1 : 0;

    if (aApple !== bApple) return aApple - bApple;

    return getOrbitEventStartMs(a, baseDate) - getOrbitEventStartMs(b, baseDate);
  });

  const deduped: any[] = [];

  for (const event of preferredFirst) {
    const duplicateIndex = deduped.findIndex((existing) =>
      eventsDuplicateForDisplay(existing, event, baseDate)
    );

    if (duplicateIndex === -1) {
      deduped.push(event);
    }
  }

  return deduped.sort(
    (a, b) => getOrbitEventStartMs(a, baseDate) - getOrbitEventStartMs(b, baseDate)
  );
};

const openSystemCalendarEvent = async (event: any) => {
  if (isExternalCalendarEvent(event) && event?.url) {
    Linking.openURL(event.url).catch(() => {
      Alert.alert('Calendar Event', 'Open this event directly from its source calendar.');
    });
    return;
  }

  if (!event?.id) {
    Alert.alert('System Event', 'This event can only be modified in the native calendar.');
    return;
  }

  try {
    const calendarAny = Calendar as any;

    if (typeof calendarAny.openEventInCalendarAsync === 'function') {
      await calendarAny.openEventInCalendarAsync(
        { id: event.id },
        { allowsEditing: true }
      );
      return;
    }

    if (typeof calendarAny.openEventInCalendar === 'function') {
      calendarAny.openEventInCalendar(event.id);
      return;
    }

    Alert.alert('System Event', 'Please edit or delete this event directly in your native calendar app.');
  } catch {
    Alert.alert('System Event', 'Please edit or delete this event directly in your native calendar app.');
  }
};


const NATIVE_DAY_TO_LOCAL_DAY: Record<number, number> = {




  1: 0,
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
  7: 6,
};

const extractOrbitRuleIdFromNotes = (notes?: string | null) => {
  const match = String(notes ?? '').match(/\[ORBIT_RULE_ID:([^\]]+)\]/);
  return match?.[1]?.trim() || null;
};

const formatNativeDateTo24Hour = (input: any) => {
  if (!input) return null;
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return null;

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
};

const extractLocalDaysFromNativeRecurringEvent = (event: any) => {
  const raw = event?.recurrenceRule?.daysOfTheWeek;
  if (!Array.isArray(raw) || !raw.length) return null;

  const days = raw
    .map((entry: any) => NATIVE_DAY_TO_LOCAL_DAY?.[entry?.dayOfTheWeek])
    .filter((day: any) => Number.isInteger(day));

  return Array.from(new Set(days)).sort((a: number, b: number) => a - b);
};

const titlesMatchForRecurringSync = (a?: string | null, b?: string | null) =>
  String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

const reconcileRecurringRulesWithNativeCalendar = async (
  nativeEvents: any[] = [],
  baseDate?: Date
) => {
  // GATE 1 — permission. Without it every getEventAsync below fails, and a
  // failed lookup used to be read as "the user deleted this in Apple
  // Calendar". Declining the prompt would have wiped every linked routine.
  //
  // The query itself is wrapped: callers invoke fetchAppleCalendar() on mount
  // and on foreground WITHOUT awaiting or catching, so a rejecting native
  // permission bridge would surface as an unhandled rejection and abandon the
  // whole refresh pass — taking the event fetch and auto-logging with it.
  let hasCalendarPermission = false;
  try {
    const { status } = await Calendar.getCalendarPermissionsAsync();
    hasCalendarPermission = status === 'granted';
  } catch {
    hasCalendarPermission = false;
  }
  if (!hasCalendarPermission) return;

  // Device-local links. Must be hydrated BEFORE resolving anything: an
  // unhydrated read returns null, which reads as "no link" — harmless (every
  // decision becomes 'skip') but it would stall re-linking for a pass.
  await hydrateAppleLinks().catch(() => ({}));

  const stateAny: any = useAppState.getState?.() ?? {};
  const allRules = Array.isArray(stateAny.recurringRules) ? stateAny.recurringRules : [];

  // "Unlinked" means "not linked ON THIS DEVICE" — anything but 'mine'.
  //
  // 'legacy-unowned' has to be in here too. A rule arriving from another device
  // carries that device's id in the synced mirror, so it resolves to
  // 'legacy-unowned'; the adopt path can only claim it if that foreign id
  // happens to resolve here, which it does not. Filtering to 'none' alone left
  // those rules unmatchable forever, so this device never established its own
  // link and could never notice its own native event being deleted.
  //
  // Matching is non-destructive — it only ever STORES a link — so widening it
  // is safe. Destructive reconciliation stays reserved for 'mine'.
  const unlinkedRules = allRules.filter(
    (rule: any) => resolveLink(rule, getAppleLink(rule?.id)).linkState !== 'mine'
  );

  if (typeof stateAny.linkRecurringRuleToAppleEvent === 'function' && nativeEvents.length) {
    for (const rule of unlinkedRules) {
      const nativeMatch = nativeEvents.find((nativeEvent: any) => {
        if (!nativeEvent?.id) return false;
        if (!nativeEvent?.recurrenceRule) return false;
        if (!titlesMatchForRecurringSync(nativeEvent?.title, rule?.title)) return false;

        const nativeStart = getOrbitEventStartMs(nativeEvent, baseDate);
        const localStart = getOrbitEventStartMs(
          {
            ...rule,
            source: 'routine',
            cal: 'ROUTINE',
            eventType: 'routine',
          },
          baseDate
        );

        if (!Number.isFinite(nativeStart) || !Number.isFinite(localStart)) return false;

        return Math.abs(nativeStart - localStart) <= 5 * 60 * 1000;
      });

      if (nativeMatch?.id) {
        stateAny.linkRecurringRuleToAppleEvent(rule.id, nativeMatch.id);
        await setAppleLink(rule.id, nativeMatch.id).catch(() => {});
      }
    }
  }

  const refreshedState: any = useAppState.getState?.() ?? {};
  const refreshedRules = Array.isArray(refreshedState.recurringRules)
    ? refreshedState.recurringRules
    : [];

  for (const rule of refreshedRules) {
    // GATE 2 — ownership. Only ever test THIS device's own identifier (or an
    // unclaimed legacy one). Another device's link is invisible here, so
    // there is nothing foreign to misread as a deletion.
    const { linkState, eventId } = resolveLink(rule, getAppleLink(rule?.id));
    if (linkState === 'none' || !eventId) continue;

    let nativeEvent: any = null;
    let lookupOutcome: 'found' | 'missing' | 'error' = 'missing';
    try {
      nativeEvent = await Calendar.getEventAsync(eventId);
      lookupOutcome = nativeEvent ? 'found' : 'missing';
    } catch {
      lookupOutcome = 'error';
    }

    const action = decideRecurringReconcile({
      hasCalendarPermission,
      linkState,
      lookupOutcome,
    });

    if (action === 'skip') continue;

    if (action === 'unlink') {
      // The backing event is gone. Drop the dead link and KEEP the routine —
      // reconciliation never deletes user data (see recurring-reconcile.ts).
      // The matcher re-links it if a matching event reappears.
      await clearAppleLink(rule.id).catch(() => {});
      if (typeof refreshedState.unlinkRecurringRuleFromAppleEvent === 'function') {
        refreshedState.unlinkRecurringRuleFromAppleEvent(rule.id);
      }
      continue;
    }

    // 'adopt' — an unowned legacy link that resolved here, so it was minted on
    // this device. Claim it into our slot; the update below then proceeds
    // exactly as for an owned link.
    if (action === 'adopt') {
      await setAppleLink(rule.id, eventId).catch(() => {});
    }

    try {
      const nativeRuleId = extractOrbitRuleIdFromNotes(nativeEvent?.notes);
      const resolvedDays =
        extractLocalDaysFromNativeRecurringEvent(nativeEvent) ?? rule.daysOfWeek ?? [];
      const resolvedTime =
        formatNativeDateTo24Hour(nativeEvent?.startDate ?? nativeEvent?.startISO) ??
        rule.time ??
        null;

      if (
        nativeRuleId &&
        nativeRuleId !== rule.id &&
        typeof refreshedState.linkRecurringRuleToAppleEvent === 'function'
      ) {
        refreshedState.linkRecurringRuleToAppleEvent(nativeRuleId, nativeEvent.id ?? eventId);
        await setAppleLink(nativeRuleId, nativeEvent.id ?? eventId).catch(() => {});
      }

      if (typeof refreshedState.updateRecurringRuleFromApple === 'function') {
        // Never overwrite title — user may have renamed the habit manually.
        // Only sync schedule/time/appleEventId from Apple Calendar.
        // The event resolved on THIS device, so claim the link for it: that is
        // what later lets this device conclude a genuine deletion.
        // EventKit can hand back a canonical id that differs from the one we
        // queried, so re-store the link as well as the mirror — otherwise the
        // stored link keeps the old id and the next pass resolves 'missing'.
        const resolvedEventId = nativeEvent?.id ?? eventId;
        refreshedState.updateRecurringRuleFromApple(rule.id, {
          daysOfWeek: resolvedDays,
          time: resolvedTime,
          preferredTimeBlock: null,
          appleEventId: resolvedEventId,
        });
        await setAppleLink(rule.id, resolvedEventId).catch(() => {});
      }
    } catch {
      // Post-lookup bookkeeping failed. The event EXISTS (we just read it), so
      // this is never grounds for deleting the user's routine.
    }
  }
};



const sortOrbitEventsByStart = (events: any[], baseDate?: Date) =>
  [...events].sort(
    (a, b) => getOrbitEventStartMs(a, baseDate) - getOrbitEventStartMs(b, baseDate)
  );


// iPad (2026-08-27): the card width used to be a module-scope window read
// minus a hand-tuned 125. That froze at import (never updated on rotation) AND
// was a WINDOW width used inside AdaptiveScreen's 680pt content column, so a
// 13" iPad rendered a 1241pt card in a ~558pt wrapper. The wrapper is measured
// per-row now; see swipe-card-metrics.ts for why the action width must NOT be
// subtracted from the card.
const ACTION_WIDTH = ORBIT_ACTION_WIDTH;

// FIDGET-FIX: pure per-day data tree builder. Used by the parent's dayDataMap
// useMemo so each visible day's events/tasks are computed once per relevant
// dep change, not once per `now` tick or unrelated parent re-render.
interface DayData {
  dayAgenda: any[];
  allTasks: any[];
}
function computeDayData(opts: {
  dayStr: string;
  recurringRules: any[];
  recurringToDos: any[];
  dailyTasks: Record<string, any[]>;
  orbitDays: Record<string, any[]>;
  groupedAppleEvents: Record<string, any[]>;
  selectedDate: Date;
}): DayData {
  const { dayStr, recurringRules, recurringToDos, dailyTasks, orbitDays, groupedAppleEvents, selectedDate } = opts;
  const dayOfWeek = new Date(dayStr).getDay();

  const generatedRoutines = (recurringRules || []).filter((r: any) => {
    // daysOfWeek is model/voice-sourced and can be missing on a synced rule —
    // an unguarded .includes throws out of the dayDataMap useMemo straight to
    // the ErrorBoundary. Missing/empty = not scheduled = hidden, matching
    // isScheduledOn semantics (same guard as widget-bridge).
    if (!r || !Array.isArray(r.daysOfWeek) || !r.daysOfWeek.includes(dayOfWeek)) return false;
    if (r.appleEventId) return false;
    if (!r.time && !r.preferredTimeBlock) return false;
    return true;
  }).map((r: any) => {
    const d = new Date(dayStr);
    let timeToParse = r.time;
    if (!timeToParse && r.preferredTimeBlock) {
      if (r.preferredTimeBlock === 'morning') timeToParse = '09:00';
      else if (r.preferredTimeBlock === 'afternoon') timeToParse = '13:00';
      else if (r.preferredTimeBlock === 'evening') timeToParse = '17:00';
      else if (r.preferredTimeBlock === 'night') timeToParse = '20:00';
    }
    const minutes = parseOrbitClockToMinutes(timeToParse || null);
    if (Number.isFinite(minutes)) d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    else d.setHours(0, 0, 0, 0);
    const matchedAppleEvent =
      r.appleEventId
        ? { id: r.appleEventId }
        : findMatchingAppleEventForRoutine(r, groupedAppleEvents[dayStr] || [], d);
    return {
      id: `${r.id}-${dayStr}`,
      recurringRuleId: r.id,
      appleEventId: matchedAppleEvent?.id ?? r.appleEventId ?? null,
      title: r.title,
      time: timeToParse || 'ROUTINE',
      preferredTimeBlock: r.preferredTimeBlock ?? null,
      cal: r.cal,
      source: 'routine',
      eventType: 'routine',
      startDate: d.toISOString(),
      endDate: new Date(d.getTime() + 3600000).toISOString(),
    };
  });

  const dKey = getLocalDateKey(dayStr);
  // NEX-205: native orbit events store startISO/endISO, but the timeline's
  // past/future split + countdown read startDate/endDate (the Apple/routine
  // shape). Normalize here (spread preserves `energy` and every other field)
  // so native time-blocks classify, sort, and grey-on-pass correctly.
  const cleanedLocalEvents = (orbitDays[dKey] || orbitDays[dayStr] || [])
    .filter((e: any) => e.cal !== 'APPLE CALENDAR')
    .map((e: any) => ({
      ...e,
      startDate: e.startDate ?? e.startISO,
      endDate: e.endDate ?? e.endISO,
    }));
  const rawEvents = [...cleanedLocalEvents, ...(groupedAppleEvents[dayStr] || []), ...generatedRoutines];
  const uniqueEvents = dedupeOrbitEventsForDisplay(rawEvents, new Date(dayStr));
  const seen = new Set<string>();
  const finalEvents = uniqueEvents.filter((e: any) => {
    const h = new Date(e.startDate).getHours();
    const key = `${(e.title || '').toLowerCase().trim()}-${h}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dayAgenda = sortOrbitEventsByStart(finalEvents, selectedDate);

  const specificTasks = dailyTasks[dKey] || dailyTasks[dayStr] || [];
  const rollup = selectTodayTaskRollup(recurringToDos, specificTasks, dKey);
  const savedMap = Object.fromEntries((specificTasks as any[]).map((t: any) => [t.id, t]));
  const enriched = rollup.items.map((t) => ({
    ...t,
    sortOrder: savedMap[t.id]?.sortOrder ?? 9999,
  }));
  const hasSavedOrder = enriched.some((t: any) => t.sortOrder !== 9999);
  const ordered = hasSavedOrder
    ? [...enriched].sort((a: any, b: any) => a.sortOrder - b.sortOrder)
    : enriched;

  // Phase 6 — completed tasks sink to the bottom of the list,
  // preserving sortOrder within the incomplete and completed
  // groups separately. Toggle handlers continue to flip
  // `completed` in place (no list mutation, so no visible
  // jolt from the toggle itself). The move-to-bottom comes
  // purely from this render-layer two-tier sort: useMemo
  // re-runs when dailyTasks / recurringRules change, the
  // partitioned array flows down, DraggableFlatList
  // animates the move via its own keyed reconciliation.
  // Drag-reorder still works within each group because
  // sortOrder is preserved per-item across the partition.
  const incomplete = ordered.filter((t: any) => !t.completed);
  const completed = ordered.filter((t: any) => t.completed);
  const allTasks = [...incomplete, ...completed];

  return { dayAgenda, allTasks };
}

// ─── TodoRow (memoized) ──────────────────────────────────────────────────────
// Surgical fix for Orbit list jolts: rendering each todo row inline in
// renderDay re-rendered every visible row whenever any state changed,
// triggering re-measurement of variable-height rows (numberOfLines=2)
// and visible jolt. Extracting and memoizing with a custom comparator
// lets unchanged rows skip rendering. The comparator deliberately
// ignores handler-prop identity — handler closures are recreated per
// render but their captured state (dKey, dayStr, task) is updated
// either via the parent's renderDay closure or by reading
// useAppState.getState() at call time, so staleness isn't a risk.
type TodoRowProps = {
  task: any;
  isActive: boolean;
  drag: () => void;
  showDragHandle: boolean;
  onPress: () => void;
  onLongPress: () => void;
};
const TodoRow = React.memo(
  function TodoRow({ task, isActive, drag, showDragHandle, onPress, onLongPress }: TodoRowProps) {
    return (
      <ScaleDecorator>
        <Pressable
          style={[styles.todoItem, { overflow: 'hidden' }, isActive && { backgroundColor: tokens.color.surfaceElevated, borderRadius: 10 }]}
          onPress={onPress}
          onLongPress={onLongPress}
          delayLongPress={500}
          disabled={isActive}
          accessibilityRole="checkbox"
          accessibilityLabel={task.title || 'this item'}
          accessibilityState={{ checked: !!task.completed }}
          accessibilityHint="Double tap to toggle complete, or double tap and hold to manage"
        >
          <View style={[styles.checkbox, task.completed && styles.checkboxActive]} accessible={false} pointerEvents="none" />
          <Text style={[styles.todoText, task.completed && styles.todoTextDone, { flex: 1 }]} numberOfLines={2}>{task.title}</Text>
          {showDragHandle && (
            <Pressable
              onLongPress={drag}
              delayLongPress={150}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Reorder ${task.title || 'this item'}`}
              accessibilityHint="Double tap and hold, then drag to reorder"
            >
              <Text style={styles.dragHandle} accessibilityElementsHidden importantForAccessibility="no">≡</Text>
            </Pressable>
          )}
        </Pressable>
      </ScaleDecorator>
    );
  },
  (prev, next) =>
    prev.task.id === next.task.id &&
    prev.task.title === next.task.title &&
    prev.task.completed === next.task.completed &&
    prev.task.isRecurring === next.task.isRecurring &&
    prev.isActive === next.isActive &&
    prev.showDragHandle === next.showDragHandle,
);

const SwipeableEvent = ({
  event,
  isPastEvent,
  onManageRecurring,
  onTapAppleEvent,
}: {
  event: any,
  isPastEvent: boolean,
  onManageRecurring: (event: any) => void,
  onTapAppleEvent?: (event: any) => void,
}) => {
  const deleteEvent = useAppState((s) => s.deleteEvent);
  const scrollRef = useRef<ScrollView>(null);
  const closeSwipe = () => scrollRef.current?.scrollTo({ x: 0, animated: true });
  // Measured width of the swipe wrapper — the ScrollView's viewport. Tracks
  // rotation, Split View and any narrowed content column, unlike the window.
  const [wrapperWidth, setWrapperWidth] = useState(0);
  const { width: swipeWindowWidth } = useWindowDimensions();
  const swipeMetrics = orbitSwipeMetrics(wrapperWidth, swipeWindowWidth);

  const isRoutine = isRoutineMirrorEvent(event);
  const badgeLabel = event?.appleEventId ? 'SYNCED' : 'LOCAL';

  const handleAction = () => {
    if (isRoutine) {
      onManageRecurring(event);
      closeSwipe();
      return;
    }

    if (isReadOnlyCalendarEvent(event)) {
      if (onTapAppleEvent) onTapAppleEvent(event);
      closeSwipe();
      return;
    }

    haptic('voiceAmbiguous');
    closeSwipe();
    setTimeout(() => {
      if (deleteEvent) deleteEvent(event.id);
    }, 150);
  };

  // Countdown chip logic
  const [countdownLabel, setCountdownLabel] = React.useState('');
  React.useEffect(() => {
    const update = () => {
      if (isPastEvent || isAllDayEvent(event)) { setCountdownLabel(''); return; }
      const now = Date.now();
      const start = new Date(event.startDate).getTime();
      const end = new Date(event.endDate || event.startDate).getTime();
      if (now >= start && now < end) { setCountdownLabel('NOW'); return; }
      const diffMs = start - now;
      if (diffMs < 0) { setCountdownLabel(''); return; }
      const mins = Math.floor(diffMs / 60000);
      if (mins < 60) setCountdownLabel(`${mins}m`);
      else if (mins < 1440) setCountdownLabel(`${Math.floor(mins/60)}h ${mins%60 > 0 ? `${mins%60}m` : ''}`);
      else setCountdownLabel('');
    };
    update();
    const t = setInterval(update, 30000);
    return () => clearInterval(t);
  }, [event.startDate, event.endDate, isPastEvent]);

  // v3 stellar: neutral fallback was #2A2A2A. textMuted (cool gray-blue)
  // is the v3 equivalent for "non-routine, no specific color" — reads as
  // quiet, not as muted-warm.
  const accentColor = event.calendarColor || (isRoutine ? tokens.color.gold : tokens.color.textMuted);
  const isNow = countdownLabel === 'NOW';
  // Only routine / read-only-calendar events have a working card tap; a plain
  // local event's onPress is a no-op, so it must not advertise a button role.
  const isActionable = isRoutine || isReadOnlyCalendarEvent(event);
  const eventTitleA11y = formatOrbitEventTitleForDisplay(event) || 'Untitled event';

  return (
    <View style={[styles.eventGroup, { opacity: isPastEvent ? 0.4 : 1.0 }]}>
      <View style={styles.timeColumn}>
        {/* v3 stellar: NOW-state green #4CAF50 → tokens.color.teal (success uses teal). */}
        <Text style={[styles.timeText, isNow && { color: tokens.color.teal }]}>{formatOrbitTimelineTime(event)}</Text>
        {countdownLabel && !isPastEvent && (
          <View style={[styles.countdownChip, isNow && styles.countdownChipNow]}>
            <Text style={[styles.countdownText, isNow && styles.countdownTextNow]}>{countdownLabel}</Text>
          </View>
        )}
      </View>
      <View style={{ flex: 1 }}>
        <View
          style={styles.swipeWrapper}
          onLayout={e => {
            const w = e.nativeEvent.layout.width;
            setWrapperWidth(prev => (Math.abs(prev - w) > 0.5 ? w : prev));
          }}
        >
          <ScrollView
            ref={scrollRef}
            horizontal
            showsHorizontalScrollIndicator={false}
            snapToOffsets={[0, ACTION_WIDTH]}
            contentOffset={{ x: 0, y: 0 }}
          >
            <Pressable
                style={[styles.card, swipeMetrics.hasWidth && { width: swipeMetrics.cardWidth }]}
                accessibilityRole={isActionable ? 'button' : 'text'}
                accessibilityLabel={`${eventTitleA11y}${isNow ? ', happening now' : ''}${event.location ? `, at ${event.location}` : ''}, ${(event.cal || 'event')}${event.energy ? `, ${event.energy} energy` : ''}`}
                accessibilityHint={isRoutine ? 'Manage recurring item' : (isReadOnlyCalendarEvent(event) ? 'Opens in Calendar' : undefined)}
                onPress={() => {
                  if (isReadOnlyCalendarEvent(event) && onTapAppleEvent) {
                    onTapAppleEvent(event);
                    haptic('buttonSecondary');
                  } else if (isRoutine) {
                    onManageRecurring(event);
                  }
                }}
              >
              {/* Left color accent bar */}
              <View style={[styles.colorBar, { backgroundColor: accentColor }]} />
              <View style={styles.cardInner}>
                <View style={styles.cardHeaderRow}>
                  <Text style={[styles.title, isPastEvent && styles.titleDimmed, styles.titleFlex]} numberOfLines={1}>
                    {formatOrbitEventTitleForDisplay(event)}
                  </Text>
                  {isNow && (
                    <View style={styles.nowBadge}>
                      <Text style={styles.nowBadgeText}>● NOW</Text>
                    </View>
                  )}
                  {!isNow && isRoutine && (
                    <View style={[styles.syncBadge, event?.appleEventId ? styles.syncBadgeSynced : styles.syncBadgeLocal]}>
                      <Text style={[styles.syncBadgeText, event?.appleEventId ? styles.syncBadgeTextSynced : styles.syncBadgeTextLocal]}>
                        {badgeLabel}
                      </Text>
                    </View>
                  )}
                </View>
                {/* Location or notes preview */}
                {event.location ? (
                  <Text style={styles.eventMeta} numberOfLines={1}>📍 {event.location}</Text>
                ) : event.notes && event.notes.replace(/\[ORBIT_RULE_ID:[^\]]+\]/g,'').trim() ? (
                  <Text style={styles.eventMeta} numberOfLines={1}>
                    {event.notes.replace(/\[ORBIT_RULE_ID:[^\]]+\]/g,'').trim().slice(0, 60)}
                    {event.notes.replace(/\[ORBIT_RULE_ID:[^\]]+\]/g,'').trim().length > 60 ? '…' : ''}
                  </Text>
                ) : null}
                <View style={styles.cardFooterRow}>
                  <Text style={styles.cal}>{event.cal?.toUpperCase() || 'EVENT'}</Text>
                  {/* NEX-205: energy tag — label-only neutral chip (no per-energy
                      accent color, per §19 palette rules). Only on native time-blocks. */}
                  {event.energy ? (
                    <View style={styles.energyChip}>
                      <Text style={styles.energyChipText}>{String(event.energy).toUpperCase()}</Text>
                    </View>
                  ) : null}
                </View>
                {/* NEX-205 (Or-2): a passed energy block greys (never reds) and
                    carries a no-shame buffer caption — the window slid, the day
                    did not cascade-fail. Native time-blocks only. */}
                {isPastEvent && isNativeTimeBlock(event) ? (
                  <Text style={styles.bufferCaption} accessibilityLabel="This window has passed. The buffer keeps the day intact.">
                    This window has passed. The buffer keeps the day intact.
                  </Text>
                ) : null}
              </View>
            </Pressable>
            <Pressable
              onPress={handleAction}
              style={[styles.actionBtn, styles.deleteBtn]}
              accessibilityRole="button"
              accessibilityLabel={`${isRoutine ? 'Manage' : isReadOnlyCalendarEvent(event) ? 'Open' : 'Delete'} ${eventTitleA11y}`}
            >
              {/* v3 stellar: destructive action red #FF4444 → tokens.color.stateError (#E55B45, warm-shifted for cosmic backdrop). */}
              <Text style={[styles.actionText, { color: tokens.color.stateError }]}>
                {isRoutine ? 'MANAGE' : isReadOnlyCalendarEvent(event) ? 'OPEN' : 'DELETE'}
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </View>
  );
};

// ─── TodayEventsSection ──────────────────────────────────────────────────────
// Renders the today-only events list (WHAT'S NEXT + past-events toggle + past
// list + future list with per-event isPastEvent flag). Owns its own `now`
// state and a 60-second tick. This is the FIDGET-FIX anchor: by scoping
// `now` here, the parent OrbitScreen no longer re-renders every 30 seconds,
// so other days' cells (and the FlatList scroll position) are not perturbed
// when minutes pass. Per-event countdown chips (inside SwipeableEvent) keep
// their own 30s cadence.
interface TodayEventsSectionProps {
  dayAgenda: any[];
  showPastToday: boolean;
  onTogglePastToday: () => void;
  onTapAppleEvent: (event: any) => void;
  onManageRecurring: (event: any) => void;
}
const TodayEventsSection: React.FC<TodayEventsSectionProps> = ({
  dayAgenda,
  showPastToday,
  onTogglePastToday,
  onTapAppleEvent,
  onManageRecurring,
}) => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  // NEX-205 (PR2b): move-to-next-window + undo. The undo affordance is a
  // component-local transient (no store/cloud field): { id, prevStartISO,
  // prevEndISO, label } while showing, plus a "no room left" note. Auto-clears.
  const setOrbitEventTime = useAppState((s) => s.setOrbitEventTime);
  const [lastMove, setLastMove] = useState<
    { id: string; prevStartISO: string; prevEndISO: string; label: string } | null
  >(null);
  const [noRoom, setNoRoom] = useState(false);
  // Separate timers so a no-room tap can't clobber an in-flight undo auto-clear.
  const undoTimer = useRef<any>(null);
  const noRoomTimer = useRef<any>(null);
  useEffect(() => () => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    if (noRoomTimer.current) clearTimeout(noRoomTimer.current);
  }, []);

  const scheduleUndoClear = useCallback(() => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setLastMove(null), 8000);
  }, []);

  const startOf = (e: any) => e?.startISO ?? e?.startDate;
  const endOf = (e: any) => e?.endISO ?? e?.endDate;

  const moveBlockToNextWindow = useCallback((blk: any) => {
    const startMin = localMinutesOf(startOf(blk));
    const endMin = localMinutesOf(endOf(blk));
    const durationMin = endMin - startMin;
    if (!Number.isFinite(durationMin) || durationMin <= 0) return;
    const earliestMin = now.getHours() * 60 + now.getMinutes();
    const blockers = dayAgenda
      .filter((e) => e.id !== blk.id && !isAllDayEvent(e))
      .map((e) => ({ startMin: localMinutesOf(startOf(e)), endMin: localMinutesOf(endOf(e)) }))
      .filter((b) => Number.isFinite(b.startMin) && Number.isFinite(b.endMin));
    const newStartMin = nextFreeStart(blockers, durationMin, earliestMin);
    if (newStartMin == null) {
      haptic('notificationWarning');
      setNoRoom(true);
      if (noRoomTimer.current) clearTimeout(noRoomTimer.current);
      noRoomTimer.current = setTimeout(() => setNoRoom(false), 5000);
      return;
    }
    // Same calendar day as the block (caps at day-end), so set wall-clock on its
    // own date — local setHours handles DST correctly.
    const ns = new Date(startOf(blk));
    ns.setHours(Math.floor(newStartMin / 60), newStartMin % 60, 0, 0);
    const ne = new Date(ns.getTime() + durationMin * 60000);
    setNoRoom(false);
    setOrbitEventTime(blk.id, ns.toISOString(), ne.toISOString());
    haptic('notificationSuccess');
    setLastMove({
      id: blk.id,
      prevStartISO: startOf(blk),
      prevEndISO: endOf(blk),
      label: ns.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
    });
    scheduleUndoClear();
  }, [dayAgenda, now, setOrbitEventTime, scheduleUndoClear]);

  const undoMove = useCallback(() => {
    if (!lastMove) return;
    setOrbitEventTime(lastMove.id, lastMove.prevStartISO, lastMove.prevEndISO);
    haptic('buttonSecondary');
    setLastMove(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
  }, [lastMove, setOrbitEventTime]);

  const pastEvents = dayAgenda.filter((e) => new Date(e.endDate) < now);
  const futureEvents = dayAgenda.filter((e) => new Date(e.endDate) >= now);
  const visibleFuture = futureEvents.filter((e) => !isAllDayEvent(e));
  const next = visibleFuture[0];

  // NEX-205 (Or-2): surface the just-passed energy block inline so the no-shame
  // "buffer" reassurance is visible without opening the collapsed past drawer.
  // The day survives a slip — nothing turns red, nothing cascades. The block is
  // then excluded from the drawer list so it isn't shown twice.
  // Filter out all-day events with Orbit's own heuristic (isAllDayEvent also
  // treats a midnight-start ≥23h event as all-day, beyond the raw `allDay`
  // flag selectJustPassedBlock guards on) so a day-spanning block can't surface.
  const justPassedBlock = selectJustPassedBlock(
    pastEvents.filter((e) => !isAllDayEvent(e)),
    now.getTime(),
  );
  const pastEventsForDrawer = justPassedBlock
    ? pastEvents.filter((e) => e.id !== justPassedBlock.id)
    : pastEvents;

  return (
    <>
      {next && (() => {
        const nowMs = Date.now();
        const startMs = new Date(next.startDate).getTime();
        const endMs = new Date(next.endDate || next.startDate).getTime();
        const isHappening = nowMs >= startMs && nowMs < endMs;
        const minsAway = Math.max(0, Math.floor((startMs - nowMs) / 60000));
        const label = isHappening ? '● HAPPENING NOW' : minsAway < 60 ? `IN ${minsAway} MIN` : `NEXT UP`;
        const accentCol = next.calendarColor || tokens.color.gold;
        // Card tap only opens read-only calendar events; for routine / plain-local
        // events in the slot it's a no-op, so it must not advertise a button role.
        const isNextActionable = isReadOnlyCalendarEvent(next);
        return (
          <Pressable
            style={[styles.whatsNextCard, { borderLeftColor: accentCol }]}
            accessibilityRole={isNextActionable ? 'button' : 'text'}
            accessibilityLabel={`${isHappening ? 'Happening now' : minsAway < 60 ? `In ${minsAway} minutes` : 'Next up'}: ${formatOrbitEventTitleForDisplay(next) || 'Untitled event'}${next.location ? `, at ${next.location}` : ''}`}
            accessibilityHint={isNextActionable ? 'Opens in Calendar' : undefined}
            onPress={() => isNextActionable && onTapAppleEvent(next)}
          >
            {/* v3 stellar: HAPPENING-NOW green → tokens.color.teal (success). */}
            <Text style={[styles.whatsNextLabel, isHappening && { color: tokens.color.teal }]}>{label}</Text>
            <Text style={styles.whatsNextTitle} numberOfLines={2}>{formatOrbitEventTitleForDisplay(next)}</Text>
            {next.location ? <Text style={styles.whatsNextMeta} numberOfLines={1}>📍 {next.location}</Text> : null}
            <Text style={styles.whatsNextTime}>
              {new Date(next.startDate).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              {' – '}
              {new Date(next.endDate || next.startDate).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </Text>
          </Pressable>
        );
      })()}

      {/* NEX-205: the just-passed energy block, surfaced inline (greyed, never
          red) with its buffer caption — so the reassurance lands without a tap. */}
      {justPassedBlock && (
        <View>
          <Text style={styles.justPassedLabel}>JUST PASSED</Text>
          <SwipeableEvent
            event={justPassedBlock}
            isPastEvent={true}
            onManageRecurring={onManageRecurring}
            onTapAppleEvent={onTapAppleEvent}
          />
          {/* NEX-205 (PR2b): one-tap "move to next window" — slides the block
              forward into the next free slot today. No auto-cascade (Or-3).
              Hidden once a move is in its undo window (the block is now a future
              event; the undo pill below carries the affordance). */}
          {!(lastMove && lastMove.id === justPassedBlock.id) && (
            <Pressable
              onPress={() => moveBlockToNextWindow(justPassedBlock)}
              style={styles.moveBlockBtn}
              accessibilityRole="button"
              accessibilityLabel="Move this window forward to the next free slot today"
            >
              <Text style={styles.moveBlockText}>MOVE TO NEXT WINDOW</Text>
            </Pressable>
          )}
          {noRoom ? (
            <Text style={styles.moveNoRoom}>No open window left today. It keeps its place.</Text>
          ) : null}
        </View>
      )}

      {/* NEX-205 (PR2b): undo pill at section level so it survives the moved
          block leaving the "just passed" slot (it becomes a future event). */}
      {lastMove ? (
        <View style={styles.moveUndoRow}>
          <Text style={styles.moveUndoText}>Moved to {lastMove.label}.</Text>
          <Pressable
            onPress={undoMove}
            accessibilityRole="button"
            accessibilityLabel={`Undo. Move back to ${new Date(lastMove.prevStartISO).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
            hitSlop={8}
          >
            <Text style={styles.moveUndoAction}>UNDO</Text>
          </Pressable>
        </View>
      ) : null}

      {pastEventsForDrawer.length > 0 && (
        <Pressable
          onPress={onTogglePastToday}
          style={styles.showPastBtn}
          hitSlop={tokens.icon.hitTarget.linkSlop}
          accessibilityRole="button"
          accessibilityLabel={showPastToday ? 'Hide past events' : `Show ${pastEventsForDrawer.length} past events`}
          accessibilityState={{ expanded: showPastToday }}
        >
          <Text style={styles.showPastText}>
            {showPastToday ? '− Hide Past Events' : `+ ${pastEventsForDrawer.length} Past Events`}
          </Text>
        </Pressable>
      )}

      {showPastToday && pastEventsForDrawer.map((event) => (
        <SwipeableEvent
          key={event.id}
          event={event}
          isPastEvent={true}
          onManageRecurring={onManageRecurring}
          onTapAppleEvent={onTapAppleEvent}
        />
      ))}

      {futureEvents.map((event) => (
        <SwipeableEvent
          key={event.id}
          event={event}
          isPastEvent={new Date(event.endDate) < now}
          onManageRecurring={onManageRecurring}
          onTapAppleEvent={onTapAppleEvent}
        />
      ))}
    </>
  );
};


const EDITABLE_RECURRING_DEFAULT_DURATION_MINUTES = 60;

const ORBIT_TIME_BLOCK_FALLBACKS: Record<string, string> = {
  EARLY_AM: '06:30',
  MORNING: '09:00',
  MIDDAY: '12:00',
  AFTERNOON: '15:00',
  EVENING: '18:00',
  NIGHT: '20:30',
};

const padOrbit2 = (n: number) => String(n).padStart(2, '0');

// The fallback arrives as a day-key string from some callers and as a Date
// (`selectedDate`/`baseDate`) from the sort/matching paths. Normalizing here
// (single point) keeps every caller correct — a raw Date passed through as a
// "key" used to build `new Date("Mon Jul 02...T00:00:00")` → NaN, silently
// breaking routine↔Apple matching and time sorting. Null stays null.
const getOrbitDisplayDateKey = (event: any, fallbackDateKey?: string | Date | null) => {
  return (
    event?.displayDateKey ||
    event?.dateKey ||
    event?.dayKey ||
    event?.localDateKey ||
    (typeof event?.startISO === 'string' && event.startISO.length >= 10
      ? event.startISO.slice(0, 10)
      : null) ||
    (typeof event?.startDate === 'string' && event.startDate.length >= 10
      ? event.startDate.slice(0, 10)
      : null) ||
    normalizeFallbackDateKey(fallbackDateKey) ||
    null
  );
};

const normalizeRecurringEditTime = (rawValue: string | null | undefined, preferredTimeBlock?: string | null) => {
  const raw = String(rawValue || '').trim();
  if (!raw && preferredTimeBlock && ORBIT_TIME_BLOCK_FALLBACKS[preferredTimeBlock]) {
    return ORBIT_TIME_BLOCK_FALLBACKS[preferredTimeBlock];
  }
  if (!raw) return null;

  const basic24 = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (basic24) {
    const hh = Number(basic24[1]);
    const mm = Number(basic24[2]);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return `${padOrbit2(hh)}:${padOrbit2(mm)}`;
    }
  }

  const ampm = raw.replace(/\s+/g, '').match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
  if (ampm) {
    let hh = Number(ampm[1]);
    const mm = Number(ampm[2] || '0');
    const meridiem = ampm[3].toLowerCase();
    if (hh >= 1 && hh <= 12 && mm >= 0 && mm <= 59) {
      if (meridiem === 'am') {
        if (hh === 12) hh = 0;
      } else {
        if (hh !== 12) hh += 12;
      }
      return `${padOrbit2(hh)}:${padOrbit2(mm)}`;
    }
  }

  return null;
};

const buildRoutineDateFromKeyAndTime = (
  dateKey: string | null | undefined,
  timeValue?: string | null,
  preferredTimeBlock?: string | null
) => {
  const safeDateKey = dateKey || new Date().toISOString().slice(0, 10);
  const normalized = normalizeRecurringEditTime(timeValue, preferredTimeBlock) || '00:00';
  const [hh, mm] = normalized.split(':').map(Number);
  const base = new Date(`${safeDateKey}T00:00:00`);
  base.setHours(hh || 0, mm || 0, 0, 0);
  return base;
};

const getStableRoutineSortMs = (event: any, fallbackDateKey?: string | Date | null) => {
  if (typeof event?.sortStartMs === 'number' && Number.isFinite(event.sortStartMs)) {
    return event.sortStartMs;
  }

  const displayDateKey = getOrbitDisplayDateKey(event, fallbackDateKey);
  const preferredClock =
    event?.time ||
    event?.timeLabel ||
    (event?.preferredTimeBlock && ORBIT_TIME_BLOCK_FALLBACKS?.[event.preferredTimeBlock]
      ? ORBIT_TIME_BLOCK_FALLBACKS[event.preferredTimeBlock]
      : null);

  if (displayDateKey) {
    return buildRoutineDateFromKeyAndTime(
      displayDateKey,
      preferredClock,
      event?.preferredTimeBlock
    ).getTime();
  }

  if (event?.startDate) {
    const parsed = new Date(event.startDate).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }

  if (event?.startISO) {
    const parsed = new Date(event.startISO).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }

  return 0;
};



// ─── DayTodoList ──────────────────────────────────────────────────────
// Per-day connected todo list. Wraps DraggableFlatList with stable
// closures so the move-to-bottom animation (introduced by the
// completion-sort fix) completes cleanly every time. Previously
// the renderItem / onPress closures were re-allocated inside
// renderDay on every parent render, which intermittently aborted
// DraggableFlatList's keyed reconciliation mid-flight.
//
// Stability contract:
//   - `dKey` and `dayStr` are stable strings.
//   - `onTogglePress` and `onLongPress` MUST be stable refs (the
//     parent uses a ref-wrapper pattern around toggleTask /
//     startEditTask to guarantee this).
//   - `allTasks` is the only prop that legitimately changes;
//     React.memo with a custom comparator reduces re-renders to
//     just the cases that matter (length / id-order / completion).
interface DayTodoListProps {
  dKey: string;
  dayStr: string;
  allTasks: any[];
  onTogglePress: (dayStr: string, taskId: string) => void;
  onLongPress: (task: any, dayStr: string) => void;
}

const DayTodoList = React.memo(
  function DayTodoList({ dKey, dayStr, allTasks, onTogglePress, onLongPress }: DayTodoListProps) {
    const showHandle = allTasks.length > 1;

    const handleRecurringToggle = useCallback(
      (task: any) => {
        // Flip in place — mirrors the non-recurring path. Previously
        // this branch removed-and-appended, moving the row to the
        // bottom of the list and triggering a visible jolt as the
        // inner DraggableFlatList re-measured. Now the move-to-bottom
        // is owned by the render-layer two-tier sort instead.
        const liveState = useAppState.getState() as any;
        const curr = (liveState.dailyTasks ?? {})[dKey] || [];
        const exists = curr.some((t: any) => t.id === task.id);
        const willComplete = !curr.some((t: any) => t.id === task.id && t.completed);
        const next = exists
          ? curr.map((t: any) =>
              t.id === task.id ? { ...t, completed: willComplete } : t,
            )
          : [...curr, { id: task.id, title: task.title, completed: true }];
        useAppState.setState({
          dailyTasks: { ...(liveState.dailyTasks ?? {}), [dKey]: next },
        });
        syncWidgetAfterMutation();
        if (willComplete) haptic('habitResolve');
        else haptic('buttonSecondary');
      },
      [dKey],
    );

    const handlePress = useCallback(
      (task: any) => {
        if (task.isRecurring) {
          handleRecurringToggle(task);
        } else {
          onTogglePress(dayStr, task.id);
          if (!task.completed)
            haptic('habitResolve');
        }
      },
      [dayStr, handleRecurringToggle, onTogglePress],
    );

    const handleLongPressStart = useCallback(
      (task: any) => onLongPress(task, dayStr),
      [dayStr, onLongPress],
    );

    const handleDragEnd = useCallback(
      ({ data: dragData }: { data: any[] }) => {
        const saved = dragData.map((t: any, i: number) => ({
          id: t.id,
          title: t.title,
          completed: t.completed ?? false,
          sortOrder: i,
          isRecurring: t.isRecurring ?? false,
        }));
        const liveState = useAppState.getState() as any;
        useAppState.setState({
          dailyTasks: { ...(liveState.dailyTasks ?? {}), [dKey]: saved },
        });
        syncWidgetAfterMutation();
      },
      [dKey],
    );

    const renderTodoItem = useCallback(
      ({ item: task, drag, isActive }: RenderItemParams<any>) => (
        <TodoRow
          task={task}
          isActive={isActive}
          drag={drag}
          showDragHandle={showHandle}
          onPress={() => handlePress(task)}
          onLongPress={() => handleLongPressStart(task)}
        />
      ),
      [showHandle, handlePress, handleLongPressStart],
    );

    return (
      <DraggableFlatList
        data={allTasks}
        keyExtractor={(task: any) => task.id}
        scrollEnabled={false}
        activationDistance={10}
        onDragEnd={handleDragEnd}
        renderItem={renderTodoItem}
      />
    );
  },
  // React.memo comparator: skip re-renders when the list signature
  // (length + id order + per-item completion) is unchanged. dKey /
  // dayStr / handlers are assumed stable upstream — the parent
  // ref-wrapper pattern guarantees the handler refs.
  (prev, next) => {
    if (prev.dKey !== next.dKey) return false;
    if (prev.dayStr !== next.dayStr) return false;
    if (prev.onTogglePress !== next.onTogglePress) return false;
    if (prev.onLongPress !== next.onLongPress) return false;
    if (prev.allTasks === next.allTasks) return true;
    if (prev.allTasks.length !== next.allTasks.length) return false;
    for (let i = 0; i < prev.allTasks.length; i++) {
      const a = prev.allTasks[i];
      const b = next.allTasks[i];
      if (a.id !== b.id) return false;
      if ((a.completed ?? false) !== (b.completed ?? false)) return false;
      if (a.title !== b.title) return false;
    }
    return true;
  },
);

// FIDGET-FIX: `now` was lifted into <TodayEventsSection> so the parent doesn't
// re-render every 30s. renderDay is useCallback'd. Per-day tree is memoized via
// dayDataMap. AppState fetches are debounced via lastFetchRef + payload hash.
// Don't re-introduce parent-level `now` state or un-memoized per-day computation
// — the today/tomorrow seam will fidget again.
export default function OrbitScreen() {
  const updateRecurringRuleFromApple = useAppState(state => state.updateRecurringRuleFromApple);

  const { orbitDays = {}, recurringRules = [], recurringToDos = [], dailyTasks = {}, userProfile, pillars, dailyWisdomQuotes, dailyWisdomDate, wisdomQuoteCount, updateRecurringToDo, deleteRecurringToDo, addRecurringToDoException, moveRecurringOccurrence, undoMoveRecurringOccurrence, reorderDailyTask, setDailyTasksOrder, deleteDailyTask, leadTimeActions = [], addLeadTimeAction, toggleLeadTimeAction, deleteLeadTimeAction } = useAppState(
    useShallow((s: any) => ({
      orbitDays: s.orbitDays,
      recurringRules: s.recurringRules,
      recurringToDos: s.recurringToDos,
      dailyTasks: s.dailyTasks,
      userProfile: s.userProfile,
      pillars: s.pillars,
      dailyWisdomQuotes: s.dailyWisdomQuotes,
      dailyWisdomDate: s.dailyWisdomDate,
      wisdomQuoteCount: s.wisdomQuoteCount,
      updateRecurringToDo: s.updateRecurringToDo,
      deleteRecurringToDo: s.deleteRecurringToDo,
      addRecurringToDoException: s.addRecurringToDoException,
      moveRecurringOccurrence: s.moveRecurringOccurrence,
      undoMoveRecurringOccurrence: s.undoMoveRecurringOccurrence,
      reorderDailyTask: s.reorderDailyTask,
      setDailyTasksOrder: s.setDailyTasksOrder,
      deleteDailyTask: s.deleteDailyTask,
      leadTimeActions: s.leadTimeActions,
      addLeadTimeAction: s.addLeadTimeAction,
      toggleLeadTimeAction: s.toggleLeadTimeAction,
      deleteLeadTimeAction: s.deleteLeadTimeAction,
    })),
  );
  const [appleEvents, setAppleEvents] = useState<any[]>([]);
  const [showPastToday, setShowPastToday] = useState(false);
  const [anchorDate, setAnchorDate] = useState(() => { const d = new Date(); d.setHours(0,0,0,0); return d; });
  const [selectedDate, setSelectedDate] = useState(anchorDate);
  const reconcilingRef = useRef(false);

  // Daily quotes — persisted in app state
  const [quotesLoading, setQuotesLoading] = useState(false);
  // Optimistic fallback shown while a cold-start generation is in flight, so the
  // section is never blank/spinning. Cleared once real quotes land. Held in state
  // (not recomputed in render) so the picks don't reshuffle on every render.
  const [provisionalQuotes, setProvisionalQuotes] = useState<FallbackQuote[] | null>(null);
  const [scheduleEditToDo, setScheduleEditToDo] = useState<any | null>(null);
  const [moveDatePickerTask, setMoveDatePickerTask] = useState<{ task: any; dateKey: string } | null>(null);
  const [moveDatePickerValue, setMoveDatePickerValue] = useState<Date>(new Date());
  const [selectedEventDetail, setSelectedEventDetail] = useState<any | null>(null);
  
  // Phase 2: Added sheetVisible state
  const [daysLoaded, setDaysLoaded] = useState(30);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [showOrbitTip, setShowOrbitTip] = useState(false);
  // NEX-162: lead-time create sheet (standalone or prefilled from an event).
  const [leadTimeSheet, setLeadTimeSheet] = useState<{ visible: boolean; prefill: LeadTimePrefill | null }>({ visible: false, prefill: null });
  // Screen-canonical "today" key (Orbit deliberately has no parent-level `now`
  // ticker). Refreshed by refreshDayAnchors on focus, foreground, and a
  // midnight timer; drives the lead-time rollup, the calendar anchor reset,
  // and the Today's Wisdom display gate.
  const [leadTimeTodayKey, setLeadTimeTodayKey] = useState(() => getLocalDateKey(new Date()));
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    AsyncStorage.getItem('nexus_hasSeenOrbitTip').then(val => {
      if (!val) setShowOrbitTip(true);
    }).catch(() => {});
  }, []);

  const dismissOrbitTip = () => {
    setShowOrbitTip(false);
    AsyncStorage.setItem('nexus_hasSeenOrbitTip', 'true').catch(() => {});
  };

  const daysArray = useMemo(() => { const arr = []; for (let i = 0; i < daysLoaded; i++) { const d = new Date(anchorDate); d.setDate(d.getDate() + i); arr.push(d.toDateString()); } return arr; }, [anchorDate, daysLoaded]);

  // FIDGET-FIX: AppState 'change' fires on every transition to active —
  // including control-center peek and notification interactions. Without a
  // cooldown each transition re-fetches and pushes a new appleEvents array
  // ref, cascading through groupedAppleEvents → dayDataMap → renderDay.
  const FETCH_COOLDOWN_MS = 60_000;
  const lastFetchRef = useRef(0);
  const lastEventsHashRef = useRef('');

  const fetchAppleCalendar = async () => {
    if (Date.now() - lastFetchRef.current < FETCH_COOLDOWN_MS) return;
    lastFetchRef.current = Date.now();
    const startDate = new Date(); startDate.setMonth(startDate.getMonth() - 1);
    const endDate = new Date(); endDate.setFullYear(endDate.getFullYear() + 1);
    const mappedAppleEvents = await fetchConnectedCalendarEventsWindow({ startDate, endDate });

    // Skip the setState if providers returned the same event list — common
    // when foregrounding from a brief background. A new array ref would
    // otherwise cascade through groupedAppleEvents.
    const hash = mappedAppleEvents.map((e: any) => `${e.id}|${e.startDate}|${e.endDate}|${e.title}|${e.provider ?? ''}`).join('§');
    if (hash !== lastEventsHashRef.current) {
      lastEventsHashRef.current = hash;
      setAppleEvents(mappedAppleEvents);
    }

    if (!reconcilingRef.current) {
      reconcilingRef.current = true;
      try {
        await reconcileRecurringRulesWithNativeCalendar(
          mappedAppleEvents.filter((event: any) => isAppleCalendarEvent(event)),
          selectedDate,
        );
      } finally {
        reconcilingRef.current = false;
      }
    }

    // Auto-log connected calendar events that match linked habits. Only log
    // after the event has ended, and never re-log something the user manually
    // unchecked today.
    const liveState: any = useAppState.getState?.() ?? {};
    const goalHabitMap: Record<string, string[]> = liveState.goalHabitMap ?? {};
    const linkedHabitTitles = Object.keys(goalHabitMap);
    if (linkedHabitTitles.length > 0) {
      const nowMs = Date.now();
      const todayKey = getLocalDateKey(new Date());
      const todayEvents = mappedAppleEvents.filter((e: any) => {
        const d = new Date(e.startDate);
        return getLocalDateKey(d) === todayKey;
      });
      todayEvents.forEach((e: any) => {
        const eventEnd = new Date(e.endDate || e.startDate).getTime();
        if (eventEnd > nowMs) return;
        const titleLower = (e.title ?? '').toLowerCase();
        const matchedHabit = linkedHabitTitles.find((h) =>
          titleLower.includes(h.toLowerCase()) || h.toLowerCase().includes(titleLower)
        );
        if (!matchedHabit) return;
        const freshState: any = useAppState.getState?.() ?? {};
        const alreadyLogged = Array.isArray(freshState.habitLog) &&
          freshState.habitLog.some((entry: any) =>
            normalize(entry.habitTitle) === normalize(matchedHabit) &&
            entry.dateKey === todayKey
          );
        if (!alreadyLogged && typeof freshState.logHabit === 'function') {
          freshState.logHabit(matchedHabit);
        }
      });
    }
  };

  // FIDGET-FIX: parent-level setNow interval removed. Today's events tick is
  // owned by <TodayEventsSection>; per-event countdown chips own their own.

  // Today's Wisdom generation lives in src/features/wisdom (so Home can pre-warm
  // it on a win change too). This wrapper only reflects the run in the local
  // loading state — the single-flight dedupe lives in the service, so Home's
  // pre-warm and this focus/refresh trigger share one in-flight run.
  const generateQuotes = async () => {
    setQuotesLoading(true);
    // Optimistic: if there's nothing FRESH to show (cold start, a Home pre-warm
    // still in flight, or the store holds a STALE DAY's quotes), render curated
    // fallback quotes immediately so the section is never blank — and never
    // shows yesterday's quotes as today's. A same-day refresh OVER existing
    // quotes (win change) keeps them visible until the AI swap.
    const live = useAppState.getState() as any;
    const todayKey = getLocalDateKey(new Date());
    const hasFreshQuotes =
      Array.isArray(live.dailyWisdomQuotes) &&
      live.dailyWisdomQuotes.length > 0 &&
      live.dailyWisdomQuotes[0]?.quote &&
      live.dailyWisdomDate === todayKey;
    if (!hasFreshQuotes) {
      const count = Math.max(0, Number(live.wisdomQuoteCount ?? 3));
      if (count > 0) setProvisionalQuotes(getFallbackQuotes(count));
    }
    try {
      await generateWisdom();
    } finally {
      setQuotesLoading(false);
      setProvisionalQuotes(null);
    }
  };

  // Single day-rollover refresh for everything on this screen keyed to "today":
  // the screen today-key, the calendar anchor/selection, and Today's Wisdom.
  // Every setter is functional and identity-preserving, so the frequent
  // triggers below cause zero re-renders while the day is unchanged (respects
  // the FIDGET-FIX constraints above). Reads live state via getState() at call
  // time, so holding a first-render closure in the mount-scoped listener is safe.
  const todayKeyRef = useRef(getLocalDateKey(new Date()));
  const refreshDayAnchors = () => {
    const now = new Date();
    const newKey = getLocalDateKey(now);
    // Anchor/selection reset ONLY on an actual day rollover (tracked via the
    // ref, not on every focus/foreground) — a deliberately-picked past date
    // must survive tab switches and brief backgrounding within the same day.
    const dayRolledOver = todayKeyRef.current < newKey;
    todayKeyRef.current = newKey;
    setLeadTimeTodayKey(prev => (prev === newKey ? prev : newKey));
    if (dayRolledOver) {
      const todayMidnight = new Date(now);
      todayMidnight.setHours(0, 0, 0, 0);
      // At rollover, reset only a selection that is now in the PAST — fixes the
      // stale "today" highlight while preserving a deliberately-picked FUTURE
      // date. (Two accepted, documented limitations: a past date being browsed
      // exactly as midnight passes also resets to today; and a backward
      // clock/timezone change leaves a now-future selection in place — both
      // corrected by the user's next manual tap.)
      setSelectedDate(prev => (getLocalDateKey(prev) < newKey ? todayMidnight : prev));
      setAnchorDate(prev => (getLocalDateKey(prev) < newKey ? todayMidnight : prev));
    }
    // Wisdom rollover: regenerate when the persisted quotes are for a prior day.
    // The service's single-flight dedupes this against the focus-time staleness
    // trigger below, so overlapping calls share one run.
    const live = useAppState.getState() as any;
    if (Math.max(0, Number(live.wisdomQuoteCount ?? 3)) > 0 && live.dailyWisdomDate !== newKey) {
      generateQuotes();
    }
  };

  // Foreground + mount: AppState fetch is debounced inside fetchAppleCalendar
  // via lastFetchRef; refreshDayAnchors no-ops within the same day.
  useEffect(() => {
    fetchAppleCalendar();
    refreshDayAnchors();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        fetchAppleCalendar();
        refreshDayAnchors();
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus: the tab stays mounted, so a mount effect never re-fires on
  // navigation — re-check the day anchors every time Orbit gains focus (same
  // pattern as the wisdom focus effect below).
  useFocusEffect(
    useCallback(() => {
      refreshDayAnchors();
      // refreshDayAnchors reads all state via functional setters/getState() at
      // call time, so referencing it without listing it as a dep is safe.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // Midnight timer: covers the app sitting foregrounded on Orbit across
  // midnight, where neither focus nor foreground fires. Re-armed
  // UNCONDITIONALLY after each fire via the tick dep (keying on the day-key
  // alone would disarm forever if the timer fired without a day change, e.g. a
  // backward clock adjustment). setHours(24,...) is local calendar math, so
  // DST-safe. Timers frozen in the background are fine — the AppState 'active'
  // path covers that, and a late fire after foreground is a same-day no-op.
  const [midnightTick, setMidnightTick] = useState(0);
  useEffect(() => {
    const next = new Date();
    next.setHours(24, 0, 5, 0); // next local midnight + 5s slop
    const id = setTimeout(() => {
      refreshDayAnchors();
      setMidnightTick(t => t + 1);
    }, Math.max(1000, next.getTime() - Date.now()));
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [midnightTick]);

  // Auto-generate when Orbit is focused if stale. useFocusEffect (not a mount
  // useEffect) so the check re-runs every time the user lands on Orbit — that's
  // what lets a today's-win set on Home, or a day rollover, surface without an
  // app restart (the tab stays mounted, so a mount effect would never re-fire).
  // Staleness is intention-aware (wisdomIsStale): a changed win re-rolls once.
  // Single attempt — the wisdom service owns the retry/dedupe/fallback chain and
  // its single-flight guard, so focus re-entry (or a Home pre-warm already in
  // flight) shares the one run rather than starting a second.
  useFocusEffect(
    useCallback(() => {
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      const liveState = useAppState.getState() as any;
      const expectedCount = Math.max(0, Number(liveState.wisdomQuoteCount ?? 3));
      // Trimmed to match how generateQuotes stores intentionKey, so the two
      // sides of the staleness compare are derived identically (the helper
      // also trims defensively).
      const currentIntention = liveState.morningIntentionDate === todayKey ? (liveState.morningIntention || '').trim() : '';
      const isStale = wisdomIsStale({
        expectedCount,
        dailyWisdomDate: liveState.dailyWisdomDate,
        dailyWisdomIntention: liveState.dailyWisdomIntention,
        quotes: liveState.dailyWisdomQuotes,
        todayKey,
        currentIntention,
      });
      if (isStale) generateQuotes();
      // generateQuotes is recreated each render but reads all state via
      // getState() at call time, so referencing it here without listing it as
      // a dep is safe; re-key only on wisdomQuoteCount (an inline count change
      // while focused should re-evaluate).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wisdomQuoteCount]),
  );

  // (Foreground-on-a-new-day wisdom refresh lives in refreshDayAnchors above —
  // a second AppState listener here would double-call generateQuotes.)

  const groupedAppleEvents = useMemo(() => { const grouped: any = {}; appleEvents.forEach(e => { const dStr = new Date(e.startDate).toDateString(); if (!grouped[dStr]) grouped[dStr] = []; grouped[dStr].push(e); }); return grouped; }, [appleEvents]);

  // FIDGET-FIX: per-day data tree memoization. Recomputes only when one of
  // its real inputs changes — never on a `now` tick or other unrelated
  // parent re-render. renderDay just looks up the precomputed entry.
  const dayDataMap = useMemo(() => {
    const map = new Map<string, DayData>();
    daysArray.forEach((dayStr: string) => {
      map.set(dayStr, computeDayData({
        dayStr,
        recurringRules,
        recurringToDos,
        dailyTasks,
        orbitDays,
        groupedAppleEvents,
        selectedDate,
      }));
    });
    return map;
  }, [daysArray, recurringRules, recurringToDos, dailyTasks, orbitDays, groupedAppleEvents, selectedDate]);

  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTaskText, setEditingTaskText] = useState('');

  const startEditTask = (task: any, dateStr: string) => {
    const baseId = task.id.replace(/-auto$/, '');
    // Check if task is recurring: either flagged, or ID matches a recurringToDo
    const isRec = task.isRecurring || (recurringToDos || []).some((r: any) => r.id === baseId);
    const options = isRec
      // NEX-309: recurring items get the DETACHING half of Apple's model.
      // "Edit Schedule" rewrites the whole series; this moves one occurrence.
      ? ['Rename', 'Move Just This Day', 'Edit Schedule', 'Delete', 'Cancel']
      : ['Rename', 'Move to Different Day', 'Delete', 'Cancel'];
    const destructiveIndex = options.indexOf('Delete');
    const cancelIndex = options.indexOf('Cancel');

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, destructiveButtonIndex: destructiveIndex, cancelButtonIndex: cancelIndex, title: task.title },
        (idx) => {
          const selected = options[idx];
          if (selected === 'Rename') {
            Alert.prompt(
              'Rename',
              null,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Save',
                  onPress: (newTitle?: string) => {
                    if (!newTitle?.trim()) return;
                    if (isRec) {
                      updateRecurringToDo(baseId, { title: newTitle.trim() });
                    } else {
                      const liveState = useAppState.getState();
                      const current = (liveState.dailyTasks as any)[dateStr] || [];
                      useAppState.setState({
                        dailyTasks: { ...(liveState.dailyTasks as any), [dateStr]: current.map((t: any) => t.id === task.id ? { ...t, title: newTitle.trim() } : t) },
                      });
                    }
                    haptic('buttonSecondary');
                  },
                },
              ],
              'plain-text',
              task.title
            );
          } else if (selected === 'Edit Schedule') {
            const liveState = useAppState.getState();
            const todo = (liveState.recurringToDos as any[]).find((r: any) => r.id === baseId);
            if (todo) setScheduleEditToDo(todo);
          } else if (selected === 'Move to Different Day' || selected === 'Move Just This Day') {
            try {
              const normalizedKey = getLocalDateKey(dateStr);
              const parts = normalizedKey.split('-');
              const initialDate = parts.length === 3
                ? new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 12, 0, 0)
                : new Date();
              if (isNaN(initialDate.getTime())) throw new Error('Invalid date');
              setMoveDatePickerValue(initialDate);
              setMoveDatePickerTask({ task, dateKey: normalizedKey });
            } catch {
              setMoveDatePickerValue(new Date());
              setMoveDatePickerTask({ task, dateKey: getLocalDateKey(new Date()) });
            }
            return;
          } else if (selected === 'Delete') {
            const delKey = getLocalDateKey(dateStr);
            if (isRec) {
              // Apple-Calendar-pattern three-option alert. "This Day
              // Only" writes a per-day exception AND removes the
              // already-toggled instance from dailyTasks (the
              // ${baseId}-auto record persists separately when the
              // user has tapped to complete today before deleting).
              Alert.alert(
                `Delete "${task.title}"?`,
                'This task repeats on a schedule. Choose how to delete it.',
                [
                  {
                    text: 'This Day Only',
                    onPress: () => {
                      if (typeof addRecurringToDoException === 'function') {
                        addRecurringToDoException(baseId, delKey);
                      }
                      if (deleteDailyTask) {
                        deleteDailyTask(delKey, `${baseId}-auto`);
                      }
                      haptic('buttonSecondary');
                    },
                  },
                  {
                    text: 'All Future Days',
                    style: 'destructive',
                    onPress: () => {
                      deleteRecurringToDo(baseId);
                      haptic('dragDrop');
                    },
                  },
                  { text: 'Cancel', style: 'cancel' },
                ],
              );
            } else {
              Alert.alert('Delete Task', `Remove "${task.title}"?`, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => {
                  if (deleteDailyTask) {
                    deleteDailyTask(delKey, task.id);
                  }
                  haptic('dragDrop');
                }},
              ]);
            }
          }
        }
      );
    } else {
      // Android fallback
      Alert.prompt('Rename', null, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Save',
          onPress: (newTitle?: string) => {
            if (!newTitle?.trim()) return;
            const liveState = useAppState.getState();
            if (task.isRecurring) {
              const baseId = task.id.replace(/-auto$/, '');
              useAppState.setState({
                recurringToDos: (liveState.recurringToDos || []).map((r: any) =>
                  r.id === baseId ? { ...r, title: newTitle.trim() } : r
                ),
              });
            } else {
              const dKey = getLocalDateKey(dateStr);
              const current = liveState.dailyTasks[dKey] || [];
              useAppState.setState({
                dailyTasks: { ...liveState.dailyTasks, [dKey]: current.map((t: any) => t.id === task.id ? { ...t, title: newTitle.trim() } : t) },
              });
            }
          },
        },
      ], 'plain-text', task.title);
    }
  };

  const saveEditTask = (dateStr: string, taskId: string) => {
    if (!editingTaskText.trim()) { setEditingTaskId(null); return; }
    const liveState = useAppState.getState();
    const dKey = getLocalDateKey(dateStr);
    const current = liveState.dailyTasks[dKey] || liveState.dailyTasks[dateStr] || [];
    useAppState.setState({ dailyTasks: { ...liveState.dailyTasks, [dKey]: current.map((t: any) => t.id === taskId ? { ...t, title: editingTaskText.trim() } : t) } });
    setEditingTaskId(null);
    haptic('buttonSecondary');
  };

  const toggleTask = (dateStr: string, taskId: string) => {
    haptic('buttonSecondary');
    const liveState = useAppState.getState();
    const dKey = getLocalDateKey(dateStr);
    const currentTasks = liveState.dailyTasks[dKey] || liveState.dailyTasks[dateStr] || [];
    useAppState.setState({ dailyTasks: { ...liveState.dailyTasks, [dKey]: currentTasks.map(t => t.id === taskId ? { ...t, completed: !t.completed } : t) } });
    syncWidgetAfterMutation();
  };

  // ─── Stable callback wrappers for the day todo list ────────────────
  // toggleTask and startEditTask are recreated each parent render,
  // which destabilized the inner DraggableFlatList's renderItem
  // closure and intermittently aborted the move-to-bottom animation
  // mid-flight. Pattern: keep latest impl in a ref, expose a
  // useCallback-wrapped stable shim that reads from the ref. Each
  // render updates the ref (cheap, no re-render); the shim's
  // identity is permanent. Downstream child components can depend
  // on the shim with no risk of fresh-closure churn.
  const toggleTaskRef = useRef(toggleTask);
  toggleTaskRef.current = toggleTask;
  const startEditTaskRef = useRef(startEditTask);
  startEditTaskRef.current = startEditTask;
  const stableToggleTask = useCallback(
    (d: string, id: string) => toggleTaskRef.current(d, id),
    [],
  );
  const stableStartEditTask = useCallback(
    (task: any, d: string) => startEditTaskRef.current(task, d),
    [],
  );

  const scrollTimeout = useRef<any>(null);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 40 }).current;
  // FIDGET-FIX note: this still calls setSelectedDate when the user crosses a
  // day boundary, which retriggers dayDataMap (selectedDate is a dep — used as
  // sort baseline). That re-runs computeDayData for visible days, but it does
  // NOT cascade through `now`, so today/tomorrow seam visuals stay stable.
  // If the re-sort cost ever shows up in profiling, hoist the sort baseline
  // to per-day (`new Date(dayStr)`) and remove selectedDate from the deps.
  //
  // INTENTIONAL "lock to next day" behavior: when the user scrolls past a day
  // boundary, after a 250ms debounce setSelectedDate fires, which causes the
  // inline DateTimePicker in the header to highlight the new day. This can
  // feel like a "snap" but the FlatList itself does NOT scrollTo or snap —
  // only the calendar header UI catches up. No scrollToOffset side-effect
  // listens to selectedDate. If the perceived snap is too abrupt, lower the
  // 250ms debounce or animate the picker selection ring transition.
  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    if (viewableItems && viewableItems.length > 0) {
      const newDate = new Date(viewableItems[0].item);
      if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
      scrollTimeout.current = setTimeout(() => setSelectedDate(prev => prev.toDateString() !== newDate.toDateString() ? newDate : prev), 250);
    }
  }).current;

  // Deletes exactly ONE routine — the one the user acted on.
  //
  // It used to delete `event.recurringRuleId` PLUS every rule matching
  // recurringRuleMatchesRenderedEvent, which is same-normalized-title +
  // within-5-minutes, and whose time check defaults to TRUE when either clock
  // is unparseable. So two genuinely distinct routines sharing a title — "Read"
  // at 8:00 and "Read" at 8:03, or two with no parseable time at all — were
  // both destroyed when the user deleted one of them.
  //
  // The rendered row carries the authoritative rule id, so use it. Title+time
  // matching survives only as a fallback for rows that lack one, and only when
  // it resolves to exactly one rule: an ambiguous match deletes nothing and
  // reports 0, which the caller already surfaces as "unable to remove". Same
  // principle as the calendar deletes — never destroy on an identifier we
  // cannot vouch for.
  const deleteMatchingRecurringRulesFromOrbit = (event: any) => {
    const liveState: any = useAppState.getState?.() ?? {};
    const allRules = Array.isArray(liveState.recurringRules) ? liveState.recurringRules : [];

    const { ids: idsToDelete, outcome } = selectRuleIdsToDelete({
      explicitId: event?.recurringRuleId ?? null,
      existingIds: allRules.map((rule: any) => rule?.id).filter(Boolean),
      matchedIds: allRules
        .filter((rule: any) => recurringRuleMatchesRenderedEvent(rule, event))
        .map((rule: any) => rule.id),
    });

    if (outcome === 'ambiguous') {
      console.warn(
        '[Orbit] several routines match this block by title/time — refusing to guess which to delete',
      );
    }

    if (!idsToDelete.length) {
      return 0;
    }

    if (typeof liveState.deleteRecurringRule === 'function') {
      idsToDelete.forEach((id: string) => {
        liveState.deleteRecurringRule(id);
      });
    } else {
      useAppState.setState((state: any) => ({
        recurringRules: (Array.isArray(state.recurringRules) ? state.recurringRules : []).filter(
          (rule: any) => !idsToDelete.includes(rule.id)
        ),
      }));
    }

    return idsToDelete.length;
  };

  
  const editRecurringBlock = async (event: any) => {
    const normalizeRuleTitle = (value: any) =>
      String(value || '')
        .trim()
        .toLowerCase();

    const normalizeRuleTime = (value: any, preferredTimeBlock?: string | null) =>
      normalizeRecurringEditTime(value, preferredTimeBlock);

    const explicitRuleId =
      event?.ruleId ||
      event?.recurringRuleId ||
      event?.orbitRuleId ||
      null;

    const eventTitleNormalized = normalizeRuleTitle(event?.title);
    const eventTimeNormalized = normalizeRuleTime(
      event?.time || event?.timeLabel,
      event?.preferredTimeBlock
    );

    const matchedRule =
      (explicitRuleId
        ? recurringRules.find((rule: any) => rule?.id === explicitRuleId)
        : null) ||
      (event?.appleEventId
        ? recurringRules.find((rule: any) => rule?.appleEventId === event.appleEventId)
        : null) ||
      recurringRules.find((rule: any) => {
        const sameTitle = normalizeRuleTitle(rule?.title) === eventTitleNormalized;
        if (!sameTitle) return false;

        const ruleTimeNormalized = normalizeRuleTime(
          rule?.time,
          rule?.preferredTimeBlock
        );

        if (eventTimeNormalized && ruleTimeNormalized) {
          return ruleTimeNormalized === eventTimeNormalized;
        }

        if (event?.preferredTimeBlock && rule?.preferredTimeBlock) {
          return rule?.preferredTimeBlock === event?.preferredTimeBlock;
        }

        return true;
      }) ||
      recurringRules.find((rule: any) => {
        return normalizeRuleTitle(rule?.title) === eventTitleNormalized;
      });

    const ruleId = matchedRule?.id || explicitRuleId || null;
    const linkedAppleEventId =
      event?.appleEventId || matchedRule?.appleEventId || null;

    if (!ruleId) {
      if (linkedAppleEventId) {
        void openSystemCalendarEvent({ id: linkedAppleEventId });
        return;
      }

      Alert.alert(
        'Cannot edit recurring block',
        'This local recurring block could not be matched to its Orbit rule.'
      );
      return;
    }

    const existingTitle = String(
      matchedRule?.title || event?.title || ''
    ).trim();

    const existingTime = String(
      matchedRule?.time ||
        event?.time ||
        event?.timeLabel ||
        (matchedRule?.preferredTimeBlock
          ? ORBIT_TIME_BLOCK_FALLBACKS[matchedRule.preferredTimeBlock]
          : '') ||
        (event?.preferredTimeBlock
          ? ORBIT_TIME_BLOCK_FALLBACKS[event.preferredTimeBlock]
          : '')
    ).trim();

    if (Platform.OS !== 'ios' || typeof (Alert as any).prompt !== 'function') {
      if (linkedAppleEventId) {
        void openSystemCalendarEvent({ id: linkedAppleEventId });
        return;
      }

      Alert.alert(
        'Edit recurring block',
        'Inline editing is currently enabled on iPhone/iOS only.'
      );
      return;
    }

    (Alert as any).prompt(
      'Edit recurring block',
      'Update the title for this recurring block.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Next',
          onPress: (nextTitleRaw: string) => {
            const nextTitle = String(nextTitleRaw || existingTitle).trim() || existingTitle;

            (Alert as any).prompt(
              'Edit time',
              'Enter a time like 17:00 or 5:00 PM.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Save',
                  onPress: async (nextTimeRaw: string) => {
                    const normalizedTime = normalizeRecurringEditTime(
                      nextTimeRaw || existingTime,
                      matchedRule?.preferredTimeBlock || event?.preferredTimeBlock
                    );

                    if (!normalizedTime) {
                      Alert.alert(
                        'Invalid time',
                        'Please use HH:MM or 12-hour time like 5:00 PM.'
                      );
                      return;
                    }

                    try {
                      const liveState = useAppState.getState?.() ?? {};
                      const liveRules = Array.isArray(liveState.recurringRules)
                        ? liveState.recurringRules
                        : [];

                      useAppState.setState({
                        recurringRules: liveRules.map((rule: any) =>
                          rule?.id === ruleId
                            ? {
                                ...rule,
                                title: nextTitle,
                                time: normalizedTime,
                                preferredTimeBlock: null,
                              }
                            : rule
                        ),
                      });

                      if (linkedAppleEventId) {
                        const displayDateKey =
                          getOrbitDisplayDateKey(event, null) ||
                          new Date().toISOString().slice(0, 10);

                        const nextStart = buildRoutineDateFromKeyAndTime(
                          displayDateKey,
                          normalizedTime,
                          null
                        );
                        const nextEnd = new Date(nextStart.getTime() + 60 * 60 * 1000);

                        await Calendar.updateEventAsync(linkedAppleEventId, {
                          title: nextTitle,
                          startDate: nextStart,
                          endDate: nextEnd,
                        });

                        if (typeof setAppleEvents === 'function') {
                          setAppleEvents((prev: any[]) =>
                            Array.isArray(prev)
                              ? prev.map(item =>
                                  item?.id === linkedAppleEventId
                                    ? {
                                        ...item,
                                        title: nextTitle,
                                        time: normalizedTime,
                                        timeLabel: normalizedTime,
                                        startDate: nextStart.toISOString(),
                                        startISO: nextStart.toISOString(),
                                        sortStartMs: nextStart.getTime(),
                                      }
                                    : item
                                )
                              : prev
                          );
                        }
                      }

                      haptic('voiceSuccess');
                    } catch (err: any) {
                      Alert.alert(
                        'Unable to update recurring block',
                        err?.message || 'Please try again.'
                      );
                    }
                  },
                },
              ],
              'plain-text',
              existingTime
            );
          },
        },
      ],
      'plain-text',
      existingTitle
    );
  };

const manageRecurringEvent = (event: any) => {
    const liveState: any = useAppState.getState?.() ?? {};
    const recurringRuleId = event?.recurringRuleId;
    const appleEventId = event?.appleEventId ?? null;

    const deleteOrbitOnly = () => {
      const removedCount = deleteMatchingRecurringRulesFromOrbit(event);

      if (removedCount > 0) {
        haptic('voiceSuccess');
        return;
      }

      Alert.alert('Recurring Block', 'Unable to remove this recurring block from Orbit.');
    };

    const deleteAppleAndOrbit = async () => {
      try {
        // Delete ONLY via this device's own stored link. There is deliberately
        // no fallback to `event.appleEventId`: that descends from the rule's
        // shared mirror, which is last-writer-wins across devices and can hold
        // an EventKit id minted elsewhere. Handing a foreign id to
        // deleteEventAsync is a guess — at best it matches nothing, at worst it
        // matches an unrelated event on this device and deletes it.
        //
        // With no local link we remove the routine from Orbit and leave the
        // calendar alone. A leftover calendar event is visible and the user can
        // delete it themselves; deleting the WRONG event is silent and
        // unrecoverable. Same principle as the reconcile: never destroy on an
        // identifier we cannot vouch for.
        await hydrateAppleLinks().catch(() => ({}));
        const ruleId = (event as any)?.recurringRuleId ?? null;
        const ownEventId = (ruleId && getAppleLink(ruleId)) || null;
        if (ownEventId) {
          await Calendar.deleteEventAsync(ownEventId);
        } else if (appleEventId) {
          console.warn(
            '[Orbit] no local calendar link for this routine — removing it from Orbit only, leaving the calendar event in place',
          );
        }
        if (ruleId) await clearAppleLink(ruleId).catch(() => {});

        deleteMatchingRecurringRulesFromOrbit(event);

        haptic('voiceSuccess');
        await fetchAppleCalendar();
      } catch {
        // Per chat 2026-05-18: notification.Error banned for routine; downgrade to Warning (voiceAmbiguous).
        haptic('voiceAmbiguous');
        Alert.alert('Delete Failed', 'Unable to remove this recurring block from Apple Calendar.');
      }
    };

    const openApple = () => {
      if (!appleEventId) {
        Alert.alert('Recurring Block', 'This block only exists in Orbit right now.');
        return;
      }

      void openSystemCalendarEvent({ id: appleEventId });
    };

    if (Platform.OS === 'ios' && ActionSheetIOS?.showActionSheetWithOptions) {
      if (appleEventId) {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: event?.title || 'Recurring Block',
            message: 'Choose how to manage this synced recurring block.',
            options: [
              'Edit recurring block',
              'Open in Apple Calendar',
              'Delete from Orbit Only',
              'Delete from Apple + Orbit',
              'Cancel',
            ],
            cancelButtonIndex: 4,
            destructiveButtonIndex: 3,
          },
          (buttonIndex) => {
            if (buttonIndex === 0) {
              void editRecurringBlock(event);
              return;
            }

            if (buttonIndex === 1) {
              openApple();
              return;
            }

            if (buttonIndex === 2) {
              deleteOrbitOnly();
              return;
            }

            if (buttonIndex === 3) {
              void deleteAppleAndOrbit();
              return;
            }
          }
        );
        return;
      }

      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: event?.title || 'Recurring Block',
          message: 'This recurring block currently exists only in Orbit.',
          options: ['Edit recurring block', 'Delete from Orbit Only', 'Cancel'],
          cancelButtonIndex: 2,
          destructiveButtonIndex: 1,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) {
            void editRecurringBlock(event);
            return;
          }

          if (buttonIndex === 1) {
            deleteOrbitOnly();
          }
        }
      );
      return;
    }

    if (appleEventId) {
      Alert.alert(
        event?.title || 'Recurring Block',
        'Choose how to manage this synced recurring block.',
        [
          { text: 'Edit recurring block', onPress: openApple },
          { text: 'Open in Apple Calendar',
          onPress: () => openSystemCalendarEvent(event),
        },
        {
          text: 'Delete from Orbit Only', onPress: deleteOrbitOnly },
          { text: 'Delete from Apple + Orbit', style: 'destructive', onPress: () => void deleteAppleAndOrbit() },
          { text: 'Cancel', style: 'cancel' },
        ]
      );
      return;
    }

    Alert.alert(
      event?.title || 'Recurring Block',
      'This recurring block currently exists only in Orbit.',
      [
        { text: 'Delete from Orbit Only', style: 'destructive', onPress: deleteOrbitOnly },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  const WisdomSection = useMemo(() => {
    if (wisdomQuoteCount === 0) return null;
    // Display priority: real (store) quotes → optimistic fallback → loading → empty.
    // The optimistic fallback means the section is never blank/spinning during a
    // cold start or a Home pre-warm; the AI swap happens under it when it resolves.
    // Store quotes are gated on TODAY's key (leadTimeTodayKey, refreshed by
    // refreshDayAnchors on focus/foreground/midnight) so a prior day's persisted
    // quotes can never render as today's while regeneration is in flight.
    const storeQuotes =
      Array.isArray(dailyWisdomQuotes) && dailyWisdomQuotes.length > 0 && dailyWisdomQuotes[0]?.quote &&
      dailyWisdomDate === leadTimeTodayKey
        ? dailyWisdomQuotes
        : null;
    const displayQuotes = storeQuotes ?? provisionalQuotes;
    return (
    <View style={styles.mandateContainer}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: tokens.spacing.sm }}>
        <Text style={styles.mandateTitle}>TODAY&apos;S WISDOM</Text>
        <Pressable
          onPress={() => generateQuotes()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Refresh wisdom"
          accessibilityState={{ busy: quotesLoading }}
        >
          {/* FIXME(nex-56): tokens.color.textDisabled off-scale gray — design review */}
          {/* FIXME(nex-56): off-scale fontSize 14, design review */}
          <Text style={{ color: tokens.color.textDisabled, fontSize: 14 }} accessibilityElementsHidden importantForAccessibility="no">{quotesLoading ? '···' : '↺'}</Text>
        </Pressable>
      </View>
      {displayQuotes && displayQuotes.length > 0 ? (
        displayQuotes.map((q: any, i: number) => (
          <View key={i}>
            {i > 0 && <View style={styles.mandateDivider} />}
            {/* FIXME(nex-56): tokens.color.textDisabled off-scale gray — design review */}
            {/* FIXME(nex-56): off-scale fontSize 8, design review */}
            {q.tag && <Text style={{ color: tokens.color.textDisabled, fontSize: 8, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.xxs }}>{q.tag.toUpperCase()}</Text>}
            <Text style={styles.quoteText}>&quot;{q.quote}&quot;</Text>
            <Text style={styles.quoteAuthor}>— {q.author}</Text>
          </View>
        ))
      ) : (
        // Nothing to show yet — the brief cold-start window before the optimistic
        // fallback (or AI) lands, including the first mount frame before the focus
        // effect kicks off generation. A quiet breathing skeleton, never a blank
        // "···". Once wisdom is enabled the store/fallback fills within a tick, so
        // this is transient by construction.
        <Shimmer bars={[{ width: '100%' }, { width: '92%' }, { width: '42%', height: 10, marginTop: 14 }]} />
      )}
    </View>);
  }, [quotesLoading, dailyWisdomQuotes, dailyWisdomDate, wisdomQuoteCount, provisionalQuotes, leadTimeTodayKey]);

  const isOrbitEmpty = (!recurringRules || recurringRules.length === 0) && (!recurringToDos || recurringToDos.length === 0);

  // Memoized JSX (not a component function) so FlatList sees stable
  // identity across renders. Previously this was an inline arrow
  // component (`const ListHeader = () => (…)`) which returned a fresh
  // function reference every render; FlatList treated it as a new
  // ListHeaderComponent, remounted the inline DateTimePicker, and the
  // re-measure on first paint produced the visible "jolts up and
  // down on render" symptom on first open of the Orbit tab.
  const leadTimeRollup = useMemo(
    () => selectLeadTimeRollup(leadTimeActions, leadTimeTodayKey),
    [leadTimeActions, leadTimeTodayKey],
  );

  const ListHeader = useMemo(() => (
    <>
      {WisdomSection}
      <View style={styles.calendarContainer}>
        <DateTimePicker
          value={selectedDate} mode="date" display="inline" themeVariant="dark" style={{ alignSelf: 'center' }}
          onChange={(event, date) => {
            if (event.type === 'set' && date) {
              if (date.toDateString() !== selectedDate.toDateString()) {
                setSelectedDate(date); setAnchorDate(date); setDaysLoaded(30);
                if (listRef.current) listRef.current.scrollToOffset({ offset: 0, animated: false });
                haptic('tabChange');
              }
            }
          }}
        />
      </View>
      <LeadTimeOrbitSection
        rollup={leadTimeRollup}
        onToggle={toggleLeadTimeAction}
        onDelete={deleteLeadTimeAction}
        onAdd={() => setLeadTimeSheet({ visible: true, prefill: null })}
      />
      {/* v3 stellar: border #262626 → tokens.color.goldHairline (now white). */}
      {isOrbitEmpty && (
        <View style={{ marginHorizontal: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, marginBottom: tokens.spacing.md, padding: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, borderRadius: 16, borderWidth: 1, borderColor: tokens.color.luminousEdge, backgroundColor: tokens.color.surface, ...ambientGlowSoft }}>
          {/* FIXME(nex-56): fontSize 13 matches caption/labelTrackedLg size but fontWeight '900' ≠ token '500'/'600' + tracked-caps style — design review */}
          <Text style={{ color: tokens.color.gold, fontSize: 13, fontWeight: '900', letterSpacing: 1.5, marginBottom: tokens.spacing.xs }}>YOUR ORBIT IS EMPTY</Text>
          {/* v3 stellar: body gray #999 → tokens.color.textSecondary (cool blue-white). */}
          {/* FIXME(nex-56): fontSize 13 matches caption size but fontWeight default ≠ token '500'; lineHeight 20 ≠ token 18 — design review */}
          <Text style={{ color: tokens.color.textSecondary, fontSize: 13, lineHeight: 20 }}>
            Routines, appointments, to-dos, and time blocks live here.
          </Text>
          {/* NEX-213 (I-4): one co-located low-threshold action (same as the
              header +) instead of the verbal "tap the + button" instruction. */}
          <Pressable
            onPress={() => { haptic('buttonPrimary'); setSheetVisible(true); }}
            style={{ backgroundColor: tokens.color.gold, paddingVertical: 12 /* FIXME(nex-56): off-scale spacing — review */, paddingHorizontal: 24 /* FIXME(nex-56): off-scale spacing — review */, borderRadius: 9999, marginTop: tokens.spacing.md, alignSelf: 'flex-start' }}
            accessibilityRole="button"
            accessibilityLabel="Add an item to your orbit"
            testID="orbit-empty-add"
          >
            {/* FIXME(nex-56): off-scale fontSize 13 — design review */}
            <Text style={{ color: tokens.color.textInverse, fontSize: 13, fontWeight: '700', letterSpacing: 1 }}>Add one thing</Text>
          </Pressable>
        </View>
      )}
    </>
  ), [WisdomSection, selectedDate, isOrbitEmpty, leadTimeRollup, toggleLeadTimeAction, deleteLeadTimeAction]);

  // FIDGET-FIX: thin renderDay. Per-day data lives in dayDataMap. Today's
  // events list — the only branch that needs `now` — is rendered by
  // <TodayEventsSection>, which owns its own ticker.
  const handleTogglePastToday = useCallback(() => setShowPastToday(v => !v), []);
  const renderDay = useCallback(({ item: dayStr }: { item: string }) => {
    try {
      const data = dayDataMap.get(dayStr);
      if (!data) return null;
      const { dayAgenda, allTasks } = data;
      const todayStr = new Date().toDateString();
      const isToday = dayStr === todayStr;
      const isSelected = dayStr === selectedDate.toDateString();
      // For non-today days, every event's past/future flag is determined by
      // the day itself — no minute-granularity required, no `now` needed.
      const dayMidnight = new Date(dayStr); dayMidnight.setHours(0, 0, 0, 0);
      const todayMidnight = new Date(todayStr); todayMidnight.setHours(0, 0, 0, 0);
      const isPastDay = !isToday && dayMidnight.getTime() < todayMidnight.getTime();
      const dKey = getLocalDateKey(dayStr);

      return (
        <View style={styles.section}>
          <View style={styles.dayHeaderRow}>
            <Text style={[styles.dayLabel, isSelected && { color: tokens.color.gold }]}>{isToday ? 'TODAY\'S HORIZON' : dayStr.toUpperCase()}</Text>
            {/* v3 stellar: meta gray #2A2A2A → tokens.color.textMuted (cool blue-gray, holds against cosmos). */}
            {/* FIXME(nex-56): off-scale fontSize 9, design review */}
            {dayAgenda.length > 0 && <Text style={{ color: tokens.color.textMuted, fontSize: 9, fontWeight: '800', marginLeft: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ }}>{dayAgenda.length} EVENT{dayAgenda.length !== 1 ? 'S' : ''}</Text>}
            <View style={styles.dayLine} />
          </View>

          {/* FIXME(nex-56): tokens.color.textMuted off-scale gray — design review */}
          {/* FIXME(nex-56): off-scale fontSize 11, design review */}
          {dayAgenda.length === 0 && allTasks.length === 0 ? (
            <View style={{ marginBottom: 30 /* FIXME(nex-56): off-scale spacing 30 — review */, opacity: 0.5 }}><Text style={{ color: tokens.color.textMuted, fontSize: 11, fontStyle: 'italic' }}>Horizon Clear</Text></View>
          ) : (
            <>
              {allTasks.length > 0 && (
                <View style={styles.todoSection}>
                  <View style={styles.todoHeaderRow}>
                    <Text style={styles.todoHeader}>DAY&apos;S TO-DO</Text>
                    <Text style={styles.todoHeaderHint}>HOLD TO EDIT</Text>
                  </View>
                  <DayTodoList
                    dKey={dKey}
                    dayStr={dayStr}
                    allTasks={allTasks}
                    onTogglePress={stableToggleTask}
                    onLongPress={stableStartEditTask}
                  />
                </View>
              )}

              {isToday ? (
                <TodayEventsSection
                  dayAgenda={dayAgenda}
                  showPastToday={showPastToday}
                  onTogglePastToday={handleTogglePastToday}
                  onTapAppleEvent={setSelectedEventDetail}
                  onManageRecurring={manageRecurringEvent}
                />
              ) : (
                dayAgenda.map((event: any) => (
                  <SwipeableEvent
                    key={event.id}
                    event={event}
                    isPastEvent={isPastDay}
                    onManageRecurring={manageRecurringEvent}
                    onTapAppleEvent={setSelectedEventDetail}
                  />
                ))
              )}
            </>
          )}
        </View>
      );
    } catch (e) {
      // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
      return <View style={{ padding: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ }}><Text style={{ color: tokens.color.textMuted }}>Unable to render day.</Text></View>;
    }
  }, [dayDataMap, selectedDate, showPastToday, handleTogglePastToday]);

    return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <View style={styles.container}>
      {/* Event Detail Sheet */}
      <EventDetailSheet
        event={selectedEventDetail}
        onDismiss={() => setSelectedEventDetail(null)}
        onOpenCalendar={(ev) => {
          // Dismiss first, then open calendar after modal is fully gone
          setSelectedEventDetail(null);
          setTimeout(() => openSystemCalendarEvent(ev), 400);
        }}
        onNeedsAdvanceAction={(ev: any) => {
          setSelectedEventDetail(null);
          setLeadTimeSheet({ visible: true, prefill: { eventTitle: ev.title, eventDate: ev.startDate, eventId: ev.id } });
        }}
      />
      {/* Schedule Edit Modal */}
      {/* ── Move to Day — Date Picker Modal ───────────────────────────── */}
      {moveDatePickerTask && (
        <Modal visible animationType="slide" presentationStyle="formSheet" onRequestClose={() => setMoveDatePickerTask(null)}>
          <View style={{ flex: 1, backgroundColor: tokens.color.void, padding: tokens.spacing.lg }}>
            <View style={{ alignItems: 'center', marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ }}>
              {/* FIXME(nex-56): tokens.color.textDisabled off-scale gray (modal drag-bar) — design review */}
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: tokens.color.textDisabled }} />
            </View>
            {/* FIXME(nex-56): off-scale fontSize 10, design review */}
            <Text style={{ color: tokens.color.gold, fontSize: 10, fontWeight: '900', letterSpacing: 3, marginBottom: tokens.spacing.xs }}>MOVE TO DAY</Text>
            {/* FIXME(nex-56): off-scale fontSize 20, design review */}
            <Text style={{ color: tokens.color.text, fontSize: 20, fontWeight: '800', marginBottom: 28 /* FIXME(nex-56): off-scale spacing 28 — review */ }} numberOfLines={2}>{moveDatePickerTask.task.title}</Text>
            <DateTimePicker
              value={moveDatePickerValue}
              mode="date"
              display="spinner"
              textColor={tokens.color.text}
              style={{ flex: 1 }}
              onChange={(_: any, date?: Date) => {
                if (date) setMoveDatePickerValue(date);
              }}
            />
            <Pressable
              style={{ backgroundColor: tokens.color.gold, borderRadius: 14, paddingVertical: 18 /* FIXME(nex-56): off-scale spacing 18 — review */, alignItems: 'center', marginBottom: tokens.spacing.sm, marginTop: tokens.spacing.md }}
              accessibilityRole="button"
              accessibilityLabel="Move to this day"
              onPress={() => {
                try {
                  const newKey = getLocalDateKey(moveDatePickerValue);
                  const liveState = useAppState.getState();
                  const oldKey = moveDatePickerTask?.dateKey;
                  if (!oldKey || !moveDatePickerTask?.task?.id) {
                    setMoveDatePickerTask(null);
                    return;
                  }
                  // NEX-309: a RECURRING row routes through the atomic
                  // occurrence-move action instead of the one-off dailyTasks
                  // shuffle below. Detected the same way the menu did (flagged,
                  // or its id matches a rule) so the two paths can't disagree.
                  const rawId = String(moveDatePickerTask.task.id ?? '');
                  const baseId = rawId.replace(/-auto$/, '');
                  const isRecurringRow =
                    moveDatePickerTask.task.isRecurring ||
                    (liveState.recurringToDos as any[])?.some((r: any) => r?.id === baseId);

                  if (isRecurringRow) {
                    const result = moveRecurringOccurrence?.(baseId, oldKey, newKey);
                    if (result?.ok) {
                      syncWidgetAfterMutation();
                      haptic('voiceSuccess');
                      // §1.5 Law A: the confirmation says WHERE it landed, and
                      // undo is one tap. A move the user can't find is a move
                      // they have to hunt for.
                      const label = describeMoveTarget(newKey, getLocalDateKey(new Date()));
                      Alert.alert(`Moved to ${label}.`, 'On your Orbit.', [
                        {
                          text: 'Undo',
                          onPress: () => {
                            undoMoveRecurringOccurrence?.(baseId, oldKey, newKey, result.detachedId);
                            syncWidgetAfterMutation();
                            haptic('buttonSecondary');
                          },
                        },
                        { text: 'OK', style: 'cancel' },
                      ]);
                    } else {
                      // Every refusal is quiet and explains itself once. No
                      // scold, no error chime (§1.5 Law C, §18.3).
                      const why =
                        result?.reason === 'completed'
                          ? "That one's already done."
                          : result?.reason === 'already-scheduled'
                            ? 'That day already has this one.'
                            : result?.reason === 'same-day'
                              ? null // same day: silent no-op
                              : 'That could not be moved.';
                      if (why) Alert.alert(why, undefined, [{ text: 'OK', style: 'cancel' }]);
                    }
                    setMoveDatePickerTask(null);
                    return;
                  }

                  const allDailyTasks = (liveState.dailyTasks as any) || {};
                  const oldTasks = allDailyTasks[oldKey] || [];
                  const taskToMove = oldTasks.find((t: any) => t.id === moveDatePickerTask.task.id);
                  if (taskToMove) {
                    const newTasks = [...(allDailyTasks[newKey] || []), { ...taskToMove, completed: false }];
                    useAppState.setState({
                      dailyTasks: {
                        ...allDailyTasks,
                        [oldKey]: oldTasks.filter((t: any) => t.id !== moveDatePickerTask.task.id),
                        [newKey]: newTasks,
                      },
                    });
                    // NEX-306: refresh the widget after the move. The other
                    // dailyTasks mutations (:1350/:1388/:1894) already do this;
                    // this handler was the one that mutated and left the widget
                    // stale until the next periodic sync.
                    syncWidgetAfterMutation();
                    haptic('voiceSuccess');
                  }
                } catch (e) {
                  console.log('[Orbit] Move task error:', e);
                }
                setMoveDatePickerTask(null);
              }}
            >
              {/* FIXME(nex-56): off-scale fontSize 12, design review */}
              <Text style={{ color: tokens.color.textInverse, fontSize: 12, fontWeight: '900', letterSpacing: 2 }} accessibilityElementsHidden importantForAccessibility="no">MOVE TO THIS DAY</Text>
            </Pressable>
            <Pressable style={{ alignItems: 'center', paddingVertical: tokens.spacing.sm }} hitSlop={tokens.icon.hitTarget.linkSlop} onPress={() => setMoveDatePickerTask(null)} accessibilityRole="button" accessibilityLabel="Cancel">
              {/* FIXME(nex-56): tokens.color.textMuted off-scale gray — design review */}
              {/* FIXME(nex-56): off-scale fontSize 11, design review */}
              <Text style={{ color: tokens.color.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 }}>CANCEL</Text>
            </Pressable>
          </View>
        </Modal>
      )}

      <ScheduleEditModal
        todo={scheduleEditToDo}
        onDismiss={() => setScheduleEditToDo(null)}
        onSave={(id, days, interval) => {
          updateRecurringToDo(id, {
            daysOfWeek: days,
            interval,
            intervalAnchorDate: scheduleEditToDo?.intervalAnchorDate || getLocalDateKey(new Date()),
          });
        }}
      />
      {/* Phase 2: Added the Gold + Button to the Header */}
      <AdaptiveScreen>
      <View style={styles.header}>
        <View />
        <Pressable
          onPress={() => { haptic('modalPresent'); setSheetVisible(true); }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 /* FIXME(nex-56): off-scale spacing 6 — review */, paddingVertical: tokens.spacing.xxs, paddingHorizontal: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, borderRadius: 8, backgroundColor: tokens.color.surfaceElevated }}
          accessibilityRole="button"
          accessibilityLabel="Add item"
          accessibilityHint="Opens the add-item sheet"
        >
          {/* FIXME(nex-56): off-scale fontSize 18 (+) decorative — design review */}
          <Text style={{ color: tokens.color.gold, fontSize: 18, fontWeight: '400', lineHeight: 20 }} accessibilityElementsHidden importantForAccessibility="no">+</Text>
          {/* FIXME(nex-56): off-scale fontSize 10, design review */}
          <Text style={{ color: tokens.color.gold, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 }}>ADD ITEM</Text>
        </Pressable>
      </View>
      <FlatList ref={listRef} data={daysArray} keyExtractor={item => item} ListHeaderComponent={ListHeader} renderItem={renderDay} onEndReached={() => setDaysLoaded(prev => prev + 14)} onEndReachedThreshold={0.5} onViewableItemsChanged={onViewableItemsChanged} viewabilityConfig={viewabilityConfig} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false} />
      </AdaptiveScreen>
      
      {/* Phase 2: Added the Manual Entry Sheet */}
      <OrbitManualAddSheet visible={sheetVisible} onClose={() => setSheetVisible(false)} selectedDate={selectedDate} />

      {/* NEX-162: lead-time create sheet (standalone or prefilled from an event) */}
      <LeadTimeCreateSheet
        visible={leadTimeSheet.visible}
        prefill={leadTimeSheet.prefill}
        onClose={() => setLeadTimeSheet({ visible: false, prefill: null })}
      />

      {/* First-visit Orbit tooltip */}
      <Modal visible={showOrbitTip} transparent animationType="fade" statusBarTranslucent>
        {/* v3 stellar: pure-black scrim → cosmic vignette (matches CLAUDE.md §4.8 gradient.vignette). */}
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(2,2,8,0.78)', justifyContent: 'center', alignItems: 'center', padding: tokens.spacing.lg }} onPress={dismissOrbitTip}>
          {/* v3 stellar: modal border #2A2A2A → tokens.color.goldHairline (now luminous white). */}
          <View style={{ backgroundColor: tokens.color.surface, borderRadius: 20, borderWidth: 1, borderColor: tokens.color.goldHairline, padding: tokens.spacing.lg, width: '100%', maxWidth: 340 }} onStartShouldSetResponder={() => true}>
            {/* FIXME(nex-56): off-scale fontSize 10, design review */}
            <Text style={{ color: tokens.color.gold, fontSize: 10, fontWeight: '900', letterSpacing: 3, marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ }}>YOUR DAILY ORBIT</Text>
            {/* FIXME(nex-56): off-scale fontSize 16 (buttonPrimary is 16 but '600'; this is '800') — design review */}
            <Text style={{ color: tokens.color.text, fontSize: 16, fontWeight: '800', marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ }}>Recurring items live here</Text>
            {/* v3 stellar: body gray #999 → tokens.color.textSecondary. */}
            {/* FIXME(nex-56): fontSize 13 matches caption size but lineHeight 20 ≠ token 18, fontWeight default ≠ token '500' — design review */}
            <Text style={{ color: tokens.color.textSecondary, fontSize: 13, lineHeight: 20, marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ }}>
              Orbit shows your daily timeline with habits, calendar events, and recurring blocks. Add items to build your daily system.
            </Text>
            <Pressable
              style={{ backgroundColor: tokens.color.gold, borderRadius: 14, paddingVertical: 14 /* FIXME(nex-56): off-scale spacing 14 — review */, alignItems: 'center', marginBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ }}
              onPress={() => { dismissOrbitTip(); setSheetVisible(true); }}
              accessibilityRole="button"
              accessibilityLabel="Add your first item"
            >
              {/* FIXME(nex-56): off-scale fontSize 12, design review */}
              <Text style={{ color: tokens.color.textInverse, fontSize: 12, fontWeight: '900', letterSpacing: 2 }} accessibilityElementsHidden importantForAccessibility="no">ADD YOUR FIRST ITEM</Text>
            </Pressable>
            <Pressable onPress={dismissOrbitTip} style={{ alignItems: 'center', paddingVertical: tokens.spacing.xs }} hitSlop={tokens.icon.hitTarget.linkSlop} accessibilityRole="button" accessibilityLabel="Got it">
              {/* v3 stellar: dismiss label gray #555 → tokens.color.textMuted. */}
              {/* FIXME(nex-56): off-scale fontSize 11, design review */}
              <Text style={{ color: tokens.color.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>GOT IT</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // FIXME(nex-56): tokens.color.voidDeep page background — table maps #000 → textInverse (for text use), but this is a page bg; should be void/voidDeep — design review
  container: { flex: 1, backgroundColor: 'transparent', paddingTop: 80 /* FIXME(nex-56): off-scale spacing 80 — between xxxl(72) and huge(96), review */ },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 25 /* FIXME(nex-56): off-scale spacing 25 — between lg(24) and xl(32), review */, marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ },
  // FIXME(nex-56): off-scale fontSize 12, design review
  headerTitle: { color: tokens.color.gold, fontSize: 12, fontWeight: '900', letterSpacing: 6 },
  // v3 stellar: gray #444 → tokens.color.textDisabled (cool dark gray).
  // FIXME(nex-56): off-scale fontSize 12, design review
  headerTime: { color: tokens.color.textDisabled, fontSize: 12, fontWeight: '700' },
  scroll: { paddingHorizontal: 25 /* FIXME(nex-56): off-scale spacing 25 — review */, paddingBottom: 100 /* FIXME(nex-56): off-scale spacing 100 — above huge(96), review */ },

  calendarContainer: { marginBottom: 30 /* FIXME(nex-56): off-scale spacing 30 — between lg(24) and xl(32), review */, backgroundColor: tokens.color.surface, borderRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: tokens.color.luminousEdge, paddingBottom: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, alignItems: 'center', justifyContent: 'center', ...ambientGlowSoft },
  mandateContainer: { marginBottom: 30 /* FIXME(nex-56): off-scale spacing 30 — review */, padding: 28 /* FIXME(nex-56): off-scale spacing 28 — between lg(24) and xl(32), review */, backgroundColor: tokens.color.surface, borderRadius: 24, borderWidth: 1, borderColor: tokens.color.luminousEdge, ...ambientGlowSoft },
  // FIXME(nex-56): off-scale fontSize 11, design review
  mandateTitle: { color: tokens.color.gold, fontSize: 11, fontWeight: '900', letterSpacing: 6, marginBottom: tokens.spacing.lg, textAlign: 'center' },
  // v3 stellar: section label gray #666 → tokens.color.textMuted.
  // FIXME(nex-56): off-scale fontSize 9, design review
  mandateSection: { color: tokens.color.textMuted, fontSize: 9, fontWeight: '900', letterSpacing: 3, marginBottom: tokens.spacing.xs },
  // v3 stellar: mandate body gray #AAA → tokens.color.textSecondary (cool blue-white).
  // FIXME(nex-56): fontSize 13 matches caption size but fontWeight '400' ≠ token '500' + italic style — design review
  mandateText: { color: tokens.color.textSecondary, fontSize: 13, lineHeight: 22, fontWeight: '400', fontStyle: 'italic' },
  mandateDivider: { height: 1, backgroundColor: tokens.color.surfaceElevated, marginVertical: 20 /* FIXME(nex-56): off-scale spacing 20 — review */ },
  // v3 stellar: quote body gray #DDD → tokens.color.text (pure white — quote
  // deserves prominent register; was bright cream-gray before).
  // FIXME(nex-56): off-scale fontSize 14, design review
  quoteText: { color: tokens.color.text, fontSize: 14, lineHeight: 23, fontStyle: 'italic', fontWeight: '400' },
  // FIXME(nex-56): off-scale fontSize 10, design review
  quoteAuthor: { color: tokens.color.gold, fontSize: 10, fontWeight: '700', letterSpacing: 2, marginTop: 10 /* FIXME(nex-56): off-scale spacing 10 — review */ },

  section: { marginBottom: 15 /* FIXME(nex-56): off-scale spacing 15 — review */ },
  dayHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 25 /* FIXME(nex-56): off-scale spacing 25 — review */ },
  // v3 stellar: day label gray #444 → tokens.color.textDisabled (kept dim;
  // day labels are unobtrusive section dividers, not headers).
  // FIXME(nex-56): off-scale fontSize 10, design review
  dayLabel: { color: tokens.color.textDisabled, fontSize: 10, fontWeight: '900', letterSpacing: 4, marginRight: 15 /* FIXME(nex-56): off-scale spacing 15 — review */ },
  // tokens.color.surface close to surface (#111113, ΔE<0.5) — established precedent (_layout.tsx, horizon-review.tsx)
  dayLine: { flex: 1, height: 1, backgroundColor: tokens.color.surface },
  eventGroup: { flexDirection: 'row', marginBottom: tokens.spacing.md, alignItems: 'flex-start' },
  timeColumn: { width: 72, paddingTop: 18 /* FIXME(nex-56): off-scale spacing 18 — between md(16) and lg(24), review */ },
  // FIXME(nex-56): off-scale fontSize 11, design review
  timeText: { color: tokens.color.gold, fontSize: 11, fontWeight: '800' },
  // v3 stellar: countdown chip retoned. Was yellow-dark tint #1A1200 bg +
  // #3A2800 border (off-palette warm). Now uses tokens.color.goldWash bg
  // + new luminous hairline border, keeping the gold-tinged "upcoming"
  // semantic without the heavy yellow-paper register.
  countdownChip: { marginTop: 5 /* FIXME(nex-56): off-scale spacing 5 — review */, backgroundColor: tokens.color.goldWash, borderRadius: 6, paddingHorizontal: 6 /* FIXME(nex-56): off-scale spacing 6 — review */, paddingVertical: 3 /* FIXME(nex-56): off-scale spacing 3 — review */, borderWidth: 1, borderColor: tokens.color.goldHairline, alignSelf: 'flex-start' },
  // v3 stellar: NOW-state chip was green tint #0A2A0A bg + #1A5A1A border.
  // Now uses tokens.color.tealWash + teal border for the "active now"
  // electric-cyan semantic.
  countdownChipNow: { backgroundColor: tokens.color.tealWash, borderColor: tokens.color.teal },
  // FIXME(nex-56): off-scale fontSize 9, design review
  countdownText: { color: tokens.color.gold, fontSize: 9, fontWeight: '900', letterSpacing: 0.5 },
  // v3 stellar: NOW countdown text green #4CAF50 → tokens.color.teal.
  countdownTextNow: { color: tokens.color.teal },
  swipeWrapper: { borderRadius: 16, overflow: 'hidden', backgroundColor: tokens.color.surface, borderWidth: 1, borderColor: tokens.color.luminousEdge, ...ambientGlowSoft },
  card: { flexDirection: 'row', backgroundColor: 'transparent', overflow: 'hidden' },
  colorBar: { width: 3, borderRadius: 0, flexShrink: 0 },
  cardInner: { flex: 1, padding: tokens.spacing.md },
  cardHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, marginBottom: tokens.spacing.xxs },
  // FIXME(nex-56): tokens.color.text off-scale gray — design review
  // FIXME(nex-56): fontSize 15 matches bodyMd size but fontWeight '600' ≠ token '400' — design review
  title: { color: tokens.color.text, fontSize: 15, fontWeight: '600' },
  titleFlex: { flex: 1, paddingRight: tokens.spacing.xs },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  titleDimmed: { color: tokens.color.textMuted },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 11, design review
  eventMeta: { color: tokens.color.textMuted, fontSize: 11, lineHeight: 16, marginBottom: tokens.spacing.xxs },
  // v3 stellar: NOW badge was green tint rgba(76,175,80,...). Now uses
  // tokens.color.tealWash bg + teal border for the "active now" semantic.
  nowBadge: { backgroundColor: tokens.color.tealWash, borderRadius: 999, paddingHorizontal: tokens.spacing.xs, paddingVertical: 3 /* FIXME(nex-56): off-scale spacing 3 — review */, borderWidth: 1, borderColor: tokens.color.teal },
  // v3 stellar: NOW badge text #4CAF50 → tokens.color.teal.
  // FIXME(nex-56): off-scale fontSize 8, design review
  nowBadgeText: { color: tokens.color.teal, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  syncBadge: { borderRadius: 999, paddingHorizontal: tokens.spacing.xs, paddingVertical: tokens.spacing.xxs, borderWidth: 1 },
  // v3 stellar: synced badge legacy gold rgba → tokens.color.goldWash +
  // new gold border (token-driven).
  syncBadgeSynced: { backgroundColor: tokens.color.goldWash, borderColor: tokens.color.gold },
  // v3 stellar: local badge bg unchanged (translucent white); border
  // #222 neutral gray → tokens.color.goldHairline (now luminous white).
  syncBadgeLocal: { backgroundColor: 'rgba(255,255,255,0.05)', borderColor: tokens.color.goldHairline },
  // FIXME(nex-56): off-scale fontSize 8, design review
  syncBadgeText: { fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  syncBadgeTextSynced: { color: tokens.color.gold },
  // v3 stellar: local sync text gray #888 → tokens.color.textMuted.
  syncBadgeTextLocal: { color: tokens.color.textMuted },
  // v3 stellar: calendar meta #2A2A2A → tokens.color.textMuted.
  // FIXME(nex-56): off-scale fontSize 8, design review
  // NEX-205: `cal` now lives inside cardFooterRow (the row owns the top gap),
  // so it carries no marginTop of its own — keeping it would shift it down
  // against the row's alignItems:center and misalign it with the energy chip.
  cal: { color: tokens.color.textMuted, fontSize: 8, fontWeight: '900' },
  // NEX-205: cal + energy chip share a row. Energy chip is label-only and
  // neutral (luminous-edge border, muted text) — no per-energy accent color.
  cardFooterRow: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.xs, marginTop: tokens.spacing.xxs },
  energyChip: { borderRadius: 6 /* FIXME(nex-56): off-scale radius 6 — review */, paddingHorizontal: 6 /* FIXME(nex-56): off-scale spacing 6 — review */, paddingVertical: 2 /* FIXME(nex-56): off-scale spacing 2 — review */, borderWidth: 1, borderColor: tokens.color.luminousEdge },
  energyChipText: { color: tokens.color.textMuted, fontSize: 8, fontWeight: '900', letterSpacing: 1 },
  // NEX-205 (Or-2): "JUST PASSED" eyebrow + the no-shame buffer caption on a
  // greyed passed block. Muted, quiet — never an error/red treatment.
  justPassedLabel: { color: tokens.color.textMuted, fontSize: 10 /* FIXME(nex-56): off-scale fontSize 10 — review */, fontWeight: '700', letterSpacing: 1.5, marginTop: tokens.spacing.sm, marginBottom: tokens.spacing.xxs },
  bufferCaption: { color: tokens.color.textMuted, fontSize: 11 /* FIXME(nex-56): off-scale fontSize 11 — review */, marginTop: tokens.spacing.xs, lineHeight: 16 },
  // NEX-205 (PR2b): move-to-next-window affordance + undo. Teal = sacred-active
  // (it's the one action here); outlined, understated. No red anywhere — the
  // "no room" note stays muted (nothing turns red).
  moveBlockBtn: { alignSelf: 'flex-start', borderWidth: 1, borderColor: tokens.color.tealDeep, borderRadius: 9999, paddingHorizontal: tokens.spacing.md, paddingVertical: tokens.spacing.xs, marginTop: tokens.spacing.xs },
  moveBlockText: { color: tokens.color.teal, fontSize: 11 /* FIXME(nex-56): off-scale fontSize 11 — review */, fontWeight: '700', letterSpacing: 1.2 },
  moveUndoRow: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.sm, marginTop: tokens.spacing.xs },
  moveUndoText: { color: tokens.color.textMuted, fontSize: 12 /* FIXME(nex-56): off-scale fontSize 12 — review */ },
  moveUndoAction: { color: tokens.color.teal, fontSize: 11 /* FIXME(nex-56): off-scale fontSize 11 — review */, fontWeight: '700', letterSpacing: 1.2 },
  moveNoRoom: { color: tokens.color.textMuted, fontSize: 11 /* FIXME(nex-56): off-scale fontSize 11 — review */, marginTop: tokens.spacing.xs, lineHeight: 16 },
  // What's Next card
  // v3 stellar: was yellow-dark #0D0D00 bg + #2A2400 border (warm-paper
  // register). Retoned to surface + goldHairline so the card sits as
  // dark frosted glass with a gold left-accent — consistent with v3
  // ceremonial cards.
  whatsNextCard: { borderLeftWidth: 3, borderLeftColor: tokens.color.gold, backgroundColor: tokens.color.surface, borderRadius: 16, borderWidth: 1, borderColor: tokens.color.goldHairline, padding: 18 /* FIXME(nex-56): off-scale spacing 18 — review */, marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, ...ambientGlowSoft },
  // FIXME(nex-56): off-scale fontSize 9, design review
  whatsNextLabel: { color: tokens.color.gold, fontSize: 9, fontWeight: '900', letterSpacing: 2, marginBottom: tokens.spacing.xs },
  // FIXME(nex-56): off-scale fontSize 20, design review
  whatsNextTitle: { color: tokens.color.text, fontSize: 20, fontWeight: '800', letterSpacing: -0.3, marginBottom: 6 /* FIXME(nex-56): off-scale spacing 6 — review */, lineHeight: 26 },
  // v3 stellar: meta gray #666 → tokens.color.textMuted.
  // FIXME(nex-56): off-scale fontSize 12, design review
  whatsNextMeta: { color: tokens.color.textMuted, fontSize: 12, marginBottom: 6 /* FIXME(nex-56): off-scale spacing 6 — review */ },
  // v3 stellar: time gray #555 → tokens.color.textMuted.
  // FIXME(nex-56): off-scale fontSize 12, design review
  whatsNextTime: { color: tokens.color.textMuted, fontSize: 12, fontWeight: '600' },
  actionBtn: { width: 80, justifyContent: 'center', alignItems: 'center' },
  editBtn: { backgroundColor: tokens.color.surfaceElevated },
  // v3 stellar: destructive bg #220000 → stateError @ 15% alpha.
  deleteBtn: { backgroundColor: 'rgba(229,91,69,0.15)' },
  // FIXME(nex-56): off-scale fontSize 10, design review
  actionText: { color: tokens.color.gold, fontSize: 10, fontWeight: '900' },
  // v3 stellar: show-past button border #222 → tokens.color.goldHairline (now white).
  showPastBtn: { padding: 10 /* FIXME(nex-56): off-scale spacing 10 — review */, backgroundColor: tokens.color.surface, borderRadius: 10, alignItems: 'center', marginBottom: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, borderWidth: 1, borderColor: tokens.color.goldHairline },
  // v3 stellar: show-past text gray #666 → tokens.color.textMuted.
  // FIXME(nex-56): off-scale fontSize 10, design review
  showPastText: { color: tokens.color.textMuted, fontSize: 10, fontWeight: '800', letterSpacing: 2 },

  todoSection: { backgroundColor: tokens.color.surface, borderRadius: 16, padding: 20 /* FIXME(nex-56): off-scale spacing 20 — review */, marginTop: 5 /* FIXME(nex-56): off-scale spacing 5 — review */, marginBottom: 30 /* FIXME(nex-56): off-scale spacing 30 — review */, borderWidth: 1, borderColor: tokens.color.luminousEdge, ...ambientGlowSoft },
  // FIXME(nex-56): tokens.color.textDisabled off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 9, design review
  todoHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 15 /* FIXME(nex-56): off-scale spacing 15 — review */ },
  todoHeader: { color: tokens.color.textDisabled, fontSize: 9, fontWeight: '900', letterSpacing: 3 },
  todoHeaderHint: { color: tokens.color.textMuted, fontSize: 9, fontWeight: '700', letterSpacing: 1.5 },
  todoItem: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 /* FIXME(nex-56): off-scale spacing 14 — review */ },
  // FIXME(nex-56): tokens.color.textDisabled off-scale gray — design review
  checkbox: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: tokens.color.textDisabled, marginRight: tokens.spacing.md },
  checkboxActive: { backgroundColor: tokens.color.gold, borderColor: tokens.color.gold },
  // FIXME(nex-56): tokens.color.textSecondary off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 14, design review
  todoText: { color: tokens.color.textSecondary, fontSize: 14, fontWeight: '500' },
  // FIXME(nex-56): tokens.color.textMuted off-scale gray — design review
  todoTextDone: { color: tokens.color.textMuted, textDecorationLine: 'line-through' },
  // FIXME(nex-56): tokens.color.textDisabled off-scale gray — design review
  // FIXME(nex-56): off-scale fontSize 20, design review
  dragHandle: { color: tokens.color.textDisabled, fontSize: 20, fontWeight: '700', paddingLeft: tokens.spacing.sm }
});
