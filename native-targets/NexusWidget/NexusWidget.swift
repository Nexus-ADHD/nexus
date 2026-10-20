import WidgetKit
import SwiftUI
import UIKit
import AppIntents

// MARK: - Raw shape (matches RawWidgetData in src/widgets/widget-bridge.ts)
//
// Self-correcting model: JS writes raw inputs; Swift derives the
// today view at render time using Date(). Without this, iOS would
// happily call getTimeline at midnight and serve yesterday's
// pre-computed numbers indefinitely until the app was opened.

struct RawWidgetData: Codable {
    let recurringRules: [RawRule]
    let habitLog: [HabitLogEntry]
    let pinnedHabits: [String]
    let recurringToDos: [RawRecurringToDo]
    let dailyTasks: [String: [DailyTask]]
    let inbox: [InboxItem]
    let events: [RawEvent]
    let habitStreaks: [String: StreakValue]
    // NEX-219: Soft Mode (opt-in). Optional so older snapshots still decode
    // (synthesized Codable → missing key = nil); the breakable streak shows only
    // when this is true, else the cumulative top-habit (reps) is the default.
    let softMode: Bool?
    let totalXP: Int
    let level: Int
    // Widget daily-score: today's win + date key, and the day's pre-picked
    // shortest wisdom quote + its date key. Optional so pre-score snapshots
    // still decode; Swift scores/renders them only when the date key matches
    // today at RENDER time (raw-inputs contract — self-corrects at midnight).
    let morningIntention: String?
    let morningIntentionDate: String?
    let dailyQuote: WisdomQuote?
    let dailyWisdomDate: String?
    let lastUpdated: Double

    /// The day's shortest wisdom quote, pre-picked in JS (pickWidgetQuote).
    /// author is optional — a malformed author must not fail the whole decode
    /// (loadRawData falls back to fake placeholder content on ANY throw).
    struct WisdomQuote: Codable {
        let quote: String
        let author: String?
    }

    struct RawRule: Codable {
        let id: String
        let title: String
        let timesPerDay: Int
        // NEX-267: the habit's weekly schedule (0=Sun … 6=Sat) so the widget
        // counts only TODAY's habits. Optional/decode-safe: snapshots written
        // before NEX-267 lack it (nil) → deriveTodayView treats nil/empty as
        // "show" and self-heals on the next app write.
        let daysOfWeek: [Int]?
        let archived: Bool
        // NEX-219: lifetime reps; deriveTodayView picks the max-reps rule as the
        // cumulative headline. Optional for forward-compat with older snapshots.
        let reps: Int?
        // NEX-171b: per-rule score-inclusion flag. Optional (older snapshots
        // lack it) — when ANY rule carries it, it is authoritative and replaces
        // the pinnedHabits shim, so "user excluded every habit" no longer reads
        // as "legacy empty pins = show all".
        let excludedFromScore: Bool?
    }
    struct HabitLogEntry: Codable {
        let date: String
        let habitTitle: String
    }
    struct RawRecurringToDo: Codable {
        let id: String
        let title: String
        let daysOfWeek: [Int]
        let interval: Int
        let intervalAnchorDate: String?
        let archived: Bool
        // NEX-306: per-day skip exceptions (YYYY-MM-DD). Optional so an older
        // payload (pre-NEX-306, no `exceptions` key) still decodes; absent ⇒ no
        // skips, matching the app's `Array.isArray(r.exceptions)` guard.
        let exceptions: [String]?
    }
    struct DailyTask: Codable {
        let id: String?
        let title: String
        let completed: Bool
    }
    struct InboxItem: Codable {
        let title: String
        let completed: Bool
        let status: String?
    }
    struct RawEvent: Codable {
        let title: String
        let startISO: String
    }

    /// Streak values come as either a bare Int or { days: Int, title: String? }.
    /// Custom Codable so Swift accepts both shapes without breaking.
    enum StreakValue: Codable {
        case days(Int)
        case detailed(days: Int, title: String?)

        var days: Int {
            switch self {
            case .days(let n): return n
            case .detailed(let n, _): return n
            }
        }
        var title: String? {
            switch self {
            case .days: return nil
            case .detailed(_, let t): return t
            }
        }

        init(from decoder: Decoder) throws {
            if let single = try? decoder.singleValueContainer().decode(Int.self) {
                self = .days(single)
                return
            }
            let c = try decoder.container(keyedBy: CodingKeys.self)
            let n = (try? c.decode(Int.self, forKey: .days)) ?? 0
            let t = try? c.decode(String.self, forKey: .title)
            self = .detailed(days: n, title: t)
        }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(days, forKey: .days)
            try c.encodeIfPresent(title, forKey: .title)
        }
        enum CodingKeys: String, CodingKey { case days, title }
    }

    static let placeholder = RawWidgetData(
        recurringRules: [
            RawRule(id: "p1", title: "Morning Meditation", timesPerDay: 1, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], archived: false, reps: 142, excludedFromScore: false),
            RawRule(id: "p2", title: "Exercise", timesPerDay: 1, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], archived: false, reps: 88, excludedFromScore: false),
            RawRule(id: "p3", title: "Read 20 Pages", timesPerDay: 1, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], archived: false, reps: 30, excludedFromScore: false),
            RawRule(id: "p4", title: "Journal", timesPerDay: 1, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], archived: false, reps: 12, excludedFromScore: false),
        ],
        habitLog: [],
        pinnedHabits: [],
        recurringToDos: [],
        dailyTasks: [:],
        inbox: [],
        events: [],
        habitStreaks: ["Morning Meditation": .days(14)],
        softMode: false,
        totalXP: 1240,
        level: 4,
        // Dated TODAY so previews/placeholder exercise the score + quote UI.
        morningIntention: "Ship the widget update",
        morningIntentionDate: localDateKey(Date()),
        dailyQuote: WisdomQuote(quote: "What stands in the way becomes the way.", author: "Marcus Aurelius"),
        dailyWisdomDate: localDateKey(Date()),
        lastUpdated: 0
    )
}

// MARK: - Derived view (what views render)
//
// Field names match the previous NexusWidgetData reads so view code
// changes are minimal. All derivation happens at render time using
// the timeline entry's `date` so the widget rolls over at midnight
// without an app launch.

struct DerivedTodayView {
    let completionPercent: Int
    let completedHabits: Int
    let totalHabits: Int
    let remaining: Int
    let level: Int
    let dateLabel: String
    let todayHabits: [HabitView]
    let orbitTasks: [TaskView]
    let todayTasks: [TaskView]
    let nextEventTitle: String
    let nextEventTime: String
    let upcomingEvents: [EventView]
    let longestStreakDays: Int
    let longestStreakHabit: String
    // NEX-219: cumulative top habit (default surface) + Soft Mode flag. Non-optional
    // so the Swift memberwise init forces every constructor below to set them.
    let topHabitReps: Int
    let topHabitTitle: String
    let softMode: Bool
    let totalXP: Int
    // Widget daily-score: the Home alignment score (0-100) + its §18.4
    // qualitative word, derived at render time from the raw inputs — mirrors
    // computeHomeDailyScore in src/state/selectors/daily-score.ts (the vitest
    // fixtures there are this port's spec).
    let dailyScore: Int
    let scoreWord: String
    /// Today's win text ('' when unset) — shown under the score on large.
    let winText: String
    /// Quote of the day ('' = hide): the day's shortest wisdom quote, rendered
    /// only when the payload's dailyWisdomDate matches today at render time.
    let quoteText: String
    let quoteAuthor: String

    struct HabitView { let title: String; let completed: Bool }
    struct TaskView { let title: String; let completed: Bool }
    struct EventView { let title: String; let time: String }

    static let empty = DerivedTodayView(
        completionPercent: 0,
        completedHabits: 0,
        totalHabits: 0,
        remaining: 0,
        level: 1,
        dateLabel: "",
        todayHabits: [],
        orbitTasks: [],
        todayTasks: [],
        nextEventTitle: "",
        nextEventTime: "",
        upcomingEvents: [],
        longestStreakDays: 0,
        longestStreakHabit: "",
        topHabitReps: 0,
        topHabitTitle: "",
        softMode: false,
        totalXP: 0,
        dailyScore: 0,
        scoreWord: "Quiet",
        winText: "",
        quoteText: "",
        quoteAuthor: ""
    )
}

// MARK: - Helpers

/// Local "YYYY-MM-DD" — must match getLocalDateKey() / getLocalTodayKey() in JS.
func localDateKey(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = .current
    return f.string(from: date)
}

private let _eventTimeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = .current
    f.dateFormat = "h:mm a"
    return f
}()

private let _dateLabelFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = .current
    // Matches JS toLocaleDateString({weekday:'short', month:'short', day:'numeric'})
    f.dateFormat = "EEE, MMM d"
    return f
}()

private func parseISO(_ s: String) -> Date? {
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = iso.date(from: s) { return d }
    iso.formatOptions = [.withInternetDateTime]
    if let d = iso.date(from: s) { return d }
    // Some events come without a Z suffix — try parsing as local.
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    f.timeZone = .current
    return f.date(from: s)
}

// MARK: - Derivation

