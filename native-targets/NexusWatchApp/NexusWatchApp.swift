import SwiftUI
import WatchKit
import WatchConnectivity

// MARK: - Data model (mirrors widget)
struct WatchNexusData: Codable {
    var disciplineScore: Int
    var completionPercent: Int
    var level: Int
    var totalXP: Int
    // NEX-219: cumulative, non-resetting headline (Law B default). Optional so an
    // older payload without these keys still decodes.
    var topHabitReps: Int?
    var topHabitTitle: String?
    // Soft Mode (opt-in). The breakable-streak fields below are zeroed in the
    // payload unless this is true — the watch shows the day streak only then.
    var softMode: Bool?
    var longestStreakDays: Int
    var longestStreakHabit: String
    var todayHabits: [HabitEntry]
    var topStreaks: [StreakEntry]

    struct HabitEntry: Codable, Identifiable {
        var id: String { title }
        var title: String
        var completed: Bool
    }
    struct StreakEntry: Codable, Identifiable {
        var id: String { title }
        var title: String
        var days: Int
    }

    static var placeholder: WatchNexusData {
        WatchNexusData(
            disciplineScore: 82,
            completionPercent: 75,
            level: 4,
            totalXP: 1240,
            topHabitReps: 142,
            topHabitTitle: "Morning Meditation",
            softMode: false,
            longestStreakDays: 14,
            longestStreakHabit: "Morning Meditation",
            todayHabits: [
                HabitEntry(title: "Morning Meditation", completed: true),
                HabitEntry(title: "Exercise", completed: true),
                HabitEntry(title: "Read 20 Pages", completed: false),
            ],
            topStreaks: [
                StreakEntry(title: "Morning Meditation", days: 14),
                StreakEntry(title: "Exercise", days: 7),
            ]
        )
    }
}

// MARK: - WatchConnectivity session manager
class WatchSessionManager: NSObject, WCSessionDelegate, ObservableObject {
    static let shared = WatchSessionManager()
    @Published var data: WatchNexusData = WatchNexusData.placeholder

    override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}

    // NEX-219: the phone sends the payload under `nexus_watch_data` (see
    // sendDataToWatch in src/widgets/watch-bridge.ts). Read that key, with a
    // legacy `nexus_data` fallback, so the watch actually decodes the de-streaked
    // payload instead of staying on placeholder data.
    private func decodeAndApply(_ container: [String: Any]) {
        guard let jsonString = (container["nexus_watch_data"] ?? container["nexus_data"]) as? String,
              let jsonData = jsonString.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(WatchNexusData.self, from: jsonData) else { return }
        DispatchQueue.main.async { self.data = parsed }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        decodeAndApply(message)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        decodeAndApply(applicationContext)
    }
}

// MARK: - Colors
let WATCH_GOLD = Color(red: 0.83, green: 0.69, blue: 0.22)
func watchScoreColor(_ score: Int) -> Color {
    if score >= 80 { return Color.green }
    if score >= 50 { return WATCH_GOLD }
    return Color.red
}

// MARK: - Score Ring View
struct ScoreRingView: View {
    let data: WatchNexusData
    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle()
                    .stroke(Color.white.opacity(0.1), lineWidth: 10)
                Circle()
                    .trim(from: 0, to: CGFloat(data.disciplineScore) / 100)
                    .stroke(watchScoreColor(data.disciplineScore), style: StrokeStyle(lineWidth: 10, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeInOut(duration: 0.5), value: data.disciplineScore)
                VStack(spacing: 2) {
                    Text("\(data.disciplineScore)")
                        .font(.system(size: 26, weight: .black))
                        .foregroundColor(watchScoreColor(data.disciplineScore))
                    Text("SCORE")
                        .font(.system(size: 8, weight: .bold))
                        .kerning(1)
                        .foregroundColor(.gray)
                }
            }
            .frame(width: 90, height: 90)
            Text("LVL \(data.level) · \(data.totalXP) XP")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(WATCH_GOLD)
        }
    }
}

