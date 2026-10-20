/**
 * Help & Guides Screen
 * Premium dark design matching Nexus visual identity.
 */
import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Linking, LayoutAnimation, Platform,
} from 'react-native';
import { haptic } from '@/src/utils/haptics';
import tokens from '@/src/theme/tokens';
import { ListRow } from '@/src/components/ui/ListRow';
import { ListSection } from '@/src/components/ui/ListSection';

const BG = tokens.color.void;
const SURFACE = tokens.color.surface;
// v3 stellar: border #1E1E1E → tokens.color.goldHairline (now luminous white).
const BORDER = tokens.color.goldHairline;
const GOLD = tokens.color.gold;
const TEXT = tokens.color.text;
// v3 stellar: muted gray #555 → tokens.color.textMuted.
const MUTED = tokens.color.textMuted;

// ─── Data types ─────────────────────────────────────────────────────────────

interface FeatureGuide {
  icon: string;
  title: string;
  content: string;
}

interface Workflow {
  icon: string;
  title: string;
  steps: string[];
}

// ─── Data ────────────────────────────────────────────────────────────────────

const FEATURE_GUIDES: FeatureGuide[] = [
  {
    icon: '◈',
    title: 'Habits & Disciplines',
    content: `Habits are the atomic unit of your system. Each habit you track builds cumulative reps. Progress never resets.\n\nTo add a habit: go to any screen and use the Command tab to say "Add habit: [name]". You can also add from the home screen.\n\nHabits feed into your Discipline Score, which resets daily. Consistency over time is tracked as your lifetime reps and this-week count.`,
  },
  {
    icon: '◆',
    title: 'Mandates',
    content: `Mandates are your life pillars, the non-negotiable areas you're committed to. Think of them as your personal constitution.\n\nAccess via the ALIGN tab. You can link habits to mandates to see how your daily actions serve your bigger vision.\n\nRecommend: 3–5 mandates max. Too many means no real priorities.`,
  },
  {
    icon: '◉',
    title: 'Command Center',
    content: `The Command tab is your AI operating partner. Speak or type naturally:\n\n• "Add habit: cold shower"\n• "Schedule meeting at 3pm tomorrow"\n• "Add task: send proposal by Friday"\n• "What's my progress on meditation?"\n\nThe AI parses your intent and updates your system automatically.\n\nVoice Journal: Record audio reflections directly from the Command tab. Best practice: record a 60-second debrief each evening. Review journal entries weekly to spot patterns in your thinking and energy.`,
  },
  {
    icon: '◇',
    title: 'Progress & Scoring',
    content: `Your Discipline Score (0–100) is calculated daily from three factors:\n\n• Morning intention set (+33 pts)\n• Habits completed (up to +33 pts)\n• Daily tasks completed (up to +34 pts)\n\nHabit progress is cumulative. A missed day subtracts nothing earned. Milestone celebrations fire at 7, 30, 66, and 365 completions.`,
  },
  {
    icon: '○',
    title: 'Orbit (Calendar)',
    content: `Orbit is your temporal command layer — a visual timeline of appointments, time blocks, and recurring events.\n\nYou can sync with Apple Calendar (iOS) to pull in existing events. Add manual events or time blocks directly in Orbit.\n\nUse Orbit to see conflicts and protect your deep work time.`,
  },
];

const WORKFLOWS: Workflow[] = [
  {
    icon: '☀',
    title: 'Morning Routine Power Stack',
    steps: [
      'Open Nexus on wake — set your morning intention (1 sentence)',
      'Review your habits for today in the home screen',
      'Check Orbit for today\'s schedule and any conflicts',
      'Say "Nexus, what are my tasks today?" in Command',
      'Execute first 90-minute deep work block before checking anything else',
    ],
  },
  {
    icon: '📋',
    title: 'Weekly Review Workflow',
    steps: [
      'Every Sunday, open the home screen and tap "Weekly Review"',
      'Review your Discipline Score trend for the week',
      'Notice which habits held and what patterns showed up this week',
      'Set your 3 weekly wins (what would make this week a W)',
      'Update any mandates that need recalibration',
      'Plan the key moves for the coming week in Orbit',
    ],
  },
  {
    icon: '⚡',
    title: 'Habit Stacking Template',
    steps: [
      'Identify 3–5 anchor habits (non-negotiable daily acts)',
      'Stack them in sequence: e.g. Wake → Meditate → Journal → Exercise',
      'Add them to Nexus as habits in the same time block',
      'Use the morning intention to set which stack you\'ll do',
      'Track the chain — once started, momentum compounds',
    ],
  },
];