func deriveTodayView(from raw: RawWidgetData, now: Date = Date()) -> DerivedTodayView {
    let cal = Calendar.current
    let todayKey = localDateKey(now)
    // weekday: 1=Sun … 7=Sat → match JS 0=Sun … 6=Sat
    let weekday = cal.component(.weekday, from: now) - 1

    // 1. Today's habit log (lower-cased title for case-insensitive match)
    let todayLog = raw.habitLog.filter { $0.date == todayKey }

    // 2a. Active = non-archived, score-inclusion-respecting — SCHEDULE-INDEPENDENT.
    //     Used for the NEX-219 cumulative lifetime-reps headline, which must not
    //     depend on today's schedule.
    let active = raw.recurringRules.filter { !$0.archived }
    let pinnedActive: [RawWidgetData.RawRule]
    if raw.recurringRules.contains(where: { $0.excludedFromScore != nil }) {
        // NEX-171b: the payload carries the per-rule score-inclusion flag —
        // authoritative. "User excluded EVERY habit" correctly yields an empty
        // scored set (which the daily score's flat-34 branch depends on),
        // instead of falling into the legacy empty-pins = show-all trap.
        pinnedActive = active.filter { $0.excludedFromScore != true }
    } else if raw.pinnedHabits.isEmpty {
        pinnedActive = active
    } else {
        let pinSet = Set(raw.pinnedHabits)
        pinnedActive = active.filter { pinSet.contains($0.id) || pinSet.contains($0.title) }
    }

    // 2b. Display = today's-scheduled subset — used for the completion count.
    //     NEX-267: previously every rule was counted on every weekday, inflating
    //     the "/total". Matches the app's isScheduledOn (today-rollup.ts): a
    //     PRESENT daysOfWeek (including empty []) uses contains() — empty → not
    //     scheduled → hidden, exactly as the app does. Only nil (a legacy snapshot
    //     from before NEX-267) falls through to "show", self-healing on the next
    //     app write.
    let display = pinnedActive.filter { rule in
        if let days = rule.daysOfWeek { return days.contains(weekday) }
        return true
    }

    // 3. Per-rule completion: normalize()-keyed title match (NFC + trim +
    //    whitespace-collapse + lowercase — the same normalizeHabitTitle port
    //    the pending-tap capper uses), requires `timesPerDay` count. Counts BY
    //    OCCURRENCES so multi-times-per-day habits get partial credit (matches
    //    the JS computeHomeDailyScore logic).
    var totalHabits = 0
    var completedHabits = 0
    var habitViews: [DerivedTodayView.HabitView] = []
    for rule in display {
        let key = normalizeHabitTitle(rule.title)
        let required = max(rule.timesPerDay, 1)
        let count = todayLog.filter { normalizeHabitTitle($0.habitTitle) == key }.count
        totalHabits += required
        completedHabits += min(required, count)
        habitViews.append(DerivedTodayView.HabitView(title: rule.title, completed: count >= required))
    }
    let completionPercent = totalHabits > 0
        ? Int(round(Double(completedHabits) / Double(totalHabits) * 100))
        : 0

    // 4. Orbit tasks for today — biweekly logic mirrors widget-bridge's
    //    previous JS exactly. Merge with dailyTasks[todayKey] (one-off).
    let dailyForToday = raw.dailyTasks[todayKey] ?? []
    let dailyTitleSet = Set(dailyForToday.map { $0.title.lowercased() })
    var orbitTasks: [DerivedTodayView.TaskView] = []
    for r in raw.recurringToDos where !r.archived {
        // NEX-306: honor per-day skip exceptions, mirroring the app's
        // selectTodayTaskRollup (today-rollup.ts) — shared helper so the
        // display list and the daily-score task rollup can't drift.
        guard ruleOccursToday(r, weekday: weekday, todayKey: todayKey, cal: cal, now: now) else { continue }
        // De-dupe vs dailyTasks (same-title items already explicit).
        // NEX-306 note: this dedups by lowercased TITLE, whereas the app's
        // selectTodayTaskRollup (today-rollup.ts) dedups the generated
        // `${id}-auto` entry against specific entries by ID. The two can
        // disagree for a moved/renamed occurrence. Any "move just this day"
        // feature (Phase 1.2b) must account for this divergence — ideally by
        // carrying the generated id into the widget so both sides key on id.
        if dailyTitleSet.contains(r.title.lowercased()) { continue }
        orbitTasks.append(DerivedTodayView.TaskView(title: r.title, completed: false))
    }
    // Append the one-off dailyTasks for today after the recurring ones.
    for t in dailyForToday {
        orbitTasks.append(DerivedTodayView.TaskView(title: t.title, completed: t.completed))
    }
    // Widget cap: 4 incomplete shown. Filter completed and slice.
    let visibleOrbit = Array(orbitTasks.filter { !$0.completed }.prefix(4))

    // 5. todayTasks: first 3 inbox items where !completed && status != "ARCHIVED"
    let pendingInbox = raw.inbox
        .filter { !$0.completed && ($0.status ?? "") != "ARCHIVED" }
        .prefix(3)
        .map { DerivedTodayView.TaskView(title: $0.title, completed: false) }

    // 6. Events: filter by startISO > now, sort ascending, take 3
    let upcomingRaw = raw.events.compactMap { ev -> (RawWidgetData.RawEvent, Date)? in
        guard let d = parseISO(ev.startISO), d > now else { return nil }
        return (ev, d)
    }.sorted { $0.1 < $1.1 }
    let upcoming = upcomingRaw.prefix(3).map { (ev, d) in
        DerivedTodayView.EventView(title: ev.title, time: _eventTimeFormatter.string(from: d))
    }
    let nextTitle = upcomingRaw.first?.0.title ?? ""
    let nextTime = upcomingRaw.first.map { _eventTimeFormatter.string(from: $0.1) } ?? ""

    // 7. Date label
    let dateLabel = _dateLabelFormatter.string(from: now)

    // 8. Longest streak (handle both shapes) — Soft Mode surface only.
    var longestDays = 0
    var longestTitle = ""
    for (titleKey, val) in raw.habitStreaks {
        if val.days > longestDays {
            longestDays = val.days
            longestTitle = val.title ?? titleKey
        }
    }

    // 9. NEX-219: cumulative top habit (lifetime reps) — the default headline.
    //    Picked over `pinnedActive` (the SCHEDULE-INDEPENDENT set), NOT `display`:
    //    lifetime reps don't depend on today's schedule, so the headline must not
    //    flip day-to-day as `display` (NEX-267 today-filtered) changes. Strict total
    //    order — reps desc,
    //    then title asc, then id asc — mirrors the reps→title→id ordering of
    //    topHabitByReps() in habit-rollup.ts so the pick is never dependent on the
    //    (store-) order rules happen to arrive in. Title compare uses lowercased()
    //    to match this widget's existing habit matching (not the JS normalize());
    //    that only affects the tiebreak between exactly-equal-rep habits.
    var topReps = 0
    var topTitle = ""
    var topKey = ""
    var topId = ""
    for rule in pinnedActive {
        let r = rule.reps ?? 0
        if r < 1 { continue }
        let key = rule.title.lowercased()
        let wins = topReps == 0
            || r > topReps
            || (r == topReps && (key < topKey || (key == topKey && rule.id < topId)))
        if wins { topReps = r; topTitle = rule.title; topKey = key; topId = rule.id }
    }

    // 10. Widget daily-score — mirrors computeHomeDailyScore in
    //     src/state/selectors/daily-score.ts EXACTLY (the vitest fixtures there
    //     are this port's spec; change both or they drift). 33 intention +
    //     33 habits (rep-weighted, from step 3's counts) + 34 tasks, cap 100.
    let intentionSet = raw.morningIntentionDate == todayKey && !(raw.morningIntention ?? "").isEmpty
    let intentionPts = intentionSet ? 33 : 0
    let habitPts = totalHabits > 0 ? Int(round(Double(completedHabits) / Double(totalHabits) * 33)) : 0
    // Task rollup, id-keyed like the app's selectTodayTaskRollup (NOT the
    // display list's title dedup): a generated "\(id)-auto" occurrence is
    // dropped when a specific dailyTasks entry with that id exists — the
    // override carries the completed flag — then ALL specific entries count.
    // NO archived filter, matching the app (its schema has no archive flag).
    let specificIds = Set(dailyForToday.compactMap { $0.id })
    var scoreTasksTotal = 0
    var scoreTasksCompleted = 0
    for r in raw.recurringToDos {
        if specificIds.contains("\(r.id)-auto") { continue }
        guard ruleOccursToday(r, weekday: weekday, todayKey: todayKey, cal: cal, now: now) else { continue }
        scoreTasksTotal += 1
    }
    for t in dailyForToday {
        scoreTasksTotal += 1
        if t.completed { scoreTasksCompleted += 1 }
    }
    let taskPts = scoreTasksTotal > 0
        ? Int(round(Double(scoreTasksCompleted) / Double(scoreTasksTotal) * 34))
        : (display.isEmpty ? 34 : 0)
    let dailyScore = min(100, intentionPts + habitPts + taskPts)

    // 11. Quote of the day — only when the payload's quotes are dated TODAY at
    //     render time (stale quotes hide; the midnight contract holds).
    let quoteToday = raw.dailyWisdomDate == todayKey ? raw.dailyQuote : nil

    return DerivedTodayView(
        completionPercent: completionPercent,
        completedHabits: completedHabits,
        totalHabits: totalHabits,
        remaining: max(totalHabits - completedHabits, 0),
        level: raw.level,
        dateLabel: dateLabel,
        todayHabits: habitViews,
        orbitTasks: Array(visibleOrbit),
        todayTasks: Array(pendingInbox),
        nextEventTitle: nextTitle,
        nextEventTime: nextTime,
        upcomingEvents: Array(upcoming),
        longestStreakDays: longestDays,
        longestStreakHabit: longestTitle,
        topHabitReps: topReps,
        topHabitTitle: topTitle,
        softMode: raw.softMode ?? false,
        totalXP: raw.totalXP,
        dailyScore: dailyScore,
        scoreWord: scoreQualitativeWord(dailyScore),
        winText: intentionSet ? (raw.morningIntention ?? "") : "",
        quoteText: quoteToday?.quote ?? "",
        quoteAuthor: quoteToday?.author ?? ""
    )
}

/// Does this recurring to-do produce an occurrence today? Days-of-week +
/// per-day exceptions + biweekly interval — mirrors occursOn() in
/// src/state/selectors/today-rollup.ts. Shared by the display list (step 4)
/// and the daily-score task rollup (step 10) so the two can't drift.
private func ruleOccursToday(_ r: RawWidgetData.RawRecurringToDo, weekday: Int, todayKey: String, cal: Calendar, now: Date) -> Bool {
    guard r.daysOfWeek.contains(weekday) else { return false }
    // NEX-306: per-day skip exception. Missing/nil ⇒ no skips.
    if r.exceptions?.contains(todayKey) == true { return false }
    let interval = max(r.interval, 1)
    if interval > 1 {
        // Compare anchor's local Sunday to today's local Sunday.
        let anchor = (r.intervalAnchorDate.flatMap { isoFromDateKey($0) }) ?? now
        let anchorSunday = startOfWeekSunday(anchor, calendar: cal)
        let todaySunday = startOfWeekSunday(now, calendar: cal)
        let weeksDiff = Int(round(todaySunday.timeIntervalSince(anchorSunday) / (7 * 24 * 60 * 60)))
        if weeksDiff % interval != 0 { return false }
    }
    return true
}

/// §18.4 locked qualitative words for the alignment score — mirrors
/// scoreQualitativeWord in src/state/selectors/daily-score.ts.
func scoreQualitativeWord(_ score: Int) -> String {
    if score >= 90 { return "Rising" }
    if score >= 75 { return "Steady" }
    if score >= 60 { return "Holding" }
    if score >= 45 { return "Drifting" }
    return "Quiet"
}

/// Score color bands (app: 80/50). The app's sub-50 red stays OFF the widget
/// (Law C — no verdict colors on an ambient surface; the widget ships no red
/// anywhere), and the mid band is always gold (the user's ringTint isn't in
/// the payload). Deliberate, not an oversight.
func scoreBandColor(_ score: Int) -> Color {
    if score >= 80 { return TEAL }
    if score >= 50 { return GOLD }
    return MUTED
}

/// Parse a "YYYY-MM-DD" key as local-midnight Date.
private func isoFromDateKey(_ key: String) -> Date? {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = .current
    return f.date(from: key)
}

private func startOfWeekSunday(_ date: Date, calendar: Calendar) -> Date {
    let comps = calendar.dateComponents([.weekday], from: date)
    let wd = (comps.weekday ?? 1) - 1 // 0=Sun
    return calendar.date(byAdding: .day, value: -wd, to: calendar.startOfDay(for: date)) ?? date
}

// MARK: - Data loading
func loadRawData() -> RawWidgetData {
    let appGroup = "group.com.jhuff.nexus"
    guard let defaults = UserDefaults(suiteName: appGroup),
          let jsonString = defaults.string(forKey: "widgetData"),
          let data = jsonString.data(using: .utf8),
          let raw = try? JSONDecoder().decode(RawWidgetData.self, from: data)
    else {
        return RawWidgetData.placeholder
    }
    return raw
}

/// Pending Home-Screen taps the app hasn't drained yet, replayed as synthetic
/// log entries for `date` — so a just-tapped habit shows complete EVERYWHERE in
/// the widget (header count, progress bar, and its row) before the app
/// reconciles on next foreground. Reads the same App Group queue
/// CompleteHabitIntent appends to. The app's drain clears that queue only AFTER
/// logging the habits, and the next snapshot it writes carries those logs — so
/// the synthetic entries hand off seamlessly to real ones. Entries stamped for
/// a different day (a tap that crossed midnight) are excluded by the dayKey
/// match, exactly as the app's drain drops them.
///
/// Every tap is returned here, duplicates included — capping to the habit's
/// daily target happens in appendingLogEntries, which is the one place that
/// knows both the persisted count and each habit's timesPerDay.
func pendingTapLogEntries(for date: Date) -> [RawWidgetData.HabitLogEntry] {
    guard let defaults = UserDefaults(suiteName: WIDGET_APP_GROUP),
          let raw = defaults.string(forKey: PENDING_KEY),
          let data = raw.data(using: .utf8),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
    else { return [] }
    let dayKey = localDateKey(date)
    return arr.compactMap { entry in
        guard let title = entry["habitTitle"] as? String,
              (entry["dayKey"] as? String) == dayKey else { return nil }
        return RawWidgetData.HabitLogEntry(date: dayKey, habitTitle: title)
    }
}

