/**
 * Widget payload trimming (NEX-268).
 *
 * The widget only renders TODAY's slice, but buildWidgetData historically
 * shipped the user's ENTIRE habitLog/inbox/dailyTasks history into the App
 * Group. For a heavy long-term user that blob is multi-MB, and a WidgetKit
 * extension has a hard ~30MB memory budget — decoding + rendering it across
 * the timeline got the extension Jetsam/OOM-killed, leaving the widget stuck
 * on its redacted placeholder (the "blank square" bug).
 *
 * trimWidgetPayload keeps only what Swift's deriveTodayView actually consumes
 * for today (and the timeline's same-day/rollover window). It is intentionally
 * render-equivalent — the widget displays the same thing, from a small payload.
 *
 * Pure module (the only import is an erased `import type`) so it is unit-tested
 * in the pure-Node vitest suite, unlike the RN-coupled widget-bridge.
 */
import type { RawWidgetData } from './widget-bridge';

/** Max pending inbox items to ship. Swift renders at most the first 3. */
export const INBOX_CAP = 12;

/**
 * Does this snapshot contain anything the widget could render?
 *
 * NEX-306: `syncWidgetAfterMutation` used to gate on "has at least one active
 * recurringRule" with the comment "no active habits — placeholder is fine".
 * That predicate predates the widget rendering to-dos, inbox and events, so a
 * user with NO habits but plenty of to-dos got no widget write at all — every
 * mutation left the widget stale. (Found by Greptile T-Rex on #335: it moved a
 * one-off with zero recurringRules and observed 0 native writes.)
 *
 * The guard is still worth keeping in some form: it also protects the cold
 * launch, where an un-hydrated store would otherwise write an EMPTY payload
 * over a perfectly good widget snapshot. So this widens the test from "has
 * habits" to "has anything", which still reads false for an un-hydrated store
 * (every collection empty) while correctly writing for a habits-less user.
 *
 * Widget daily-score change (2026-08): today's morning intention and today's
 * wisdom quotes are renderable too — an intention-only user must get a write
 * or the widget never shows their score's 33 intention points. Both are
 * date-gated against `now` so a STALE intention/quotes still read false,
 * preserving the cold-launch protection. `now` is a parameter (not a hidden
 * clock read) so tests are deterministic.
 *
 * Pure + exported so it is unit-tested, unlike the RN-coupled caller.
 */
export function hasRenderableWidgetContent(
  state: {
    recurringRules?: unknown;
    recurringToDos?: unknown;
    dailyTasks?: unknown;
    inbox?: unknown;
    morningIntention?: unknown;
    morningIntentionDate?: unknown;
    dailyWisdomQuotes?: unknown;
    dailyWisdomDate?: unknown;
  } | null | undefined,
  /**
   * The COMPOSED today+tomorrow event list the caller is about to write.
   * Passed separately because it is not a single store field —
   * syncWidgetAfterMutation merges `orbitDays[today]`, `orbitDays[tomorrow]`
   * and `appleEventsWindow` to build it. The widget renders events, so a
   * calendar-only user (no habits, no to-dos, no tasks, no inbox) still has
   * renderable content and must get a write. Found by Greptile T-Rex on #335
   * against the first version of this guard, which omitted events.
   */
  composedEvents?: unknown,
  now: Date = new Date(),
): boolean {
  if (Array.isArray(composedEvents) && composedEvents.length > 0) return true;
  if (!state) return false;
  const notArchived = (list: unknown): boolean =>
    Array.isArray(list) && list.some((r: any) => r && !r.archived);
  if (notArchived(state.recurringRules)) return true;
  if (notArchived(state.recurringToDos)) return true;
  if (Array.isArray(state.inbox) && state.inbox.length > 0) return true;
  const daily = state.dailyTasks;
  if (daily && typeof daily === 'object' && !Array.isArray(daily)) {
    for (const list of Object.values(daily as Record<string, unknown>)) {
      if (Array.isArray(list) && list.length > 0) return true;
    }
  }
  const todayKey = localDateKey(now);
  if (state.morningIntentionDate === todayKey && !!state.morningIntention) return true;
  if (
    state.dailyWisdomDate === todayKey &&
    Array.isArray(state.dailyWisdomQuotes) &&
    state.dailyWisdomQuotes.length > 0
  ) {
    return true;
  }
  return false;
}

/** Upper bound for a widget quote — generous enough that a real quote is never mangled. */
export const WIDGET_QUOTE_MAX_CHARS = 400;

/**
 * Pick the ONE wisdom quote the widget shows: the shortest well-formed quote
 * of the day (the large widget has room for exactly one, and short reads
 * better at a glance). Returns null when Today's Wisdom is disabled
 * (`wisdomQuoteCount === 0`) or nothing well-formed exists — a malformed
 * entry must never cross into the native decoder (Swift decodes quote +
 * optional author; see RawWidgetData.WisdomQuote). `tag` is deliberately
 * dropped — the widget doesn't render it.
 *
 * Pure + exported for the vitest suite; called from buildWidgetData.
 */