const FAQS = [
  {
    q: 'Why isn\'t my progress showing?',
    a: 'Progress is cumulative and never resets. Every completion adds to your lifetime reps and this-week count, even after a pause. Check that you\'re logging habits on the correct day. The app uses your local device time.',
  },
  {
    q: 'Can I sync to Apple Calendar?',
    a: 'Yes. Go to Orbit and tap the sync button. Nexus will request Calendar permissions and pull in your events. Only read-only for now — Nexus-created events appear separately.',
  },
  {
    q: 'How do I change my notification times?',
    a: 'Go to Settings → Notifications. You can set your morning reminder time, evening check-in time, and weekly summary day.',
  },
  {
    q: 'What is the Discipline Score?',
    a: 'It\'s a 0–100 daily score based on: morning intention set (33 pts), habit completions (33 pts), and daily task completions (34 pts). It resets each day — it measures today, not history.',
  },
  {
    q: 'How do I delete a habit?',
    a: 'Long-press any habit on the home screen to reveal delete and edit options. Note: deleting a habit removes it from future tracking but preserves historical log entries.',
  },
  {
    q: 'Is my data backed up?',
    a: 'Yes. All data syncs to the cloud every 5 minutes when you\'re signed in. You can sign out and sign back in on any device to restore your data.',
  },
  {
    q: 'Can I use Nexus offline?',
    a: 'Yes. All core features work offline. Data syncs when you reconnect to the internet. The AI Command features require an internet connection.',
  },
];

// ─── Accordion Item ───────────────────────────────────────────────────────────
function AccordionItem({ q, a }: { q: string; a: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <View style={acc.item}>
      <Pressable
        style={acc.header}
        onPress={() => {
          haptic('buttonSecondary');
          if (Platform.OS === 'ios') LayoutAnimation.easeInEaseOut();
          setOpen(v => !v);
        }}
      >
        <Text style={acc.question}>{q}</Text>
        <Text style={[acc.chevron, open && { transform: [{ rotate: '90deg' }] }]}>▸</Text>
      </Pressable>
      {open && <Text style={acc.answer}>{a}</Text>}
    </View>
  );
}

const acc = StyleSheet.create({
  item: { borderBottomWidth: 1, borderBottomColor: BORDER },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingVertical: tokens.spacing.md, paddingHorizontal: tokens.spacing.md },
  // FIXME(nex-56): off-scale 14pt fontSize, design review (nearest token: bodyMd 15pt)
  // FIXME(nex-56): off-scale 10pt margin, design review
  question: { color: TEXT, fontSize: 14, flex: 1, marginRight: 10, lineHeight: 20 },
  // FIXME(nex-56): off-scale 14pt fontSize, design review
  chevron: { color: MUTED, fontSize: 14 },
  // FIXME(nex-56): off-scale gray text, design review
  // FIXME(nex-56): off-scale 13pt fontSize, design review (matches caption 13pt but weight/family differ)
  answer: { color: tokens.color.textMuted, fontSize: 13, lineHeight: 20, paddingHorizontal: tokens.spacing.md, paddingBottom: tokens.spacing.md },
});

// ─── Guide Card ───────────────────────────────────────────────────────────────
function GuideCard({ item }: { item: FeatureGuide }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      style={guide.card}
      onPress={() => {
        haptic('buttonSecondary');
        if (Platform.OS === 'ios') LayoutAnimation.easeInEaseOut();
        setOpen(v => !v);
      }}
    >
      <View style={guide.row}>
        <Text style={guide.icon}>{item.icon}</Text>
        <Text style={guide.title}>{item.title}</Text>
        <Text style={[guide.chevron, open && { transform: [{ rotate: '90deg' }] }]}>▸</Text>
      </View>
      {open && <Text style={guide.content}>{item.content}</Text>}
    </Pressable>
  );
}