// MARK: - Today's Habits View
struct WatchHabitsView: View {
    let data: WatchNexusData
    var body: some View {
        List(data.todayHabits) { habit in
            HStack(spacing: 8) {
                Image(systemName: habit.completed ? "checkmark.circle.fill" : "circle")
                    .foregroundColor(habit.completed ? WATCH_GOLD : .gray)
                    .font(.system(size: 13))
                Text(habit.title)
                    .font(.system(size: 12))
                    .foregroundColor(habit.completed ? .white : .gray)
                    .lineLimit(1)
            }
        }
        .listStyle(.carousel)
        .navigationTitle("TODAY")
    }
}

// MARK: - Progress View (NEX-219)
// Default (Law B): the cumulative top habit by lifetime reps — a miss takes none
// away. Soft Mode (opt-in) shows the breakable day streaks instead. The bridge
// zeroes the streak fields unless Soft Mode is on, so the default path renders no
// breakable streak even if this view were reached with stale data.
struct WatchStreaksView: View {
    let data: WatchNexusData
    var body: some View {
        Group {
            if data.softMode == true {
                List(data.topStreaks.prefix(3)) { streak in
                    HStack {
                        Text(streak.title)
                            .font(.system(size: 12))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        Spacer()
                        Text("\(streak.days)d")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(WATCH_GOLD)
                    }
                }
                .listStyle(.carousel)
                .navigationTitle("STREAKS")
            } else if let reps = data.topHabitReps, reps > 0 {
                List {
                    HStack {
                        Text(data.topHabitTitle ?? "")
                            .font(.system(size: 12))
                            .foregroundColor(.white)
                            .lineLimit(1)
                        Spacer()
                        Text("\(reps) reps")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(WATCH_GOLD)
                    }
                }
                .listStyle(.carousel)
                .navigationTitle("TOP HABIT")
            } else {
                // No reps yet — never a deflating "0", mirrors the widget + weeklyProgressLabel.
                Text("No reps yet")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.gray)
                    .navigationTitle("TOP HABIT")
            }
        }
    }
}

// MARK: - Main Tab View
struct ContentView: View {
    @StateObject var session = WatchSessionManager.shared

    var body: some View {
        TabView {
            // Tab 1: Score Ring
            NavigationView {
                ScrollView {
                    ScoreRingView(data: session.data)
                        .padding(.top, 8)
                }
                .navigationTitle("NEXUS")
                .navigationBarTitleDisplayMode(.inline)
            }

            // Tab 2: Habits
            NavigationView {
                WatchHabitsView(data: session.data)
            }

            // Tab 3: Streaks
            NavigationView {
                WatchStreaksView(data: session.data)
            }
        }
        .tabViewStyle(.page)
    }
}

// MARK: - App entry point
@main
struct NexusWatchApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

// MARK: - Complication (Score number for watch face)
struct NexusComplicationWidget: Widget {
    let kind = "NexusComplication"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: WatchComplicationProvider()) { entry in
            Text("\(entry.score)")
                .font(.system(size: 18, weight: .black))
                .foregroundColor(watchScoreColor(entry.score))
                .containerBackground(Color.clear, for: .widget)
        }
        .configurationDisplayName("Nexus Score")
        .description("Your discipline score on the watch face.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline])
    }
}

struct WatchComplicationEntry: TimelineEntry {
    let date: Date
    let score: Int
}

struct WatchComplicationProvider: TimelineProvider {
    func placeholder(in context: Context) -> WatchComplicationEntry {
        WatchComplicationEntry(date: Date(), score: 82)
    }
    func getSnapshot(in context: Context, completion: @escaping (WatchComplicationEntry) -> Void) {
        let score = WatchSessionManager.shared.data.disciplineScore
        completion(WatchComplicationEntry(date: Date(), score: score))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<WatchComplicationEntry>) -> Void) {
        let score = WatchSessionManager.shared.data.disciplineScore
        let entry = WatchComplicationEntry(date: Date(), score: score)
        completion(Timeline(entries: [entry], policy: .after(Calendar.current.date(byAdding: .minute, value: 15, to: Date())!)))
    }
}