export function pickWidgetQuote(
  quotes: unknown,
  wisdomQuoteCount: unknown,
): { quote: string; author: string | null } | null {
  if (wisdomQuoteCount === 0) return null;
  if (!Array.isArray(quotes)) return null;
  let best: { quote: string; author: string | null } | null = null;
  for (const q of quotes) {
    if (!q || typeof (q as any).quote !== 'string') continue;
    const text = (q as any).quote.trim();
    if (!text || text.length > WIDGET_QUOTE_MAX_CHARS) continue;
    const author = typeof (q as any).author === 'string' ? (q as any).author.trim() : '';
    const candidate = { quote: text, author: author || null };
    if (!best || candidate.quote.length < best.quote.length) best = candidate;
  }
  return best;
}

/**
 * Local "YYYY-MM-DD" — matches isoToLocalDateKey() in widget-bridge and
 * Swift's localDateKey(), so date-key comparisons line up across the bridge.
 */
export function localDateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Trim an already-built RawWidgetData to today-relevant data.
 *
 * MUST run as the LAST step of buildWidgetData: each rule's lifetime `reps` is
 * pre-computed from the FULL habitLog earlier, so this function must not touch
 * `recurringRules` (it doesn't) and must run after reps is baked in. Moving it
 * earlier — or trimming the input log — would collapse every habit's reps to
 * today's count (the NEX-219 regression class).
 *
 * Render-equivalence:
 *  - habitLog → today only: Swift uses it solely for today's completion;
 *    rollover entries legitimately see an empty next day, and every completion
 *    re-syncs via syncWidgetAfterMutation.
 *  - dailyTasks → today + tomorrow keys only: Swift does exact date-key lookups
 *    and the timeline's furthest entry is tomorrow noon, so those are the only
 *    keys it can ever render; bounding to two keys also stops a large future
 *    one-off backlog from re-bloating the payload.
 *  - inbox → active + pending, capped: mirrors the app's active-inbox rule
 *    (`!completed && (status ?? "") != "ARCHIVED" && !triagedSkip`) before the
 *    cap, so a leading run of skipped items can't be shown or crowd out real
 *    pending work; Swift then takes `.prefix(3)`.
 *  - events → unchanged: already windowed upstream (syncWidgetAfterMutation +
 *    the NEX-45 appleEventsWindow); a "first-N" cap is unsafe against Swift's
 *    future-relative rollover filter.
 */
export function trimWidgetPayload(data: RawWidgetData, now: Date = new Date()): RawWidgetData {
  const todayKey = localDateKey(now);
  // Swift's timeline only does exact dailyTasks lookups for today and the
  // rollover entries (next midnight/6am/noon = tomorrow). A plain `>= today`
  // filter would let a large *future* one-off backlog back into the payload and
  // defeat the size fix, so keep at most those two keys. Tomorrow via date
  // components (DST-safe), not a +24h offset.
  const tomorrowKey = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const keepKeys = new Set([todayKey, tomorrowKey]);

  // Defensive `?? []`/`?? {}` for parity with the rest of the bridge — this is
  // an exported pure util that may be handed a partially-formed snapshot.
  const habitLog = (data.habitLog ?? []).filter((e) => e.date === todayKey);

  const dailyTasks: RawWidgetData['dailyTasks'] = {};
  for (const [key, list] of Object.entries(data.dailyTasks ?? {})) {
    if (keepKeys.has(key)) dailyTasks[key] = list;
  }

  // Mirror the app's active-inbox visibility (status != ARCHIVED && !completed
  // && !triagedSkip) BEFORE the cap, so skipped items can't crowd out — or be
  // shown ahead of — real pending work.
  const inbox = (data.inbox ?? [])
    .filter((i) => !i.completed && (i.status ?? '') !== 'ARCHIVED' && !i.triagedSkip)
    .slice(0, INBOX_CAP);

  // NEX-306: `exceptions` (per-day skips) is APPEND-ONLY in the app —
  // addRecurringToDoException does `[...existing, dateKey]` and nothing ever
  // prunes it — so a long-term user accumulates a dateKey per skip, forever,
  // per rule. Swift only ever asks `exceptions.contains(todayKey)`, and the
  // timeline reaches at most tomorrow, so ship only those keys. Without this
  // the new field would reintroduce exactly the payload bloat this module was
  // written to prevent.
  const recurringToDos = (data.recurringToDos ?? []).map((r) =>
    Array.isArray(r.exceptions) && r.exceptions.length > 0
      ? { ...r, exceptions: r.exceptions.filter((k) => keepKeys.has(k)) }
      : r,
  );

  // Widget daily-score fields (morningIntention(+Date), dailyQuote,
  // dailyWisdomDate) ride the `...data` spread untouched: they're already
  // bounded — dailyQuote is a single pre-picked quote from pickWidgetQuote
  // (≤ WIDGET_QUOTE_MAX_CHARS), the rest are scalars.
  return { ...data, habitLog, dailyTasks, inbox, recurringToDos };
}