const guide = StyleSheet.create({
  // FIXME(nex-56): off-scale 10pt margin, design review
  card: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: tokens.color.luminousEdge, marginBottom: 10, padding: tokens.spacing.md },
  row: { flexDirection: 'row', alignItems: 'center' },
  // FIXME(nex-56): off-scale 18pt fontSize, design review (matches titleCard 18pt but family/weight differ)
  icon: { color: GOLD, fontSize: 18, marginRight: tokens.spacing.sm, width: 24 },
  // FIXME(nex-56): off-scale 15pt fontSize, design review (matches bodyMd 15pt but weight 600 differs from token 400/500)
  title: { color: TEXT, fontSize: 15, fontWeight: '600', flex: 1 },
  // FIXME(nex-56): off-scale 14pt fontSize, design review
  chevron: { color: MUTED, fontSize: 14 },
  // FIXME(nex-56): off-scale gray text, design review
  // FIXME(nex-56): off-scale 13pt fontSize, design review
  // FIXME(nex-56): off-scale 14pt margin, design review
  content: { color: tokens.color.textMuted, fontSize: 13, lineHeight: 22, marginTop: 14 },
});

// ─── Workflow Card ────────────────────────────────────────────────────────────
function WorkflowCard({ item }: { item: Workflow }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      style={wf.card}
      onPress={() => {
        haptic('buttonSecondary');
        if (Platform.OS === 'ios') LayoutAnimation.easeInEaseOut();
        setOpen(v => !v);
      }}
    >
      <View style={wf.header}>
        <Text style={wf.icon}>{item.icon}</Text>
        <Text style={wf.title}>{item.title}</Text>
        <Text style={[wf.chevron, open && { transform: [{ rotate: '90deg' }] }]}>▸</Text>
      </View>
      {open && (
        // FIXME(nex-56): off-scale 14pt margin, design review
        <View style={{ marginTop: 14 }}>
          {item.steps.map((s, i) => (
            <View key={i} style={wf.step}>
              <View style={wf.stepNum}>
                <Text style={wf.stepNumText}>{i + 1}</Text>
              </View>
              <Text style={wf.stepText}>{s}</Text>
            </View>
          ))}
        </View>
      )}
    </Pressable>
  );
}