extension RawWidgetData {
    /// A copy with pending Home-Screen taps folded in as extra habit-log
    /// entries — see pendingTapLogEntries.
    ///
    /// Count-capped to mirror the app's reconciler exactly: a queued tap is
    /// kept only while the habit's daily target (timesPerDay) is not yet
    /// reached between the persisted log and the taps already folded in. So
    /// the second tap of a 2x/day habit counts (rep 2), but a persisted rep
    /// plus its still-queued tap never double-counts, and taps past the
    /// target are no-ops here just as the drain drops them there.
    func appendingLogEntries(_ extra: [HabitLogEntry]) -> RawWidgetData {
        guard !extra.isEmpty else { return self }
        // Daily target per normalized title (rules carry timesPerDay; a tap
        // for a title no rule knows gets the conservative target 1, matching
        // the drain's default for unknown-but-kept entries). Duplicate-titled
        // rules resolve FIRST-match — the same rule logHabit uses to pick its
        // matchingRule — so the widget never caps against a different target
        // than the app will enforce (Greptile P1 on #371).
        var requiredByTitle: [String: Int] = [:]
        for r in recurringRules {
            let t = normalizeHabitTitle(r.title)
            if requiredByTitle[t] == nil {
                requiredByTitle[t] = max(r.timesPerDay, 1)
            }
        }
        // Occurrences already accounted for: the persisted log first…
        var usedByKey: [String: Int] = [:]
        for e in habitLog {
            let k = "\(e.date) \(normalizeHabitTitle(e.habitTitle))"
            usedByKey[k] = (usedByKey[k] ?? 0) + 1
        }
        // …then each queued tap, kept only below the target.
        var fresh: [HabitLogEntry] = []
        for e in extra {
            let title = normalizeHabitTitle(e.habitTitle)
            let k = "\(e.date) \(title)"
            let used = usedByKey[k] ?? 0
            guard used < (requiredByTitle[title] ?? 1) else { continue }
            usedByKey[k] = used + 1
            fresh.append(e)
        }
        guard !fresh.isEmpty else { return self }
        return RawWidgetData(
            recurringRules: recurringRules,
            habitLog: habitLog + fresh,
            pinnedHabits: pinnedHabits,
            recurringToDos: recurringToDos,
            dailyTasks: dailyTasks,
            inbox: inbox,
            events: events,
            habitStreaks: habitStreaks,
            softMode: softMode,
            totalXP: totalXP,
            level: level,
            morningIntention: morningIntention,
            morningIntentionDate: morningIntentionDate,
            dailyQuote: dailyQuote,
            dailyWisdomDate: dailyWisdomDate,
            lastUpdated: lastUpdated
        )
    }
}

// MARK: - Timeline provider
struct NexusProvider: TimelineProvider {
    func placeholder(in context: Context) -> NexusEntry {
        NexusEntry(date: Date(), derived: deriveTodayView(from: RawWidgetData.placeholder))
    }
    func getSnapshot(in context: Context, completion: @escaping (NexusEntry) -> Void) {
        let now = Date()
        let raw = loadRawData().appendingLogEntries(pendingTapLogEntries(for: now))
        completion(NexusEntry(date: now, derived: deriveTodayView(from: raw)))
    }
    /// Multi-entry timeline:
    ///   - one entry every 15 minutes for the next 4 hours
    ///   - explicit entries at next local midnight + 6am + noon
    ///   so the widget rolls over correctly even if the app never opens.
    func getTimeline(in context: Context, completion: @escaping (Timeline<NexusEntry>) -> Void) {
        let raw = loadRawData()
        let now = Date()
        let cal = Calendar.current
        // Today's pending taps, folded in below only for entries still on the
        // tap's day — after the midnight rollover the app has either drained
        // or dropped them, so they must not pollute the new day's count.
        let pendingTaps = pendingTapLogEntries(for: now)
        let todayKey = localDateKey(now)

        var dates: [Date] = []
        for i in 0..<16 {
            if let d = cal.date(byAdding: .minute, value: i * 15, to: now) {
                dates.append(d)
            }
        }
        if let midnight = cal.nextDate(after: now,
                                       matching: DateComponents(hour: 0, minute: 0),
                                       matchingPolicy: .nextTime) {
            dates.append(midnight)
            if let sixAM = cal.date(byAdding: .hour, value: 6, to: midnight) { dates.append(sixAM) }
            if let noon = cal.date(byAdding: .hour, value: 12, to: midnight) { dates.append(noon) }
        }

        let entries = dates.map { d in
            let effective = localDateKey(d) == todayKey
                ? raw.appendingLogEntries(pendingTaps)
                : raw
            return NexusEntry(date: d, derived: deriveTodayView(from: effective, now: d))
        }
        completion(Timeline(entries: entries, policy: .atEnd))
    }
}

struct NexusEntry: TimelineEntry {
    let date: Date
    let derived: DerivedTodayView
}

// MARK: - Colors (v3 STELLAR — mirrors src/theme/tokens.ts)
//
// Widget palette retoned 2026-05-20 to match the v3 stellar pivot in the
// main app (NEX-43). Pure white text, brightened gold, electric teal,
// cool-near-black void. Amber retired from default utility — kept here
// only as `AMBER_MILESTONE` for streak-milestone ceremonies (none in
// the current widget set, but reserved for future).
let GOLD       = Color(red: 0.898, green: 0.729, blue: 0.431) // #E5BA6E
// Arc-gradient ends + seed-dot core for the score hero ring — mirror
// tokens.color.goldDeep / goldBright and the app's #FDFBED emission point.
let GOLD_DEEP   = Color(red: 0.627, green: 0.478, blue: 0.247) // #A07A3F
let GOLD_BRIGHT = Color(red: 0.949, green: 0.816, blue: 0.541) // #F2D08A
let CREAM       = Color(red: 0.992, green: 0.984, blue: 0.929) // #FDFBED
let TEAL       = Color(red: 0.373, green: 0.878, blue: 0.918) // #5FE0EA
let VOID       = Color(red: 0.024, green: 0.024, blue: 0.047) // #06060C
let VOID_DEEP  = Color(red: 0.008, green: 0.008, blue: 0.031) // #020208
let MUTED      = Color(red: 0.604, green: 0.639, blue: 0.710) // #9AA3B5 textMuted
let TEXT_SOFT  = Color(red: 0.910, green: 0.933, blue: 0.965) // #E8EEF6 textSecondary
let HAIRLINE   = Color.white.opacity(0.10)
let DIM        = Color.white.opacity(0.55) // brighter than v2 (was 0.4) — reads against cosmic backdrop

// MARK: - Brand type (mirrors src/theme/tokens.ts `font`)
/// The widget sets type with the same three families as the app: Inter for
/// UI text, IBM Plex Mono for numerals, Fraunces Light Italic for the one
/// serif moment. `Font.custom` takes the PostScript name; the ttfs ship
/// inside the extension (native-targets/NexusWidget, wired by
/// scripts/add-native-targets.js) and are listed under UIAppFonts in the
/// widget Info.plist. An unregistered name degrades to the system face, so a
/// missing file can never blank a widget.
enum NexusFont {
    static let interMedium    = "Inter18pt-Medium"
    static let interSemiBold  = "Inter18pt-SemiBold"
    static let interBold      = "Inter18pt-Bold"
    static let plexMonoMedium = "IBMPlexMono-Medium"
    static let fraunces       = "Fraunces72ptSoft-LightItalic"

    /// Inter — body, titles, chips. Weight maps onto the three bundled cuts.
    static func ui(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font {
        let name: String
        switch weight {
        case .bold, .heavy, .black: name = interBold
        case .semibold:             name = interSemiBold
        default:                    name = interMedium
        }
        return .custom(name, size: size)
    }
    /// Inter SemiBold — the tracked all-caps section labels (tokens.type.label).
    static func label(_ size: CGFloat) -> Font { .custom(interSemiBold, size: size) }
    /// IBM Plex Mono Medium — every numeral (counts, score, streaks, times).
    static func numeral(_ size: CGFloat) -> Font { .custom(plexMonoMedium, size: size) }
    /// Fraunces Light Italic — quote and score word. Already italic; never stack .italic().
    static func serif(_ size: CGFloat) -> Font { .custom(fraunces, size: size) }
}

// Nebula hint used inside the cosmic backdrop gradient.
private let NEBULA_HINT = Color(red: 0.282, green: 0.180, blue: 0.367) // soft violet/magenta

/// Cosmic backdrop for widgets — the same sky the app draws behind every
/// screen. Static (no animated stars; widgets can't animate that cheaply).
/// `night-sky-bg.jpg` IS assets/images/cosmic-field-bg.png (the StarField
/// layer-1 image), downscaled to 900px wide so the extension stays inside
/// its memory budget. When the app swaps its backdrop, regenerate this jpg
/// from the same source — a widget on a different sky than the Home screen
/// behind it is the one thing the founder notices first (2026-09-03).
/// The light scrim below keeps the mean tone within ~1 luminance unit of
/// the app (the quiet sky peaks at L≈28/255; the old galaxy photo it
/// replaced peaked near 90 and needed a 38% void scrim to be legible).
/// Falls back to the original gradient slice if the image is missing.
/// Applied via .containerBackground on every home-screen widget.
struct CosmicBackdrop: View {
    /// Legibility scrim over the sky. Shared container background
    /// (`.containerBackground` on all three home-screen widgets), so re-toning
    /// it here re-tones them all. Retuned 2026-09-03 for the quiet app sky:
    /// 38% → 10% so the widget reads as the app's own backdrop, not a darker
    /// cousin of it. The large family passes a gentler version of its NEX-324
    /// vertical gradient: a little more ground under the dense habit grid.
    var scrim: AnyView = CosmicBackdrop.defaultScrim

    /// Small and medium. Mean tone with this scrim ≈ the app's (L 17 vs 18.5).
    static let defaultScrim = AnyView(VOID.opacity(0.10))

    /// The large family's scrim: open sky at the top, a touch more ground
    /// under the checklist.
    static let deepScrim = AnyView(
        LinearGradient(
            colors: [VOID.opacity(0.20), VOID.opacity(0.32), VOID.opacity(0.45)],
            startPoint: .top,
            endPoint: .bottom
        )
    )

    var body: some View {
        ZStack {
            // Base layer — cool near-black void (matches tokens.color.void).
            VOID

            if let path = Bundle.main.path(forResource: "night-sky-bg", ofType: "jpg"),
               let galaxy = UIImage(contentsOfFile: path) {
                // The app sky — same image as StarField layer 1.
                GeometryReader { geo in
                    Image(uiImage: galaxy)
                        .resizable()
                        .scaledToFill()
                        .frame(width: geo.size.width, height: geo.size.height)
                        .clipped()
                }

                // Legibility scrim — keeps text readable over bright
                // nebula regions, same job as the in-app StarField scrim.
                scrim
            } else {
                // Fallback: diagonal void gradient — slight depth top→bottom-right.
                LinearGradient(
                    colors: [VOID_DEEP, VOID],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )

                // Nebula hint — soft violet/magenta glow in the upper-right
                // corner, fading to fully transparent.
                RadialGradient(
                    colors: [NEBULA_HINT.opacity(0.45), Color.clear],
                    center: UnitPoint(x: 0.85, y: 0.15),
                    startRadius: 0,
                    endRadius: 180
                )
            }
        }
    }
}

/// Progress bar / completion-color tier.
/// v3 stellar: high tier = teal (success), mid = gold (attention),
/// low = textMuted (quiet, not punitive). Replaces v2's green/gold/red.
func progressColor(_ pct: Int) -> Color {
    if pct >= 80 { return TEAL }
    if pct >= 40 { return GOLD }
    return MUTED
}

// MARK: - Small: Habit Progress
struct HabitProgressSmallView: View {
    let data: DerivedTodayView
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("HABITS")
                    .font(NexusFont.label(9))
                    .kerning(1.5)
                    .foregroundColor(DIM)
                Spacer()
                Text("LVL \(data.level)")
                    .font(NexusFont.ui(9, .bold))
                    .foregroundColor(GOLD)
            }

