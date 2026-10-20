/**
 * Nexus Daily Progress Widget — React Native preview component
 * ────────────────────────────────────────────────────────────────────
 * This component renders what the widget will look like.
 * The actual widget is a SwiftUI view (iOS) or XML layout (Android).
 *
 * Use this for:
 *  - Design reference when building the native widget views
 *  - Preview in a settings/debug screen to show users what widgets look like
 *
 * NATIVE WIDGET FILES (to be created after `npx expo prebuild`):
 *  iOS:     ios/NexusWidget/DailyProgressWidget.swift
 *  Android: android/app/src/main/res/layout/widget_daily_progress.xml
 *            android/app/src/main/java/.../DailyProgressWidgetProvider.kt
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import tokens from '@/src/theme/tokens';
import { stripEmoji } from '@/src/utils/text';

// Local preview shape — this file is a design-reference component
// only (no runtime consumers). Decoupled from widget-bridge after
// the May 2026 raw-snapshot rewrite, which removed the pre-derived
// WidgetData fields (dateLabel, completionPercent, todayHabits,
// etc.) in favor of Swift-side derivation. If you re-enable a
// debug preview screen, hand-build this shape from store state.
interface WidgetPreviewData {
  dateLabel: string;
  completionPercent: number;
  todayHabits: { title: string; completed: boolean }[];
  longestStreakDays: number;
  longestStreakHabit: string;
}

const GOLD = tokens.color.gold;
const BG = tokens.color.void;

interface Props {
  data: WidgetPreviewData;
  size?: 'small' | 'medium'; // small = 155×155, medium = 329×155
}

export function DailyProgressWidgetPreview({ data, size = 'small' }: Props) {
  const dim = size === 'small' ? 155 : 329;

  return (
    <View style={[styles.widget, { width: dim, height: 155 }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.appName}>NEXUS</Text>
        <Text style={styles.date}>{data.dateLabel}</Text>
      </View>

      {/* Score ring — simplified */}
      <View style={styles.scoreRow}>
        <View style={styles.ringOuter}>
          <View style={[
            styles.ringInner,
            // FIXME(nex-56): off-scale gray #444 (inactive ring), no token — design review
            { borderColor: data.completionPercent >= 80 ? GOLD : tokens.color.textDisabled },
          ]}>
            <Text style={styles.scoreNumber}>{data.completionPercent}</Text>
            <Text style={styles.scorePct}>%</Text>
          </View>
        </View>

        {size === 'medium' && (
          <View style={styles.habitList}>
            {data.todayHabits.slice(0, 4).map((h, i) => (
              <View key={i} style={styles.habitRow}>
                <Text style={[styles.habitDot, h.completed && { color: GOLD }]}>
                  {h.completed ? '●' : '○'}
                </Text>
                <Text style={[
                  styles.habitTitle,
                  // FIXME(nex-56): off-scale gray #ccc (completed habit text), no token — design review
                  h.completed && { color: tokens.color.textSecondary, textDecorationLine: 'line-through' },
                ]}>
                  {stripEmoji(h.title)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {/* Score label */}
      <Text style={styles.label}>DISCIPLINE SCORE {data.completionPercent}%</Text>
    </View>
  );
}

/**
 * Streak Counter Widget Preview
 */
export function StreakWidgetPreview({ data, size = 'small' }: Props) {
  return (
    <View style={[styles.widget, { width: 155, height: 155 }]}>
      <Text style={styles.appName}>NEXUS</Text>
      <Text style={styles.streakNum}>{data.longestStreakDays}</Text>
      <Text style={styles.streakLabel}>DAY STREAK</Text>
      <Text style={styles.streakHabit} numberOfLines={1}>{data.longestStreakHabit}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // FIXME(nex-56): off-scale 14pt padding + 22pt radius — design review
  widget: {
    backgroundColor: BG,
    borderRadius: 22,
    padding: 14,
    borderWidth: 1,
    borderColor: tokens.color.surfaceElevated,
    justifyContent: 'space-between',
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  // FIXME(nex-56): off-scale 8pt fontSize — design review
  appName: { color: GOLD, fontSize: 8, fontWeight: '900', letterSpacing: 3 },
  // FIXME(nex-56): off-scale gray #444 + 8pt fontSize — design review
  date: { color: tokens.color.textDisabled, fontSize: 8 },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: tokens.spacing.sm, flex: 1 },
  ringOuter: { width: 60, height: 60, alignItems: 'center', justifyContent: 'center' },
  ringInner: { width: 56, height: 56, borderRadius: 28, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  // FIXME(nex-56): off-scale 16pt fontSize — design review
  scoreNumber: { color: tokens.color.text, fontSize: 16, fontWeight: '900' },
  // FIXME(nex-56): off-scale gray #666 + 8pt fontSize — design review
  scorePct: { color: tokens.color.textMuted, fontSize: 8 },
  habitList: { flex: 1, gap: 6 },
  habitRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  // FIXME(nex-56): off-scale gray #333 + 8pt fontSize — design review
  habitDot: { color: tokens.color.textDisabled, fontSize: 8 },
  // FIXME(nex-56): off-scale gray #666 + 10pt fontSize — design review
  habitTitle: { color: tokens.color.textMuted, fontSize: 10 },
  // FIXME(nex-56): off-scale gray #333 + 7pt fontSize — design review
  label: { color: tokens.color.textDisabled, fontSize: 7, letterSpacing: 1 },
  // FIXME(nex-56): off-scale 48pt fontSize + 56pt lineHeight (decorative streak numeral) — design review
  streakNum: { color: GOLD, fontSize: 48, fontWeight: '900', textAlign: 'center', lineHeight: 56 },
  // FIXME(nex-56): off-scale gray #555 + 8pt fontSize — design review
  streakLabel: { color: tokens.color.textMuted, fontSize: 8, letterSpacing: 2, textAlign: 'center' },
  // FIXME(nex-56): off-scale gray #444 + 9pt fontSize — design review
  streakHabit: { color: tokens.color.textDisabled, fontSize: 9, textAlign: 'center' },
});

/**
 * ────────────────────────────────────────────────────────────────────
 * SWIFT WIDGET CODE (copy into ios/NexusWidget/NexusWidget.swift after prebuild)
 * ────────────────────────────────────────────────────────────────────
 *
 * import WidgetKit
 * import SwiftUI
 *
 * struct WidgetData: Codable {
 *   var completionPercent: Int
 *   var disciplineScore: Int
 *   var dateLabel: String
 *   var longestStreakDays: Int
 *   var longestStreakHabit: String
 *   var lastUpdated: Double
 * }
 *
 * struct Provider: TimelineProvider {
 *   func placeholder(in context: Context) -> SimpleEntry {
 *     SimpleEntry(date: Date(), data: WidgetData(completionPercent: 75, disciplineScore: 80, dateLabel: "Today", longestStreakDays: 14, longestStreakHabit: "Meditation", lastUpdated: 0))
 *   }
 *
 *   func getSnapshot(in context: Context, completion: @escaping (SimpleEntry) -> ()) {
 *     let entry = SimpleEntry(date: Date(), data: loadData())
 *     completion(entry)
 *   }
 *
 *   func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> ()) {
 *     let entry = SimpleEntry(date: Date(), data: loadData())
 *     let nextUpdate = Calendar.current.date(byAdding: .hour, value: 1, to: Date())!
 *     let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
 *     completion(timeline)
 *   }
 *
 *   func loadData() -> WidgetData {
 *     let defaults = UserDefaults(suiteName: "group.com.jhuff.nexus")
 *     if let data = defaults?.data(forKey: "nexus_widget"),
 *        let decoded = try? JSONDecoder().decode(WidgetData.self, from: data) {
 *       return decoded
 *     }
 *     return WidgetData(completionPercent: 0, disciplineScore: 0, dateLabel: "", longestStreakDays: 0, longestStreakHabit: "", lastUpdated: 0)
 *   }
 * }
 *
 * struct SimpleEntry: TimelineEntry {
 *   let date: Date
 *   let data: WidgetData
 * }
 *
 * struct NexusWidgetEntryView : View {
 *   var entry: Provider.Entry
 *   @Environment(\.widgetFamily) var family
 *
 *   var body: some View {
 *     ZStack {
 *       Color(hex: "0A0A0A")
 *       VStack(alignment: .leading, spacing: 8) {
 *         Text("NEXUS")
 *           .font(.system(size: 8, weight: .black))
 *           .foregroundColor(Color(hex: "D4AF37"))
 *           .kerning(3)
 *         Spacer()
 *         Text("\(entry.data.completionPercent)%")
 *           .font(.system(size: 36, weight: .black))
 *           .foregroundColor(.white)
 *         Text("DISCIPLINES TODAY")
 *           .font(.system(size: 7, weight: .bold))
 *           .foregroundColor(.gray)
 *           .kerning(1)
 *       }
 *       .padding(14)
 *       .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
 *     }
 *   }
 * }
 *
 * @main
 * struct NexusWidget: Widget {
 *   let kind: String = "NexusWidget"
 *
 *   var body: some WidgetConfiguration {
 *     StaticConfiguration(kind: kind, provider: Provider()) { entry in
 *       NexusWidgetEntryView(entry: entry)
 *     }
 *     .configurationDisplayName("Nexus Daily")
 *     .description("Today's habit completion and discipline score.")
 *     .supportedFamilies([.systemSmall, .systemMedium])
 *   }
 * }
 */