// FIXME(nex-56): runtime gold-alpha compositions in stepNum (gold + '22' / '44') —
// the gold base resolves to tokens.color.gold; the alpha suffixes are not tokens.
// Design review should decide if alpha overlays become tokenized.
const wf = StyleSheet.create({
  // FIXME(nex-56): off-scale 10pt margin, design review
  card: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: tokens.color.luminousEdge, marginBottom: 10, padding: tokens.spacing.md },
  header: { flexDirection: 'row', alignItems: 'center' },
  // FIXME(nex-56): off-scale 18pt fontSize, design review
  icon: { fontSize: 18, marginRight: tokens.spacing.sm, width: 24 },
  // FIXME(nex-56): off-scale 15pt fontSize, design review
  title: { color: TEXT, fontSize: 15, fontWeight: '600', flex: 1 },
  // FIXME(nex-56): off-scale 14pt fontSize, design review
  chevron: { color: MUTED, fontSize: 14 },
  step: { flexDirection: 'row', marginBottom: tokens.spacing.sm, alignItems: 'flex-start' },
  // FIXME(nex-56): runtime gold-alpha bg + border (see palette comment above)
  // FIXME(nex-56): off-scale 10pt margin, 1pt top — design review
  stepNum: { width: 22, height: 22, borderRadius: 11, backgroundColor: GOLD + '22', borderWidth: 1, borderColor: GOLD + '44', alignItems: 'center', justifyContent: 'center', marginRight: 10, marginTop: 1 },
  // FIXME(nex-56): off-scale 11pt fontSize, design review (matches labelTrackedSm 11pt but no uppercase/tracking)
  stepNumText: { color: GOLD, fontSize: 11, fontWeight: '700' },
  // FIXME(nex-56): off-scale gray text, design review
  // FIXME(nex-56): off-scale 13pt fontSize, design review
  stepText: { color: tokens.color.textSecondary, fontSize: 13, flex: 1, lineHeight: 20 },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────
interface Props {
  onBack?: () => void;
}

export function HelpScreen({ onBack }: Props): React.JSX.Element {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
      {/* Header */}
      <View style={styles.header}>
        {onBack && (
          <Pressable onPress={onBack} style={styles.backBtn} accessibilityRole="button" accessibilityLabel="Back">
            <Text style={styles.backText}>← BACK</Text>
          </Pressable>
        )}
        <Text style={styles.title}>HELP & GUIDES</Text>
        <Text style={styles.subtitle}>Everything you need to master your system</Text>
      </View>

      {/* Feature Guides */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>FEATURE GUIDES</Text>
        {FEATURE_GUIDES.map((item) => (
          <GuideCard key={item.title} item={item} />
        ))}
      </View>

      {/* Best Workflows */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>BEST WORKFLOWS</Text>
        {WORKFLOWS.map((item) => (
          <WorkflowCard key={item.title} item={item} />
        ))}
      </View>

      {/* FAQ */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>FREQUENTLY ASKED</Text>
        <View style={[styles.card, { padding: 0 }]}>
          {FAQS.map((item, i) => (
            <AccordionItem key={i} q={item.q} a={item.a} />
          ))}
        </View>
      </View>

      {/* Support */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>SUPPORT</Text>
        <ListSection>
          {/* Both hand off to a mail client — ↗, never a chevron. */}
          <ListRow
            title="Contact Support"
            subtitle="admin@thecircleoflight.net"
            trailing="external"
            onPress={() => Linking.openURL('mailto:admin@thecircleoflight.net?subject=Nexus%20Support')}
          />
          <ListRow
            title="Request a Feature"
            trailing="external"
            onPress={() => Linking.openURL('mailto:admin@thecircleoflight.net?subject=Nexus%20Feature%20Request')}
          />
        </ListSection>
      </View>

      <Text style={styles.footer}>Nexus · Built for the intentional</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  // FIXME(nex-56): off-scale 70pt top + 120pt bottom padding, design review
  scroll: { paddingHorizontal: tokens.spacing.lg, paddingTop: 70, paddingBottom: 120 },
  // FIXME(nex-56): off-scale 36pt margin, design review (nearest xl 32pt)
  header: { marginBottom: 36 },
  // FIXME(nex-56): off-scale 20pt margin, design review
  backBtn: { marginBottom: 20 },
  // FIXME(nex-56): off-scale 11pt fontSize, design review
  backText: { color: MUTED, fontSize: 11, letterSpacing: 1 },
  // FIXME(nex-56): off-scale 12pt fontSize, design review
  title: { color: GOLD, fontSize: 12, fontWeight: '900', letterSpacing: 4, marginBottom: tokens.spacing.xs, textAlign: 'center' },
  // FIXME(nex-56): off-scale 13pt fontSize, design review
  subtitle: { color: MUTED, fontSize: 13, textAlign: 'center' },
  section: { marginBottom: tokens.spacing.xl },
  // FIXME(nex-56): off-scale 9pt fontSize, design review (matches labelTrackedMicro 9.5pt — close)
  // FIXME(nex-56): off-scale 4pt left margin (matches xxs 4pt — re-check)
  sectionLabel: { color: MUTED, fontSize: 9, fontWeight: '800', letterSpacing: 2, marginBottom: tokens.spacing.sm, marginLeft: tokens.spacing.xxs },
  card: { backgroundColor: SURFACE, borderRadius: 14, borderWidth: 1, borderColor: tokens.color.luminousEdge, overflow: 'hidden' },
  footer: { color: tokens.color.textDisabled, fontSize: 11, textAlign: 'center', marginTop: 20, letterSpacing: 1 },
});