            Spacer(minLength: 4)

            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text("\(data.completedHabits)")
                    .font(NexusFont.numeral(42))
                    .foregroundColor(progressColor(data.completionPercent))
                Text("/\(data.totalHabits)")
                    .font(NexusFont.numeral(20))
                    .foregroundColor(DIM)
            }

            Spacer(minLength: 4)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(HAIRLINE)
                        .frame(height: 6)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(progressColor(data.completionPercent))
                        .frame(width: max(geo.size.width * CGFloat(data.completionPercent) / 100, 4), height: 6)
                }
            }.frame(height: 6)

            Spacer(minLength: 6)

            if data.remaining > 0 {
                Text("\(data.remaining) left today")
                    .font(NexusFont.ui(11, .semibold))
                    .foregroundColor(TEXT_SOFT)
            } else {
                HStack(spacing: 4) {
                    // v3: success indicators use teal, never green.
                    Image(systemName: "checkmark.seal.fill")
                        .font(.system(size: 11))
                        .foregroundColor(TEAL)
                    Text("All complete")
                        .font(NexusFont.ui(11, .semibold))
                        .foregroundColor(TEAL)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Medium: Today Overview (Habits + Calendar + Tasks)
struct TodayOverviewMediumView: View {
    let data: DerivedTodayView
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Text("HABITS")
                    .font(NexusFont.label(8))
                    .kerning(1.5)
                    .foregroundColor(DIM)

                Spacer(minLength: 2)

                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text("\(data.completedHabits)")
                        .font(NexusFont.numeral(36))
                        .foregroundColor(progressColor(data.completionPercent))
                    Text("/\(data.totalHabits)")
                        .font(NexusFont.numeral(16))
                        .foregroundColor(DIM)
                }

                Spacer(minLength: 4)

                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(HAIRLINE)
                            .frame(height: 5)
                        RoundedRectangle(cornerRadius: 3)
                            .fill(progressColor(data.completionPercent))
                            .frame(width: max(geo.size.width * CGFloat(data.completionPercent) / 100, 4), height: 5)
                    }
                }.frame(height: 5)

                Spacer(minLength: 6)

                if data.remaining > 0 {
                    Text("\(data.remaining) left")
                        .font(NexusFont.ui(10, .semibold))
                        .foregroundColor(TEXT_SOFT)
                } else {
                    HStack(spacing: 3) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 10))
                            .foregroundColor(TEAL)
                        Text("All complete")
                            .font(NexusFont.ui(10, .semibold))
                            .foregroundColor(TEAL)
                    }
                }

                Spacer(minLength: 4)

                // Daily score — the Home alignment score with its §18.4 word.
                // Fraunces Light Italic — the same face the app uses for the
                // score word (tokens.font.fraunces).
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text("SCORE")
                        .font(NexusFont.label(7))
                        .kerning(1)
                        .foregroundColor(DIM)
                    Text("\(data.dailyScore)")
                        .font(NexusFont.numeral(11))
                        .foregroundColor(scoreBandColor(data.dailyScore))
                    Text(data.scoreWord)
                        .font(NexusFont.serif(9))
                        .foregroundColor(TEXT_SOFT)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)
            }
            .frame(width: 100)
            .padding(.trailing, 12)

            Rectangle()
                .fill(HAIRLINE)
                .frame(width: 1)

            VStack(alignment: .leading, spacing: 0) {
                if !data.nextEventTitle.isEmpty {
                    Text("UP NEXT")
                        .font(NexusFont.label(8))
                        .kerning(1.5)
                        .foregroundColor(DIM)
                    HStack(spacing: 5) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(GOLD)
                            .frame(width: 3, height: 28)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(data.nextEventTitle)
                                .font(NexusFont.ui(13, .semibold))
                                .foregroundColor(.white)
                                .lineLimit(1)
                            Text(data.nextEventTime)
                                .font(NexusFont.ui(11))
                                .foregroundColor(GOLD)
                        }
                    }
                    .padding(.top, 4)
                }

                let inboxPending = data.todayTasks.filter { !$0.completed }
                let orbitPending = data.orbitTasks.filter { !$0.completed }
                let pendingTasks = Array((orbitPending + inboxPending).prefix(4))

                // NEX-315: the right column shows ONE actionable list, never two
                // stacked (that overflowed the medium widget top and bottom).
                // iOS 17+ with habits scheduled today: the interactive, tappable
                // habit rows take the slot — check a habit off from the Home Screen.
                // Otherwise (iOS 16 and earlier, or no habits today) fall back to the
                // read-only to-do list exactly as before.
                if #available(iOS 17.0, *), !data.todayHabits.isEmpty {
                    Text("TAP TO LOG")
                        .font(NexusFont.label(8))
                        .kerning(1.5)
                        .foregroundColor(DIM)
                        .padding(.top, data.nextEventTitle.isEmpty ? 0 : 8)
                        .padding(.bottom, 4)

                    InteractiveHabitList(
                        habits: data.todayHabits,
                        // Completed rows rotate out, so each tap reveals the next
                        // habit. More room when there's no "UP NEXT" event above.
                        maxRows: data.nextEventTitle.isEmpty ? 5 : 3
                    )
                } else if !pendingTasks.isEmpty {
                    Text("TO-DO")
                        .font(NexusFont.label(8))
                        .kerning(1.5)
                        .foregroundColor(DIM)
                        .padding(.top, data.nextEventTitle.isEmpty ? 0 : 8)

                    ForEach(Array(pendingTasks.prefix(4).enumerated()), id: \.offset) { _, task in
                        HStack(spacing: 5) {
                            Image(systemName: "circle")
                                .font(.system(size: 9))
                                .foregroundColor(MUTED)
                            Text(task.title)
                                .font(NexusFont.ui(11))
                                .foregroundColor(TEXT_SOFT)
                                .lineLimit(1)
                        }
                        .padding(.top, 2)
                    }
                }

                if data.nextEventTitle.isEmpty && pendingTasks.isEmpty {
                    Spacer(minLength: 0)
                    VStack(spacing: 4) {
                        // v3: clear-schedule success uses teal, never green.
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 20))
                            .foregroundColor(TEAL.opacity(0.7))
                        Text("Clear schedule")
                            .font(NexusFont.ui(10))
                            .foregroundColor(DIM)
                    }
                    .frame(maxWidth: .infinity)
                    Spacer(minLength: 0)
                }

                Spacer(minLength: 0)
            }
            .padding(.leading, 12)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Large: Score hero ring
/// Static, widget-scale port of the in-app AlignmentScoreRing hero
/// (src/components/ui/AlignmentScoreRing.tsx): the same thin gold gradient
/// arc (goldDeep → gold → goldBright) on a faint gold track over a dark
/// well, the same NEX-157 horizon bloom behind it (gold peak → faint teal →
/// transparent), the glowing seed dot at the arc terminus, and the eyebrow /
/// numeral / word stack inside. Widgets can't run the app's count-up and
/// breath, so this renders the ring's settled state. The numeral uses the
/// system monospaced face (Plex Mono is app-locked, unavailable to the
/// extension); the word uses the real Fraunces Light Italic, bundled with
/// the extension (see UIAppFonts in the widget's Info.plist).
///
/// The eyebrow and the §18.4 word deliberately live OUTSIDE this view now
/// (see TodayOverviewLargeView's hero strip): at the band-sized 60-64pt badge
/// there is no room for a three-line stack inside the well, and setting them
/// beside the ring is what lets both shrink without becoming unreadable.
///
/// GEOMETRY, and the bug that lived here (NEX-324). The horizon bloom used to
/// be a ZStack SIBLING carrying a `size * 1.5` frame. A ZStack resolves to its
/// largest child, and a FLEXIBLE child — which a stroked Shape is, exactly like
/// Color — then fills that resolved size. So the two unframed `Circle()`
/// strokes rendered at `0.75 * size` radius while the explicitly-framed well,
/// seed dot and bloom stayed at `0.5 * size`: the arc drew ~1.5x oversized and
/// spilled out of its layout box onto the row below. Measured off a device
/// screenshot: well 46px, bloom rim 52px, seed dot 52px, arc 81px.
///
/// Two independent defenses, so a future edit cannot reintroduce it:
///   1. every circle carries an explicit `.frame(width: size, height: size)`,
///      so none of them is flexible any more;
///   2. the bloom moved to `.background`, which is proposed the PRIMARY view's
///      size and therefore can never inflate the stack. It keeps its oversized
///      frame there and still bleeds unclipped, which is the intended look.
struct ScoreHeroRing: View {
    let score: Int
    /// Band-sized: ~60-64pt in the large widget's hero strip.
    var size: CGFloat = 62

    /// 3pt matches the in-app ring (design system §10.13); below ~80pt that
    /// reads as a band rather than a hairline, so it thins with the badge.
    private var stroke: CGFloat { size < 80 ? 2.5 : 3 }
    private var progress: Double { Double(max(0, min(100, score))) / 100 }
    /// Arc centerline radius — a stroked Circle insets its path by half the
    /// stroke from the frame edge.
    private var arcRadius: CGFloat { (size - stroke) / 2 }
    /// Arc terminus position (12 o'clock at progress 0, sweeping clockwise).
    private var terminus: CGSize {
        let theta = progress * 2 * .pi
        return CGSize(width: arcRadius * sin(theta), height: -arcRadius * cos(theta))
    }
    /// The lit terminus scales with the badge. Hardcoded 14/5pt was tuned for a
    /// 104pt ring and reads as a blob at 62pt.
    private var seedHalo: CGFloat { max(8, size * 0.13) }
    private var seedCore: CGFloat { max(3, size * 0.048) }

    /// Horizon bloom — one smooth radial glow peaking just outside the arc and
    /// fading gold → faint teal → transparent. Stop locations are fractions of
    /// the bloom radius derived from the arc geometry, so they're
    /// size-independent. Lives in `.background`, never as a stack sibling.
    private var bloom: some View {
        RadialGradient(
            stops: [
                .init(color: GOLD.opacity(0), location: 0),
                .init(color: GOLD.opacity(0), location: 0.58),
                .init(color: GOLD_BRIGHT.opacity(0.30), location: 0.67),
                .init(color: GOLD.opacity(0.12), location: 0.74),
                .init(color: TEAL.opacity(0.05), location: 0.79),
                .init(color: TEAL.opacity(0), location: 1),
            ],
            center: .center,
            startRadius: 0,
            endRadius: size * 0.75
        )
        .frame(width: size * 1.5, height: size * 1.5)
        .allowsHitTesting(false)
    }

    var body: some View {
        ZStack {
            // Dark inner well — the numeral sits on void, not raw cosmos.
            Circle()
                .fill(RadialGradient(
                    colors: [VOID.opacity(0.92), VOID_DEEP.opacity(0.92)],
                    center: .center,
                    startRadius: 0,
                    endRadius: (size - stroke * 2 - 4) / 2
                ))
                .frame(width: size - stroke * 2 - 4, height: size - stroke * 2 - 4)

            // Faint full-circle track (app: gold @18%).
            Circle()
                .stroke(GOLD.opacity(0.18), lineWidth: stroke)
                .frame(width: size, height: size)

            // Gold gradient progress arc — starts at 12 o'clock, sweeps
            // clockwise, round cap (trim starts at 3 o'clock, hence -90°).
            Circle()
                .trim(from: 0, to: progress)
                .stroke(
                    LinearGradient(
                        colors: [GOLD_DEEP, GOLD, GOLD_BRIGHT],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    style: StrokeStyle(lineWidth: stroke, lineCap: .round)
                )
                .frame(width: size, height: size)
                .rotationEffect(.degrees(-90))

            // Glowing seed dot at the arc terminus (the "lit terminus").
            Circle()
                .fill(GOLD.opacity(0.45))
                .frame(width: seedHalo, height: seedHalo)
                .offset(terminus)
            Circle()
                .fill(CREAM)
                .frame(width: seedCore, height: seedCore)
                .offset(terminus)

            // The numeral alone. White, not the band color: the arc and its
            // seed dot are this surface's two sanctioned gold elements (§19),
            // and the §18.4 word beside the badge already carries the band.
            Text("\(score)")
                .font(NexusFont.numeral(size * 0.30))
                .foregroundColor(.white)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
        .frame(width: size, height: size)
        .background(bloom)
    }
}

// MARK: - Large: Today Overview (habit checklist)
/// Home Screen widgets can't scroll, so for a user with a full day of habits
/// the large family is the whole checklist or nothing. NEX-324 rebuilt it as
/// three horizontal bands with real gutters, replacing a centered hero that
/// pushed the day's work off the bottom:
///
///   BAND 1  hero strip — count, progress bar, and the score badge pushed to
///           the trailing edge. The score is a summary, so it keeps its
///           identity and gives up the middle of the widget.
///   BAND 2  context — WHAT'S NEXT beside the day's quote, moved up into the
///           top third where they are actually read.
///   BAND 3  the work — every scheduled habit as tappable rows.
///
/// Sizing note: `systemLarge` runs 364x382 on a Pro Max down to 321x324 on an
/// SE, so every budget below is measured against the real height and the SE is
/// the binding case.
struct TodayOverviewLargeView: View {
    let data: DerivedTodayView

    // MARK: Band budget

    /// Minimum height of one tappable checklist row, and therefore the
    /// budgeting unit. Natural row height is ~21.5pt (the SF Symbol's line box
    /// sets it, not the label), which Greptile correctly flagged as far under
    /// the 44pt touch minimum — see the TAP-TARGET note on the checklist.
    ///
    /// 44pt is unreachable here and not by a little: at 44pt the tightest
    /// `systemLarge` (321×324, content 292) fits 2 rows with the context band
    /// and 4 without, so 15 habits do not fit even if WHAT'S NEXT and the
    /// quote are deleted outright. 30pt is the owner-chosen middle: it nearly
    /// doubles the natural target, keeps the whole day on a Pro Max, and
    /// degrades to "+N more" on smaller phones rather than to unusable rows.
    private let minRowHeight: CGFloat = 30
    /// Height the "+N more" hint needs when the list overflows: 9pt text plus
    /// the stack spacing above it. Reserved in BOTH the row-count budget and
    /// the fill height — they have to agree, because the hint is laid out
    /// AFTER the rows and silently clips if the rows already took its space.
    private let hintHeight: CGFloat = 14
    private func rowHeight(columns: Int) -> CGFloat { minRowHeight }
    /// Zero, deliberately: any gap between rows is dead space that belongs to
    /// nobody. Folding it into the rows' own padding makes every point of the
    /// list's height a hit region instead of a gutter between two of them.
    private let rowSpacing: CGFloat = 0
    /// Hero strip: 34pt numeral (≈40pt line) + 6 + 4pt bar + 6 + an 11pt
    /// tracked label. The badge column is shorter than that, so the text
    /// column sets the height.
    private let band1: CGFloat = 67
    /// Quotes run to WIDGET_QUOTE_MAX_CHARS (400), so a full-height quote is
    /// the common case, not a corner — the old 58pt budget here is what
    /// clipped it. On the short height classes the quote gives up its third
    /// line rather than the checklist giving up habits: seeing the whole day
    /// is this family's whole reason to exist.
    private func quoteLines(for height: CGFloat) -> Int { height >= 360 ? 3 : 2 }
    /// 11pt label + 5 + N × ~14pt lines + 5 + a 10pt attribution.
    private func band2(for height: CGFloat) -> CGFloat {
        31 + CGFloat(quoteLines(for: height)) * 14
    }
    private let gutter: CGFloat = 14
    /// "TAP TO LOG" label plus its bottom padding.
    private let tapLabel: CGFloat = 16

    /// The badge scales gently with the height class. It never returns to
    /// being the visual center of the widget.
    private func heroBadgeSize(for height: CGFloat) -> CGFloat {
        if height >= 360 { return 64 }
        if height >= 340 { return 60 }
        return 56
    }

    private var hasContextRow: Bool {
        !data.nextEventTitle.isEmpty || !data.quoteText.isEmpty
    }

    /// Height left for checklist rows after the three bands.
    private func checklistHeight(for height: CGFloat) -> CGFloat {
        // Budget against the PADDED content height — the VStack's 16pt outer
        // padding (top + bottom) is not list space (Greptile P1 on #380).
        var used = (height - 32) - band1 - gutter - tapLabel
        if hasContextRow { used -= band2(for: height) + gutter }
        if !data.winText.isEmpty { used -= 14 }
        return max(0, used)
    }

    /// Rows per column that fit, reserving space for the "+N more" hint when
    /// the list will actually overflow (9pt text + 4pt spacing ≈ 14pt). The
    /// hint renders BELOW the rows, so not reserving it clips the last row.
    private func rowsPerColumn(for height: CGFloat, columns: Int) -> Int {
        let avail = checklistHeight(for: height)
        let unit = rowHeight(columns: columns)
        var rows = max(0, Int(avail / unit))
        if data.todayHabits.count > rows * columns {
            rows = max(0, Int((avail - hintHeight) / unit))
        }
        return rows
    }

    /// Two roomy columns while the day fits in them, three when it doesn't.
    /// Short days keep full habit names; long days trade name length for
    /// seeing everything, which is the whole point of this family.
    private func columnCount(for height: CGFloat) -> Int {
        data.todayHabits.count <= rowsPerColumn(for: height, columns: 2) * 2 ? 2 : 3
    }

    var body: some View {
        GeometryReader { geo in
            let columns = columnCount(for: geo.size.height)
            let rows = rowsPerColumn(for: geo.size.height, columns: columns)
            let rowCap = rows * columns
            // Surplus height goes into row PADDING rather than row spacing, so
            // a roomy widget makes every row a bigger tap target instead of
            // leaving a hole above the list. On the SE there is no surplus and
            // rows stay at the minimum; on a Pro Max this roughly doubles the
            // hit region. Capped so a short list does not turn into stripes.
            // Measured against the rows actually RENDERED, not the capacity:
            // a 15-habit day in 3 columns draws 5 rows even where 7 would fit,
            // and budgeting the surplus against 7 leaves it on the floor.
            let drawnRows = min(rows, Int((Double(data.todayHabits.count) / Double(columns)).rounded(.up)))
            // Rows share out the WHOLE checklist band rather than sitting at
            // the 30pt floor with the remainder pooling above them as a gap
            // (that gap measured 37pt on a 354pt widget). Growing the rows
            // instead moves the list up AND spends the slack on hit area,
            // walking the target back toward the 44pt ideal where the space
            // exists. Never below the 30pt floor, never above 44 (past that it
            // reads as stripes rather than a list).
            // The hint is appended BELOW the rows, so its reserve has to come
            // off the top before the rows divide up what is left. Sharing the
            // full band instead let three 40.7pt rows swallow all 122pt at
            // 321x324 and clip the "+4 more" line — which reads as "that is
            // my whole day" and is the worst way for this widget to be wrong.
            let overflowing = data.todayHabits.count > rowCap
            let fillBand = checklistHeight(for: geo.size.height) - (overflowing ? hintHeight : 0)
            let fillRowHeight: CGFloat = drawnRows > 0
                ? min(44, max(minRowHeight, fillBand / CGFloat(drawnRows)))
                : minRowHeight

            VStack(alignment: .leading, spacing: 0) {

                // ── BAND 1 · the glance ─────────────────────────────────────
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 2) {
                            Text("\(data.completedHabits)")
                                .font(NexusFont.numeral(34))
                                .foregroundColor(.white)
                            Text("/\(data.totalHabits)")
                                .font(NexusFont.numeral(18))
                                .foregroundColor(DIM)
                        }
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)

                        // Teal, not gold: §19 allows two gold elements per
                        // surface and the badge's arc plus its seed dot are
                        // both of them. Teal also reads as "now", which is
                        // what a live count is.
                        GeometryReader { bar in
                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(HAIRLINE)
                                    .frame(height: 4)
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(TEAL)
                                    .frame(
                                        width: max(bar.size.width * CGFloat(data.completionPercent) / 100, 4),
                                        height: 4
                                    )
                            }
                        }
                        .frame(height: 4)

                        if data.remaining > 0 {
                            Text("\(data.remaining) LEFT TODAY")
                                .font(NexusFont.ui(9, .semibold))
                                .kerning(1.5)
                                .foregroundColor(MUTED)
                                .lineLimit(1)
                        } else {
                            HStack(spacing: 4) {
                                Image(systemName: "checkmark.seal.fill")
                                    .font(.system(size: 9))
                                    .foregroundColor(TEAL)
                                Text("ALL COMPLETE")
                                    .font(NexusFont.ui(9, .semibold))
                                    .kerning(1.5)
                                    .foregroundColor(TEAL)
                            }
                        }
                    }

                    HStack(spacing: 9) {
                        ScoreHeroRing(
                            score: data.dailyScore,
                            size: heroBadgeSize(for: geo.size.height)
                        )
                        VStack(alignment: .leading, spacing: 3) {
                            Text("TODAY'S SCORE")
                                .font(NexusFont.ui(8, .semibold))
                                .kerning(1.4)
                                .foregroundColor(MUTED)
                            Text(data.scoreWord)
                                // Fraunces Light Italic — the locked
                                // alignment-score face, bundled with the
                                // extension (UIAppFonts; the string is the
                                // font's PostScript name). One Fraunces
                                // moment per surface, and this is it.
                                .font(NexusFont.serif(13))
                                .foregroundColor(TEXT_SOFT)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                    }
                    .fixedSize(horizontal: true, vertical: false)
                }

                if !data.winText.isEmpty {
                    Text(data.winText)
                        .font(NexusFont.ui(10))
                        .foregroundColor(MUTED)
                        .lineLimit(1)
                        .padding(.top, 4)
                }

                // ── BAND 2 · the context ────────────────────────────────────
                // Fixed gutter, not a Spacer: two flexible spacers would split
                // the leftover height between them and float this band into
                // the middle of the widget. It belongs directly under the hero
                // — being read at a glance is the entire point of moving it up.
                if hasContextRow {
                    HStack(alignment: .top, spacing: 16) {
                        if !data.nextEventTitle.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("WHAT'S NEXT")
                                    .font(NexusFont.ui(9, .semibold))
                                    .kerning(1.5)
                                    .foregroundColor(MUTED)
                                HStack(spacing: 7) {
                                    // Teal rule: this is a NOW state, and the
                                    // gold budget is spent on the badge.
                                    RoundedRectangle(cornerRadius: 1)
                                        .fill(TEAL)
                                        .frame(width: 2)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(data.nextEventTitle)
                                            .font(NexusFont.ui(13, .semibold))
                                            .foregroundColor(.white)
                                            .lineLimit(1)
                                        Text(data.nextEventTime)
                                            .font(NexusFont.numeral(11))
                                            .foregroundColor(TEAL)
                                            .lineLimit(1)
                                    }
                                }
                                .fixedSize(horizontal: false, vertical: true)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        if !data.quoteText.isEmpty {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("TODAY'S WISDOM")
                                    .font(NexusFont.ui(9, .semibold))
                                    .kerning(1.5)
                                    .foregroundColor(MUTED)
                                // No gold rule any more — the quote stands on
                                // the serif face and its attribution.
                                Text(data.quoteText)
                                    .font(NexusFont.serif(11.5))
                                    .foregroundColor(TEXT_SOFT)
                                    .lineLimit(quoteLines(for: geo.size.height))
                                    .minimumScaleFactor(0.9)
                                    // Without this the checklist's appetite for
                                    // height compresses the quote to a single
                                    // truncated line. lineLimit(3) bounds the
                                    // ideal height, so this claims exactly the
                                    // three lines band2 already budgets for.
                                    .fixedSize(horizontal: false, vertical: true)
                                if !data.quoteAuthor.isEmpty {
                                    Text(data.quoteAuthor.uppercased())
                                        .font(NexusFont.ui(8, .semibold))
                                        .kerning(1.4)
                                        .foregroundColor(MUTED)
                                        .lineLimit(1)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.top, gutter)
                }

                // Fixed, not flexible. A Spacer here soaked up whatever the
                // context band did not use and pushed the checklist down the
                // widget; the rows now absorb that height themselves (see
                // fillRowHeight), so the list starts directly under band 2.
                Spacer().frame(height: gutter)

                // ── BAND 3 · the work ───────────────────────────────────────
                // The widget extension targets iOS 17.0 (pbxproj Debug +
                // Release), so this availability check is always satisfied at
                // runtime — it stays only to keep the compiler honest if the
                // target is ever lowered (Greptile P1 on #360: a read-only iOS
                // 16 fallback here was dead code, and it shipped a
                // selection-order bug precisely because it could never run).
                if #available(iOS 17.0, *), !data.todayHabits.isEmpty {
                    Text("TAP TO LOG")
                        .font(NexusFont.ui(9, .semibold))
                        .kerning(1.5)
                        .foregroundColor(MUTED)
                        .padding(.bottom, 5)

                    // TAP TARGETS: 30pt rows, under the 44pt minimum. This
                    // is the ONE named exception in §19 (owner-approved
                    // 2026-08-07, NEX-324) — read it there for the full
                    // rationale and its bounds. Short version: Home Screen
                    // widgets cannot scroll, 44pt cannot fit a 15-habit day at
                    // any systemLarge size even with the context band deleted,
                    // and a habit the user cannot see is one they will not log
                    // (§1.5 Law A/D). Scoped to this grid alone; medium and
                    // small keep the 44pt floor.
                    InteractiveHabitList(
                        habits: data.todayHabits,
                        maxRows: rowCap,
                        rowPadding: 2,
                        rowSpacing: rowSpacing,
                        minRowHeight: fillRowHeight,
                        columns: columns,
                        textSize: columns >= 3 ? 10 : 11,
                        // keepCompleted only while the WHOLE day fits: done
                        // habits keep their slot as a teal check. Once the cap
                        // truncates the list, pinned check-rows would eat the
                        // visible slots and could hide every tappable habit
                        // behind the non-interactive hint — so a capped list
                        // rotates completed rows out and prioritizes pending
                        // ones, keeping an actionable row on screen (Greptile
                        // P1 round 4 on #380).
                        keepCompleted: data.todayHabits.count <= rowCap
                    )
                }

                // Absorbs the few points between the budgeted band heights and
                // what SwiftUI actually lays out, so a small estimate error
                // shows up as a hairline at the bottom instead of clipping the
                // last row.
                Spacer(minLength: 0)
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

// MARK: - iPad Extra Large: Daily Command
/// The iPad-only systemExtraLarge surface — the Today Overview writ large.
/// Same three bands as the large family; the extra width goes entirely into
/// BAND 2, which grows from large's two context columns to three:
///   BAND 1  the glance — habit count + bar beside the score hero ring,
///           identical to the large hero strip.
///   BAND 2  the context — WHAT'S NEXT (the day's upcoming events strip,
///           not just the single next one), TODAY'S WISDOM (the quote), and
///           TO-DO (the day's pending tasks, the medium widget's list style).
///   BAND 3  the work — every scheduled habit as tappable rows via the same
///           InteractiveHabitList + CompleteHabitIntent path, full width.
/// Takes the large family's deep scrim via TodayBackdrop.
///
/// systemExtraLarge runs roughly 690-720pt wide x 330-380pt tall depending on
/// iPad class, so every budget below is measured against the real height with
/// the same rules as the large family: 30pt row floor (the owner-approved
/// §19/NEX-324 exception), the "+N more" hint reserved in BOTH the row count
/// and the fill height, and surplus height spent on row padding (hit area),
/// never on gaps.
struct NexusXLView: View {
    let data: DerivedTodayView

    // MARK: Band budget (same rules as the large family)

    private let minRowHeight: CGFloat = 30
    private let hintHeight: CGFloat = 14
    private let rowSpacing: CGFloat = 0
    private let band1: CGFloat = 67
    private let gutter: CGFloat = 14
    /// "TAP TO LOG" label plus its bottom padding (same as large).
    private let tapLabel: CGFloat = 16

    /// Band 2's height is set by its tallest column. The quote is that column:
    /// label (11) + 5 + N x ~14pt lines + 5 + a 10pt attribution. The event
    /// strip (label + 3 rows x ~19pt) and the TO-DO list (label + rows x ~16pt)
    /// both come in under it as long as their row counts follow quoteLines.
    private func quoteLines(for height: CGFloat) -> Int { height >= 360 ? 4 : 3 }
    private func band2(for height: CGFloat) -> CGFloat {
        31 + CGFloat(quoteLines(for: height)) * 14
    }
    /// TO-DO rows shown; tracks quoteLines so the column never outgrows band 2.
    private func maxTodoRows(for height: CGFloat) -> Int { quoteLines(for: height) }

    private func heroBadgeSize(for height: CGFloat) -> CGFloat {
        if height >= 360 { return 64 }
        if height >= 340 { return 60 }
        return 56
    }

    /// ONE actionable to-do list, the medium widget's merge: orbit tasks first,
    /// then inbox, pending only.
    private func pendingTasks(for height: CGFloat) -> [DerivedTodayView.TaskView] {
        let orbitPending = data.orbitTasks.filter { !$0.completed }
        let inboxPending = data.todayTasks.filter { !$0.completed }
        return Array((orbitPending + inboxPending).prefix(maxTodoRows(for: height)))
    }

    private func hasContextRow(height: CGFloat) -> Bool {
        !data.upcomingEvents.isEmpty || !data.quoteText.isEmpty || !pendingTasks(for: height).isEmpty
    }

    /// Height left for checklist rows after the three bands (large's rule:
    /// budget against the PADDED content height — the 16pt outer padding is
    /// not list space).
    private func checklistHeight(for height: CGFloat) -> CGFloat {
        var used = (height - 32) - band1 - gutter - tapLabel
        if hasContextRow(height: height) { used -= band2(for: height) + gutter }
        if !data.winText.isEmpty { used -= 14 }
        return max(0, used)
    }

    /// Rows per column that fit, reserving space for the "+N more" hint when
    /// the list will actually overflow (same as the large view).
    private func rowsPerColumn(for height: CGFloat, columns: Int) -> Int {
        let avail = checklistHeight(for: height)
        var rows = max(0, Int(avail / minRowHeight))
        if data.todayHabits.count > rows * columns {
            rows = max(0, Int((avail - hintHeight) / minRowHeight))
        }
        return rows
    }

    /// Two roomy columns while the day fits in them, three when it doesn't
    /// (the large family's rule; the wider canvas just makes both roomier).
    private func columnCount(for height: CGFloat) -> Int {
        data.todayHabits.count <= rowsPerColumn(for: height, columns: 2) * 2 ? 2 : 3
    }

    var body: some View {
        GeometryReader { geo in
            let columns = columnCount(for: geo.size.height)
            let rows = rowsPerColumn(for: geo.size.height, columns: columns)
            let rowCap = rows * columns
            // Surplus height goes into row PADDING, not a gap above the list
            // (the large checklist's fillRowHeight logic): every point of the
            // list's height is a hit region. Never below 30, never above 44.
            // Measured against the rows actually RENDERED, not the capacity.
            let drawnRows = min(rows, Int((Double(data.todayHabits.count) / Double(columns)).rounded(.up)))
            let overflowing = data.todayHabits.count > rowCap
            let fillBand = checklistHeight(for: geo.size.height) - (overflowing ? hintHeight : 0)
            let fillRowHeight: CGFloat = drawnRows > 0
                ? min(44, max(minRowHeight, fillBand / CGFloat(drawnRows)))
                : minRowHeight
            let todos = pendingTasks(for: geo.size.height)

            VStack(alignment: .leading, spacing: 0) {

                // ── BAND 1 · the glance (identical to large) ──────────────
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 2) {
                            Text("\(data.completedHabits)")
                                .font(NexusFont.numeral(34))
                                .foregroundColor(.white)
                            Text("/\(data.totalHabits)")
                                .font(NexusFont.numeral(18))
                                .foregroundColor(DIM)
                        }
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)

                        // Teal, not gold: §19 allows two gold elements per
                        // surface and the badge's arc plus its seed dot are
                        // both of them.
                        GeometryReader { bar in
                            ZStack(alignment: .leading) {
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(HAIRLINE)
                                    .frame(height: 4)
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(TEAL)
                                    .frame(
                                        width: max(bar.size.width * CGFloat(data.completionPercent) / 100, 4),
                                        height: 4
                                    )
                            }
                        }
                        .frame(height: 4)

                        if data.remaining > 0 {
                            Text("\(data.remaining) LEFT TODAY")
                                .font(NexusFont.ui(9, .semibold))
                                .kerning(1.5)
                                .foregroundColor(MUTED)
                                .lineLimit(1)
                        } else {
                            HStack(spacing: 4) {
                                Image(systemName: "checkmark.seal.fill")
                                    .font(.system(size: 9))
                                    .foregroundColor(TEAL)
                                Text("ALL COMPLETE")
                                    .font(NexusFont.ui(9, .semibold))
                                    .kerning(1.5)
                                    .foregroundColor(TEAL)
                            }
                        }
                    }

                    HStack(spacing: 9) {
                        ScoreHeroRing(
                            score: data.dailyScore,
                            size: heroBadgeSize(for: geo.size.height)
                        )
                        VStack(alignment: .leading, spacing: 3) {
                            Text("TODAY'S SCORE")
                                .font(NexusFont.ui(8, .semibold))
                                .kerning(1.4)
                                .foregroundColor(MUTED)
                            Text(data.scoreWord)
                                // Fraunces Light Italic — one serif moment
                                // per surface (see the large hero strip).
                                .font(NexusFont.serif(13))
                                .foregroundColor(TEXT_SOFT)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                    }
                    .fixedSize(horizontal: true, vertical: false)
                }

                // Today's intention, dated today at render time (the derived
                // view empties it otherwise — stale payloads hide it, exactly
                // like the large widget).
                if !data.winText.isEmpty {
                    Text(data.winText)
                        .font(NexusFont.ui(10))
                        .foregroundColor(MUTED)
                        .lineLimit(1)
                        .padding(.top, 4)
                }

                // ── BAND 2 · the context — three columns ──────────────────
                // Fixed gutter, not a Spacer (large's rule: flexible spacers
                // would float this band into the middle of the widget).
                if hasContextRow(height: geo.size.height) {
                    HStack(alignment: .top, spacing: 16) {
                        // WHAT'S NEXT — the day's upcoming events strip. The
                        // derived view already trims the payload to the next
                        // three, which is what band 2 budgets for.
                        if !data.upcomingEvents.isEmpty {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("WHAT'S NEXT")
                                    .font(NexusFont.ui(9, .semibold))
                                    .kerning(1.5)
                                    .foregroundColor(MUTED)
                                ForEach(Array(data.upcomingEvents.enumerated()), id: \.offset) { _, event in
                                    HStack(spacing: 7) {
                                        // Teal, monospaced: a NOW state; the
                                        // gold budget is spent on the badge.
                                        Text(event.time)
                                            .font(NexusFont.numeral(10))
                                            .foregroundColor(TEAL)
                                            .frame(width: 58, alignment: .leading)
                                        Text(event.title)
                                            .font(NexusFont.ui(12))
                                            .foregroundColor(.white)
                                            .lineLimit(1)
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        // TODAY'S WISDOM — the quote, large's exact styling.
                        if !data.quoteText.isEmpty {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("TODAY'S WISDOM")
                                    .font(NexusFont.ui(9, .semibold))
                                    .kerning(1.5)
                                    .foregroundColor(MUTED)
                                // No gold rule — the quote stands on the
                                // serif face and its attribution.
                                Text(data.quoteText)
                                    .font(NexusFont.serif(11.5))
                                    .foregroundColor(TEXT_SOFT)
                                    .lineLimit(quoteLines(for: geo.size.height))
                                    .minimumScaleFactor(0.9)
                                    // Claims exactly the lines band 2 budgets
                                    // for; without it the checklist's appetite
                                    // compresses the quote (large's fix).
                                    .fixedSize(horizontal: false, vertical: true)
                                if !data.quoteAuthor.isEmpty {
                                    Text(data.quoteAuthor.uppercased())
                                        .font(NexusFont.ui(8, .semibold))
                                        .kerning(1.4)
                                        .foregroundColor(MUTED)
                                        .lineLimit(1)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        // TO-DO — the day's pending tasks, the medium widget's
                        // read-only list style (the tappable list stays the
                        // habits in band 3; tasks complete in the app).
                        if !todos.isEmpty {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("TO-DO")
                                    .font(NexusFont.ui(9, .semibold))
                                    .kerning(1.5)
                                    .foregroundColor(MUTED)
                                ForEach(Array(todos.enumerated()), id: \.offset) { _, task in
                                    HStack(spacing: 5) {
                                        Image(systemName: "circle")
                                            .font(.system(size: 9))
                                            .foregroundColor(MUTED)
                                        Text(task.title)
                                            .font(NexusFont.ui(11))
                                            .foregroundColor(TEXT_SOFT)
                                            .lineLimit(1)
                                    }
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(.top, gutter)
                }

                // Fixed, not flexible (large's rule): the rows absorb slack
                // themselves via fillRowHeight, so the list starts directly
                // under band 2.
                Spacer().frame(height: gutter)

                // ── BAND 3 · the work ─────────────────────────────────────
                // The extension targets iOS 17.0, so this guard is always
                // satisfied; it stays to keep the compiler honest if the
                // target is ever lowered (same as the large checklist).
                if #available(iOS 17.0, *), !data.todayHabits.isEmpty {
                    Text("TAP TO LOG")
                        .font(NexusFont.ui(9, .semibold))
                        .kerning(1.5)
                        .foregroundColor(MUTED)
                        .padding(.bottom, 5)

                    // TAP TARGETS: 30pt rows, under the 44pt minimum — the ONE
                    // named §19 exception (owner-approved 2026-08-07, NEX-324);
                    // see the large checklist for the full rationale.
                    InteractiveHabitList(
                        habits: data.todayHabits,
                        maxRows: rowCap,
                        rowPadding: 2,
                        rowSpacing: rowSpacing,
                        minRowHeight: fillRowHeight,
                        columns: columns,
                        textSize: columns >= 3 ? 10 : 11,
                        // keepCompleted only while the WHOLE day fits (the
                        // large checklist's rule): done habits keep their slot
                        // as a teal check; a capped list rotates them out so an
                        // actionable row stays on screen above the "+N more".
                        keepCompleted: data.todayHabits.count <= rowCap
                    )
                } else if data.todayHabits.isEmpty {
                    // No habits scheduled today — the same quiet all-clear the
                    // medium widget ships.
                    Spacer(minLength: 0)
                    VStack(spacing: 4) {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 20))
                            .foregroundColor(TEAL.opacity(0.7))
                        Text("Clear schedule")
                            .font(NexusFont.ui(10))
                            .foregroundColor(DIM)
                    }
                    .frame(maxWidth: .infinity)
                }

                // Absorbs the few points between the budgeted band heights and
                // what SwiftUI actually lays out (large's safety valve).
                Spacer(minLength: 0)
            }
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

// MARK: - Small: Streak Counter
struct StreakSmallView: View {
    let data: DerivedTodayView
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if data.softMode {
                // Soft Mode (opt-in): the breakable day-streak.
                Text("TOP STREAK")
                    .font(NexusFont.label(9))
                    .kerning(1.5)
                    .foregroundColor(DIM)
                HStack(alignment: .lastTextBaseline, spacing: 2) {
                    Text("\(data.longestStreakDays)")
                        .font(NexusFont.numeral(48))
                        .foregroundColor(GOLD)
                        .minimumScaleFactor(0.6)
                    Text("days")
                        .font(NexusFont.ui(14, .semibold))
                        .foregroundColor(MUTED)
                }
                Text(data.longestStreakHabit)
                    .font(NexusFont.ui(11, .semibold))
                    .foregroundColor(TEXT_SOFT)
                    .lineLimit(2)
            } else {
                // Default (Law B): cumulative lifetime reps — a miss takes none away.
                Text("TOP HABIT")
                    .font(NexusFont.label(9))
                    .kerning(1.5)
                    .foregroundColor(DIM)
                if data.topHabitReps > 0 {
                    HStack(alignment: .lastTextBaseline, spacing: 2) {
                        Text("\(data.topHabitReps)")
                            .font(NexusFont.numeral(48))
                            .foregroundColor(GOLD)
                            .minimumScaleFactor(0.6)
                        Text("reps")
                            .font(NexusFont.ui(14, .semibold))
                            .foregroundColor(MUTED)
                    }
                    Text(data.topHabitTitle)
                        .font(NexusFont.ui(11, .semibold))
                        .foregroundColor(TEXT_SOFT)
                        .lineLimit(2)
                } else {
                    // No reps yet — never a deflating "0 reps" (mirrors weeklyProgressLabel).
                    Text("No reps yet")
                        .font(NexusFont.ui(15, .semibold))
                        .foregroundColor(MUTED)
                        .padding(.top, 4)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

// MARK: - Lock Screen: Habit Progress Circle (accessoryCircular)
struct HabitCircleView: View {
    let data: DerivedTodayView
    var body: some View {
        let total = max(data.totalHabits, 1)
        Gauge(value: Double(data.completedHabits), in: 0...Double(total)) {
            Text("")
        } currentValueLabel: {
            VStack(spacing: -2) {
                Text("\(data.completedHabits)/\(data.totalHabits)")
                    .font(NexusFont.numeral(12))
            }
        }
        .gaugeStyle(.accessoryCircular)
        .tint(progressColor(data.completionPercent))
    }
}

// MARK: - Lock Screen: Streak Circle
struct StreakCircleView: View {
    let data: DerivedTodayView
    var body: some View {
        if data.softMode {
            Gauge(value: Double(min(data.longestStreakDays, 30)), in: 0...30) {
                Text("STK")
            } currentValueLabel: {
                Text("\(data.longestStreakDays)")
                    .font(NexusFont.numeral(14))
            }
            .gaugeStyle(.accessoryCircular)
            .tint(GOLD)
        } else {
            // Default (Law B): cumulative reps. The 0...100 fill is a decorative
            // "century" arc, not a breakable target; minimumScaleFactor keeps
            // 3–4-digit counts legible in the small circular slot.
            Gauge(value: Double(min(data.topHabitReps, 100)), in: 0...100) {
                Text("REPS")
            } currentValueLabel: {
                Text("\(data.topHabitReps)")
                    .font(NexusFont.numeral(14))
                    .minimumScaleFactor(0.5)
            }
            .gaugeStyle(.accessoryCircular)
            .tint(GOLD)
        }
    }
}

// MARK: - Lock Screen: Inline
struct InlineView: View {
    let data: DerivedTodayView
    var body: some View {
        let base = "\(data.completedHabits)/\(data.totalHabits) habits · \(data.completionPercent)%"
        // Soft Mode → day streak; default → cumulative reps (omitted when 0, never "0 reps").
        let tail = data.softMode
            ? "\(data.longestStreakDays)d streak"
            : (data.topHabitReps > 0 ? "\(data.topHabitReps) reps" : "")
        Text(tail.isEmpty ? base : "\(base) · \(tail)")
            .font(NexusFont.ui(12, .semibold))
    }
}

// MARK: - Widget entries
//
// v3 stellar: home-screen widgets render on top of `CosmicBackdrop` — a
// static cosmic gradient (void + nebula hint) that mirrors the app's
// galaxy field at widget scale. Lock-screen widgets keep `Color.clear`
// per Apple guidance (they composite into the system's wallpaper-aware
// container).
struct NexusHabitWidget: Widget {
    let kind = "NexusScoreWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NexusProvider()) { entry in
            HabitProgressSmallView(data: entry.derived)
                .containerBackground(for: .widget) { CosmicBackdrop() }
        }
        .configurationDisplayName("Habit Progress")
        .description("How many habits you've completed today.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

struct NexusTodayWidget: Widget {
    let kind = "NexusScoreMediumWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NexusProvider()) { entry in
            NexusTodayOverviewView(data: entry.derived)
                // Family-aware scrim: the large layout is denser than the
                // medium one and needs firmer ground under the checklist,
                // while medium keeps the backdrop it has always had.
                .containerBackground(for: .widget) { TodayBackdrop() }
        }
        .configurationDisplayName("Today Overview")
        .description("Habits, calendar, tasks, and your daily score at a glance. Large shows what is next, the day's wisdom, and your whole habit list as a tappable checklist.")
        .supportedFamilies([.systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}

struct NexusXLWidget: Widget {
    let kind = "NexusXLWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NexusProvider()) { entry in
            NexusTodayOverviewView(data: entry.derived)
                .containerBackground(for: .widget) { TodayBackdrop() }
        }
        .configurationDisplayName("Daily Command")
        .description("Your score, the day's quote, what's next, your to-dos, and the whole day's habits as a tappable checklist. The largest size, on iPad.")
        .supportedFamilies([.systemExtraLarge])
        .contentMarginsDisabled()
    }
}

/// Routes the Today Overview widgets by family: medium keeps the
/// habits/calendar/tasks split; large centers TODAY'S SCORE up top, puts the
/// WHAT'S NEXT event side-by-side with the quote of the day, and pins the
/// full day as a tappable checklist (completed rows stay as checks) to the
/// bottom; extra-large (iPad only, the Daily Command widget) splits the wide
/// canvas into a score/intention/calendar glance column and a taller tappable
/// checklist.
struct NexusTodayOverviewView: View {
    @Environment(\.widgetFamily) private var family
    let data: DerivedTodayView
    var body: some View {
        switch family {
        case .systemExtraLarge:
            NexusXLView(data: data)
        case .systemLarge:
            TodayOverviewLargeView(data: data)
        default:
            TodayOverviewMediumView(data: data)
        }
    }
}

/// Picks the backdrop scrim for whichever family is rendering. Only the large
/// and extra-large layouts take the deeper gradient; medium keeps the shared
/// default so this change stays inside its stated scope (NEX-324).
struct TodayBackdrop: View {
    @Environment(\.widgetFamily) private var family
    var body: some View {
        CosmicBackdrop(
            scrim: (family == .systemLarge || family == .systemExtraLarge)
                ? CosmicBackdrop.deepScrim
                : CosmicBackdrop.defaultScrim
        )
    }
}

struct NexusStreakWidget: Widget {
    let kind = "NexusStreakWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NexusProvider()) { entry in
            StreakSmallView(data: entry.derived)
                .containerBackground(for: .widget) { CosmicBackdrop() }
        }
        .configurationDisplayName("Top Habit")
        .description("Your habit with the most reps. Soft Mode shows a day streak instead.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

struct NexusLockScreenWidget: Widget {
    let kind = "NexusLockScreenWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NexusProvider()) { entry in
            Group {
                HabitCircleView(data: entry.derived)
            }
            .containerBackground(Color.clear, for: .widget)
        }
        .configurationDisplayName("Habit Progress")
        .description("Habit completion on your lock screen.")
        .supportedFamilies([.accessoryCircular])
    }
}

struct NexusStreakLockWidget: Widget {
    let kind = "NexusStreakLockWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NexusProvider()) { entry in
            StreakCircleView(data: entry.derived)
                .containerBackground(Color.clear, for: .widget)
        }
        .configurationDisplayName("Top Habit")
        .description("Your top habit's reps on the lock screen. Soft Mode shows a day streak.")
        .supportedFamilies([.accessoryCircular])
    }
}

struct NexusInlineWidget: Widget {
    let kind = "NexusInlineWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NexusProvider()) { entry in
            InlineView(data: entry.derived)
                .containerBackground(Color.clear, for: .widget)
        }
        .configurationDisplayName("Nexus Inline")
        .description("Habits and reps in one line.")
        .supportedFamilies([.accessoryInline])
    }
}

// MARK: - Bundle
// MARK: - Interactive completion (NEX-313/NEX-315, iOS 17+)
//
// Checking a habit off from the Home Screen. The button runs this intent in the
// WIDGET EXTENSION's process, which cannot touch the RN app's state — so it only
// leaves a message in the App Group queue the RN app drains on next foreground
// (src/widgets/widget-completion-drain.ts) and, for instant visual feedback,
// the timeline provider folds that same queue into the derived view (see
// pendingTapLogEntries / appendingLogEntries — count-accurate for multi-rep
// habits, which a flat optimistic-title set could never be).
//
// The action is COMPLETE, never toggle: applying it twice equals once, so the
// app-side reconcile has no double-apply race to lose. Un-completing lives
// in-app. Everything here is gated iOS 17+ (Button(intent:) requires it); the
// non-interactive widget is the fallback below that.

private let WIDGET_APP_GROUP = "group.com.jhuff.nexus"
private let PENDING_KEY = "widgetPendingCompletions"   // mirror: widget-completion-drain.ts

/// Same normalization as the app's `normalize` (src/utils/text.ts): NFC,
/// trimmed, lowercased, whitespace-collapsed. Used to match queued taps and
/// persisted logs to the same habit when capping occurrences to timesPerDay.
private func normalizeHabitTitle(_ s: String) -> String {
    let collapsed = s.components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }
        .joined(separator: " ")
    return collapsed.precomposedStringWithCanonicalMapping.lowercased()
}

private func todayDayKey(_ now: Date = Date()) -> String {
    let f = DateFormatter()
    f.calendar = Calendar.current
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f.string(from: now)
}

@available(iOS 17.0, *)
struct CompleteHabitIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete Habit"
    static var isDiscoverable: Bool = false   // widget-only; not a Shortcuts action

    @Parameter(title: "Habit") var habitTitle: String

    init() {}
    init(habitTitle: String) { self.habitTitle = habitTitle }

    func perform() async throws -> some IntentResult {
        guard let defaults = UserDefaults(suiteName: WIDGET_APP_GROUP) else { return .result() }

        var queue: [[String: Any]] = []
        if let raw = defaults.string(forKey: PENDING_KEY),
           let data = raw.data(using: .utf8),
           let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            queue = arr
        }
        queue.append([
            "id": UUID().uuidString,
            "habitTitle": habitTitle,
            "dayKey": todayDayKey(),
            "at": Date().timeIntervalSince1970 * 1000,
        ])
        if let out = try? JSONSerialization.data(withJSONObject: queue),
           let s = String(data: out, encoding: .utf8) {
            defaults.set(s, forKey: PENDING_KEY)
        }
        // The reloaded timeline re-derives completion from widgetData UNION the
        // pending queue (count-capped at each habit's timesPerDay), so the
        // tapped row shows checked at once; the app makes it authoritative on
        // next foreground.
        WidgetCenter.shared.reloadAllTimelines()
        return .result()
    }
}

/// Tappable today's-habits list (iOS 17+). Completed rows — whether derived
/// from the synced snapshot or optimistically tapped — either drop OUT of the
/// list (default: the next incomplete habit rotates into view, so a small
/// widget always surfaces what's left to do — Apple does not allow scrolling
/// in Home Screen widgets) or, with `keepCompleted`, STAY as teal check rows
/// in place (the large checklist: the whole day fits at once, so a tap should
/// read as a check-mark, not a vanishing row). Renders at most `maxRows` rows
/// plus a "+N more" hint.
///
/// Every row gets an explicit, full-width hit region (frame + vertical
/// `rowPadding` + contentShape) — a `.plain` button's tap area is otherwise
/// content-sized (Greptile P2 on #360). `columns: 2` splits the rows into two
/// side-by-side stacks so the padded rows of the large widget still fit.
@available(iOS 17.0, *)
struct InteractiveHabitList: View {
    let habits: [DerivedTodayView.HabitView]
    var maxRows: Int = 3
    /// Extra vertical tap area per row. The medium widget keeps 0 — its
    /// compact rows only just fit; the large widget has room to pad.
    var rowPadding: CGFloat = 0
    /// Gap between rows in a column. The large widget tightens to 3 so a full
    /// day fits; the medium widget keeps the 4 it shipped with.
    var rowSpacing: CGFloat = 4
    /// Floor on each row's tappable height. 0 = natural size (medium, whose
    /// compact rows only just fit). The large checklist raises it so the hit
    /// region is not set by the SF Symbol's line box.
    var minRowHeight: CGFloat = 0
    /// 1 = single stack (medium). 2+ = side-by-side stacks (large). The large
    /// widget goes to 3 on a full day so nothing collapses into the hint.
    var columns: Int = 1
    /// Row text size. The large widget's 3-column grid drops to 10 so the
    /// whole day fits; the medium widget keeps 11.
    var textSize: CGFloat = 11
    /// false = completed rows rotate out (medium). true = completed rows stay
    /// as checks (large checklist).
    var keepCompleted: Bool = false

    /// Glyph tracks the text so the circle never outweighs the label.
    private var glyphSize: CGFloat { textSize + 2 }

    // habit.completed is already tap-accurate — the timeline provider folds
    // the pending queue into the derived data, count-capped at timesPerDay, so
    // a 2x/day habit at 1 rep correctly still reads incomplete (and tappable).
    private func isDone(_ habit: DerivedTodayView.HabitView) -> Bool {
        habit.completed
    }

    private var pending: [DerivedTodayView.HabitView] {
        habits.filter { !isDone($0) }
    }

    private func logButton(for habit: DerivedTodayView.HabitView) -> some View {
        Button(intent: CompleteHabitIntent(habitTitle: habit.title)) {
            HStack(spacing: 6) {
                Image(systemName: "circle")
                    .font(.system(size: glyphSize, weight: .semibold))
                    .foregroundColor(MUTED)
                Text(habit.title)
                    .font(NexusFont.ui(textSize))
                    .foregroundColor(TEXT_SOFT)
                    .lineLimit(1)
                    // Shrink before truncating: a narrow 3-column cell fits
                    // ~14 characters, and several real habit titles are longer.
                    .minimumScaleFactor(0.85)
            }
            .padding(.vertical, rowPadding)
            .frame(maxWidth: .infinity, minHeight: minRowHeight, alignment: .leading)
            // Inside the frame, so the floor is part of the hit region and not
            // just visual padding around a smaller tappable box.
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// A checked-off row (keepCompleted mode only). Not tappable — the action
    /// is COMPLETE, never toggle; un-completing lives in-app.
    private func doneRow(for habit: DerivedTodayView.HabitView) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: glyphSize, weight: .semibold))
                .foregroundColor(TEAL)
            Text(habit.title)
                .font(NexusFont.ui(textSize))
                .foregroundColor(DIM)
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
        .padding(.vertical, rowPadding)
        .frame(maxWidth: .infinity, minHeight: minRowHeight, alignment: .leading)
    }

    @ViewBuilder
    private func rowView(for habit: DerivedTodayView.HabitView) -> some View {
        if keepCompleted && isDone(habit) {
            doneRow(for: habit)
        } else {
            logButton(for: habit)
        }
    }

    /// Column-major split into `n` stacks: reading order runs DOWN each column
    /// then across, which is how a checklist is scanned. Earlier columns take
    /// the remainder so a short last column sits on the trailing edge.
    private func chunk(_ visible: [DerivedTodayView.HabitView], into n: Int) -> [[DerivedTodayView.HabitView]] {
        guard n > 1 else { return visible.isEmpty ? [] : [visible] }
        let perColumn = Int((Double(visible.count) / Double(n)).rounded(.up))
        guard perColumn > 0 else { return [] }
        return stride(from: 0, to: visible.count, by: perColumn).map {
            Array(visible[$0 ..< min($0 + perColumn, visible.count)])
        }
    }

    @ViewBuilder
    private func rows(for visible: [DerivedTodayView.HabitView]) -> some View {
        if columns > 1 {
            HStack(alignment: .top, spacing: 10) {
                ForEach(Array(chunk(visible, into: columns).enumerated()), id: \.offset) { _, column in
                    VStack(alignment: .leading, spacing: rowSpacing) {
                        ForEach(Array(column.enumerated()), id: \.offset) { _, habit in
                            rowView(for: habit)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        } else {
            ForEach(Array(visible.enumerated()), id: \.offset) { _, habit in
                rowView(for: habit)
            }
        }
    }

    private func moreHint(_ count: Int) -> some View {
        Text("+\(count) more")
            .font(NexusFont.ui(9))
            .foregroundColor(DIM)
            .padding(.leading, 20)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: rowSpacing) {
            if keepCompleted {
                // The full day in place — done rows checked, the rest tappable,
                // and crucially in PAYLOAD ORDER so a check-mark lands where the
                // row already was instead of making the list reshuffle under the
                // user's finger.
                //
                // That in-place ordering is only safe while nothing is cut. The
                // caller only passes keepCompleted when the day fits, but if a
                // future caller (or a pathological height) truncates anyway, a
                // prefix in payload order could be entirely completed rows and
                // leave the widget with nothing to tap — the exact defect
                // reverted by Greptile P1 round 4 on #380. So on overflow this
                // falls back to pending-first, keeping the list actionable.
                let ordered = habits.count > maxRows ? (pending + habits.filter { isDone($0) }) : habits
                let visible = Array(ordered.prefix(maxRows))
                rows(for: visible)
                if habits.count > maxRows {
                    moreHint(habits.count - maxRows)
                }
            } else if pending.isEmpty {
                HStack(spacing: 5) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(TEAL)
                    Text("All logged")
                        .font(NexusFont.ui(11))
                        .foregroundColor(TEAL)
                }
            } else {
                let visible = Array(pending.prefix(maxRows))
                rows(for: visible)
                if pending.count > maxRows {
                    moreHint(pending.count - maxRows)
                }
            }
        }
    }
}

@main
struct NexusWidgetBundle: WidgetBundle {
    var body: some Widget {
        NexusHabitWidget()
        NexusTodayWidget()
        NexusXLWidget()
        NexusStreakWidget()
        NexusLockScreenWidget()
        NexusStreakLockWidget()
        NexusInlineWidget()
    }
}
